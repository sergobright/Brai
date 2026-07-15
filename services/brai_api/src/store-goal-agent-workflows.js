import { randomBytes } from 'node:crypto';
import { buildGoalAgentInput, goalAgentStableHash, validateGoalAgentResultContext } from './goal-agent-context.js';
import { parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopedUserId, withUserScope } from './user-scope.js';
import { assertAgentResultEnvelope } from '../../brai_goal_agents/src/contracts.mjs';
import {
  loadGoalAgentVersionedContract as loadVersionedContract,
  stableGoalAgentWorkflowId as stableWorkflowId,
  syncGoalAgentWorkflowDefinition as syncWorkflowDefinition
} from './goal-agent-catalog.js';
import {
  GOAL_AGENT_TERMINAL as TERMINAL,
  assertLlmCallsPersisted,
  failExecution,
  finishGoalAgentFailure,
  formatExecution,
  isDeterministicPersistenceError,
  persistenceReason,
  persistLlmCalls,
  terminalResult
} from './goal-agent-persistence.js';
import { contextDeploymentVersion } from '../../brai_goal_agents/src/versioning.mjs';

const AGENTS = new Set([
  'activity.classifier', 'goal.item-matcher', 'goal.member-finder',
  'goal.discovery', 'goal.planner'
]);
const DAY_MS = 24 * 60 * 60 * 1000;

export const goalAgentWorkflowMethods = {
  configureGoalAgentEnvironment(environment) {
    this.goalAgentEnvironment = validEnvironment(environment);
    return this.goalAgentEnvironment;
  },
  syncGoalAgentCatalog(manifests, nowIso = new Date().toISOString()) {
    validEnvironment(this.goalAgentEnvironment);
    return atomic(this, () => {
      for (const manifest of manifests) {
        if (!AGENTS.has(manifest.id)) throw workflowError('goal_agent_unknown', 400);
        syncWorkflowDefinition(this, manifest, nowIso);
      this.db.prepare(`
        UPDATE agents SET version = ?, prompt_version = ?, schema_version = ?,
          task_queue_base = ?, runtime_service = ?, llm_model = ?,
          llm_prompt_template = ?, llm_timeout_ms = ?, source_module = ?,
          metadata_json = metadata_json || ?::jsonb, updated_at_utc = ?
        WHERE id = ?
      `).run(
        manifest.version, manifest.prompt_version, manifest.output_schema_version,
        manifest.queue_base, `brai-agent-${manifest.id.replaceAll('.', '-')}`,
        manifest.default_model ?? '', manifest.prompt ?? '', manifest.timeout_ms,
        `services/brai_goal_agents/manifests/${manifest.id}.json`, JSON.stringify({
          review_only: manifest.review_only,
          decision_kinds: manifest.decision_kinds,
          workflow_type: manifest.workflow_type
        }), nowIso, manifest.id
      );
      }
    })();
  },

  scheduleGoalAgentForActivity({ itemsId, triggerKind, triggerRevision, skipClassifier = false, nowIso }) {
    if (this.goalAgentsEnabled === false) return null;
    const activity = this.getActivityItem(itemsId);
    if (!activity || activity.deleted_at_utc || !activity.item_roles_id || activity.activity_type_id === 'operation') return null;
    if (activity.activity_type_id === 'goal' && activity.status !== 'New') return null;
    const agentId = activity.activity_type_id === 'goal'
      ? 'goal.member-finder'
      : skipClassifier ? 'goal.item-matcher' : 'activity.classifier';
    return ensureExecution(this, {
      agentId, subjectKind: activity.activity_type_id === 'goal' ? 'goal' : 'item',
      subjectId: activity.id, triggerKind, triggerRevision, nowIso
    });
  },

  scheduleGoalAgentForInbox({ inboxId, triggerKind, triggerRevision, nowIso }) {
    if (this.goalAgentsEnabled === false) return null;
    const item = this.getInboxItem(inboxId);
    if (!item?.is_normalized || !item.items_id || item.deleted_at_utc) return null;
    const agentId = item.preliminary_section === 'operation'
      ? 'goal.item-matcher'
      : 'activity.classifier';
    return ensureExecution(this, {
      agentId, subjectKind: 'item', subjectId: item.items_id,
      triggerKind, triggerRevision, nowIso
    });
  },

  scheduleGoalMatcherForCurrent({ itemsId, triggerKind = 'classifier_resolved', triggerRevision, nowIso }) {
    if (this.goalAgentsEnabled === false) return null;
    const activity = this.getActivityItem(itemsId);
    if (activity && !activity.deleted_at_utc && activity.activity_type_id !== 'operation') {
      return this.scheduleGoalAgentForActivity({
        itemsId, triggerKind, triggerRevision, skipClassifier: true, nowIso
      });
    }
    const scopeUser = requireUser();
    const operation = this.db.prepare(`
      SELECT i.id FROM inbox i JOIN item_roles r ON r.id = i.item_roles_id
      WHERE r.items_id = ? AND i.user_id = ? AND i.is_normalized = 1
        AND i.preliminary_section = 'operation' AND i.deleted_at_utc IS NULL
    `).get(itemsId, scopeUser);
    return operation ? this.scheduleGoalAgentForInbox({
      inboxId: operation.id, triggerKind, triggerRevision, nowIso
    }) : null;
  },

  requestGoalPlan({ itemsId, triggerRevision, nowIso }) {
    if (this.goalAgentsEnabled === false) throw workflowError('goal_agents_disabled', 503);
    const goal = this.getActivityItem(itemsId);
    if (!goal || goal.activity_type_id !== 'goal' || goal.deleted_at_utc) {
      throw workflowError('goal_not_found', 404);
    }
    if (goal.status !== 'New') throw workflowError('goal_not_eligible', 409);
    return ensureExecution(this, {
      agentId: 'goal.planner', subjectKind: 'goal', subjectId: goal.id,
      triggerKind: 'explicit_plan_request', triggerRevision, nowIso
    });
  },

  noteGoalDiscoveryChanges({ count = 1, nowIso } = {}) {
    if (this.goalAgentsEnabled === false) return false;
    const userId = requireUser();
    const increment = Math.max(1, Math.min(Number(count) || 1, 1000));
    const now = nowIso ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO context_discovery_watermarks (
        user_id, relevant_sequence, processed_sequence, relevant_change_count,
        first_unprocessed_change_at_utc, last_relevant_change_at_utc, updated_at_utc
      ) VALUES (?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        relevant_sequence = context_discovery_watermarks.relevant_sequence + excluded.relevant_sequence,
        relevant_change_count = context_discovery_watermarks.relevant_change_count + excluded.relevant_change_count,
        first_unprocessed_change_at_utc = CASE
          WHEN context_discovery_watermarks.active_workflow_execution_id IS NOT NULL
            AND context_discovery_watermarks.first_unprocessed_change_at_utc IS NULL
            THEN excluded.first_unprocessed_change_at_utc
          WHEN context_discovery_watermarks.active_workflow_execution_id IS NULL
            AND context_discovery_watermarks.relevant_change_count = 0
            THEN excluded.first_unprocessed_change_at_utc
          ELSE context_discovery_watermarks.first_unprocessed_change_at_utc
        END,
        last_relevant_change_at_utc = excluded.last_relevant_change_at_utc,
        updated_at_utc = excluded.updated_at_utc
    `).run(userId, increment, increment, now, now, now);
  },

  ensureEligibleGoalDiscoveries({ nowIso, limit = 100 } = {}) {
    if (this.goalAgentsEnabled === false) return [];
    const now = nowIso ?? new Date().toISOString();
    const cutoff = new Date(Date.parse(now) - DAY_MS).toISOString();
    const candidates = this.db.prepare(`SELECT user_id FROM context_discovery_watermarks
      WHERE relevant_change_count > 0 AND active_workflow_execution_id IS NULL
        AND (relevant_change_count >= 5 OR COALESCE(first_unprocessed_change_at_utc, last_relevant_change_at_utc) <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM workflow_executions retry
          WHERE retry.user_id = context_discovery_watermarks.user_id
            AND retry.workflow_definition_id = 'goal.discovery'
            AND retry.status = 'failed' AND retry.watermark_to = context_discovery_watermarks.relevant_sequence
            AND retry.next_retry_at_utc > ?
        )
      ORDER BY COALESCE(first_unprocessed_change_at_utc, last_relevant_change_at_utc), user_id LIMIT ?
    `).all(cutoff, now, boundedLimit(limit));
    const executions = [];
    for (const candidate of candidates) {
      const execution = atomic(this, () => {
        const row = this.db.prepare(`SELECT * FROM context_discovery_watermarks
          WHERE user_id = ? AND relevant_change_count > 0 AND active_workflow_execution_id IS NULL
            AND (relevant_change_count >= 5 OR COALESCE(first_unprocessed_change_at_utc, last_relevant_change_at_utc) <= ?)
            AND NOT EXISTS (
              SELECT 1 FROM workflow_executions retry
              WHERE retry.user_id = context_discovery_watermarks.user_id
                AND retry.workflow_definition_id = 'goal.discovery'
                AND retry.status = 'failed' AND retry.watermark_to = context_discovery_watermarks.relevant_sequence
                AND retry.next_retry_at_utc > ?
            )
          FOR UPDATE
        `).get(candidate.user_id, cutoff, now);
        if (!row) return null;
        const claimed = withUserScope(row.user_id, () => ensureExecution(this, {
          agentId: 'goal.discovery', subjectKind: 'user', subjectId: row.user_id,
          triggerKind: 'discovery_watermark', triggerRevision: Number(row.relevant_sequence),
          watermarkFrom: Number(row.processed_sequence) + 1, watermarkTo: Number(row.relevant_sequence), nowIso: now
        }));
        const result = this.db.prepare(`UPDATE context_discovery_watermarks SET active_workflow_execution_id = ?,
            active_range_first_change_at_utc = COALESCE(first_unprocessed_change_at_utc, last_relevant_change_at_utc),
            first_unprocessed_change_at_utc = NULL, updated_at_utc = ?
          WHERE user_id = ? AND active_workflow_execution_id IS NULL
        `).run(claimed.id, now, row.user_id);
        if (result.changes !== 1) throw workflowError('discovery_claim_conflict', 409);
        return claimed;
      })();
      if (execution) executions.push(execution);
    }
    return executions;
  },

  listQueuedGoalAgentExecutions({ limit = 100, nowIso } = {}) {
    if (this.goalAgentsEnabled === false) return [];
    const now = nowIso ?? new Date().toISOString();
    const environment = validEnvironment(this.goalAgentEnvironment);
    return this.db.prepare(`
      SELECT * FROM workflow_executions
      WHERE workflow_definition_id IN (
        'activity.classifier','goal.item-matcher','goal.member-finder','goal.discovery','goal.planner'
      ) AND deployment_environment = ? AND status = 'queued'
        AND (next_retry_at_utc IS NULL OR next_retry_at_utc <= ?)
      ORDER BY created_at_utc, id LIMIT ?
    `).all(environment, now, boundedLimit(limit)).map(formatExecution);
  },

  listRunningGoalAgentExecutions({ limit = 100, nowIso } = {}) {
    if (this.goalAgentsEnabled === false) return [];
    const now = nowIso ?? new Date().toISOString();
    const environment = validEnvironment(this.goalAgentEnvironment);
    return this.db.prepare(`
      SELECT * FROM workflow_executions
      WHERE workflow_definition_id IN (
        'activity.classifier','goal.item-matcher','goal.member-finder','goal.discovery','goal.planner'
      ) AND deployment_environment = ? AND status = 'running'
        AND (next_retry_at_utc IS NULL OR next_retry_at_utc <= ?)
      ORDER BY updated_at_utc, id LIMIT ?
    `).all(environment, now, boundedLimit(limit)).map(formatExecution);
  },

  markGoalAgentExecutionStarted({ executionId, runId, nowIso }) {
    const now = nowIso ?? new Date().toISOString();
    return this.db.prepare(`
      UPDATE workflow_executions SET run_id = ?, status = 'running', current_step = 'dispatch',
        attempt_count = CASE WHEN status = 'queued' THEN attempt_count + 1 ELSE attempt_count END,
        started_at_utc = COALESCE(started_at_utc, ?),
        last_error = NULL, next_retry_at_utc = NULL, transport_failure_count = 0,
        updated_at_utc = ? WHERE id = ? AND status IN ('queued','running') AND (run_id IS NULL OR run_id = ?)
    `).run(runId, now, now, executionId, runId).changes > 0;
  },
  persistGoalAgentLlmCalls({ executionId, result, nowIso }) {
    const now = nowIso ?? new Date().toISOString();
    const execution = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId);
    if (!execution) throw workflowError('workflow_execution_not_found', 404);
    const manifest = parseJsonObject(execution.contract_json);
    if (!manifest.id) throw workflowError('goal_agent_not_registered', 503);
    if (!execution.contract_hash || goalAgentStableHash(manifest) !== execution.contract_hash) {
      throw workflowError('agent_execution_contract_integrity_failed', 409);
    }
    return persistLlmCalls(this, execution, manifest, result, now);
  },
  completeGoalAgentExecution({ executionId, result, nowIso }) {
    const now = nowIso ?? new Date().toISOString();
    const execution = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId);
    if (!execution) throw workflowError('workflow_execution_not_found', 404);
    if (TERMINAL.has(execution.status)) return formatExecution(execution);
    const manifest = parseJsonObject(execution.contract_json);
    if (!manifest.id) throw workflowError('goal_agent_not_registered', 503);
    if (!execution.contract_hash || goalAgentStableHash(manifest) !== execution.contract_hash) {
      return finishGoalAgentFailure(this, {
        executionId, reason: 'agent_execution_contract_integrity_failed', now
      });
    }
    try {
      assertLlmCallsPersisted(this, execution, manifest, result);
    } catch (error) {
      if (!isDeterministicPersistenceError(error)) throw error;
      return finishGoalAgentFailure(this, {
        executionId, reason: persistenceReason('agent_llm_log_verification_failed', error), now,
        result: terminalResult(result, error, 'verify_ai_logs')
      });
    }
    try {
      assertAgentResultEnvelope(result, manifest, {
        workflow_id: execution.workflow_id,
        run_id: execution.run_id
      });
    } catch (error) {
      return finishGoalAgentFailure(this, {
        executionId,
        reason: `agent_result_contract_invalid:${error?.message ?? error?.code ?? 'invalid'}`,
        now, result: terminalResult(result, error, 'validate_result')
      });
    }
    if (result.status !== 'completed') return finishGoalAgentFailure(this, {
      executionId, reason: result.error?.code ?? 'agent_failed', now,
      result: terminalResult(result, result.error, 'invoke_agent')
    });
    try {
      return this.db.transaction(() => {
        const locked = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ? FOR UPDATE').get(executionId);
        if (TERMINAL.has(locked.status)) return formatExecution(locked);
        const decisions = Array.isArray(result.decisions) ? result.decisions : [];
        const context = validateGoalAgentResultContext(this, formatExecution(locked), decisions);
        if (!context.valid) {
          failExecution(this, locked, 'agent_result_reference_invalid', now, {
            result: terminalResult(result, { code: 'agent_result_reference_invalid' }, 'validate_context')
          });
          return formatExecution(this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(locked.id));
        }
        const recorded = [];
        for (const decision of decisions) {
          if (isNoChange(this, decision)) continue;
          recorded.push(this.recordContextDecision({
            agentId: result.agent_id,
            agentVersion: result.agent_version,
            promptVersion: result.prompt_version,
            model: result.model,
            schemaVersion: result.output_schema_version,
            decisionKind: decision.decision_kind,
            triggerItemsId: locked.subject_kind === 'user' ? null : decision.subject_items_id,
            triggerRevision: locked.trigger_revision,
            confidence: decision.confidence,
            rationale: decision.rationale,
            evidence: decision.evidence,
            proposal: decision.proposal,
            workflowExecutionId: locked.id,
            workflowId: locked.workflow_id,
            runId: locked.run_id,
            attemptNumber: result.workflow_attempt,
            staleContext: context.stale,
            nowIso: now
          }).decision);
        }
        this.db.prepare(`
          UPDATE workflow_executions SET status = 'completed', current_step = 'persist_decisions',
            result_json = ?::jsonb, last_error = NULL, completed_at_utc = ?, updated_at_utc = ?,
            trace_status = 'complete' WHERE id = ?
        `).run(JSON.stringify({ ...result, decisions: recorded }), now, now, locked.id);
        if (context.stale) {
          scheduleFreshGoalAgentAnalysis(this, locked, now);
        } else if (locked.workflow_definition_id === 'goal.discovery') {
          advanceDiscovery(this, locked, now);
        } else if (locked.workflow_definition_id === 'activity.classifier') {
          const pending = recorded.some((decision) => decision.status === 'pending');
          if (!pending) this.scheduleGoalMatcherForCurrent({
            itemsId: locked.subject_id,
            triggerKind: 'classifier_resolved',
            triggerRevision: locked.trigger_revision,
            nowIso: now
          });
        }
        return formatExecution(this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(locked.id));
      })();
    } catch (error) {
      if (!isDeterministicPersistenceError(error)) throw error;
      return finishGoalAgentFailure(this, {
        executionId, status: 'needs_review', currentStep: 'persist_decisions',
        reason: persistenceReason('decision_apply_failed', error), now,
        result: terminalResult(result, error, 'persist_decisions')
      });
    }
  },
  failGoalAgentExecution({ executionId, reason, nowIso }) {
    const now = nowIso ?? new Date().toISOString();
    const execution = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId);
    if (!execution || TERMINAL.has(execution.status)) return false;
    failExecution(this, execution, reason, now);
    return true;
  },
  noteGoalAgentTransportFailure({ executionId, reason, nowIso }) {
    const now = nowIso ?? new Date().toISOString();
    const execution = this.db.prepare(`
      SELECT id, status, transport_failure_count FROM workflow_executions WHERE id = ?
    `).get(executionId);
    if (!execution || !['queued', 'running'].includes(execution.status)) return null;
    const failures = Math.min(Number(execution.transport_failure_count ?? 0) + 1, 30);
    const delaySeconds = Math.min(300, 2 ** Math.min(failures, 8));
    const nextRetry = new Date(Date.parse(now) + delaySeconds * 1000).toISOString();
    this.db.prepare(`
      UPDATE workflow_executions SET transport_failure_count = ?, next_retry_at_utc = ?,
        last_error = ?, updated_at_utc = ? WHERE id = ? AND status IN ('queued','running')
    `).run(failures, nextRetry, String(reason ?? 'temporal_transport_failure').slice(0, 1000), now, executionId);
    return { failure_count: failures, next_retry_at_utc: nextRetry };
  }
};

function ensureExecution(store, input) {
  if (store.goalAgentsEnabled === false) return null;
  const userId = requireUser();
  if (!AGENTS.has(input.agentId)) throw workflowError('goal_agent_unknown', 400);
  const agent = store.getAgent(input.agentId);
  if (!agent) throw workflowError('goal_agent_not_registered', 503);
  const definitionVersion = Number(agent.version);
  if (!Number.isInteger(definitionVersion) || definitionVersion < 1) {
    throw workflowError('goal_agent_definition_version_invalid', 503);
  }
  const contract = loadVersionedContract(store, input.agentId, definitionVersion);
  if (!contract) throw workflowError('goal_agent_contract_missing', 503);
  const environment = validEnvironment(store.goalAgentEnvironment);
  const now = input.nowIso ?? new Date().toISOString();
  const revision = nonNegative(input.triggerRevision);
  const workflowId = stableWorkflowId({
    environment, agentId: input.agentId, userId, subjectId: input.subjectId,
    triggerKind: input.triggerKind, definitionVersion,
    revision: revision ?? input.watermarkTo ?? 0
  });
  const contextCapability = randomBytes(32).toString('base64url');
  const payload = {
    ...buildGoalAgentInput(store, { ...input, userId, agent }),
    execution_contract: {
      context_capability: contextCapability,
      context_worker_build_id: contextDeploymentVersion(environment).buildId
    }
  };
  const contractHash = goalAgentStableHash(contract);
  const row = store.db.prepare(`
    INSERT INTO workflow_executions (
      workflow_definition_id, workflow_definition_version, workflow_id, run_id,
      role_contract_id, raw_record_id, subject_kind, subject_id, trigger_kind,
      trigger_revision, watermark_from, watermark_to, status, current_step,
      attempt_count, created_at_utc, updated_at_utc, user_id, trace_status,
      deployment_environment, input_json, contract_json, contract_hash, context_capability_hash
    ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, 'queued', 'dispatch',
      0, ?, ?, ?, 'recording', ?, ?::jsonb, ?::jsonb, ?, ?)
    ON CONFLICT (workflow_id) DO UPDATE SET
      run_id = CASE WHEN workflow_executions.status = 'failed' THEN NULL ELSE workflow_executions.run_id END,
      status = CASE WHEN workflow_executions.status = 'failed' THEN 'queued' ELSE workflow_executions.status END,
      current_step = CASE WHEN workflow_executions.status = 'failed' THEN 'dispatch' ELSE workflow_executions.current_step END,
      last_error = CASE WHEN workflow_executions.status = 'failed' THEN NULL ELSE workflow_executions.last_error END,
      completed_at_utc = CASE WHEN workflow_executions.status = 'failed' THEN NULL ELSE workflow_executions.completed_at_utc END,
      result_json = CASE WHEN workflow_executions.status = 'failed' THEN NULL ELSE workflow_executions.result_json END,
      next_retry_at_utc = CASE WHEN workflow_executions.status = 'failed' THEN NULL ELSE workflow_executions.next_retry_at_utc END,
      transport_failure_count = CASE WHEN workflow_executions.status = 'failed' THEN 0 ELSE workflow_executions.transport_failure_count END,
      input_json = CASE WHEN workflow_executions.status = 'failed' THEN excluded.input_json ELSE workflow_executions.input_json END,
      context_capability_hash = CASE WHEN workflow_executions.status = 'failed' THEN excluded.context_capability_hash ELSE workflow_executions.context_capability_hash END,
      updated_at_utc = CASE WHEN workflow_executions.status = 'failed' THEN excluded.updated_at_utc ELSE workflow_executions.updated_at_utc END
    WHERE workflow_executions.user_id = excluded.user_id
    RETURNING *
  `).get(
    input.agentId, definitionVersion, workflowId, input.subjectKind, input.subjectId, input.triggerKind,
    revision, input.watermarkFrom ?? null, input.watermarkTo ?? null,
    now, now, userId, environment, JSON.stringify(payload), JSON.stringify(contract), contractHash, goalAgentStableHash(contextCapability)
  );
  if (!row) throw workflowError('workflow_id_conflict', 409);
  return formatExecution(row);
}

function advanceDiscovery(store, execution, now) {
  store.db.prepare(`
    UPDATE context_discovery_watermarks SET
      processed_sequence = GREATEST(processed_sequence, ?),
      relevant_change_count = GREATEST(0, relevant_sequence - GREATEST(processed_sequence, ?)),
      first_unprocessed_change_at_utc = CASE
        WHEN relevant_sequence - GREATEST(processed_sequence, ?) <= 0 THEN NULL
        ELSE COALESCE(first_unprocessed_change_at_utc, last_relevant_change_at_utc)
      END,
      active_range_first_change_at_utc = NULL,
      active_workflow_execution_id = NULL, updated_at_utc = ?
    WHERE user_id = ? AND active_workflow_execution_id = ?
  `).run(execution.watermark_to, execution.watermark_to, execution.watermark_to,
    now, execution.user_id, execution.id);
}

export function scheduleFreshGoalAgentAnalysis(store, execution, now) {
  if (store.goalAgentsEnabled === false) return;
  const revision = Math.max(
    store.getActivityServerRevision(),
    store.getInboxServerRevision(),
    store.getRelationServerRevision()
  );
  if (execution.workflow_definition_id === 'goal.discovery') {
    const watermark = store.db.prepare(`SELECT active_workflow_execution_id
      FROM context_discovery_watermarks WHERE user_id = ? FOR UPDATE`).get(execution.user_id);
    if (!watermark || (watermark.active_workflow_execution_id
      && watermark.active_workflow_execution_id !== execution.id)) return;
    store.db.prepare(`
      UPDATE context_discovery_watermarks SET active_workflow_execution_id = NULL, updated_at_utc = ?
      WHERE user_id = ? AND active_workflow_execution_id = ?
    `).run(now, execution.user_id, execution.id);
    const fresh = ensureExecution(store, {
      agentId: 'goal.discovery', subjectKind: 'user', subjectId: execution.user_id,
      triggerKind: 'stale_context_refresh', triggerRevision: revision,
      watermarkFrom: execution.watermark_from, watermarkTo: execution.watermark_to,
      nowIso: now
    });
    store.db.prepare(`
      UPDATE context_discovery_watermarks SET active_workflow_execution_id = ?, updated_at_utc = ?
      WHERE user_id = ? AND active_workflow_execution_id IS NULL
    `).run(fresh.id, now, execution.user_id);
    return;
  }
  if (execution.workflow_definition_id === 'goal.planner') {
    const goal = store.getActivityItem(execution.subject_id);
    if (goal?.activity_type_id === 'goal' && !goal.deleted_at_utc && goal.status === 'New') ensureExecution(store, {
      agentId: 'goal.planner', subjectKind: 'goal', subjectId: goal.id,
      triggerKind: 'stale_context_refresh', triggerRevision: revision, nowIso: now
    });
    return;
  }
  if (execution.workflow_definition_id === 'activity.classifier') {
    const inboxId = execution.input_json?.snapshot?.subject?.inbox_id;
    if (inboxId) {
      store.scheduleGoalAgentForInbox({
        inboxId, triggerKind: 'stale_context_refresh', triggerRevision: revision, nowIso: now
      });
    } else {
      store.scheduleGoalAgentForActivity({
        itemsId: execution.subject_id,
        triggerKind: 'stale_context_refresh', triggerRevision: revision, nowIso: now
      });
    }
    return;
  }
  store.scheduleGoalMatcherForCurrent({
    itemsId: execution.subject_id,
    triggerKind: 'stale_context_refresh', triggerRevision: revision, nowIso: now
  });
}
function isNoChange(store, decision) {
  if (decision?.decision_kind !== 'activity_type_change') return false;
  if (decision?.proposal?.target_type === 'no_change') return true;
  if (decision?.proposal?.target_type !== 'action') return false;
  return store.getActivityItem(decision.subject_items_id)?.activity_type_id === 'action';
}
function validEnvironment(value) {
  const environment = sanitizeText(value) ?? 'prod';
  if (!/^(prod|dev|preview-[a-e])$/.test(environment)) throw workflowError('invalid_environment', 500);
  return environment;
}
function nonNegative(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}
function boundedLimit(value) {
  return Math.max(1, Math.min(Number(value) || 100, 500));
}
function requireUser() {
  const userId = sanitizeText(scopedUserId());
  if (!userId) throw workflowError('unauthorized', 401);
  return userId;
}
function atomic(store, fn) {
  return store.db.currentTxId ? fn : store.db.transaction(fn);
}
function workflowError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
