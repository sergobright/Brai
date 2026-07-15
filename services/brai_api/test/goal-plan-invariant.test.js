import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFixture, request } from '../test-support/api.js';
import {
  NOW, claimOwner, evidence, owner, persistAndComplete, plusHours, resultFor, seedActivity
} from './goal-agent-test-support.js';

test('Goal plan retry reuses queued, running, and pending work across Activity revisions', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedActivity(fixture.store, 'plan-retry-goal', 'goal'));
    const queued = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 1, nowIso: NOW
    }));
    const queuedRetry = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 99, nowIso: plusHours(1)
    }));
    assert.equal(queuedRetry.id, queued.id);

    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: queued.id, runId: 'plan-retry-run', nowIso: NOW
    }));
    const runningRetry = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 100, nowIso: plusHours(1)
    }));
    assert.equal(runningRetry.id, queued.id);

    const decision = completePlan(fixture, queued, 'retry');
    assert.equal(decision.status, 'pending');
    const pendingRetry = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 101, nowIso: plusHours(2)
    }));
    assert.equal(pendingRetry.id, queued.id);

    owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: decision.id, action: 'reject', resolutionKey: 'plan-retry:reject', nowIso: plusHours(3)
    }));
    const afterReject = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 101, nowIso: plusHours(3)
    }));
    assert.notEqual(afterReject.id, queued.id);

    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: afterReject.id, runId: 'plan-accept-run', nowIso: plusHours(3)
    }));
    const acceptedDecision = completePlan(fixture, afterReject, 'accept');
    owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: acceptedDecision.id,
      action: 'accept',
      resolutionKey: 'plan-retry:accept',
      editedPayload: planProposal('plan-retry-goal'),
      nowIso: plusHours(4)
    }));
    const afterAccept = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-retry-goal', triggerRevision: 101, nowIso: plusHours(4)
    }));
    assert.notEqual(afterAccept.id, afterReject.id);
  } finally {
    await fixture.close();
  }
});

test('Concurrent Goal plan HTTP requests create one active execution', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedActivity(fixture.store, 'plan-concurrency-goal', 'goal'));
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(
      fixture.url, '/v1/goals/plan-concurrency-goal/plan', { method: 'POST' }
    )));
    assert.equal(responses.every(({ status }) => status === 202), true);
    assert.equal(new Set(responses.map(({ body }) => body.execution_id)).size, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM workflow_executions
      WHERE workflow_definition_id = 'goal.planner' AND subject_id = 'plan-concurrency-goal'
        AND status IN ('queued','running')
    `).get().count, 1);
  } finally {
    await fixture.close();
  }
});

test('Preview planning does not reuse a cloned queued Production execution', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedActivity(fixture.store, 'plan-environment-goal', 'goal'));
    fixture.store.configureGoalAgentEnvironment('prod');
    const production = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-environment-goal', triggerRevision: 1, nowIso: NOW
    }));
    fixture.store.configureGoalAgentEnvironment('preview-a');
    const preview = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-environment-goal', triggerRevision: 1, nowIso: plusHours(1)
    }));
    const previewRetry = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-environment-goal', triggerRevision: 2, nowIso: plusHours(2)
    }));
    assert.notEqual(preview.id, production.id);
    assert.equal(previewRetry.id, preview.id);
  } finally {
    await fixture.close();
  }
});

test('0031 keeps the newest pending Goal plan and protects the invariant', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  try {
    claimOwner(fixture);
    owner(fixture, () => seedActivity(fixture.store, 'plan-migration-goal', 'goal'));
    fixture.store.db.prepare('DROP INDEX idx_context_decisions_pending_goal_plan').run();
    const execution = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'plan-migration-goal', triggerRevision: 1, nowIso: NOW
    }));
    const older = owner(fixture, () => recordPlan(fixture, 1, NOW));
    const newest = owner(fixture, () => recordPlan(fixture, 2, plusHours(1)));
    fixture.store.db.prepare(`
      UPDATE context_decisions SET workflow_execution_id = ?, workflow_id = ? WHERE id IN (?, ?)
    `).run(execution.id, execution.workflow_id, older.id, newest.id);
    const orphan = owner(fixture, () => recordPlan(fixture, 3, plusHours(2)));
    const migration = fs.readFileSync(path.resolve(
      import.meta.dirname, '../../../supabase/migrations/0031_pending_goal_plan_invariant.sql'
    ), 'utf8');
    await pool.query(migration);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT id, status FROM context_decisions WHERE id IN (?, ?) ORDER BY created_at_utc
    `).all(older.id, newest.id), [
      { id: older.id, status: 'stale_context' },
      { id: newest.id, status: 'pending' }
    ]);
    assert.equal(fixture.store.db.prepare('SELECT status FROM context_decisions WHERE id = ?').get(orphan.id).status, 'stale_context');
    const index = (await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'idx_context_decisions_pending_goal_plan'
    `)).rows[0]?.indexdef;
    assert.match(index, /UNIQUE/);
    assert.throws(() => owner(fixture, () => recordPlan(fixture, 4, plusHours(3))), /unique|duplicate/i);
    await pool.query(migration);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE version = 67')).rows[0].count, 1);
  } finally {
    await pool.end();
    await fixture.close();
  }
});

function completePlan(fixture, execution, suffix) {
  return owner(fixture, () => persistAndComplete(fixture.store, {
    executionId: execution.id,
    result: resultFor(fixture.store, 'goal.planner', {
      llmCalls: [{ llm_call_id: `plan-${suffix}-call`, status: 'completed' }],
      decisions: [{
        decision_kind: 'goal_plan', subject_items_id: 'plan-retry-goal', confidence: 1,
        rationale: 'Проверка инварианта плана', evidence: [evidence('plan-retry-goal')],
        proposal: planProposal('plan-retry-goal')
      }]
    }),
    nowIso: plusHours(2)
  })).result_json.decisions[0];
}

function recordPlan(fixture, revision, nowIso) {
  const agent = fixture.store.getAgent('goal.planner');
  return fixture.store.recordContextDecision({
    agentId: agent.id,
    agentVersion: agent.version,
    promptVersion: agent.prompt_version,
    model: 'test-model',
    schemaVersion: agent.schema_version,
    decisionKind: 'goal_plan',
    triggerItemsId: 'plan-migration-goal',
    triggerRevision: revision,
    confidence: 1,
    rationale: 'Migration fixture',
    evidence: [evidence('plan-migration-goal')],
    proposal: { ...planProposal('plan-migration-goal'), revision },
    nowIso
  }).decision;
}

function planProposal(goalItemsId) {
  return {
    goal_items_id: goalItemsId,
    steps: [
      { title: 'Первый шаг', description_md: '', position: 0 },
      { title: 'Второй шаг', description_md: '', position: 1 }
    ]
  };
}
