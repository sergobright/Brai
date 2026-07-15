import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvent, createFixture, request } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const T0 = '2026-07-13T12:00:00.000Z';

test('v1 part_of becomes end-invalid and Goal reopen keeps exact type-change causality', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    createActivities(fixture, 'invalid', [
      ['invalid-a', 'action'], ['invalid-b', 'action'], ['invalid-goal', 'goal']
    ]);
    syncActivity(fixture, 'invalid-done', [
      actionEvent('invalid-a-done', 1, 'set_status', 'invalid-a', at(1), { status: 'Done' }),
      actionEvent('invalid-b-done', 2, 'set_status', 'invalid-b', at(1), { status: 'Done' })
    ], at(1));
    createRelation(fixture, 'invalid-rel-a', 'invalid-a', 'invalid-goal', 'part_of', 0);
    createRelation(fixture, 'invalid-rel-b', 'invalid-b', 'invalid-goal', 'part_of', 1);
    syncActivity(fixture, 'invalid-complete', [
      actionEvent('invalid-goal-done', 1, 'set_status', 'invalid-goal', at(2), { status: 'Done' })
    ], at(2));

    syncActivity(fixture, 'invalid-type', [
      actionEvent('invalid-type-event', 1, 'set_type', 'invalid-a', at(3), {
        from_activity_type_id: 'action', to_activity_type_id: 'goal',
        operation_id: 'operation:invalid-type'
      })
    ], at(3));

    const ended = relation(fixture, 'invalid-rel-a');
    assert.equal(ended.status, 'ended');
    assert.equal(ended.end_reason, 'activity_type_changed:end_invalid');
    assert.equal(ended.ended_operation_id, 'operation:invalid-type');
    const repair = relationEvent(fixture, 'invalid-rel-a', 'end');
    assert.deepEqual(repair.payload, {
      causal_event_id: 'invalid-type-event',
      causal_operation_id: 'operation:invalid-type',
      reason: 'activity_type_changed:end_invalid',
      reconciliation_outcome: 'end_invalid',
      replacement_error: null,
      replacement_relation_id: null
    });
    assert.deepEqual(goalReopenPayload(fixture, 'invalid-goal'), {
      causal_event_id: 'invalid-type-event',
      causal_operation_id: 'operation:invalid-type',
      reason: 'activity_type_changed'
    });
  } finally {
    await fixture.close();
  }
});

test('type-change reconciliation keeps a valid orientation and reverses only by endpoint rules', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    fixture.store.db.prepare('DELETE FROM agents').run();
    createActivities(fixture, 'generic', [
      ['keep-source', 'action'], ['keep-target', 'goal'], ['reverse-activity', 'action']
    ]);
    seedOperation(fixture, 'reverse-operation');
    seedRelationType(fixture, 'keep_type', [
      ['activity', 'action', 'activity', 'goal'],
      ['activity', 'action', 'activity', 'action']
    ]);
    seedRelationType(fixture, 'reverse_type', [
      ['activity', 'action', 'inbox', 'operation'],
      ['inbox', 'operation', 'activity', 'goal']
    ]);
    createRelation(fixture, 'keep-relation', 'keep-source', 'keep-target', 'keep_type');
    createRelation(fixture, 'reverse-relation', 'reverse-activity', 'reverse-operation', 'reverse_type');

    syncActivity(fixture, 'generic-type', [
      actionEvent('keep-type-event', 1, 'set_type', 'keep-target', at(1), {
        from_activity_type_id: 'goal', to_activity_type_id: 'action', operation_id: 'operation:keep'
      }),
      actionEvent('reverse-type-event', 2, 'set_type', 'reverse-activity', at(2), {
        from_activity_type_id: 'action', to_activity_type_id: 'goal', operation_id: 'operation:reverse'
      })
    ], at(2));

    assert.equal(relation(fixture, 'keep-relation').status, 'active');
    assert.equal(relationEventCount(fixture, 'keep-relation', 'end'), 0);
    const ended = relation(fixture, 'reverse-relation');
    assert.equal(ended.status, 'ended');
    assert.equal(ended.end_reason, 'activity_type_changed:end_reverse');
    const replacement = fixture.store.db.prepare(`
      SELECT * FROM relations WHERE relation_types_id = 'reverse_type' AND status = 'active'
    `).get();
    assert.equal(replacement.source_items_id, 'reverse-operation');
    assert.equal(replacement.target_items_id, 'reverse-activity');
    assert.deepEqual(JSON.parse(replacement.metadata_json), {
      causal_event_id: 'reverse-type-event',
      prior_relation_id: 'reverse-relation',
      reconciliation_outcome: 'reverse'
    });
    assert.equal(relationEvent(fixture, 'reverse-relation', 'end').payload.replacement_relation_id, replacement.id);
  } finally {
    await fixture.close();
  }
});

test('one Activity batch attributes each reopened Goal to its own causal event and operation', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    createActivities(fixture, 'batch', [
      ['batch-a1', 'action'], ['batch-a2', 'action'], ['batch-goal-a', 'goal'],
      ['batch-b1', 'action'], ['batch-b2', 'action'], ['batch-goal-b', 'goal']
    ]);
    syncActivity(fixture, 'batch-members-done', [
      actionEvent('batch-a1-done', 1, 'set_status', 'batch-a1', at(1), { status: 'Done' }),
      actionEvent('batch-a2-done', 2, 'set_status', 'batch-a2', at(1), { status: 'Done' }),
      actionEvent('batch-b1-done', 3, 'set_status', 'batch-b1', at(1), { status: 'Done' }),
      actionEvent('batch-b2-done', 4, 'set_status', 'batch-b2', at(1), { status: 'Done' })
    ], at(1));
    createRelation(fixture, 'batch-rel-a1', 'batch-a1', 'batch-goal-a', 'part_of', 0);
    createRelation(fixture, 'batch-rel-a2', 'batch-a2', 'batch-goal-a', 'part_of', 1);
    createRelation(fixture, 'batch-rel-b1', 'batch-b1', 'batch-goal-b', 'part_of', 0);
    createRelation(fixture, 'batch-rel-b2', 'batch-b2', 'batch-goal-b', 'part_of', 1);
    syncActivity(fixture, 'batch-goals-done', [
      actionEvent('batch-goal-a-done', 1, 'set_status', 'batch-goal-a', at(2), { status: 'Done' }),
      actionEvent('batch-goal-b-done', 2, 'set_status', 'batch-goal-b', at(2), { status: 'Done' })
    ], at(2));

    syncActivity(fixture, 'batch-reopen', [
      actionEvent('batch-cause-a', 1, 'set_status', 'batch-a1', at(3), {
        status: 'New', operation_id: 'operation:batch-a'
      }),
      actionEvent('batch-cause-b', 2, 'set_status', 'batch-b1', at(3), {
        status: 'New', operation_id: 'operation:batch-b'
      })
    ], at(3));

    assert.deepEqual(goalReopenPayload(fixture, 'batch-goal-a'), {
      causal_event_id: 'batch-cause-a',
      causal_operation_id: 'operation:batch-a',
      reason: 'member_activity_changed'
    });
    assert.deepEqual(goalReopenPayload(fixture, 'batch-goal-b'), {
      causal_event_id: 'batch-cause-b',
      causal_operation_id: 'operation:batch-b',
      reason: 'member_activity_changed'
    });
  } finally {
    await fixture.close();
  }
});

test('one Relation sync batch rechecks only each event target with its own causal operation', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    createActivities(fixture, 'relation-batch', [
      ['relation-a1', 'action'], ['relation-a2', 'action'], ['relation-goal-a', 'goal'],
      ['relation-b1', 'action'], ['relation-b2', 'action'], ['relation-goal-b', 'goal']
    ]);
    syncActivity(fixture, 'relation-members-done', [
      actionEvent('relation-a1-done', 1, 'set_status', 'relation-a1', at(1), { status: 'Done' }),
      actionEvent('relation-a2-done', 2, 'set_status', 'relation-a2', at(1), { status: 'Done' }),
      actionEvent('relation-b1-done', 3, 'set_status', 'relation-b1', at(1), { status: 'Done' }),
      actionEvent('relation-b2-done', 4, 'set_status', 'relation-b2', at(1), { status: 'Done' })
    ], at(1));
    createRelation(fixture, 'relation-rel-a1', 'relation-a1', 'relation-goal-a', 'part_of', 0);
    createRelation(fixture, 'relation-rel-a2', 'relation-a2', 'relation-goal-a', 'part_of', 1);
    createRelation(fixture, 'relation-rel-b1', 'relation-b1', 'relation-goal-b', 'part_of', 0);
    createRelation(fixture, 'relation-rel-b2', 'relation-b2', 'relation-goal-b', 'part_of', 1);
    syncActivity(fixture, 'relation-goals-done', [
      actionEvent('relation-goal-a-done', 1, 'set_status', 'relation-goal-a', at(2), { status: 'Done' }),
      actionEvent('relation-goal-b-done', 2, 'set_status', 'relation-goal-b', at(2), { status: 'Done' })
    ], at(2));

    const response = await request(fixture.url, '/v1/relations/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'relation-batch-device', platform: 'web' },
        events: [
          {
            event_id: 'relation-cause-a', client_sequence: 1, change_type: 'end',
            relation_id: 'relation-rel-a1', occurred_at_utc: at(3), payload_version: 1,
            payload: { reason: 'removed_by_user', operation_id: 'operation:relation-a' }
          },
          {
            event_id: 'relation-cause-b', client_sequence: 2, change_type: 'end',
            relation_id: 'relation-rel-b1', occurred_at_utc: at(3), payload_version: 1,
            payload: { reason: 'removed_by_user', operation_id: 'operation:relation-b' }
          }
        ]
      })
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(goalReopenPayload(fixture, 'relation-goal-a'), {
      causal_event_id: 'relation-cause-a',
      causal_operation_id: 'operation:relation-a',
      reason: 'relation_changed'
    });
    assert.deepEqual(goalReopenPayload(fixture, 'relation-goal-b'), {
      causal_event_id: 'relation-cause-b',
      causal_operation_id: 'operation:relation-b',
      reason: 'relation_changed'
    });
  } finally {
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ('reconciliation-owner', 'Owner', 'reconciliation@example.test', true, now(), now())
  `).run();
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc) VALUES ('primary_user_id', 'reconciliation-owner', ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(T0);
}

function owner(fixture, callback) {
  return withUserScope(fixture.store.primaryUserId(), callback);
}

function createActivities(fixture, deviceId, definitions) {
  syncActivity(fixture, `${deviceId}-create`, definitions.map(([id, type], index) =>
    actionEvent(`${deviceId}-create-${id}`, index + 1, 'create', id, T0, {
      title: id, activity_type_id: type
    })), T0);
  owner(fixture, () => definitions.forEach(([id]) =>
    fixture.store.ensureActivityRoleLink(fixture.store.getActivityItem(id))));
}

function syncActivity(fixture, deviceId, events, nowIso) {
  return owner(fixture, () => fixture.store.syncActivityEvents({
    device: { device_id: deviceId, platform: 'web' }, events, nowIso
  }));
}

function createRelation(fixture, id, source, target, type, position = null) {
  return owner(fixture, () => fixture.store.createRelationWithEvent({
    id, relationTypeId: type, sourceItemsId: source, targetItemsId: target, position,
    operationId: `operation:${id}`, actorType: 'user', actorId: 'reconciliation-owner', nowIso: T0
  }));
}

function seedRelationType(fixture, id, rules) {
  owner(fixture, () => {
    const userId = fixture.store.primaryUserId();
    fixture.store.db.prepare(`
      INSERT INTO relation_types (
        id, user_id, key, title, description, directionality, source_label, target_label,
        is_ordered, status, is_system, created_by_actor_type, created_by_actor_id,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, '', 'directed', 'source', 'target', 0, 'active', 0, 'user', ?, ?, ?)
    `).run(id, userId, id, id, userId, T0, T0);
    const insert = fixture.store.db.prepare(`
      INSERT INTO relation_type_endpoint_rules (
        relation_types_id, source_role_key, source_type_key, target_role_key, target_type_key,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const rule of rules) insert.run(id, ...rule, T0, T0);
  });
}

function seedOperation(fixture, id) {
  owner(fixture, () => {
    const userId = fixture.store.primaryUserId();
    fixture.store.db.prepare(`
      INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, '', '', ?, ?)
    `).run(id, userId, id, T0, T0);
    const role = fixture.store.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
      SELECT ?, id, ?, 'active', '{}' FROM item_role_types WHERE title_system = 'inbox' RETURNING id
    `).get(id, T0);
    fixture.store.db.prepare(`
      INSERT INTO inbox (
        id, title, record_type_id, preliminary_section, is_normalized, status,
        created_at_utc, updated_at_utc, user_id, item_roles_id
      ) VALUES (?, ?, 2, 'operation', 1, 'Done', ?, ?, ?, ?)
    `).run(id, id, T0, T0, userId, role.id);
  });
}

function relation(fixture, id) {
  return fixture.store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

function relationEvent(fixture, id, type) {
  const row = fixture.store.db.prepare(`
    SELECT payload_json FROM events
    WHERE event_domain = 'relation' AND event_type = ? AND subject_id = ?
    ORDER BY domain_sequence DESC LIMIT 1
  `).get(type, id);
  return JSON.parse(row.payload_json);
}

function relationEventCount(fixture, id, type) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM events
    WHERE event_domain = 'relation' AND event_type = ? AND subject_id = ?
  `).get(type, id).count;
}

function goalReopenPayload(fixture, goalId) {
  const row = fixture.store.db.prepare(`
    SELECT payload_json FROM events
    WHERE event_domain = 'activity' AND event_action = 'activity.goal_reopened' AND subject_id = ?
    ORDER BY domain_sequence DESC LIMIT 1
  `).get(goalId);
  return JSON.parse(row.payload_json);
}

function at(minutes) {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}
