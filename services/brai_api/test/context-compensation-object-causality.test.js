import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvent, createFixture } from '../test-support/api.js';
import {
  NOW,
  activatePolicy,
  claimOwner,
  owner,
  seedActivity,
  seedCanonicalActivity
} from './goal-agent-test-support.js';

const T1 = '2026-07-13T17:01:00.000Z';
const T2 = '2026-07-13T17:02:00.000Z';
const T3 = '2026-07-13T17:03:00.000Z';

test('audit rejection preserves a reordered auto Relation', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'reorder-auto-member');
      seedCanonicalActivity(fixture.store, 'reorder-existing-member');
      seedActivity(fixture.store, 'reorder-goal', 'goal');
    });
    const existing = seedRelation(
      fixture, 'reorder-existing-relation', 'reorder-existing-member', 'reorder-goal', 0
    );
    activatePolicy(fixture, 'goal.item-matcher', 'relation_add', 0.8);
    const payload = {
      relation_type_id: 'part_of',
      source_items_id: 'reorder-auto-member',
      target_items_id: 'reorder-goal',
      position: 1
    };
    const decision = recordDecision(fixture, {
      agentId: 'goal.item-matcher', decisionKind: 'relation_add',
      itemsId: 'reorder-auto-member', payload
    });
    const automaticId = decision.relation_ids[0];

    owner(fixture, () => fixture.store.reorderRelationsWithEvent({
      relationTypeId: 'part_of',
      targetItemsId: 'reorder-goal',
      orderedRelationIds: [automaticId, existing.id],
      operationId: 'user:reorder-after-auto',
      actorType: 'user',
      nowIso: T1
    }));
    const auditItemId = seedAudit(fixture, decision, 'reorder-audit');
    owner(fixture, () => fixture.store.resolveContextAuditItem({
      auditItemId,
      action: 'reject',
      resolutionKey: 'reorder-audit-reject',
      nowIso: T2
    }));

    assert.deepEqual(goalOrder(fixture, 'reorder-goal'), [automaticId, existing.id]);
    assert.equal(relation(fixture, automaticId).status, 'active');
  } finally {
    await fixture.close();
  }
});

test('late discovery compensation preserves a user-edited generated Goal and memberships', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'discovery-member-a');
      seedCanonicalActivity(fixture.store, 'discovery-member-b');
    });
    const payload = {
      title: 'Черновая цель',
      member_items_ids: ['discovery-member-a', 'discovery-member-b']
    };
    const decision = recordDecision(fixture, {
      agentId: 'goal.discovery', decisionKind: 'goal_discovery', payload
    });
    const operationId = 'accepted:causal-discovery';
    const result = applyPackage(fixture, decision, payload, operationId);

    syncActivityEvents(fixture, 'discovery-edit-device', [
      actionEvent('discovery-user-title', 1, 'update_title', result.activity_id, T1, {
        title: 'Пользовательская цель'
      })
    ], T1);
    compensatePackage(fixture, decision, operationId, 'undo:causal-discovery', T2);

    assert.deepEqual(activity(fixture, result.activity_id), {
      title: 'Пользовательская цель', status: 'New', deleted_at_utc: null
    });
    assert.equal(result.relation_ids.every((id) => relation(fixture, id).status === 'active'), true);
  } finally {
    await fixture.close();
  }
});

test('late plan compensation preserves a changed generated Action and removes untouched siblings', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedActivity(fixture.store, 'plan-causal-goal', 'goal'));
    const payload = {
      goal_items_id: 'plan-causal-goal',
      actions: [{ title: 'Изменяемый шаг' }, { title: 'Нетронутый шаг' }]
    };
    const decision = recordDecision(fixture, {
      agentId: 'goal.planner', decisionKind: 'goal_plan',
      itemsId: 'plan-causal-goal', payload
    });
    const operationId = 'accepted:causal-plan';
    const result = applyPackage(fixture, decision, payload, operationId);
    const [changedActionId, untouchedActionId] = result.activity_ids;
    const [changedRelationId, untouchedRelationId] = result.relation_ids;

    syncActivityEvents(fixture, 'plan-edit-device', [
      actionEvent('plan-user-status', 1, 'set_status', changedActionId, T1, { status: 'Done' })
    ], T1);
    compensatePackage(fixture, decision, operationId, 'undo:causal-plan', T3);

    assert.deepEqual(activity(fixture, changedActionId), {
      title: 'Изменяемый шаг', status: 'Done', deleted_at_utc: null
    });
    assert.equal(relation(fixture, changedRelationId).status, 'active');
    assert.ok(activity(fixture, untouchedActionId).deleted_at_utc);
    assert.equal(relation(fixture, untouchedRelationId).status, 'ended');
  } finally {
    await fixture.close();
  }
});

let revision = 20;

function recordDecision(fixture, { agentId, decisionKind, itemsId = null, payload }) {
  const agent = fixture.store.getAgent(agentId);
  revision += 1;
  return owner(fixture, () => fixture.store.recordContextDecision({
    agentId,
    agentVersion: agent.version,
    promptVersion: agent.prompt_version,
    model: 'test-model',
    schemaVersion: agent.schema_version,
    decisionKind,
    triggerItemsId: itemsId,
    triggerRevision: revision,
    confidence: 0.8,
    rationale: 'Проверка причинности объектной компенсации',
    evidence: [],
    proposal: payload,
    nowIso: NOW
  })).decision;
}

function applyPackage(fixture, decision, payload, operationId) {
  return owner(fixture, () => fixture.store.applyContextDecisionPackage({
    decision, payload, operationId, nowIso: NOW
  }));
}

function compensatePackage(fixture, decision, originalOperationId, operationId, nowIso) {
  return owner(fixture, () => fixture.store.compensateContextDecision({
    decision: { ...decision, operation_id: originalOperationId },
    operationId,
    nowIso
  }));
}

function syncActivityEvents(fixture, deviceId, events, nowIso) {
  const result = owner(fixture, () => fixture.store.syncActivityEvents({
    device: { device_id: deviceId, platform: 'test' }, events, nowIso
  }));
  assert.deepEqual(result.ignored_events, []);
}

function seedRelation(fixture, id, sourceItemsId, targetItemsId, position) {
  return owner(fixture, () => fixture.store.createRelation({
    id,
    relationTypeId: 'part_of',
    sourceItemsId,
    targetItemsId,
    position,
    operationId: `seed:${id}`,
    actorType: 'user',
    nowIso: NOW
  })).relation;
}

function seedAudit(fixture, decision, id) {
  const batch = fixture.store.db.prepare(`
    INSERT INTO context_audit_batches (
      id, user_id, policies_id, status, window_started_at_utc,
      window_ended_at_utc, due_at_utc, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?) RETURNING id
  `).get(id, fixture.store.primaryUserId(), decision.policy.id, NOW, NOW,
    '2026-07-27T17:00:00.000Z', NOW, NOW);
  return fixture.store.db.prepare(`
    INSERT INTO context_audit_items (
      audit_batches_id, decisions_id, sample_kind, position, created_at_utc
    ) VALUES (?, ?, 'nearest_threshold', 0, ?) RETURNING id
  `).get(batch.id, decision.id, NOW).id;
}

function activity(fixture, id) {
  return fixture.store.db.prepare(`
    SELECT title, status, deleted_at_utc FROM activities WHERE id = ?
  `).get(id);
}

function relation(fixture, id) {
  return fixture.store.db.prepare('SELECT status, position FROM relations WHERE id = ?').get(id);
}

function goalOrder(fixture, goalId) {
  return fixture.store.db.prepare(`
    SELECT id FROM relations WHERE target_items_id = ? AND status = 'active'
    ORDER BY position, id
  `).all(goalId).map((row) => row.id);
}
