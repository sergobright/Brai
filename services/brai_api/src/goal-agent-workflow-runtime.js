import { activityInfo as temporalActivityInfo } from '@temporalio/activity';
import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { IllegalStateError, NativeConnection, Worker } from '@temporalio/worker';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BraiStore } from './store.js';
import { createGoalAgentContextSmokeActivity } from './goal-agent-context-smoke.js';
import { goalAgentStableHash, validateGoalAgentInputIntegrity } from './goal-agent-context.js';
import { goalAgentsEnabledFromEnv } from './goal-agent-switch.js';
import { withUserScope } from './user-scope.js';
import {
  CONTEXT_DESCRIPTOR_SCHEMA,
  CONTEXT_PAGE_SCHEMA,
  EXECUTION_REFERENCE_SCHEMA,
  assertContextDescriptor,
  assertContextPage,
  assertExecutionReference,
  assertManifestContract,
  contextTaskQueue
} from '../../brai_goal_agents/src/contracts.mjs';
import {
  contextDeploymentVersion,
  pinnedVersioningOverride
} from '../../brai_goal_agents/src/versioning.mjs';

const AGENT_IDS = [
  'activity.classifier', 'goal.item-matcher', 'goal.member-finder',
  'goal.discovery', 'goal.planner'
];
const TERMINAL_TEMPORAL = new Set(['FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']);

export function shutdownGoalAgentWorker(worker) {
  try {
    worker.shutdown();
  } catch (error) {
    if (!(error instanceof IllegalStateError)) throw error;
  }
}

export async function createGoalAgentWorkflowRuntime({
  databaseUrl,
  enabled = goalAgentsEnabledFromEnv(),
  environment = process.env.BRAI_ENVIRONMENT ?? 'prod',
  address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace = process.env.TEMPORAL_NAMESPACE ?? 'default',
  now = () => new Date(),
  logger = console,
  intervalMs = 2_000,
  healthIntervalMs = 10_000
}) {
  if (enabled === false) return {
    enabled: false,
    environment,
    manifests: [],
    recoverQueued: async () => 0,
    startReconciler: () => false,
    close: async () => {}
  };
  const manifests = await loadGoalAgentManifests();
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const store = new BraiStore(databaseUrl);
  store.logger = logger;
  store.configureGoalAgentEnvironment(environment);
  store.syncGoalAgentCatalog(manifests, now().toISOString());
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const contextConnection = await NativeConnection.connect({ address });
  const contextQueue = contextTaskQueue(environment);
  let contextWorker;
  try {
    contextWorker = await Worker.create({
      connection: contextConnection,
      namespace,
      taskQueue: contextQueue,
      activities: createGoalAgentContextActivities({ store, manifests: byId, environment, now }),
      identity: `brai-api-context:${environment}:${os.hostname()}:${process.pid}`,
      maxConcurrentActivityTaskExecutions: 20,
      shutdownGraceTime: '30 seconds',
      workerDeploymentOptions: {
        version: contextDeploymentVersion(environment),
        useWorkerVersioning: false
      }
    });
  } catch (error) {
    await contextConnection.close();
    await connection.close();
    store.db.close();
    throw error;
  }
  const contextWorkerRun = contextWorker.run().catch((error) => {
    logger.error?.('Goal agent context worker stopped unexpectedly', {
      error: error instanceof Error ? error.message : String(error),
      taskQueue: contextQueue
    });
  });
  const reconciler = createGoalAgentReconciler({
    store, client, connection, manifests: byId, environment,
    namespace, now, logger, intervalMs, healthIntervalMs
  });

  return {
    environment,
    manifests,
    recoverQueued: reconciler.run,
    startReconciler: reconciler.start,
    async close() {
      await reconciler.close();
      shutdownGoalAgentWorker(contextWorker);
      await contextWorkerRun;
      store.db.close();
      await contextConnection.close();
      await connection.close();
    }
  };
}

export function createGoalAgentReconciler({
  store,
  client,
  connection = null,
  manifests,
  environment,
  namespace = 'default',
  now = () => new Date(),
  logger = console,
  intervalMs = 2_000,
  healthIntervalMs = 10_000,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval
}) {
  let activeRun = null;
  let interval = null;
  let healthInterval = null;
  let closing = false;
  const observers = new Map();

  function observe(execution, handle) {
    const key = `${execution.workflow_id}\0${execution.run_id ?? ''}`;
    if (observers.has(key) || closing) return;
    const observer = Promise.resolve()
      .then(async () => {
        await handle.result();
      })
      .catch(async (error) => {
        if (closing) return;
        const failedResult = goalAgentFailureResult(error);
        if (failedResult) {
          withUserScope(execution.user_id, () => store.failGoalAgentExecution({
            executionId: execution.id,
            reason: failedResult.error?.code ?? 'agent_failed',
            nowIso: now().toISOString()
          }));
          return;
        }
        const status = await terminalStatus(handle, error);
        if (!status) {
          withUserScope(execution.user_id, () => store.noteGoalAgentTransportFailure({
            executionId: execution.id,
            reason: `temporal_observation:${error instanceof Error ? error.message : String(error)}`,
            nowIso: now().toISOString()
          }));
          logError(logger, 'Goal agent workflow observation failed', error, execution);
          return;
        }
        withUserScope(execution.user_id, () => store.failGoalAgentExecution({
          executionId: execution.id,
          reason: `temporal_${status.toLowerCase()}`,
          nowIso: now().toISOString()
        }));
      })
      .finally(() => observers.delete(key));
    observers.set(key, observer);
  }

  async function dispatch(execution) {
    const manifest = manifests.get(execution.workflow_definition_id);
    if (!manifest) throw new Error(`goal_agent_manifest_missing:${execution.workflow_definition_id}`);
    const taskQueue = `${manifest.queue_base}-${environment}`;
    let handle;
    try {
      handle = await client.workflow.start(manifest.workflow_type, {
        args: [goalAgentExecutionReference(execution, manifest, environment)],
        taskQueue,
        workflowId: execution.workflow_id,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
        versioningOverride: pinnedVersioningOverride(manifest, environment, execution.contract_json)
      });
    } catch (error) {
      if (error?.name !== 'WorkflowExecutionAlreadyStartedError') throw error;
      handle = client.workflow.getHandle(execution.workflow_id);
    }
    const description = handle.firstExecutionRunId ? null : await handle.describe();
    const runId = handle.firstExecutionRunId ?? description?.runId;
    withUserScope(execution.user_id, () => store.markGoalAgentExecutionStarted({
      executionId: execution.id,
      runId,
      nowIso: now().toISOString()
    }));
    observe({ ...execution, run_id: runId }, handle);
  }

  function run({ limit = 500 } = {}) {
    if (closing) return Promise.resolve(0);
    if (activeRun) return activeRun;
    activeRun = (async () => {
      store.ensureEligibleGoalDiscoveries({ nowIso: now().toISOString(), limit });
      let dispatched = 0;
      for (const execution of store.listQueuedGoalAgentExecutions({ limit, nowIso: now().toISOString() })) {
        if (closing) break;
        try {
          await dispatch(execution);
          dispatched += 1;
        } catch (error) {
          withUserScope(execution.user_id, () => store.noteGoalAgentTransportFailure({
            executionId: execution.id,
            reason: `temporal_dispatch:${error instanceof Error ? error.message : String(error)}`,
            nowIso: now().toISOString()
          }));
          logError(logger, 'Queued Goal agent workflow dispatch failed', error, execution);
        }
      }
      for (const execution of store.listRunningGoalAgentExecutions({ limit, nowIso: now().toISOString() })) {
        if (closing || !execution.run_id) continue;
        const handle = client.workflow.getHandle(execution.workflow_id, execution.run_id, { followRuns: true });
        observe(execution, handle);
      }
      return dispatched;
    })().finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  async function observePollers() {
    if (!connection || closing) return;
    const taskQueues = [
      ...[...manifests.values()].map((manifest) => `${manifest.queue_base}-${environment}`),
      contextTaskQueue(environment)
    ];
    for (const taskQueue of taskQueues) {
      const pollers = new Map();
      for (const taskQueueType of [1, 2]) {
        try {
          const response = await connection.workflowService.describeTaskQueue({
            namespace,
            taskQueue: { name: taskQueue },
            taskQueueType,
            reportStats: false
          });
          for (const poller of response.pollers ?? []) {
            const identity = String(poller.identity ?? '').trim();
            if (!identity) continue;
            const entry = pollers.get(identity) ?? { identity, types: [], lastSeenAt: null, deployment: null };
            entry.types.push(taskQueueType === 1 ? 'workflow' : 'activity');
            entry.lastSeenAt = latestIso(entry.lastSeenAt, timestampIso(poller.lastAccessTime));
            entry.deployment = poller.deploymentOptions ?? poller.workerVersionCapabilities ?? null;
            pollers.set(identity, entry);
          }
        } catch (error) {
          logError(logger, 'Goal agent task queue observation failed', error, { workflow_id: taskQueue });
        }
      }
      for (const poller of pollers.values()) {
        store.recordWorkflowWorkerHeartbeat({
          taskQueue,
          workerIdentity: poller.identity,
          buildRef: buildRef(poller.deployment),
          startedAtIso: poller.lastSeenAt ?? now().toISOString(),
          nowIso: poller.lastSeenAt ?? now().toISOString(),
          metadataJson: {
            namespace,
            observed_by: 'brai-api',
            poller_types: poller.types,
            deployment_environment: environment
          }
        });
      }
    }
  }

  return {
    run,
    observePollers,
    start() {
      if (closing || interval) return;
      interval = scheduleInterval(() => {
        void run().catch((error) => logError(logger, 'Goal agent reconciliation failed', error));
      }, intervalMs);
      interval.unref?.();
      healthInterval = scheduleInterval(() => {
        void observePollers();
      }, healthIntervalMs);
      healthInterval.unref?.();
      void observePollers();
    },
    async close() {
      closing = true;
      if (interval) clearScheduledInterval(interval);
      if (healthInterval) clearScheduledInterval(healthInterval);
      interval = null;
      healthInterval = null;
      await activeRun?.catch(() => {});
      observers.clear();
    }
  };
}

function goalAgentFailureResult(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.type === 'GoalAgentResultFailure' && Array.isArray(current.details)) {
      const result = current.details[0];
      if (result && typeof result === 'object' && result.status === 'failed') return result;
    }
    current = current.cause;
  }
  return null;
}

export async function loadGoalAgentManifests() {
  const root = path.resolve(import.meta.dirname, '../../brai_goal_agents/manifests');
  return Promise.all(AGENT_IDS.map(async (agentId) => {
    const parsed = JSON.parse(await fs.readFile(path.join(root, `${agentId}.json`), 'utf8'));
    try {
      return assertManifestContract(parsed, agentId);
    } catch (error) {
      throw new Error(`invalid_goal_agent_manifest:${agentId}:${error?.code ?? error?.message ?? 'invalid'}`);
    }
  }));
}

export function goalAgentExecutionReference(execution, manifest, environment) {
  if (execution.workflow_definition_id !== manifest.id) throw new Error('goal_agent_execution_manifest_mismatch');
  return assertExecutionReference({
    schema_version: EXECUTION_REFERENCE_SCHEMA,
    execution_id: String(execution.id),
    agent_id: manifest.id,
    workflow_id: execution.workflow_id,
    context_capability: execution.input_json?.execution_contract?.context_capability,
    context_task_queue: contextTaskQueue(environment)
  }, manifest.id);
}

export function createGoalAgentContextActivities({ store, manifests, environment, now = () => new Date(), activityInfo = temporalActivityInfo }) {
  const expectedQueue = contextTaskQueue(environment);
  const expectedContextBuild = contextDeploymentVersion(environment).buildId;

  function executionFor(reference) {
    assertExecutionReference(reference);
    if (reference.context_task_queue !== expectedQueue) throw new Error('context_environment_mismatch');
    let info;
    try { info = activityInfo(); } catch { throw new Error('context_activity_identity_missing'); }
    const identity = info?.inWorkflow === true ? info.workflowExecution : null;
    if (!identity) throw new Error('context_activity_identity_missing');
    if (info.taskQueue !== expectedQueue) throw new Error('context_task_queue_mismatch');
    let row = store.db.prepare(`
      SELECT * FROM workflow_executions WHERE id = ?
    `).get(reference.execution_id);
    if (!row || row.workflow_definition_id !== reference.agent_id
      || row.deployment_environment !== environment) throw new Error('goal_agent_execution_not_found');
    const manifest = manifests.get(reference.agent_id);
    if (!manifest) throw new Error('goal_agent_manifest_missing');
    const input = parseJson(row.input_json);
    const contract = parseJson(row.contract_json);
    if (!contract.id || goalAgentStableHash(contract) !== row.contract_hash) throw new Error('goal_agent_contract_integrity_failed');
    if (input.agent_id !== contract.id || input.agent_version !== contract.version) {
      throw new Error('goal_agent_context_manifest_mismatch');
    }
    if (input.execution_contract?.context_worker_build_id !== expectedContextBuild) {
      throw new Error('context_worker_build_mismatch');
    }
    if (!validateGoalAgentInputIntegrity(input)) throw new Error('goal_agent_context_integrity_failed');
    if (reference.workflow_id !== row.workflow_id || identity.workflowId !== row.workflow_id) {
      throw new Error('context_workflow_identity_mismatch');
    }
    if (info.workflowType !== contract.workflow_type) throw new Error('context_workflow_type_mismatch');
    if (!capabilityMatches(reference.context_capability, row.context_capability_hash)
      || input.execution_contract?.context_capability !== reference.context_capability) {
      throw new Error('context_capability_mismatch');
    }
    if (row.run_id && row.run_id !== identity.runId) throw new Error('context_run_identity_mismatch');
    if (!row.run_id) {
      const bound = withUserScope(row.user_id, () => store.markGoalAgentExecutionStarted({
        executionId: row.id, runId: identity.runId, nowIso: now().toISOString()
      }));
      if (!bound) throw new Error('context_run_identity_mismatch');
      row = store.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(row.id);
    }
    if (row.run_id !== identity.runId) throw new Error('context_run_identity_mismatch');
    return { row, manifest, contract, input };
  }

  return {
    goalAgentContextSmoke: createGoalAgentContextSmokeActivity({ environment, manifests, activityInfo }),
    async loadGoalAgentContext(reference) {
      const { row, contract, input } = executionFor(reference);
      const { page_sets: pageSets = {}, execution_contract: _contract, ...base } = input;
      const descriptor = {
        schema_version: CONTEXT_DESCRIPTOR_SCHEMA,
        execution_id: String(row.id),
        agent_id: contract.id,
        agent_version: contract.version,
        base,
        page_counts: Object.fromEntries(Object.entries(pageSets).map(([kind, pages]) => [
          kind, Array.isArray(pages) ? pages.length : -1
        ]))
      };
      return assertContextDescriptor(descriptor, reference);
    },

    async loadGoalAgentPage(request) {
      const { reference, kind, index } = parsePageRequest(request);
      const { row, input } = executionFor(reference);
      const pages = input.page_sets?.[kind];
      if (!Array.isArray(pages) || !Number.isInteger(index) || index < 0 || index >= pages.length) {
        throw new Error('goal_agent_context_page_not_found');
      }
      return assertContextPage({
        schema_version: CONTEXT_PAGE_SCHEMA,
        execution_id: String(row.id),
        agent_id: reference.agent_id,
        kind,
        index,
        items: pages[index]?.items
      }, reference, kind, index);
    },

    async persistGoalAgentLlmCalls(request) {
      const { reference, result } = parsePersistenceRequest(request);
      const { row } = executionFor(reference);
      const persistedAt = now().toISOString();
      try {
        const llmCallIds = withUserScope(row.user_id, () => store.persistGoalAgentLlmCalls({
          executionId: row.id,
          result,
          nowIso: persistedAt
        }));
        return {
          schema_version: 'brai.goal-agent.llm-log-ack.v1',
          execution_id: String(row.id),
          execution_status: row.status,
          llm_call_ids: llmCallIds,
          last_error: null
        };
      } catch (error) {
        if (!isDeterministicError(error)) throw error;
        withUserScope(row.user_id, () => store.failGoalAgentExecution({
          executionId: row.id,
          reason: `agent_llm_log_failed:${error?.code ?? error?.message ?? 'unknown'}`,
          nowIso: persistedAt
        }));
        const failed = store.db.prepare('SELECT status, last_error FROM workflow_executions WHERE id = ?').get(row.id);
        return {
          schema_version: 'brai.goal-agent.llm-log-ack.v1',
          execution_id: String(row.id),
          execution_status: failed.status,
          llm_call_ids: [],
          last_error: failed.last_error
        };
      }
    },

    async persistGoalAgentResult(request) {
      const { reference, result } = parsePersistenceRequest(request);
      const { row } = executionFor(reference);
      const persistedAt = now().toISOString();
      const completed = withUserScope(row.user_id, () => store.completeGoalAgentExecution({
        executionId: row.id,
        result,
        nowIso: persistedAt
      }));
      return {
        schema_version: 'brai.goal-agent.persistence-ack.v1',
        execution_id: String(row.id),
        execution_status: completed.status,
        last_error: completed.last_error ?? null
      };
    }
  };
}

function capabilityMatches(value, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actualHash = goalAgentStableHash(value);
  return timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function parsePageRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('invalid_context_page_request');
  const keys = Object.keys(request);
  if (keys.length !== 3 || !keys.includes('reference') || !keys.includes('kind') || !keys.includes('index')) {
    throw new Error('invalid_context_page_request');
  }
  assertExecutionReference(request.reference);
  if (typeof request.kind !== 'string' || request.kind.length > 32) throw new Error('invalid_context_page_kind');
  if (!Number.isInteger(request.index)) throw new Error('invalid_context_page_index');
  return request;
}

function parsePersistenceRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).length !== 2 || !('reference' in request) || !('result' in request)) {
    throw new Error('invalid_goal_agent_persistence_request');
  }
  assertExecutionReference(request.reference);
  return request;
}

function isDeterministicError(error) {
  const status = Number(error?.status);
  return error?.deterministic === true || (Number.isInteger(status) && status >= 400 && status < 500);
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const parsed = JSON.parse(String(value ?? '{}'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_goal_agent_context');
  return parsed;
}

async function terminalStatus(handle, originalError) {
  if (originalError instanceof WorkflowNotFoundError) return 'NOT_FOUND';
  try {
    const description = await handle.describe();
    return TERMINAL_TEMPORAL.has(description.status.name) ? description.status.name : null;
  } catch (error) {
    return error instanceof WorkflowNotFoundError ? 'NOT_FOUND' : null;
  }
}

function timestampIso(timestamp) {
  if (!timestamp) return null;
  const seconds = Number(timestamp.seconds ?? 0);
  const nanos = Number(timestamp.nanos ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}

function latestIso(left, right) {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function buildRef(deployment) {
  return String(
    deployment?.deploymentVersion?.buildId
      ?? deployment?.buildId
      ?? deployment?.buildIdForCurrentTask
      ?? ''
  ).slice(0, 500);
}

function logError(logger, message, error, execution = null) {
  logger.error?.(message, {
    error: error instanceof Error ? error.message : String(error),
    workflowId: execution?.workflow_id ?? null,
    executionId: execution?.id ?? null
  });
}
