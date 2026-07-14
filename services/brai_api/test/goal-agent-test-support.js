import { policyIdentity } from '../src/context-policy.js';
import { withUserScope } from '../src/user-scope.js';

export const OWNER = 'goal-agent-owner';
export const NOW = '2026-07-13T16:00:00.000Z';

export function persistAndComplete(store, input) {
  store.persistGoalAgentLlmCalls(input);
  return store.completeGoalAgentExecution(input);
}

export function completeClassifierDecision(fixture, itemsId, revision, toType) {
  const scheduled = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
    itemsId, triggerKind: 'activity_created', triggerRevision: revision, nowIso: NOW
  }));
  owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
    executionId: scheduled.id, runId: `classifier-${itemsId}-run`, nowIso: NOW
  }));
  const completed = owner(fixture, () => persistAndComplete(fixture.store, {
    executionId: scheduled.id,
    result: resultFor(fixture.store, 'activity.classifier', {
      llmCalls: [{ llm_call_id: `classifier-${itemsId}-call`, status: 'completed' }],
      decisions: [{
        decision_kind: 'activity_type_change', subject_items_id: itemsId,
        confidence: 0.8, rationale: 'Классификация', evidence: [evidence(itemsId)],
        proposal: {
          current_role: 'activity', current_type: 'action',
          target_type: toType, end_inbox_role: false
        }
      }]
    }),
    nowIso: plusHours(1)
  }));
  return completed.result_json.decisions[0];
}

export function scheduleMatcher(fixture, triggerKind, revision) {
  const scheduled = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
    itemsId: 'trust-action', triggerKind, triggerRevision: revision,
    skipClassifier: true, nowIso: NOW
  }));
  owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
    executionId: scheduled.id, runId: `run:${triggerKind}`, nowIso: NOW
  }));
  return scheduled;
}

export function resultFor(store, agentId, { status = 'completed', decisions = [], llmCalls = [] } = {}) {
  const agent = store.getAgent(agentId);
  const definition = store.db.prepare(`
    SELECT input_schema_version FROM workflow_definitions WHERE id = ? AND version = 1
  `).get(agentId);
  const execution = store.db.prepare(`
    SELECT workflow_id, run_id, attempt_count FROM workflow_executions
    WHERE workflow_definition_id = ? ORDER BY created_at_utc DESC, id DESC LIMIT 1
  `).get(agentId);
  const calls = llmCalls.map((call, index) => ({
    llm_call_id: call.llm_call_id,
    attempt: call.attempt ?? index + 1,
    status: call.status === 'failed' ? 'provider_failed' : call.status,
    model: call.model ?? 'test-model',
    duration_ms: call.duration_ms ?? 1,
    error_code: call.error_code ?? null
  }));
  return {
    schema_version: '1', status, agent_id: agentId, agent_version: agent.version,
    input_schema_version: definition.input_schema_version,
    prompt_version: agent.prompt_version, model: 'test-model',
    output_schema_version: agent.schema_version,
    workflow_id: execution.workflow_id,
    run_id: execution.run_id,
    workflow_attempt: execution.attempt_count,
    review_only: ['goal.discovery', 'goal.planner'].includes(agentId),
    llm_call_id: calls.at(-1)?.llm_call_id ?? null,
    attempt: calls.at(-1)?.attempt ?? 0,
    decisions, llm_calls: calls,
    error: status === 'completed' ? null : { code: 'agent_failed' }
  };
}

export function evidence(itemsId) {
  return { items_id: itemsId, field: 'title', excerpt: itemsId };
}

export function activatePolicy(fixture, agentId, decisionKind, threshold) {
  const agent = fixture.store.getAgent(agentId);
  const contract = {
    user_id: OWNER, agent_id: agentId, agent_version: agent.version,
    prompt_version: agent.prompt_version, model: 'test-model',
    schema_version: agent.schema_version, decision_kind: decisionKind
  };
  fixture.store.db.prepare(`
    INSERT INTO context_policies (
      id, user_id, agent_id, agent_version, prompt_version, model, schema_version,
      decision_kind, state, active_threshold, activated_at_utc, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).run(policyIdentity(contract), OWNER, agentId, agent.version, agent.prompt_version,
    'test-model', agent.schema_version, decisionKind, threshold, NOW, NOW, NOW);
}

export function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Goal Agent Owner', 'goal-agent-owner@example.test', true, now(), now())
  `).run(OWNER);
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(OWNER, NOW);
}

export function owner(fixture, callback) {
  return withUserScope(OWNER, callback);
}

export function seedActivity(store, id, type) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, type, id, NOW, NOW, OWNER);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW });
}

export function seedCanonicalActivity(store, id) {
  seedActivity(store, id, 'action');
  const row = store.getActivityItem(id);
  store.insertEventRecord({
    id: `activity:create-${id}`, eventId: `create-${id}`,
    eventDomain: 'activity', eventType: 'create', eventAction: 'activity.create',
    title: 'Activity create', itemsId: id, itemRolesId: row.item_roles_id,
    subjectType: 'activity', subjectId: id, actorType: 'user', actorId: OWNER,
    occurredAtUtc: NOW, receivedAtUtc: NOW, status: 'accepted', payloadVersion: 1,
    payloadJson: JSON.stringify({ title: id, activity_type_id: 'action' })
  });
}

export function execution(fixture, agentId, subjectId) {
  return fixture.store.db.prepare(`
    SELECT * FROM workflow_executions
    WHERE workflow_definition_id = ? AND subject_id = ? ORDER BY id DESC LIMIT 1
  `).get(agentId, subjectId);
}

export function aiLogCount(fixture, callId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM ai_logs WHERE llm_call_id = ?
  `).get(callId).count;
}

export function plusHours(hours) {
  return new Date(Date.parse(NOW) + hours * 60 * 60 * 1000).toISOString();
}

export function hasCode(code, status) {
  return (error) => error?.code === code && error?.status === status;
}
