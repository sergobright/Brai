import assert from 'node:assert/strict';
import test from 'node:test';
import { IllegalStateError } from '@temporalio/worker';
import { createFixture, request } from '../test-support/api.js';
import { goalAgentsEnabledFromEnv } from '../src/goal-agent-switch.js';
import {
  createGoalAgentWorkflowRuntime,
  shutdownGoalAgentWorker
} from '../src/goal-agent-workflow-runtime.js';
import { withUserScope } from '../src/user-scope.js';

const OWNER = 'goal-agent-disable-owner';
const NOW = '2026-07-13T19:00:00.000Z';

test('Goal-agent shutdown tolerates a Temporal worker already draining', () => {
  assert.doesNotThrow(() => shutdownGoalAgentWorker({
    shutdown() {
      throw new IllegalStateError('Not running. Current state: DRAINING');
    }
  }));
  assert.throws(() => shutdownGoalAgentWorker({
    shutdown() {
      throw new Error('unexpected shutdown failure');
    }
  }), /unexpected shutdown failure/);
});

test('disabled Goal-agent runtime is a no-op before database or Temporal connections', async () => {
  assert.equal(goalAgentsEnabledFromEnv(''), true);
  assert.equal(goalAgentsEnabledFromEnv('true'), true);
  for (const value of ['0', 'false', 'NO', 'off']) assert.equal(goalAgentsEnabledFromEnv(value), false);

  const runtime = await createGoalAgentWorkflowRuntime({
    databaseUrl: 'not-a-postgres-url', environment: 'preview-a', enabled: false
  });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.environment, 'preview-a');
  assert.deepEqual(runtime.manifests, []);
  assert.equal(await runtime.recoverQueued(), 0);
  assert.equal(runtime.startReconciler(), false);
  await runtime.close();
});

test('disabled store triggers preserve queued work and watermarks while manual Relations remain available', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedActivity(fixture.store, 'disable-existing-action', 'action');
      seedActivity(fixture.store, 'disable-new-action', 'action');
      seedActivity(fixture.store, 'disable-goal', 'goal');
    });
    const queued = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'disable-existing-action', triggerKind: 'activity_created',
      triggerRevision: 1, nowIso: NOW
    }));
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 2, nowIso: NOW }));
    const watermarkBefore = fixture.store.db.prepare(`
      SELECT relevant_sequence, processed_sequence, relevant_change_count, updated_at_utc
      FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER);
    const executionCount = fixture.store.db.prepare('SELECT count(*)::int AS count FROM workflow_executions').get().count;

    fixture.store.goalAgentsEnabled = false;
    assert.equal(owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'disable-new-action', triggerKind: 'activity_created',
      triggerRevision: 2, nowIso: NOW
    })), null);
    assert.equal(owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 10, nowIso: NOW })), false);
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW }), []);
    assert.deepEqual(fixture.store.listQueuedGoalAgentExecutions({ nowIso: NOW }), []);
    assert.throws(() => owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'disable-goal', triggerRevision: 2, nowIso: NOW
    })), (error) => error.code === 'goal_agents_disabled' && error.status === 503);

    const relation = owner(fixture, () => fixture.store.createRelation({
      id: 'disable-manual-relation', relationTypeId: 'part_of',
      sourceItemsId: 'disable-new-action', targetItemsId: 'disable-goal',
      operationId: 'disable-manual-operation', actorType: 'user', nowIso: NOW
    }));
    assert.equal(relation.relation.id, 'disable-manual-relation');
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status FROM workflow_executions WHERE id = ?
    `).get(queued.id), { status: 'queued' });
    assert.equal(fixture.store.db.prepare('SELECT count(*)::int AS count FROM workflow_executions').get().count, executionCount);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT relevant_sequence, processed_sequence, relevant_change_count, updated_at_utc
      FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER), watermarkBefore);
  } finally {
    await fixture.close();
  }
});

test('disabled server returns 503 for explicit planning but keeps manual Relation HTTP working', async () => {
  const fixture = await createFixture([NOW], { goalAgentsEnabled: false });
  try {
    claimOwner(fixture);
    const manualGoal = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'disable-http-activity', platform: 'web' },
        events: [{
          event_id: 'disable-http-goal-create', client_sequence: 1,
          change_type: 'create', activity_id: 'disable-http-manual-goal',
          occurred_at_utc: NOW,
          payload: { title: 'Manual Goal while disabled', activity_type_id: 'goal' }
        }]
      })
    });
    assert.equal(manualGoal.status, 200, JSON.stringify(manualGoal.body));
    assert.equal(manualGoal.body.state.goals.some((goal) => goal.id === 'disable-http-manual-goal'), true);
    owner(fixture, () => {
      seedActivity(fixture.store, 'disable-http-action', 'action');
      seedActivity(fixture.store, 'disable-http-goal', 'goal');
    });

    const plan = await request(fixture.url, '/v1/goals/disable-http-goal/plan', { method: 'POST' });
    assert.equal(plan.status, 503);
    assert.deepEqual(plan.body, { error: 'goal_agents_disabled' });

    const relation = await request(fixture.url, '/v1/relations/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'disable-http-device', platform: 'web' },
        events: [{
          event_id: 'disable-http-event', client_sequence: 1, change_type: 'create',
          relation_id: 'disable-http-relation', occurred_at_utc: NOW,
          base_server_revision: 0, payload_version: 1,
          payload: {
            relation_type_id: 'part_of', source_items_id: 'disable-http-action',
            target_items_id: 'disable-http-goal'
          }
        }]
      })
    });
    assert.equal(relation.status, 200, JSON.stringify(relation.body));
    assert.deepEqual(relation.body.state.relations.map((item) => item.id), ['disable-http-relation']);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT workflow_definition_id, subject_kind, subject_id, trigger_kind, status
      FROM workflow_executions
      WHERE workflow_definition_id IN (
        'activity.classifier','goal.item-matcher','goal.member-finder','goal.discovery','goal.planner')
    `).all(), []);
    assert.equal(fixture.store.db.prepare('SELECT count(*)::int AS count FROM context_discovery_watermarks').get().count, 0);
  } finally {
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Goal Agent Disable Owner', 'goal-agent-disable@example.test', true, now(), now())
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
  store.ensureActivityRoleLink({
    id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW
  });
}
