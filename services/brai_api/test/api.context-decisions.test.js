import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, request } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = '2026-07-13T12:00:00.000Z';

test('decision API is authenticated, owner-scoped, idempotent, and simple proposals are immutable', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.item-matcher');
    owner(fixture, () => {
      seedActivity(fixture.store, 'decision-action', 'action');
      seedActivity(fixture.store, 'decision-goal', 'goal');
    });
    const recorded = owner(fixture, () => recordDecision(fixture.store, {
      proposal: relationProposal('decision-action', 'decision-goal'),
      triggerItemsId: 'decision-action'
    }));
    const duplicate = owner(fixture, () => recordDecision(fixture.store, {
      proposal: relationProposal('decision-action', 'decision-goal'),
      triggerItemsId: 'decision-action'
    }));
    assert.equal(recorded.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(recorded.decision.status, 'pending');

    assert.equal((await request(fixture.url, '/v1/context-decisions', {}, false)).status, 401);
    const pending = await request(fixture.url, '/v1/context-decisions?status=pending');
    assert.equal(pending.status, 200);
    assert.deepEqual(pending.body.decisions.map((decision) => decision.id), [recorded.decision.id]);

    const edited = await resolve(fixture, recorded.decision.id, 'accept', 'resolve:simple:edited', {
      relation_type_id: 'part_of', source_items_id: 'other', target_items_id: 'other-goal'
    });
    assert.equal(edited.status, 400);
    assert.equal(edited.body.error, 'simple_decision_not_editable');

    const accepted = await resolve(fixture, recorded.decision.id, 'accept', 'resolve:simple');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.decision.status, 'accepted');
    assert.ok(accepted.body.operation_id);
    const relation = fixture.store.db.prepare(`
      SELECT status, origin_decision_id, operation_id, created_by_actor_type
      FROM relations WHERE id = ?
    `).get(accepted.body.decision.relation_ids[0]);
    assert.deepEqual(relation, {
      status: 'active', origin_decision_id: recorded.decision.id,
      operation_id: 'resolve:simple', created_by_actor_type: 'agent'
    });

    const replay = await resolve(fixture, recorded.decision.id, 'accept', 'resolve:simple');
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal(count(fixture, 'relations'), 1);
    const conflict = await resolve(fixture, recorded.decision.id, 'reject', 'resolve:simple');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'resolution_idempotency_conflict');

    const foreign = withUserScope('another-user', () => recordDecision(fixture.store, {
      proposal: relationProposal('missing-a', 'missing-g'), triggerRevision: 2
    }));
    const hidden = await resolve(fixture, foreign.decision.id, 'reject', 'foreign-resolution');
    assert.equal(hidden.status, 404);
    assert.equal(hidden.body.error, 'decision_not_found');
  } finally {
    await fixture.close();
  }
});

test('active policy auto-applies only above threshold and undo compensates Relation history', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.item-matcher');
    owner(fixture, () => {
      seedActivity(fixture.store, 'auto-action', 'action');
      seedActivity(fixture.store, 'auto-goal', 'goal');
    });
    const shadow = owner(fixture, () => recordDecision(fixture.store, {
      confidence: 0.99,
      proposal: relationProposal('auto-action', 'auto-goal'),
      triggerItemsId: 'auto-action', triggerRevision: 1
    }));
    fixture.store.db.prepare(`
      UPDATE context_policies SET state = 'active', active_threshold = 0.9,
        activated_at_utc = ?, shadow_reason = NULL WHERE id = ?
    `).run(NOW, shadow.decision.policy.id);

    const below = owner(fixture, () => recordDecision(fixture.store, {
      confidence: 0.89,
      proposal: { ...relationProposal('auto-action', 'auto-goal'), position: 1 },
      triggerItemsId: 'auto-action', triggerRevision: 2
    }));
    assert.equal(below.decision.status, 'pending');
    assert.equal(count(fixture, 'relations'), 0);

    const automatic = owner(fixture, () => recordDecision(fixture.store, {
      confidence: 0.9,
      proposal: relationProposal('auto-action', 'auto-goal'),
      triggerItemsId: 'auto-action', triggerRevision: 3
    }));
    assert.equal(automatic.decision.status, 'auto_accepted');
    const relationId = automatic.decision.relation_ids[0];
    assert.equal(fixture.store.db.prepare('SELECT status FROM relations WHERE id = ?').get(relationId).status, 'active');

    const undone = owner(fixture, () => fixture.store.undoContextDecision({
      decisionId: automatic.decision.id,
      operationId: 'undo:auto-membership',
      nowIso: '2026-07-13T12:01:00.000Z'
    }));
    assert.equal(undone.compensated_operation_id, automatic.decision.operation_id);
    assert.equal(undone.duplicate, false);
    const ended = fixture.store.db.prepare(`
      SELECT status, ended_operation_id, end_reason FROM relations WHERE id = ?
    `).get(relationId);
    assert.deepEqual(ended, {
      status: 'ended', ended_operation_id: 'undo:auto-membership', end_reason: 'decision_compensated'
    });
    const decision = fixture.store.db.prepare(`
      SELECT status, compensation_operation_id FROM context_decisions WHERE id = ?
    `).get(automatic.decision.id);
    assert.deepEqual(decision, { status: 'undone', compensation_operation_id: 'undo:auto-membership' });
    assert.equal(fixture.store.db.prepare(`
      SELECT accepted FROM context_policy_labels WHERE decisions_id = ? AND source = 'undo'
    `).get(automatic.decision.id).accepted, 0);
    const counts = {
      operations: count(fixture, 'context_operations'),
      events: count(fixture, 'events'),
      labels: count(fixture, 'context_policy_labels')
    };
    const replay = owner(fixture, () => fixture.store.undoContextDecision({
      decisionId: automatic.decision.id,
      operationId: 'undo:auto-membership',
      nowIso: '2026-07-13T12:02:00.000Z'
    }));
    assert.deepEqual(replay, {
      operation_id: 'undo:auto-membership',
      compensated_operation_id: automatic.decision.operation_id,
      duplicate: true
    });
    assert.deepEqual({
      operations: count(fixture, 'context_operations'),
      events: count(fixture, 'events'),
      labels: count(fixture, 'context_policy_labels')
    }, counts);
    assert.throws(() => owner(fixture, () => fixture.store.undoContextDecision({
      decisionId: automatic.decision.id,
      operationId: 'undo:auto-membership-conflict',
      nowIso: '2026-07-13T12:03:00.000Z'
    })), hasCode('undo_idempotency_conflict', 409));
  } finally {
    await fixture.close();
  }
});

test('edited Goal discovery and plan packages apply atomically and replay once', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.discovery');
    seedAgent(fixture.store, 'goal.planner');
    owner(fixture, () => {
      seedActivity(fixture.store, 'draft-member-a', 'action');
      seedActivity(fixture.store, 'draft-member-b', 'action');
    });
    const draft = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'goal.discovery', decisionKind: 'goal_discovery', confidence: 1,
      proposal: { title: 'Raw title', member_items_ids: ['draft-member-a', 'draft-member-b'] }
    }));
    const missingEdit = await resolve(fixture, draft.decision.id, 'accept', 'draft:no-edit');
    assert.equal(missingEdit.status, 400);
    assert.equal(missingEdit.body.error, 'edited_payload_required');

    const accepted = await resolve(fixture, draft.decision.id, 'accept', 'draft:accept', {
      title: 'Отредактированная цель', description_md: 'Полное описание',
      member_items_ids: ['draft-member-a', 'draft-member-b']
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const goalId = accepted.body.decision.operation_id
      ? fixture.store.db.prepare(`SELECT result_json FROM context_operations WHERE id = 'draft:accept'`).get().result_json.activity_id
      : null;
    assert.ok(goalId);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT activity_type_id, title FROM activities WHERE id = ?
    `).get(goalId), { activity_type_id: 'goal', title: 'Отредактированная цель' });
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM relations WHERE target_items_id = ? AND status = 'active'
    `).get(goalId).count, 2);
    const replay = await resolve(fixture, draft.decision.id, 'accept', 'draft:accept', {
      title: 'Отредактированная цель', description_md: 'Полное описание',
      member_items_ids: ['draft-member-a', 'draft-member-b']
    });
    assert.equal(replay.body.duplicate, true);

    const invalid = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'goal.discovery', decisionKind: 'goal_discovery', confidence: 1,
      triggerRevision: 9,
      proposal: { title: 'Invalid', member_items_ids: ['draft-member-a', 'missing-member'] }
    }));
    const beforeActivities = count(fixture, 'activities');
    const beforeRelations = count(fixture, 'relations');
    const failed = await resolve(fixture, invalid.decision.id, 'accept', 'draft:invalid', {
      title: 'Не должна сохраниться', member_items_ids: ['draft-member-a', 'missing-member']
    });
    assert.equal(failed.status, 409);
    assert.equal(failed.body.error, 'invalid_relation_endpoints');
    assert.equal(count(fixture, 'activities'), beforeActivities);
    assert.equal(count(fixture, 'relations'), beforeRelations);
    assert.equal(fixture.store.db.prepare('SELECT status FROM context_decisions WHERE id = ?').get(invalid.decision.id).status, 'pending');

    const plan = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'goal.planner', decisionKind: 'goal_plan', confidence: 1,
      triggerItemsId: goalId, triggerRevision: 10,
      proposal: { goal_items_id: goalId, actions: [{ title: 'A' }, { title: 'B' }] }
    }));
    const beforePlanActivities = count(fixture, 'activities');
    const beforePlanRelations = count(fixture, 'relations');
    const invalidPlan = await resolve(fixture, plan.decision.id, 'accept', 'plan:invalid', {
      goal_items_id: goalId, actions: [{ title: 'Only one step' }]
    });
    assert.equal(invalidPlan.status, 400);
    assert.equal(invalidPlan.body.error, 'goal_plan_action_count_invalid');
    assert.equal(count(fixture, 'activities'), beforePlanActivities);
    assert.equal(count(fixture, 'relations'), beforePlanRelations);
    const planAccepted = await resolve(fixture, plan.decision.id, 'accept', 'plan:accept', {
      goal_items_id: goalId,
      actions: [{ title: 'Первый шаг' }, { title: 'Второй шаг' }]
    });
    assert.equal(planAccepted.status, 200, JSON.stringify(planAccepted.body));
    const planResult = fixture.store.db.prepare("SELECT result_json FROM context_operations WHERE id = 'plan:accept'").get().result_json;
    assert.equal(planResult.activity_ids.length, 2);
    assert.equal(planResult.relation_ids.length, 2);
    assert.equal(planResult.activity_ids.every((id) => fixture.store.db.prepare('SELECT activity_type_id FROM activities WHERE id = ?').get(id).activity_type_id === 'action'), true);
  } finally {
    await fixture.close();
  }
});

test('Inbox classification preserves Item identity and forced Operations cannot convert', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'activity.classifier');
    owner(fixture, () => {
      seedInbox(fixture.store, 'convert-inbox', 'follow_up');
      seedInbox(fixture.store, 'forced-operation', 'operation');
    });
    const beforeItems = count(fixture, 'items');
    const conversion = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      triggerItemsId: 'convert-inbox',
      proposal: { items_id: 'convert-inbox', to_activity_type_id: 'action' }
    }));
    const converted = await resolve(fixture, conversion.decision.id, 'accept', 'convert:accept');
    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    assert.equal(count(fixture, 'items'), beforeItems);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT id, activity_type_id FROM activities WHERE id = 'convert-inbox'
    `).get(), { id: 'convert-inbox', activity_type_id: 'action' });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status FROM item_roles WHERE id = (
        SELECT item_roles_id FROM inbox WHERE id = 'convert-inbox'
      )
    `).get(), { status: 'ended' });
    assert.equal((await request(fixture.url, '/v1/inbox')).body.inbox.some((item) => item.id === 'convert-inbox'), false);

    const forced = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      triggerItemsId: 'forced-operation', triggerRevision: 2,
      proposal: { items_id: 'forced-operation', to_activity_type_id: 'goal' }
    }));
    const rejected = await resolve(fixture, forced.decision.id, 'accept', 'forced:convert');
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error, 'forced_operation_conversion_forbidden');
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM activities WHERE id = 'forced-operation'").get().count, 0);
    assert.equal(fixture.store.db.prepare(`
      SELECT r.status FROM inbox i JOIN item_roles r ON r.id = i.item_roles_id
      WHERE i.id = 'forced-operation'
    `).get().status, 'active');
  } finally {
    await fixture.close();
  }
});

test('decision validation rejects unbounded and invalid agent payloads', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.item-matcher');
    assert.throws(() => owner(fixture, () => recordDecision(fixture.store, { confidence: Number.NaN })), hasCode('confidence_invalid', 400));
    assert.throws(() => owner(fixture, () => recordDecision(fixture.store, {
      proposal: { oversized: 'x'.repeat(65_000) }
    })), hasCode('decision_proposal_invalid', 413));
    assert.throws(() => owner(fixture, () => recordDecision(fixture.store, {
      evidence: [{ excerpt: 'x'.repeat(17_000) }]
    })), hasCode('decision_evidence_invalid', 413));
    assert.throws(() => owner(fixture, () => recordDecision(fixture.store, {
      decisionKind: 'relation_type_candidate'
    })), hasCode('decision_kind_unsupported', 400));
  } finally {
    await fixture.close();
  }
});

test('audit resolution keys conflict across batches for one owner', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.item-matcher');
    const first = owner(fixture, () => recordDecision(fixture.store, {
      triggerRevision: 70, proposal: { ...relationProposal('missing-a', 'missing-g'), sample: 'audit-a' }
    }));
    const second = owner(fixture, () => recordDecision(fixture.store, {
      triggerRevision: 71, proposal: { ...relationProposal('missing-a', 'missing-g'), sample: 'audit-b' }
    }));
    const firstItem = seedAuditItem(fixture, first.decision, 'audit-key-batch-a', 0);
    const secondItem = seedAuditItem(fixture, second.decision, 'audit-key-batch-b', 1);

    const accepted = await request(fixture.url, `/v1/context-audits/${firstItem}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: 'accept', idempotency_key: 'audit:owner-stable' })
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const conflict = await request(fixture.url, `/v1/context-audits/${secondItem}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: 'accept', idempotency_key: 'audit:owner-stable' })
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'audit_resolution_idempotency_conflict');
  } finally {
    await fixture.close();
  }
});

test('edited Goal drafts reject out-of-contract counts and text without truncation', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.discovery');
    seedAgent(fixture.store, 'goal.planner');
    const discovery = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'goal.discovery', decisionKind: 'goal_discovery', triggerItemsId: null,
      proposal: { title: 'Черновик', member_items_ids: ['one', 'two'] }
    }));
    const tooMany = await resolve(fixture, discovery.decision.id, 'accept', 'draft:too-many', {
      title: 'Черновик', description_md: '',
      member_items_ids: Array.from({ length: 51 }, (_, index) => `member-${index}`)
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error, 'goal_member_count_invalid');

    owner(fixture, () => seedActivity(fixture.store, 'bounded-plan-goal', 'goal'));
    const plan = owner(fixture, () => recordDecision(fixture.store, {
      agentId: 'goal.planner', decisionKind: 'goal_plan', triggerItemsId: 'bounded-plan-goal',
      triggerRevision: 2, proposal: { goal_items_id: 'bounded-plan-goal', steps: [{ title: 'A' }, { title: 'B' }] }
    }));
    const oversized = await resolve(fixture, plan.decision.id, 'accept', 'draft:oversized', {
      goal_items_id: 'bounded-plan-goal',
      steps: [{ title: 'A', description_md: 'x'.repeat(8001) }, { title: 'B', description_md: '' }]
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error, 'activity_description_invalid');
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM context_operations WHERE id IN ('draft:too-many','draft:oversized')").get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('25 labels activate one exact policy and audit rejection compensates and degrades it', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedAgent(fixture.store, 'goal.item-matcher');
    owner(fixture, () => {
      seedActivity(fixture.store, 'calibration-action', 'action');
      seedActivity(fixture.store, 'calibration-goal', 'goal');
    });
    let policyId;
    for (let index = 0; index < 24; index += 1) {
      const recorded = owner(fixture, () => recordDecision(fixture.store, {
        confidence: 0.8, triggerRevision: index + 1,
        proposal: { ...relationProposal('missing-action', 'missing-goal'), sample: index }
      }));
      policyId = recorded.decision.policy.id;
      fixture.store.db.prepare(`
        INSERT INTO context_policy_labels (
          policies_id, decisions_id, source, accepted, confidence, created_at_utc
        ) VALUES (?, ?, 'review', 1, 0.8, ?)
      `).run(policyId, recorded.decision.id, NOW);
    }
    const boundary = owner(fixture, () => recordDecision(fixture.store, {
      confidence: 0.8, triggerRevision: 25,
      proposal: { ...relationProposal('missing-action', 'missing-goal'), sample: 25 }
    }));
    const resolved = await resolve(fixture, boundary.decision.id, 'reject', 'calibration:25');
    assert.equal(resolved.status, 200);
    const active = fixture.store.db.prepare(`
      SELECT state, active_threshold, sample_count, accepted_count, observed_precision
      FROM context_policies WHERE id = ?
    `).get(policyId);
    assert.deepEqual(active, {
      state: 'active', active_threshold: 0.8, sample_count: 25,
      accepted_count: 24, observed_precision: 0.96
    });
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_notifications
      WHERE policies_id = ? AND kind = 'policy_activated'
    `).get(policyId).count, 1);

    const differentPrompt = owner(fixture, () => recordDecision(fixture.store, {
      promptVersion: 'prompt-2', confidence: 1, triggerItemsId: 'calibration-action',
      triggerRevision: 26, proposal: relationProposal('calibration-action', 'calibration-goal')
    }));
    assert.equal(differentPrompt.decision.status, 'pending');
    assert.notEqual(differentPrompt.decision.policy.id, policyId);

    const automatic = owner(fixture, () => recordDecision(fixture.store, {
      confidence: 0.8, triggerItemsId: 'calibration-action', triggerRevision: 27,
      proposal: relationProposal('calibration-action', 'calibration-goal')
    }));
    assert.equal(automatic.decision.status, 'auto_accepted');
    const relationId = automatic.decision.relation_ids[0];
    const batch = fixture.store.db.prepare(`
      INSERT INTO context_audit_batches (
        id, user_id, policies_id, status, window_started_at_utc,
        window_ended_at_utc, due_at_utc, created_at_utc, updated_at_utc
      ) VALUES ('audit-calibration', ?, ?, 'pending', ?, ?, ?, ?, ?)
      RETURNING id
    `).get(fixture.store.primaryUserId(), policyId, NOW, NOW,
      '2026-07-27T12:00:00.000Z', NOW, NOW);
    const item = fixture.store.db.prepare(`
      INSERT INTO context_audit_items (
        audit_batches_id, decisions_id, sample_kind, position, created_at_utc
      ) VALUES (?, ?, 'nearest_threshold', 0, ?) RETURNING id
    `).get(batch.id, automatic.decision.id, NOW);
    const auditState = await request(fixture.url, '/v1/context-decisions?status=audit');
    assert.equal(auditState.status, 200);
    assert.deepEqual(auditState.body.audits.map((entry) => entry.id), ['audit-calibration']);
    assert.deepEqual(auditState.body.audits[0].decision_ids, [automatic.decision.id]);
    assert.equal(auditState.body.audits[0].items[0].trigger_items_id, 'calibration-action');
    const audit = await request(fixture.url, `/v1/context-audits/${item.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: 'reject', idempotency_key: 'audit:reject' })
    });
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    assert.ok(audit.body.compensation_operation_id);
    assert.equal(fixture.store.db.prepare('SELECT status FROM relations WHERE id = ?').get(relationId).status, 'ended');
    assert.equal(fixture.store.db.prepare('SELECT status FROM context_decisions WHERE id = ?').get(automatic.decision.id).status, 'audit_rejected');
    assert.equal(fixture.store.db.prepare('SELECT state FROM context_policies WHERE id = ?').get(policyId).state, 'shadow');
    const auditReplay = await request(fixture.url, `/v1/context-audits/${item.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: 'reject', idempotency_key: 'audit:reject' })
    });
    assert.equal(auditReplay.status, 200);
    assert.equal(auditReplay.body.duplicate, true);
    const auditConflict = await request(fixture.url, `/v1/context-audits/${item.id}/resolve`, {
      method: 'POST', body: JSON.stringify({ resolution: 'accept', idempotency_key: 'audit:reject' })
    });
    assert.equal(auditConflict.status, 409);
    assert.equal(auditConflict.body.error, 'audit_resolution_idempotency_conflict');
  } finally {
    await fixture.close();
  }
});

function owner(fixture, callback) {
  return withUserScope(fixture.store.primaryUserId(), callback);
}

function recordDecision(store, overrides = {}) {
  return store.recordContextDecision({
    agentId: overrides.agentId ?? 'goal.item-matcher', agentVersion: '1',
    promptVersion: overrides.promptVersion ?? 'prompt-1', model: 'test-model', schemaVersion: '1',
    decisionKind: overrides.decisionKind ?? 'relation_add',
    triggerItemsId: overrides.triggerItemsId,
    triggerRevision: overrides.triggerRevision ?? 1,
    confidence: overrides.confidence ?? 0.8,
    rationale: 'Проверяемое предложение', evidence: overrides.evidence ?? [],
    proposal: overrides.proposal ?? relationProposal('missing-action', 'missing-goal'), nowIso: NOW
  });
}

function relationProposal(source, target) {
  return { relation_type_id: 'part_of', source_items_id: source, target_items_id: target };
}

function resolve(fixture, id, resolution, idempotencyKey, editedPayload) {
  return request(fixture.url, `/v1/context-decisions/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ resolution, idempotency_key: idempotencyKey, ...(editedPayload ? { edited_payload: editedPayload } : {}) })
  });
}

function seedAgent(store, id) {
  if (!store.primaryUserId()) {
    store.db.prepare(`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('context-owner', 'Context Owner', 'context-owner@example.test', true, now(), now())
    `).run();
    store.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES ('primary_user_id', 'context-owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(NOW);
  }
  store.db.prepare(`
    INSERT INTO agents (
      id, version, target, kind, status, title, summary, trigger_description,
      conditions_description, input_description, output_description,
      interactions_description, side_effects_description, source_module, updated_at_utc
    ) VALUES (?, '1', 'goal', 'runtime', 'active', ?, '', '', '', '', '', '', '', 'test', ?)
    ON CONFLICT (id) DO NOTHING
  `).run(id, id, NOW);
}

function seedActivity(store, id, type) {
  const userId = store.primaryUserId();
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, type, id, NOW, NOW, userId);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW });
}

function seedInbox(store, id, section) {
  const userId = store.primaryUserId();
  store.db.prepare(`
    INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, '', '', ?, ?)
  `).run(id, userId, id, NOW, NOW);
  const role = store.db.prepare(`
    INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
    SELECT ?, id, ?, 'active', '{}' FROM item_role_types WHERE title_system = 'inbox'
    RETURNING id
  `).get(id, NOW);
  store.db.prepare(`
    INSERT INTO inbox (
      id, title, record_type_id, preliminary_section, is_normalized, status,
      created_at_utc, updated_at_utc, user_id, item_roles_id
    ) VALUES (?, ?, 2, ?, 1, 'New', ?, ?, ?, ?)
  `).run(id, id, section, NOW, NOW, userId, role.id);
}

function seedAuditItem(fixture, decision, batchId, offset) {
  const start = new Date(Date.parse(NOW) + offset * 2000).toISOString();
  const end = new Date(Date.parse(start) + 1000).toISOString();
  fixture.store.db.prepare(`
    INSERT INTO context_audit_batches (
      id, user_id, policies_id, status, window_started_at_utc,
      window_ended_at_utc, due_at_utc, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
  `).run(batchId, fixture.store.primaryUserId(), decision.policy.id, start, end,
    '2026-07-27T12:00:00.000Z', NOW, NOW);
  return fixture.store.db.prepare(`
    INSERT INTO context_audit_items (
      audit_batches_id, decisions_id, sample_kind, position, created_at_utc
    ) VALUES (?, ?, 'nearest_threshold', 0, ?) RETURNING id
  `).get(batchId, decision.id, NOW).id;
}

function count(fixture, table) {
  assert.match(table, /^[a-z_]+$/);
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM ${table}`).get().count;
}

function hasCode(code, status) {
  return (error) => error?.code === code && error?.status === status;
}
