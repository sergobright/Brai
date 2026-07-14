import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import {
  createGoalAgentReconciler,
  goalAgentExecutionReference,
  loadGoalAgentManifests
} from '../src/goal-agent-workflow-runtime.js';
import { withUserScope } from '../src/user-scope.js';
import { agentDeploymentVersion } from '../../brai_goal_agents/src/versioning.mjs';

const OWNER = 'goal-reconciler-owner';
const NOW = '2026-07-13T18:00:00.000Z';

test('reconciler isolates one queue dispatch failure and preserves exact Temporal contracts', async () => {
  const fixture = await createFixture([NOW]);
  const errors = [];
  let reconciler;
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    const manifestList = await loadGoalAgentManifests();
    fixture.store.syncGoalAgentCatalog(manifestList, NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'reconcile-action', 'action');
      seedActivity(fixture.store, 'reconcile-goal', 'goal');
    });
    const classifier = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'reconcile-action', triggerKind: 'activity_created',
      triggerRevision: 1, nowIso: NOW
    }));
    const planner = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'reconcile-goal', triggerRevision: 1, nowIso: NOW
    }));
    const manifests = new Map(manifestList.map((manifest) => [manifest.id, manifest]));
    const started = [];
    const handles = new Map();
    let clock = NOW;
    const pendingResult = new Promise(() => {});
    const client = {
      workflow: {
        async start(workflowType, options) {
          started.push({ workflowType, options });
          if (options.workflowId === planner.workflow_id) throw new Error('planner_temporal_unavailable');
          const handle = {
            firstExecutionRunId: `run:${options.workflowId}`,
            result: () => pendingResult,
            describe: async () => ({ runId: `run:${options.workflowId}`, status: { name: 'RUNNING' } })
          };
          handles.set(options.workflowId, handle);
          return handle;
        },
        getHandle(workflowId) {
          return handles.get(workflowId) ?? {
            result: () => pendingResult,
            describe: async () => ({ runId: `run:${workflowId}`, status: { name: 'RUNNING' } })
          };
        }
      }
    };
    reconciler = createGoalAgentReconciler({
      store: fixture.store, client, manifests, environment: 'preview-c',
      now: () => new Date(clock), logger: { error: (...args) => errors.push(args) }
    });

    assert.equal(await reconciler.run(), 1);
    const classifierRow = fixture.store.db.prepare(`
      SELECT status, run_id, attempt_count FROM workflow_executions WHERE id = ?
    `).get(classifier.id);
    assert.equal(classifierRow.status, 'running');
    assert.equal(classifierRow.run_id, `run:${classifier.workflow_id}`);
    assert.equal(classifierRow.attempt_count, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT status, transport_failure_count, next_retry_at_utc FROM workflow_executions WHERE id = ?
    `).get(planner.id).transport_failure_count, 1);
    const classifierStart = started.find((entry) => entry.options.workflowId === classifier.workflow_id);
    assert.equal(classifierStart.workflowType, manifests.get('activity.classifier').workflow_type);
    assert.equal(classifierStart.options.taskQueue, 'brai-agent-activity-classifier-preview-c');
    assert.equal(classifierStart.options.workflowIdConflictPolicy, 'USE_EXISTING');
    assert.equal(classifierStart.options.workflowIdReusePolicy, 'ALLOW_DUPLICATE_FAILED_ONLY');
    const classifierDeployment = agentDeploymentVersion(
      manifests.get('activity.classifier'), 'preview-c'
    );
    assert.deepEqual(classifierStart.options.versioningOverride, {
      pinnedTo: classifierDeployment
    });
    assert.deepEqual(classifierStart.options.args, [
      goalAgentExecutionReference(classifier, manifests.get('activity.classifier'), 'preview-c')
    ]);
    assert.equal('workflowExecutionTimeout' in classifierStart.options, false);
    assert.equal(errors.some(([message, details]) =>
      message === 'Queued Goal agent workflow dispatch failed'
      && details.workflowId === planner.workflow_id
      && details.error === 'planner_temporal_unavailable'), true);

    assert.equal(await reconciler.run(), 0);
    assert.equal(fixture.store.db.prepare(`
      SELECT status FROM workflow_executions WHERE id = ?
    `).get(classifier.id).status, 'running');
    assert.equal(fixture.store.db.prepare(`
      SELECT status FROM workflow_executions WHERE id = ?
    `).get(planner.id).status, 'queued');
    assert.equal(started.filter((entry) => entry.options.workflowId === planner.workflow_id).length, 1);
    clock = new Date(Date.parse(NOW) + 3_000).toISOString();
    assert.equal(await reconciler.run(), 0);
    assert.equal(started.filter((entry) => entry.options.workflowId === planner.workflow_id).length, 2);
  } finally {
    await reconciler?.close();
    await fixture.close();
  }
});

test('poller observation writes one environment-qualified heartbeat per agent queue', async () => {
  const fixture = await createFixture([NOW]);
  let reconciler;
  try {
    claimOwner(fixture);
    const manifestList = await loadGoalAgentManifests();
    const manifests = new Map(manifestList.map((manifest) => [manifest.id, manifest]));
    const described = [];
    const connection = {
      workflowService: {
        async describeTaskQueue(input) {
          described.push(input);
          return {
            pollers: [{
              identity: `worker:${input.taskQueue.name}`,
              lastAccessTime: { seconds: Math.floor(Date.parse(NOW) / 1000), nanos: 0 },
              deploymentOptions: { deploymentVersion: { buildId: 'preview-build' } }
            }]
          };
        }
      }
    };
    reconciler = createGoalAgentReconciler({
      store: fixture.store,
      client: { workflow: { start: async () => { throw new Error('unused'); }, getHandle: () => null } },
      connection, manifests, environment: 'preview-c', namespace: 'test-namespace',
      now: () => new Date(NOW), logger: { error: () => {} }
    });
    await reconciler.observePollers();
    assert.equal(described.length, 12);
    assert.equal(described.every((entry) => entry.namespace === 'test-namespace'), true);
    assert.equal(described.every((entry) => entry.taskQueue.name.endsWith('-preview-c')), true);
    assert.deepEqual(new Set(described.map((entry) => entry.taskQueueType)), new Set([1, 2]));
    const heartbeats = fixture.store.db.prepare(`
      SELECT task_queue, worker_identity, build_ref, metadata_json
      FROM workflow_worker_heartbeats
      WHERE task_queue LIKE '%-preview-c' ORDER BY task_queue
    `).all();
    assert.equal(heartbeats.length, 6);
    assert.equal(heartbeats.every((row) => row.worker_identity === `worker:${row.task_queue}`), true);
    assert.equal(heartbeats.every((row) => row.build_ref === 'preview-build'), true);
    assert.equal(heartbeats.every((row) => row.metadata_json.deployment_environment === 'preview-c'), true);
    assert.equal(heartbeats.every((row) => row.metadata_json.observed_by === 'brai-api'), true);
    assert.equal(heartbeats.every((row) => row.metadata_json.poller_types.length === 2), true);
  } finally {
    await reconciler?.close();
    await fixture.close();
  }
});

test('a provider-reported workflow failure cannot leave a discovery execution running or retry immediately', async () => {
  const fixture = await createFixture([NOW]);
  let reconciler;
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    const manifestList = await loadGoalAgentManifests();
    fixture.store.syncGoalAgentCatalog(manifestList, NOW);
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 5, nowIso: NOW }));
    const [execution] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW });
    const failure = {
      type: 'GoalAgentResultFailure',
      details: [{ status: 'failed', error: { code: 'llm_failed' } }]
    };
    const handle = {
      firstExecutionRunId: 'failed-run',
      result: async () => { throw failure; },
      describe: async () => ({ runId: 'failed-run', status: { name: 'FAILED' } })
    };
    reconciler = createGoalAgentReconciler({
      store: fixture.store,
      client: {
        workflow: {
          start: async () => handle,
          getHandle: () => handle
        }
      },
      manifests: new Map(manifestList.map((manifest) => [manifest.id, manifest])),
      environment: 'preview-c',
      now: () => new Date(NOW),
      logger: { error: () => {} }
    });

    assert.equal(await reconciler.run(), 1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const row = fixture.store.db.prepare(`
      SELECT status, last_error, next_retry_at_utc FROM workflow_executions WHERE id = ?
    `).get(execution.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, 'llm_failed');
    assert.equal(row.next_retry_at_utc, new Date(Date.parse(NOW) + 60_000).toISOString());
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW }), []);
  } finally {
    await reconciler?.close();
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Goal Reconciler Owner', 'goal-reconciler@example.test', true, now(), now())
  `).run(OWNER);
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(OWNER, NOW);
}

function owner(fixture, callback) {
  return withUserScope(OWNER, callback);
}

function seedActivity(store, id, type) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, type, id, NOW, NOW, OWNER);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW });
}
