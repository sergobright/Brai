import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import {
  NOW,
  claimOwner,
  evidence,
  hasCode,
  owner,
  persistAndComplete,
  plusHours,
  resultFor,
  seedActivity
} from './goal-agent-test-support.js';

test('accept revalidates a pending workflow decision and idempotently schedules fresh analysis', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = startMatcher(fixture, 'stale-review');
    const completed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id,
      result: matcherResult(fixture, 'stale-review-call'),
      nowIso: plusHours(1)
    }));
    assert.equal(completed.status, 'completed');
    const decision = decisionFor(fixture, execution.id);
    assert.equal(decision.status, 'pending');

    mutateRelationRevision(fixture);
    const resolved = owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: decision.id, action: 'accept', resolutionKey: 'stale-review:accept',
      nowIso: plusHours(2)
    }));
    assert.equal(resolved.decision.status, 'stale_context');
    assert.equal(resolved.decision.operation_id, null);
    assert.equal(membershipCount(fixture, 'review-action', 'review-goal'), 0);
    assert.equal(operationCount(fixture, 'stale-review:accept'), 0);
    assert.equal(refreshCount(fixture, 'goal.item-matcher', 'review-action'), 1);

    const replay = owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: decision.id, action: 'accept', resolutionKey: 'stale-review:accept',
      nowIso: plusHours(3)
    }));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.decision.status, 'stale_context');
    assert.equal(refreshCount(fixture, 'goal.item-matcher', 'review-action'), 1);
  } finally {
    await fixture.close();
  }
});

test('edited Goal plan is not applied after its frozen workflow context becomes stale', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'review-goal', triggerRevision: fixture.store.getActivityServerRevision(), nowIso: NOW
    }));
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: execution.id, runId: 'stale-plan-run', nowIso: NOW
    }));
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id,
      result: resultFor(fixture.store, 'goal.planner', {
        llmCalls: [{ llm_call_id: 'stale-plan-call', status: 'completed' }],
        decisions: [{
          decision_kind: 'goal_plan', subject_items_id: 'review-goal', confidence: 1,
          rationale: 'План', evidence: [evidence('review-goal')],
          proposal: planPayload('Первый шаг')
        }]
      }),
      nowIso: plusHours(1)
    }));
    const decision = decisionFor(fixture, execution.id);
    const activityCount = tableCount(fixture, 'activities');

    mutateRelationRevision(fixture);
    const resolved = owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: decision.id, action: 'accept', resolutionKey: 'stale-plan:accept',
      editedPayload: planPayload('Отредактированный шаг'), nowIso: plusHours(2)
    }));
    assert.equal(resolved.decision.status, 'stale_context');
    assert.equal(tableCount(fixture, 'activities'), activityCount);
    assert.equal(operationCount(fixture, 'stale-plan:accept'), 0);
    assert.equal(refreshCount(fixture, 'goal.planner', 'review-goal'), 1);
  } finally {
    await fixture.close();
  }
});

test('tampered frozen workflow contract fails closed and leaves the decision pending', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = startMatcher(fixture, 'tampered-review');
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id,
      result: matcherResult(fixture, 'tampered-review-call'),
      nowIso: plusHours(1)
    }));
    const decision = decisionFor(fixture, execution.id);
    fixture.store.db.prepare(`UPDATE workflow_executions
      SET contract_json = jsonb_set(contract_json, '{prompt_version}', '"tampered"'::jsonb, true)
      WHERE id = ?`).run(execution.id);

    assert.throws(() => owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: decision.id, action: 'accept', resolutionKey: 'tampered-review:accept',
      nowIso: plusHours(2)
    })), hasCode('decision_context_integrity_failed', 500));
    assert.equal(decisionFor(fixture, execution.id).status, 'pending');
    assert.equal(membershipCount(fixture, 'review-action', 'review-goal'), 0);
    assert.equal(refreshCount(fixture, 'goal.item-matcher', 'review-action'), 0);
  } finally {
    await fixture.close();
  }
});

async function goalAgentFixture() {
  const fixture = await createFixture([NOW]);
  claimOwner(fixture);
  fixture.store.configureGoalAgentEnvironment('preview-c');
  fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
  owner(fixture, () => {
    seedActivity(fixture.store, 'review-action', 'action');
    seedActivity(fixture.store, 'review-goal', 'goal');
    seedActivity(fixture.store, 'revision-action', 'action');
    seedActivity(fixture.store, 'revision-goal', 'goal');
  });
  return fixture;
}

function startMatcher(fixture, triggerKind) {
  const execution = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
    itemsId: 'review-action', triggerKind,
    triggerRevision: fixture.store.getActivityServerRevision(), skipClassifier: true, nowIso: NOW
  }));
  owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
    executionId: execution.id, runId: `${triggerKind}-run`, nowIso: NOW
  }));
  return execution;
}

function matcherResult(fixture, callId) {
  return resultFor(fixture.store, 'goal.item-matcher', {
    llmCalls: [{ llm_call_id: callId, status: 'completed' }],
    decisions: [{
      decision_kind: 'relation_add', subject_items_id: 'review-action', confidence: 1,
      rationale: 'Подходит к цели', evidence: [evidence('review-goal')],
      proposal: {
        relation_type_id: 'part_of', source_items_id: 'review-action',
        target_items_id: 'review-goal', suggested_position: null
      }
    }]
  });
}

function mutateRelationRevision(fixture) {
  return owner(fixture, () => fixture.store.createRelationWithEvent({
    id: 'revision-membership', relationTypeId: 'part_of',
    sourceItemsId: 'revision-action', targetItemsId: 'revision-goal', position: 0,
    operationId: 'revision-membership:create', actorType: 'user', actorId: 'goal-agent-owner',
    nowIso: plusHours(1.5)
  }));
}

function planPayload(firstTitle) {
  return {
    goal_items_id: 'review-goal',
    steps: [
      { title: firstTitle, description_md: '', position: 0 },
      { title: 'Второй шаг', description_md: '', position: 1 }
    ]
  };
}

function decisionFor(fixture, executionId) {
  return fixture.store.db.prepare('SELECT * FROM context_decisions WHERE workflow_execution_id = ?').get(executionId);
}

function refreshCount(fixture, agentId, subjectId) {
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM workflow_executions
    WHERE workflow_definition_id = ? AND subject_id = ? AND trigger_kind = 'stale_context_refresh'`)
    .get(agentId, subjectId).count;
}

function membershipCount(fixture, sourceId, targetId) {
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM relations
    WHERE source_items_id = ? AND target_items_id = ?`).get(sourceId, targetId).count;
}

function operationCount(fixture, operationId) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM context_operations WHERE id = ?')
    .get(operationId).count;
}

function tableCount(fixture, table) {
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM ${table}`).get().count;
}
