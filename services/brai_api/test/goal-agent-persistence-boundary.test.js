import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import {
  NOW,
  activatePolicy,
  aiLogCount,
  claimOwner,
  evidence,
  owner,
  persistAndComplete,
  plusHours,
  resultFor,
  scheduleMatcher,
  seedActivity
} from './goal-agent-test-support.js';

test('deterministic auto-apply failure keeps one durable AI log and no partial domain mutation', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = scheduleMatcher(fixture, 'persistence-failure', 1);
    activatePolicy(fixture, 'goal.item-matcher', 'relation_add', 0.5);
    const result = matcherResult(fixture, 'persistence-failure-call');
    const apply = fixture.store.applyContextDecisionPackage.bind(fixture.store);
    let applyAttempts = 0;
    fixture.store.applyContextDecisionPackage = (input) => {
      applyAttempts += 1;
      apply(input);
      const error = new Error('deterministic_apply_failure');
      error.code = 'deterministic_apply_failure';
      error.status = 409;
      throw error;
    };

    const failed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id, result, nowIso: plusHours(1)
    }));

    assert.equal(failed.status, 'needs_review');
    assert.equal(failed.current_step, 'persist_decisions');
    assert.equal(failed.last_error, 'decision_apply_failed:deterministic_apply_failure');
    assert.equal(failed.result_json.persistence_diagnostic.code, 'deterministic_apply_failure');
    assert.equal(failed.result_json.persistence_diagnostic.retryable, false);
    assert.equal(aiLogCount(fixture, 'persistence-failure-call'), 1);
    assert.equal(applyAttempts, 1);
    assert.equal(count(fixture, 'context_decisions'), 0);
    assert.equal(count(fixture, 'context_operations'), 0);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM relations
      WHERE source_items_id = 'trust-action' AND target_items_id = 'trust-goal'
    `).get().count, 0);

    const replay = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id, result, nowIso: plusHours(2)
    }));
    assert.equal(replay.status, 'needs_review');
    assert.equal(aiLogCount(fixture, 'persistence-failure-call'), 1);
    assert.equal(applyAttempts, 1);
    assert.equal(count(fixture, 'context_decisions'), 0);
    assert.equal(count(fixture, 'relations'), 0);
  } finally {
    await fixture.close();
  }
});

test('valid LLM calls survive result-envelope validation failure exactly once', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = scheduleMatcher(fixture, 'invalid-result-envelope', 2);
    const result = matcherResult(fixture, 'invalid-result-call');
    result.decisions[0].confidence = 2;

    const failed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id, result, nowIso: plusHours(1)
    }));
    assert.equal(failed.status, 'failed');
    assert.match(failed.last_error, /^agent_result_contract_invalid:/);
    assert.equal(failed.result_json.persistence_diagnostic.stage, 'validate_result');
    assert.equal(aiLogCount(fixture, 'invalid-result-call'), 1);
    assert.equal(count(fixture, 'context_decisions'), 0);

    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id, result, nowIso: plusHours(2)
    }));
    assert.equal(aiLogCount(fixture, 'invalid-result-call'), 1);
  } finally {
    await fixture.close();
  }
});

test('final result persistence fails closed when an observable call was not logged first', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = scheduleMatcher(fixture, 'missing-incremental-log', 3);
    const result = matcherResult(fixture, 'missing-incremental-log-call');

    const failed = owner(fixture, () => fixture.store.completeGoalAgentExecution({
      executionId: execution.id, result, nowIso: plusHours(1)
    }));

    assert.equal(failed.status, 'failed');
    assert.equal(failed.current_step, 'invoke_agent');
    assert.equal(failed.last_error, 'agent_llm_log_verification_failed:agent_llm_log_missing');
    assert.equal(failed.result_json.persistence_diagnostic.stage, 'verify_ai_logs');
    assert.equal(aiLogCount(fixture, 'missing-incremental-log-call'), 0);
    assert.equal(count(fixture, 'context_decisions'), 0);
    assert.equal(count(fixture, 'context_operations'), 0);
    assert.equal(count(fixture, 'relations'), 0);
  } finally {
    await fixture.close();
  }
});

test('each observable call commits independently when a later call log fails', async () => {
  const fixture = await goalAgentFixture();
  try {
    const execution = scheduleMatcher(fixture, 'partial-incremental-log', 4);
    const result = resultFor(fixture.store, 'goal.item-matcher', {
      llmCalls: [
        { llm_call_id: 'partial-log-call-1', status: 'schema_failed', error_code: 'invalid_json' },
        { llm_call_id: 'partial-log-call-2', status: 'completed' }
      ],
      decisions: []
    });
    const record = fixture.store.recordAiLog.bind(fixture.store);
    let writes = 0;
    fixture.store.recordAiLog = (input) => {
      writes += 1;
      if (writes === 2) {
        const error = new Error('injected_second_log_failure');
        error.code = 'injected_second_log_failure';
        error.status = 409;
        throw error;
      }
      return record(input);
    };

    assert.throws(() => owner(fixture, () => fixture.store.persistGoalAgentLlmCalls({
      executionId: execution.id, result, nowIso: plusHours(1)
    })), (error) => error.code === 'injected_second_log_failure');

    assert.equal(aiLogCount(fixture, 'partial-log-call-1'), 1);
    assert.equal(aiLogCount(fixture, 'partial-log-call-2'), 0);
    assert.equal(count(fixture, 'context_decisions'), 0);
    assert.equal(count(fixture, 'context_operations'), 0);
    assert.equal(count(fixture, 'relations'), 0);
    assert.equal(fixture.store.db.prepare(`
      SELECT status FROM workflow_executions WHERE id = ?
    `).get(execution.id).status, 'running');
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
    seedActivity(fixture.store, 'trust-action', 'action');
    seedActivity(fixture.store, 'trust-goal', 'goal');
  });
  return fixture;
}

function matcherResult(fixture, callId) {
  return resultFor(fixture.store, 'goal.item-matcher', {
    llmCalls: [{ llm_call_id: callId, status: 'completed' }],
    decisions: [{
      decision_kind: 'relation_add', subject_items_id: 'trust-action', confidence: 1,
      rationale: 'Подходит к цели', evidence: [evidence('trust-action')],
      proposal: {
        relation_type_id: 'part_of', source_items_id: 'trust-action',
        target_items_id: 'trust-goal', suggested_position: null
      }
    }]
  });
}

function count(fixture, table) {
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM ${table}`).get().count;
}
