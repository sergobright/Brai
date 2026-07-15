import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvent, createFixture, request } from '../test-support/api.js';
import {
  NOW,
  activatePolicy,
  claimOwner,
  owner,
  seedActivity,
  seedCanonicalActivity
} from './goal-agent-test-support.js';

const T1 = '2026-07-13T16:01:00.000Z';
const T2 = '2026-07-13T16:02:00.000Z';
const T3 = '2026-07-13T16:03:00.000Z';
const T4 = '2026-07-13T16:04:00.000Z';
const T5 = '2026-07-13T16:05:00.000Z';

test('audit rejection preserves a later user type cycle and does not restore stale Relations', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'causal-action');
      seedActivity(fixture.store, 'causal-parent-goal', 'goal');
    });
    const originalRelation = seedRelation(
      fixture, 'causal-prior-relation', 'causal-action', 'causal-parent-goal'
    );
    activatePolicy(fixture, 'activity.classifier', 'activity_type_change', 0.8);
    const payload = typePayload('causal-action');
    const decision = recordAutoDecision(fixture, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      itemsId: 'causal-action', triggerRevision: 1, payload
    });

    assert.equal(decision.status, 'auto_accepted');
    assert.equal(activityType(fixture, 'causal-action'), 'goal');
    assert.equal(relationStatus(fixture, originalRelation.id), 'ended');
    const originalOperation = operation(fixture, decision.operation_id);
    assert.equal(
      originalOperation.compensation_json.applied_type_event_id,
      latestTypeEventId(fixture, 'causal-action')
    );

    syncActivityEvents(fixture, 'causal-user-device', [
      actionEvent('user-goal-to-action', 1, 'set_type', 'causal-action', T1, {
        from_activity_type_id: 'goal', to_activity_type_id: 'action'
      }),
      actionEvent('user-action-back-to-goal', 2, 'set_type', 'causal-action', T2, {
        from_activity_type_id: 'action', to_activity_type_id: 'goal'
      })
    ], T2);
    assert.equal(activityType(fixture, 'causal-action'), 'goal');
    assert.equal(latestTypeEventId(fixture, 'causal-action'), 'user-action-back-to-goal');
    const typeEventCountBeforeAudit = typeEventCount(fixture, 'causal-action');
    const auditItemId = seedAudit(fixture, decision, 'causal-audit');

    const rejected = owner(fixture, () => fixture.store.resolveContextAuditItem({
      auditItemId,
      action: 'reject',
      resolutionKey: 'causal-audit-reject',
      nowIso: T3
    }));

    assert.equal(rejected.status, 'rejected');
    assert.equal(activityType(fixture, 'causal-action'), 'goal');
    assert.equal(typeEventCount(fixture, 'causal-action'), typeEventCountBeforeAudit);
    assert.equal(latestTypeEventId(fixture, 'causal-action'), 'user-action-back-to-goal');
    assert.equal(activeMembershipCount(fixture, 'causal-action', 'causal-parent-goal'), 0);
    assert.equal(relationStatus(fixture, originalRelation.id), 'ended');
    assert.equal(operation(fixture, decision.operation_id).status, 'compensated');
    assert.equal(operation(fixture, rejected.compensation_operation_id).status, 'completed');
  } finally {
    await fixture.close();
  }
});

test('audit rejection preserves a later manual member Relation and its Goal type', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'graph-action');
      seedCanonicalActivity(fixture.store, 'graph-later-member');
      seedActivity(fixture.store, 'graph-parent-goal', 'goal');
    });
    const priorRelation = seedRelation(
      fixture, 'graph-prior-relation', 'graph-action', 'graph-parent-goal'
    );
    activatePolicy(fixture, 'activity.classifier', 'activity_type_change', 0.8);
    const decision = recordAutoDecision(fixture, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      itemsId: 'graph-action', triggerRevision: 2, payload: typePayload('graph-action')
    });
    assert.equal(activityType(fixture, 'graph-action'), 'goal');
    assert.equal(relationStatus(fixture, priorRelation.id), 'ended');
    const checkpoint = operation(fixture, decision.operation_id)
      .compensation_json.post_apply_relation_graph;
    assert.match(checkpoint.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(Number.isInteger(checkpoint.revision), true);

    const laterRelation = seedRelation(
      fixture, 'graph-later-relation', 'graph-later-member', 'graph-action'
    );
    const typeEventsBeforeAudit = typeEventCount(fixture, 'graph-action');
    const auditItemId = seedAudit(fixture, decision, 'graph-audit');
    const rejected = owner(fixture, () => fixture.store.resolveContextAuditItem({
      auditItemId,
      action: 'reject',
      resolutionKey: 'graph-audit-reject',
      nowIso: T3
    }));

    assert.equal(rejected.status, 'rejected');
    assert.equal(activityType(fixture, 'graph-action'), 'goal');
    assert.equal(typeEventCount(fixture, 'graph-action'), typeEventsBeforeAudit);
    assert.equal(relationStatus(fixture, laterRelation.id), 'active');
    assert.equal(activeMembershipCount(fixture, 'graph-later-member', 'graph-action'), 1);
    assert.equal(relationStatus(fixture, priorRelation.id), 'ended');
    assert.equal(activeMembershipCount(fixture, 'graph-action', 'graph-parent-goal'), 0);
  } finally {
    await fixture.close();
  }
});

test('unrelated Activity events allow valid type undo and compensated operations remain terminal replays', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'undo-type-action');
      seedActivity(fixture.store, 'undo-type-parent', 'goal');
    });
    const priorRelation = seedRelation(
      fixture, 'undo-type-prior-relation', 'undo-type-action', 'undo-type-parent'
    );
    activatePolicy(fixture, 'activity.classifier', 'activity_type_change', 0.8);
    const typeDecisionPayload = typePayload('undo-type-action');
    const typeDecision = recordAutoDecision(fixture, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      itemsId: 'undo-type-action', triggerRevision: 2, payload: typeDecisionPayload
    });
    assert.equal(activityType(fixture, 'undo-type-action'), 'goal');
    assert.equal(relationStatus(fixture, priorRelation.id), 'ended');

    syncActivityEvents(fixture, 'unrelated-user-device', [
      actionEvent('unrelated-title', 1, 'update_title', 'undo-type-action', T1, {
        title: 'Пользовательский заголовок'
      }),
      actionEvent('unrelated-status', 2, 'set_status', 'undo-type-action', T2, {
        status: 'New'
      })
    ], T2);
    assert.equal(latestTypeEventId(fixture, 'undo-type-action'),
      operation(fixture, typeDecision.operation_id).compensation_json.applied_type_event_id);

    owner(fixture, () => fixture.store.undoContextDecision({
      decisionId: typeDecision.id,
      operationId: 'undo:type-with-unrelated-events',
      nowIso: T3
    }));
    assert.equal(activityType(fixture, 'undo-type-action'), 'action');
    assert.equal(activityTitle(fixture, 'undo-type-action'), 'Пользовательский заголовок');
    assert.equal(activeMembershipCount(fixture, 'undo-type-action', 'undo-type-parent'), 1);

    const typeEventsAfterUndo = typeEventCount(fixture, 'undo-type-action');
    const typeReplay = owner(fixture, () => fixture.store.applyContextDecisionPackage({
      decision: typeDecision,
      payload: typeDecisionPayload,
      operationId: typeDecision.operation_id,
      nowIso: T4
    }));
    assert.deepEqual(typeReplay, {
      operation_id: typeDecision.operation_id,
      activity_id: 'undo-type-action'
    });
    assert.equal(activityType(fixture, 'undo-type-action'), 'action');
    assert.equal(typeEventCount(fixture, 'undo-type-action'), typeEventsAfterUndo);
    assert.equal(operation(fixture, typeDecision.operation_id).status, 'compensated');

    owner(fixture, () => {
      seedCanonicalActivity(fixture.store, 'replay-relation-action');
      seedActivity(fixture.store, 'replay-relation-goal', 'goal');
    });
    activatePolicy(fixture, 'goal.item-matcher', 'relation_add', 0.8);
    const relationPayload = {
      relation_type_id: 'part_of',
      source_items_id: 'replay-relation-action',
      target_items_id: 'replay-relation-goal'
    };
    const relationDecision = recordAutoDecision(fixture, {
      agentId: 'goal.item-matcher', decisionKind: 'relation_add',
      itemsId: 'replay-relation-action', triggerRevision: 3, payload: relationPayload
    });
    const relationId = relationDecision.relation_ids[0];
    owner(fixture, () => fixture.store.undoContextDecision({
      decisionId: relationDecision.id,
      operationId: 'undo:relation-replay',
      nowIso: T4
    }));
    assert.equal(relationStatus(fixture, relationId), 'ended');
    const eventCountBeforeReplay = eventCount(fixture);

    const relationReplay = owner(fixture, () => fixture.store.applyContextDecisionPackage({
      decision: relationDecision,
      payload: relationPayload,
      operationId: relationDecision.operation_id,
      nowIso: T5
    }));
    assert.deepEqual(relationReplay, {
      operation_id: relationDecision.operation_id,
      relation_id: relationId
    });
    assert.equal(relationStatus(fixture, relationId), 'ended');
    assert.equal(eventCount(fixture), eventCountBeforeReplay);
    assert.equal(operation(fixture, relationDecision.operation_id).status, 'compensated');
  } finally {
    await fixture.close();
  }
});

test('public undo cannot archive an auto-converted Inbox Activity after newer user intent', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedInbox(fixture.store, 'causal-inbox'));
    activatePolicy(fixture, 'activity.classifier', 'activity_type_change', 0.8);
    const decision = recordAutoDecision(fixture, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      itemsId: 'causal-inbox', triggerRevision: 10,
      payload: { items_id: 'causal-inbox', to_activity_type_id: 'action' }
    });
    assert.equal(decision.status, 'auto_accepted');

    syncActivityEvents(fixture, 'causal-inbox-user-device', [
      actionEvent('causal-inbox-user-title', 1, 'update_title', 'causal-inbox', T1, {
        title: 'Пользователь сохранил это действие'
      })
    ], T1);
    const undone = await request(fixture.url, `/v1/context-decisions/${decision.id}/undo`, {
      method: 'POST', body: JSON.stringify({ idempotency_key: 'undo:causal-inbox' })
    });

    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT title, deleted_at_utc FROM activities WHERE id = 'causal-inbox'
    `).get(), { title: 'Пользователь сохранил это действие', deleted_at_utc: null });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT title, deleted_at_utc FROM items WHERE id = 'causal-inbox'
    `).get(), { title: 'Пользователь сохранил это действие', deleted_at_utc: null });
    assert.equal(fixture.store.db.prepare(`
      SELECT r.status FROM inbox i JOIN item_roles r ON r.id = i.item_roles_id
      WHERE i.id = 'causal-inbox'
    `).get().status, 'ended');
  } finally {
    await fixture.close();
  }
});

test('valid Inbox conversion undo reactivates its role without deleting the shared Item', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => seedInbox(fixture.store, 'restored-inbox'));
    activatePolicy(fixture, 'activity.classifier', 'activity_type_change', 0.8);
    const decision = recordAutoDecision(fixture, {
      agentId: 'activity.classifier', decisionKind: 'activity_type_change',
      itemsId: 'restored-inbox', triggerRevision: 11,
      payload: { items_id: 'restored-inbox', to_activity_type_id: 'action' }
    });
    assert.equal(decision.status, 'auto_accepted');

    const undone = await request(fixture.url, `/v1/context-decisions/${decision.id}/undo`, {
      method: 'POST', body: JSON.stringify({ idempotency_key: 'undo:restore-inbox' })
    });

    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.equal(fixture.store.db.prepare(`
      SELECT deleted_at_utc FROM items WHERE id = 'restored-inbox'
    `).get().deleted_at_utc, null);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT r.status, r.active_to_utc FROM inbox i JOIN item_roles r ON r.id = i.item_roles_id
      WHERE i.id = 'restored-inbox'
    `).get(), { status: 'active', active_to_utc: null });
    assert.ok(fixture.store.db.prepare(`
      SELECT deleted_at_utc FROM activities WHERE id = 'restored-inbox'
    `).get().deleted_at_utc);
    const inbox = await request(fixture.url, '/v1/inbox');
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.inbox.some((item) => item.id === 'restored-inbox'), true);
  } finally {
    await fixture.close();
  }
});

function recordAutoDecision(fixture, {
  agentId, decisionKind, itemsId, triggerRevision, payload
}) {
  const agent = fixture.store.getAgent(agentId);
  return owner(fixture, () => fixture.store.recordContextDecision({
    agentId,
    agentVersion: agent.version,
    promptVersion: agent.prompt_version,
    model: 'test-model',
    schemaVersion: agent.schema_version,
    decisionKind,
    triggerItemsId: itemsId,
    triggerRevision,
    confidence: 0.8,
    rationale: 'Проверка причинности компенсации',
    evidence: [],
    proposal: payload,
    nowIso: NOW
  })).decision;
}

function seedRelation(fixture, id, sourceItemsId, targetItemsId) {
  return owner(fixture, () => fixture.store.createRelation({
    id,
    relationTypeId: 'part_of',
    sourceItemsId,
    targetItemsId,
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
    '2026-07-27T16:00:00.000Z', NOW, NOW);
  return fixture.store.db.prepare(`
    INSERT INTO context_audit_items (
      audit_batches_id, decisions_id, sample_kind, position, created_at_utc
    ) VALUES (?, ?, 'nearest_threshold', 0, ?) RETURNING id
  `).get(batch.id, decision.id, NOW).id;
}

function syncActivityEvents(fixture, deviceId, events, nowIso) {
  const result = owner(fixture, () => fixture.store.syncActivityEvents({
    device: { device_id: deviceId, platform: 'test' },
    events,
    nowIso
  }));
  assert.deepEqual(result.ignored_events, []);
}

function seedInbox(store, id) {
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
    ) VALUES (?, ?, 2, 'follow_up', 1, 'New', ?, ?, ?, ?)
  `).run(id, id, NOW, NOW, userId, role.id);
}

function typePayload(itemsId) {
  return {
    items_id: itemsId,
    from_activity_type_id: 'action',
    to_activity_type_id: 'goal'
  };
}

function operation(fixture, id) {
  return fixture.store.db.prepare(`
    SELECT status, result_json, compensation_json FROM context_operations
    WHERE id = ? AND user_id = ?
  `).get(id, fixture.store.primaryUserId());
}

function latestTypeEventId(fixture, itemsId) {
  return fixture.store.db.prepare(`
    SELECT event_id FROM events
    WHERE event_domain = 'activity' AND event_type = 'set_type'
      AND status = 'accepted' AND items_id = ?
    ORDER BY occurred_at_utc DESC, domain_sequence DESC LIMIT 1
  `).get(itemsId)?.event_id ?? null;
}

function typeEventCount(fixture, itemsId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM events
    WHERE event_domain = 'activity' AND event_type = 'set_type' AND items_id = ?
  `).get(itemsId).count;
}

function activeMembershipCount(fixture, sourceItemsId, targetItemsId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM relations
    WHERE relation_types_id = 'part_of' AND source_items_id = ?
      AND target_items_id = ? AND status = 'active'
  `).get(sourceItemsId, targetItemsId).count;
}

function activityType(fixture, id) {
  return fixture.store.db.prepare('SELECT activity_type_id FROM activities WHERE id = ?').get(id)?.activity_type_id;
}

function activityTitle(fixture, id) {
  return fixture.store.db.prepare('SELECT title FROM activities WHERE id = ?').get(id)?.title;
}

function relationStatus(fixture, id) {
  return fixture.store.db.prepare('SELECT status FROM relations WHERE id = ?').get(id)?.status;
}

function eventCount(fixture) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM events').get().count;
}
