import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import {
  createGoalAgentContextActivities,
  goalAgentExecutionReference,
  loadGoalAgentManifests
} from '../src/goal-agent-workflow-runtime.js';
import { withUserScope } from '../src/user-scope.js';
import {
  NOW,
  OWNER,
  activatePolicy,
  aiLogCount,
  claimOwner,
  completeClassifierDecision,
  evidence,
  execution,
  hasCode,
  owner,
  persistAndComplete,
  plusHours,
  resultFor,
  scheduleMatcher,
  seedActivity,
  seedCanonicalActivity
} from './goal-agent-test-support.js';

test('API-owned context activities hydrate only the requested bounded execution page', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    const manifestList = await loadGoalAgentManifests();
    fixture.store.syncGoalAgentCatalog(manifestList, NOW);
    const manifests = new Map(manifestList.map((manifest) => [manifest.id, manifest]));
    owner(fixture, () => {
      seedActivity(fixture.store, 'context-subject', 'action');
      for (let index = 0; index < 61; index += 1) {
        seedActivity(fixture.store, `context-goal-${String(index).padStart(3, '0')}`, 'goal');
      }
    });
    const execution = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'context-subject', triggerKind: 'classifier_resolved',
      triggerRevision: 9, skipClassifier: true, nowIso: NOW
    }));
    const reference = goalAgentExecutionReference(
      execution,
      manifests.get('goal.item-matcher'),
      'preview-c'
    );
    const activityIdentity = {
      inWorkflow: true,
      taskQueue: reference.context_task_queue,
      workflowType: manifests.get('goal.item-matcher').workflow_type,
      workflowExecution: { workflowId: reference.workflow_id, runId: 'context-activity-run' }
    };
    const activities = createGoalAgentContextActivities({
      store: fixture.store, manifests, environment: 'preview-c',
      activityInfo: () => activityIdentity
    });
    manifests.get('goal.item-matcher').workflow_type = 'mutated-current-manifest';
    const forgedWorkflow = createGoalAgentContextActivities({
      store: fixture.store, manifests, environment: 'preview-c',
      activityInfo: () => ({
        ...activityIdentity,
        workflowExecution: { ...activityIdentity.workflowExecution, workflowId: 'forged-workflow' }
      })
    });
    await assert.rejects(
      () => forgedWorkflow.loadGoalAgentContext(reference), /context_workflow_identity_mismatch/
    );
    await assert.rejects(() => activities.loadGoalAgentContext({
      ...reference, context_capability: 'B'.repeat(43)
    }), /context_capability_mismatch/);
    const frozenContextBuild = execution.input_json.execution_contract.context_worker_build_id;
    fixture.store.db.prepare(`
      UPDATE workflow_executions
      SET input_json = input_json #- '{execution_contract,context_worker_build_id}'
      WHERE id = ?
    `).run(execution.id);
    await assert.rejects(
      () => activities.loadGoalAgentContext(reference), /context_worker_build_mismatch/
    );
    fixture.store.db.prepare(`
      UPDATE workflow_executions
      SET input_json = jsonb_set(input_json, '{execution_contract,context_worker_build_id}', to_jsonb(?::text), true)
      WHERE id = ?
    `).run('wrong-context-build', execution.id);
    await assert.rejects(
      () => activities.loadGoalAgentContext(reference), /context_worker_build_mismatch/
    );
    fixture.store.db.prepare(`
      UPDATE workflow_executions
      SET input_json = jsonb_set(input_json, '{execution_contract,context_worker_build_id}', to_jsonb(?::text), true)
      WHERE id = ?
    `).run(frozenContextBuild, execution.id);
    const descriptor = await activities.loadGoalAgentContext(reference);
    assert.equal(descriptor.agent_id, 'goal.item-matcher');
    assert.equal('page_sets' in descriptor.base, false);
    assert.equal(descriptor.page_counts.items, 2);
    assert.equal('execution_contract' in descriptor.base, false);
    const replayedRun = createGoalAgentContextActivities({
      store: fixture.store, manifests, environment: 'preview-c',
      activityInfo: () => ({
        ...activityIdentity,
        workflowExecution: { ...activityIdentity.workflowExecution, runId: 'replayed-run' }
      })
    });
    await assert.rejects(
      () => replayedRun.loadGoalAgentContext(reference), /context_run_identity_mismatch/
    );
    const pages = [];
    for (let index = 0; index < descriptor.page_counts.items; index += 1) {
      const page = await activities.loadGoalAgentPage({ reference, kind: 'items', index });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 36_000);
      pages.push(...page.items);
    }
    assert.equal(pages.length, 61);
    const frozenContract = fixture.store.db.prepare(`
      SELECT contract_hash, contract_json, context_capability_hash FROM workflow_executions WHERE id = ?
    `).get(execution.id);
    assert.equal(typeof frozenContract.contract_hash, 'string');
    assert.match(frozenContract.context_capability_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(frozenContract.context_capability_hash, reference.context_capability);
    assert.equal(frozenContract.contract_json.output_schema_version, 'brai.goal-item-matcher.result.v1');
    fixture.store.db.prepare(`
      UPDATE workflow_definitions SET output_schema_version = 'mutated-after-start'
      WHERE id = 'goal.item-matcher' AND version = 1
    `).run();
    const activityResult = {
      ...resultFor(fixture.store, 'goal.item-matcher', {
        decisions: [],
        llmCalls: [{ llm_call_id: 'context-activity-call', status: 'completed' }]
      }),
      run_id: 'context-activity-run',
      workflow_attempt: 1
    };
    const logAcknowledgement = await activities.persistGoalAgentLlmCalls({
      reference,
      result: activityResult
    });
    assert.deepEqual(logAcknowledgement.llm_call_ids, ['context-activity-call']);
    assert.equal(logAcknowledgement.execution_status, 'running');
    assert.equal(aiLogCount(fixture, 'context-activity-call'), 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_decisions WHERE workflow_execution_id = ?
    `).get(execution.id).count, 0);
    const acknowledgement = await activities.persistGoalAgentResult({
      reference,
      result: activityResult
    });
    assert.equal(acknowledgement.execution_status, 'completed');
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, run_id, attempt_count FROM workflow_executions WHERE id = ?
    `).get(execution.id), {
      status: 'completed', run_id: 'context-activity-run', attempt_count: 1
    });
    await assert.rejects(() => activities.loadGoalAgentPage({
      reference: { ...reference, agent_id: 'goal.member-finder' },
      kind: 'items',
      index: 0
    }), /goal_agent_execution_not_found/);
    fixture.store.db.prepare(`
      UPDATE workflow_executions
      SET input_json = jsonb_set(input_json, '{snapshot,subject,title}', '"tampered"'::jsonb, true)
      WHERE id = ?
    `).run(execution.id);
    await assert.rejects(() => activities.loadGoalAgentContext(reference), /goal_agent_context_integrity_failed/);
  } finally {
    await fixture.close();
  }
});

test('Done Goals are excluded from matching and cannot be planned or scheduled', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'eligibility-action', 'action');
      seedActivity(fixture.store, 'eligibility-current-goal', 'goal');
      seedActivity(fixture.store, 'eligibility-done-goal', 'goal');
      fixture.store.db.prepare(`
        UPDATE activities SET status = 'Done' WHERE id = 'eligibility-done-goal'
      `).run();
    });
    const matcher = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'eligibility-action', triggerKind: 'classifier_resolved',
      triggerRevision: 1, skipClassifier: true, nowIso: NOW
    }));
    const ids = matcher.input_json.page_sets.items.flatMap((page) => page.items.map((item) => item.items_id));
    assert.equal(ids.includes('eligibility-current-goal'), true);
    assert.equal(ids.includes('eligibility-done-goal'), false);
    assert.equal(owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'eligibility-done-goal', triggerKind: 'goal_changed', triggerRevision: 2, nowIso: NOW
    })), null);
    assert.throws(() => owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'eligibility-done-goal', triggerRevision: 2, nowIso: NOW
    })), hasCode('goal_not_eligible', 409));
  } finally {
    await fixture.close();
  }
});

test('discovery watermarks trigger at five or 24h, never overlap, retry failure, and advance only success', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 4, nowIso: NOW }));
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW }), []);
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 1, nowIso: NOW }));
    const [first] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW });
    assert.ok(first);
    assert.equal(first.workflow_definition_id, 'goal.discovery');
    assert.equal(Number(first.watermark_from), 1);
    assert.equal(Number(first.watermark_to), 5);
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(1) }), []);

    assert.equal(owner(fixture, () => fixture.store.failGoalAgentExecution({
      executionId: first.id, reason: 'worker_unavailable', nowIso: plusHours(1)
    })), true);
    const retryAt = new Date(Date.parse(plusHours(1)) + 60_000).toISOString();
    assert.equal(fixture.store.db.prepare(`
      SELECT next_retry_at_utc FROM workflow_executions WHERE id = ?
    `).get(first.id).next_retry_at_utc, retryAt);
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({
      nowIso: new Date(Date.parse(plusHours(1)) + 30_000).toISOString()
    }), []);
    let watermark = fixture.store.db.prepare(`
      SELECT processed_sequence, relevant_sequence, relevant_change_count, active_workflow_execution_id
      FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER);
    assert.deepEqual(watermark, {
      processed_sequence: 0, relevant_sequence: 5, relevant_change_count: 5,
      active_workflow_execution_id: null
    });
    const [retry] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(2) });
    assert.ok(retry);
    assert.equal(retry.id, first.id);
    assert.equal(retry.workflow_id, first.workflow_id);
    assert.equal(retry.status, 'queued');
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: retry.id, runId: 'discovery-retry-run', nowIso: plusHours(2)
    }));
    assert.equal(fixture.store.db.prepare(`
      SELECT attempt_count FROM workflow_executions WHERE id = ?
    `).get(retry.id).attempt_count, 1);
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: retry.id,
      result: resultFor(fixture.store, 'goal.discovery', { decisions: [], llmCalls: [] }),
      nowIso: plusHours(3)
    }));
    watermark = fixture.store.db.prepare(`
      SELECT processed_sequence, relevant_sequence, relevant_change_count, active_workflow_execution_id
      FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER);
    assert.deepEqual(watermark, {
      processed_sequence: 5, relevant_sequence: 5, relevant_change_count: 0,
      active_workflow_execution_id: null
    });

    withUserScope('discovery-24h-user', () => fixture.store.noteGoalDiscoveryChanges({ count: 1, nowIso: NOW }));
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(23.99) }), []);
    const due = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(24) });
    assert.equal(due.length, 1);
    assert.equal(due[0].user_id, 'discovery-24h-user');
    assert.equal(Number(due[0].watermark_from), 1);
    assert.equal(Number(due[0].watermark_to), 1);

    withUserScope('discovery-first-change-user', () => fixture.store.noteGoalDiscoveryChanges({
      count: 1, nowIso: NOW
    }));
    withUserScope('discovery-first-change-user', () => fixture.store.noteGoalDiscoveryChanges({
      count: 1, nowIso: plusHours(23)
    }));
    const [firstChangeDue] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(24) });
    assert.equal(firstChangeDue.user_id, 'discovery-first-change-user');
    assert.equal(Number(firstChangeDue.watermark_from), 1);
    assert.equal(Number(firstChangeDue.watermark_to), 2);
    withUserScope('discovery-first-change-user', () => fixture.store.markGoalAgentExecutionStarted({
      executionId: firstChangeDue.id, runId: 'first-change-run', nowIso: plusHours(24)
    }));
    withUserScope('discovery-first-change-user', () => fixture.store.noteGoalDiscoveryChanges({
      count: 1, nowIso: plusHours(25)
    }));
    withUserScope('discovery-first-change-user', () => persistAndComplete(fixture.store, {
      executionId: firstChangeDue.id,
      result: resultFor(fixture.store, 'goal.discovery', { decisions: [], llmCalls: [] }),
      nowIso: plusHours(26)
    }));
    const remaining = fixture.store.db.prepare(`
      SELECT processed_sequence, relevant_sequence, relevant_change_count, first_unprocessed_change_at_utc
      FROM context_discovery_watermarks WHERE user_id = 'discovery-first-change-user'
    `).get();
    assert.deepEqual(remaining, {
      processed_sequence: 2, relevant_sequence: 3, relevant_change_count: 1,
      first_unprocessed_change_at_utc: plusHours(25)
    });
    assert.deepEqual(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(48.99) }), []);
    assert.equal(fixture.store.ensureEligibleGoalDiscoveries({ nowIso: plusHours(49) })[0].user_id,
      'discovery-first-change-user');
  } finally {
    await fixture.close();
  }
});

test('agent results persist exactly-once AI logs, decisions, failures, and classifier routing', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'result-action', 'action');
      seedActivity(fixture.store, 'result-goal', 'goal');
      seedCanonicalActivity(fixture.store, 'accepted-classifier-action');
      seedCanonicalActivity(fixture.store, 'rejected-classifier-action');
      seedActivity(fixture.store, 'no-change-action', 'action');
    });

    const matcher = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'result-action', triggerKind: 'classifier_resolved', triggerRevision: 1,
      skipClassifier: true, nowIso: NOW
    }));
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: matcher.id, runId: 'matcher-run', nowIso: NOW
    }));
    const matcherResult = resultFor(fixture.store, 'goal.item-matcher', {
      llmCalls: [{ llm_call_id: 'matcher-call-1', status: 'completed', model: 'test-model', attempt: 1 }],
      decisions: [{
        decision_kind: 'relation_add', subject_items_id: 'result-action', confidence: 0.8,
        rationale: 'Подходит к цели', evidence: [evidence('result-action')],
        proposal: {
          relation_type_id: 'part_of', source_items_id: 'result-action',
          target_items_id: 'result-goal', suggested_position: null
        }
      }]
    });
    const completed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: matcher.id, result: matcherResult, nowIso: plusHours(1)
    }));
    assert.equal(completed.status, 'completed', completed.last_error);
    const decision = fixture.store.db.prepare(`
      SELECT status, workflow_execution_id, workflow_id, run_id
      FROM context_decisions WHERE workflow_execution_id = ?
    `).get(matcher.id);
    assert.deepEqual(decision, {
      status: 'pending', workflow_execution_id: matcher.id,
      workflow_id: matcher.workflow_id, run_id: 'matcher-run'
    });
    assert.equal(aiLogCount(fixture, 'matcher-call-1'), 1);
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: matcher.id, result: matcherResult, nowIso: plusHours(2)
    }));
    assert.equal(aiLogCount(fixture, 'matcher-call-1'), 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_decisions WHERE workflow_execution_id = ?
    `).get(matcher.id).count, 1);

    const planner = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'result-goal', triggerRevision: 2, nowIso: NOW
    }));
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: planner.id, runId: 'planner-failed-run', nowIso: NOW
    }));
    const failedResult = resultFor(fixture.store, 'goal.planner', {
      status: 'failed', decisions: [],
      llmCalls: [{ llm_call_id: 'planner-failed-call', status: 'failed', error_code: 'provider_timeout' }]
    });
    const failed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: planner.id, result: failedResult, nowIso: plusHours(1)
    }));
    assert.equal(failed.status, 'failed');
    assert.equal(aiLogCount(fixture, 'planner-failed-call'), 1);
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: planner.id, result: failedResult, nowIso: plusHours(2)
    }));
    assert.equal(aiLogCount(fixture, 'planner-failed-call'), 1);

    const noChange = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'no-change-action', triggerKind: 'activity_created', triggerRevision: 3, nowIso: NOW
    }));
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: noChange.id, runId: 'classifier-no-change-run', nowIso: NOW
    }));
    owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: noChange.id,
      result: resultFor(fixture.store, 'activity.classifier', {
        llmCalls: [{ llm_call_id: 'classifier-no-change-call', status: 'completed' }],
        decisions: [{
          decision_kind: 'activity_type_change', subject_items_id: 'no-change-action',
          confidence: 0.9, rationale: 'Оставить действием', evidence: [evidence('no-change-action')],
          proposal: {
            current_role: 'activity', current_type: 'action',
            target_type: 'action', end_inbox_role: false
          }
        }]
      }),
      nowIso: plusHours(1)
    }));
    assert.ok(execution(fixture, 'goal.item-matcher', 'no-change-action'));

    const accepted = completeClassifierDecision(fixture, 'accepted-classifier-action', 4, 'goal');
    owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: accepted.id, action: 'accept', resolutionKey: 'classifier:accept',
      nowIso: plusHours(2)
    }));
    assert.equal(fixture.store.getActivityItem('accepted-classifier-action').activity_type_id, 'goal');
    assert.ok(execution(fixture, 'goal.member-finder', 'accepted-classifier-action'));

    const rejected = completeClassifierDecision(fixture, 'rejected-classifier-action', 5, 'goal');
    owner(fixture, () => fixture.store.resolveContextDecision({
      decisionId: rejected.id, action: 'reject', resolutionKey: 'classifier:reject',
      nowIso: plusHours(2)
    }));
    assert.equal(fixture.store.getActivityItem('rejected-classifier-action').activity_type_id, 'action');
    assert.ok(execution(fixture, 'goal.item-matcher', 'rejected-classifier-action'));
  } finally {
    await fixture.close();
  }
});

test('result trust boundary rejects forged references and stale snapshots never apply', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'trust-action', 'action');
      seedActivity(fixture.store, 'trust-goal', 'goal');
    });

    const forgedProposal = scheduleMatcher(fixture, 'forged-proposal-trigger', 0);
    const invalidProposal = resultFor(fixture.store, 'goal.item-matcher', {
      llmCalls: [{ llm_call_id: 'forged-proposal-call', status: 'completed' }],
      decisions: [{
        decision_kind: 'relation_add', subject_items_id: 'trust-action', confidence: 1,
        rationale: 'Forged target', evidence: [evidence('trust-action')],
        proposal: {
          relation_type_id: 'part_of', source_items_id: 'trust-action',
          target_items_id: 'not-in-snapshot', suggested_position: null
        }
      }]
    });
    const failedProposal = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: forgedProposal.id, result: invalidProposal, nowIso: plusHours(1)
    }));
    assert.equal(failedProposal.status, 'failed');
    assert.equal(failedProposal.last_error, 'agent_result_reference_invalid');
    assert.equal(aiLogCount(fixture, 'forged-proposal-call'), 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_decisions WHERE workflow_execution_id = ?
    `).get(forgedProposal.id).count, 0);

    const forgedEvidence = scheduleMatcher(fixture, 'forged-evidence-trigger', 0);
    const invalidEvidence = resultFor(fixture.store, 'goal.item-matcher', {
      llmCalls: [{ llm_call_id: 'forged-evidence-call', status: 'completed' }],
      decisions: [{
        decision_kind: 'relation_add', subject_items_id: 'trust-action', confidence: 1,
        rationale: 'Valid edge with forged evidence',
        evidence: [{ items_id: 'foreign-evidence-item', field: 'title', excerpt: 'forged' }],
        proposal: {
          relation_type_id: 'part_of', source_items_id: 'trust-action',
          target_items_id: 'trust-goal', suggested_position: null
        }
      }]
    });
    const failedEvidence = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: forgedEvidence.id, result: invalidEvidence, nowIso: plusHours(1)
    }));
    assert.equal(failedEvidence.status, 'failed');
    assert.equal(failedEvidence.last_error, 'agent_result_reference_invalid');
    assert.equal(aiLogCount(fixture, 'forged-evidence-call'), 1);

    const staleExecution = scheduleMatcher(fixture, 'stale-result-trigger', 0);
    activatePolicy(fixture, 'goal.item-matcher', 'relation_add', 0.5);
    fixture.store.db.prepare(`
      UPDATE activities SET updated_at_utc = ? WHERE id = 'trust-goal'
    `).run(plusHours(2));
    const staleResult = resultFor(fixture.store, 'goal.item-matcher', {
      llmCalls: [{ llm_call_id: 'stale-result-call', status: 'completed' }],
      decisions: [{
        decision_kind: 'relation_add', subject_items_id: 'trust-action', confidence: 1,
        rationale: 'Snapshot is stale',
        evidence: [{ items_id: 'trust-goal', field: 'title', excerpt: 'trust-goal' }],
        proposal: {
          relation_type_id: 'part_of', source_items_id: 'trust-action',
          target_items_id: 'trust-goal', suggested_position: null
        }
      }]
    });
    const completedStale = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: staleExecution.id, result: staleResult, nowIso: plusHours(3)
    }));
    assert.equal(completedStale.status, 'completed');
    const staleDecision = fixture.store.db.prepare(`
      SELECT status FROM context_decisions WHERE workflow_execution_id = ?
    `).get(staleExecution.id);
    assert.equal(staleDecision.status, 'stale_context');
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM relations
      WHERE source_items_id = 'trust-action' AND target_items_id = 'trust-goal'
    `).get().count, 0);
    const refresh = fixture.store.db.prepare(`
      SELECT * FROM workflow_executions
      WHERE workflow_definition_id = 'goal.item-matcher'
        AND subject_id = 'trust-action' AND trigger_kind = 'stale_context_refresh'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.ok(refresh);
    assert.equal(refresh.status, 'queued');
    assert.notEqual(refresh.workflow_id, staleExecution.workflow_id);
    assert.equal(aiLogCount(fixture, 'stale-result-call'), 1);
  } finally {
    await fixture.close();
  }
});
