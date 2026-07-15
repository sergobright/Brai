import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const OWNER = 'relations-owner';
const NOW = '2026-07-13T10:00:00.000Z';

test('Relation sync preserves lifecycle, dense Goal order, and completion read state', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'action-a', 'action', 'New');
      seedActivity(fixture.store, 'action-b', 'action', 'Done');
      seedActivity(fixture.store, 'goal-a', 'goal', 'New');
    });

    const first = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-a', platform: 'web' },
      events: [relationEvent('relation-event-1', 1, 'create', 'relation-a', {
        relation_type_id: 'part_of',
        source_items_id: 'action-a',
        target_items_id: 'goal-a',
        position: 0
      })],
      nowIso: NOW
    }));
    assert.deepEqual(first.acknowledged_event_ids, ['relation-event-1']);
    assert.deepEqual(first.ignored_events, []);
    assert.equal(first.server_revision, 1);
    assert.deepEqual(owned(fixture, () => fixture.store.listRelations({ status: 'active' })).map(compactRelation), [
      { id: 'relation-a', source: 'action-a', target: 'goal-a', status: 'active', position: 0 }
    ]);
    assert.deepEqual(discoveryWatermark(fixture), { relevant_sequence: 1, relevant_change_count: 1 });

    const replay = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-a', platform: 'web' },
      events: [relationEvent('relation-event-1', 1, 'create', 'relation-a', {
        relation_type_id: 'part_of',
        source_items_id: 'action-a',
        target_items_id: 'goal-a',
        position: 0
      })],
      nowIso: NOW
    }));
    assert.equal(replay.server_revision, 1);
    assert.equal(rowCount(fixture, 'relations'), 1);
    assert.deepEqual(discoveryWatermark(fixture), { relevant_sequence: 1, relevant_change_count: 1 });

    const ended = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-a', platform: 'web' },
      events: [relationEvent('relation-event-2', 2, 'end', 'relation-a', { reason: 'removed_by_user' })],
      nowIso: '2026-07-13T10:01:00.000Z'
    }));
    assert.equal(ended.server_revision, 2);
    const endedRow = fixture.store.db.prepare(`
      SELECT status, active_to_utc, operation_id, ended_operation_id,
        created_by_actor_type, ended_by_actor_type, end_reason
      FROM relations WHERE id = 'relation-a'
    `).get();
    assert.deepEqual(endedRow, {
      status: 'ended',
      active_to_utc: '2026-07-13T10:01:00.000Z',
      operation_id: 'relation-event-1',
      ended_operation_id: 'relation-event-2',
      created_by_actor_type: 'user',
      ended_by_actor_type: 'user',
      end_reason: 'removed_by_user'
    });

    owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-a', platform: 'web' },
      events: [
        relationEvent('relation-event-3', 3, 'create', 'relation-a-2', {
          relation_type_id: 'part_of', source_items_id: 'action-a', target_items_id: 'goal-a'
        }),
        relationEvent('relation-event-4', 4, 'create', 'relation-b', {
          relation_type_id: 'part_of', source_items_id: 'action-b', target_items_id: 'goal-a', position: 0
        })
      ],
      nowIso: '2026-07-13T10:02:00.000Z'
    }));
    assert.deepEqual(
      owned(fixture, () => fixture.store.listGoalMembers('goal-a')).map(({ relation_id, items_id, position }) => ({ relation_id, items_id, position })),
      [
        { relation_id: 'relation-b', items_id: 'action-b', position: 0 },
        { relation_id: 'relation-a-2', items_id: 'action-a', position: 1 }
      ]
    );

    const reordered = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-a', platform: 'web' },
      events: [relationEvent('relation-event-5', 5, 'reorder', null, {
        relation_type_id: 'part_of',
        target_items_id: 'goal-a',
        ordered_relation_ids: ['relation-a-2', 'relation-b']
      }, 4)],
      nowIso: '2026-07-13T10:03:00.000Z'
    }));
    assert.deepEqual(reordered.ignored_events, []);
    assert.deepEqual(
      owned(fixture, () => fixture.store.listGoalMembers('goal-a')).map(({ relation_id, position }) => ({ relation_id, position })),
      [{ relation_id: 'relation-a-2', position: 0 }, { relation_id: 'relation-b', position: 1 }]
    );

    assert.deepEqual(completionSummary(owned(fixture, () => fixture.store.goalCompletionState('goal-a'))), {
      member_count: 2, done_count: 1, all_done: false, eligible: false
    });
    fixture.store.db.prepare("UPDATE activities SET status = 'Done' WHERE id = 'action-a'").run();
    assert.deepEqual(completionSummary(owned(fixture, () => fixture.store.goalCompletionState('goal-a'))), {
      member_count: 2, done_count: 2, all_done: true, eligible: true
    });

    const cascade = owned(fixture, () => fixture.store.endRelationsForItem('action-b', {
      reason: 'member_deleted',
      operationId: 'operation:delete-action-b',
      actorType: 'system',
      actorId: 'activity-owner',
      nowIso: '2026-07-13T10:04:00.000Z'
    }));
    assert.deepEqual(cascade.ended_relation_ids, ['relation-b']);
    assert.deepEqual(cascade.affected_goal_ids, ['goal-a']);
    assert.deepEqual(completionSummary(owned(fixture, () => fixture.store.goalCompletionState('goal-a'))), {
      member_count: 1, done_count: 1, all_done: true, eligible: false
    });
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM events
      WHERE event_domain = 'relation' AND event_action = 'relation.ended'
    `).get().count, 2);
  } finally {
    await fixture.close();
  }
});

test('Relations accept normalized Operations and persist rejected or conflicting sync outcomes', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'goal-operation', 'goal', 'New');
      seedOperation(fixture.store, 'operation-item', 'Done');
    });
    const accepted = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-operation', platform: 'android' },
      events: [relationEvent('operation-relation-event', 1, 'create', 'operation-relation', {
        relation_type_id: 'part_of', source_items_id: 'operation-item', target_items_id: 'goal-operation'
      })],
      nowIso: NOW
    }));
    assert.deepEqual(accepted.ignored_events, []);
    assert.equal(owned(fixture, () => fixture.store.listGoalMembers('goal-operation'))[0].type_key, 'operation');

    withUserScope('another-owner', () => seedActivity(fixture.store, 'foreign-action', 'action', 'New'));
    const rejected = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'relation-device-operation', platform: 'android' },
      events: [relationEvent('foreign-relation-event', 2, 'create', 'foreign-relation', {
        relation_type_id: 'part_of', source_items_id: 'foreign-action', target_items_id: 'goal-operation'
      })],
      nowIso: '2026-07-13T10:01:00.000Z'
    }));
    assert.deepEqual(rejected.ignored_events, [
      { event_id: 'foreign-relation-event', reason: 'invalid_relation_endpoints' }
    ]);
    const ignored = fixture.store.db.prepare(`
      SELECT status, ignore_reason FROM events
      WHERE event_domain = 'relation' AND event_id = 'foreign-relation-event'
    `).get();
    assert.deepEqual(ignored, { status: 'ignored', ignore_reason: 'invalid_relation_endpoints' });
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM relations WHERE id = 'foreign-relation'").get().count, 0);

    assert.throws(
      () => owned(fixture, () => fixture.store.syncRelationEvents({
        device: { device_id: 'relation-device-operation', platform: 'android' },
        events: [relationEvent('operation-relation-event', 1, 'create', 'operation-relation', {
          relation_type_id: 'part_of', source_items_id: 'operation-item', target_items_id: 'goal-operation', position: 9
        })],
        nowIso: NOW
      })),
      (error) => error.code === 'idempotency_conflict' && error.status === 409
    );

    owned(fixture, () => fixture.store.createRelation({
      id: 'second-operation-relation',
      relationTypeId: 'part_of',
      sourceItemsId: 'operation-item',
      targetItemsId: 'goal-operation',
      operationId: 'manual-duplicate',
      actorType: 'user',
      nowIso: NOW
    }));
    assert.equal(rowCount(fixture, 'relations'), 1);
  } finally {
    await fixture.close();
  }
});

test('Relation sync defers a same-user raw Activity endpoint until normalization completes', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'deferred-goal', 'goal', 'New');
      seedRawActivity(fixture.store, 'deferred-action');
    });
    const event = relationEvent('deferred-relation-event', 1, 'create', 'deferred-relation', {
      relation_type_id: 'part_of', source_items_id: 'deferred-action', target_items_id: 'deferred-goal'
    });
    const first = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'deferred-device', platform: 'web' }, events: [event], nowIso: NOW
    }));
    assert.deepEqual(first.acknowledged_event_ids, []);
    assert.deepEqual(first.ignored_events, []);
    assert.deepEqual(first.deferred_events, [{ event_id: 'deferred-relation-event', reason: 'endpoint_not_ready' }]);
    assert.equal(first.server_revision, 0);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM events WHERE event_id = 'deferred-relation-event'").get().count, 0);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM relations WHERE id = 'deferred-relation'").get().count, 0);

    const replay = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'deferred-device', platform: 'web' }, events: [event], nowIso: NOW
    }));
    assert.deepEqual(replay.deferred_events, first.deferred_events);
    owned(fixture, () => fixture.store.ensureActivityRoleLink(
      fixture.store.db.prepare("SELECT * FROM activities WHERE id = 'deferred-action'").get()
    ));
    const accepted = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'deferred-device', platform: 'web' }, events: [event], nowIso: NOW
    }));
    assert.deepEqual(accepted.acknowledged_event_ids, ['deferred-relation-event']);
    assert.deepEqual(accepted.deferred_events, []);
    assert.equal(accepted.server_revision, 1);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM relations WHERE id = 'deferred-relation'").get().count, 1);
  } finally {
    await fixture.close();
  }
});

test('Ended Relation identities cannot be reused and re-add creates a new interval', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'identity-action', 'action', 'Done');
      seedActivity(fixture.store, 'identity-goal', 'goal', 'New');
      fixture.store.createRelation({
        id: 'identity-relation', relationTypeId: 'part_of', sourceItemsId: 'identity-action',
        targetItemsId: 'identity-goal', operationId: 'identity-create', actorType: 'user', nowIso: NOW
      });
      fixture.store.endRelation({
        id: 'identity-relation', operationId: 'identity-end', reason: 'removed_by_user', actorType: 'user', nowIso: NOW
      });
      assert.throws(() => fixture.store.createRelation({
        id: 'identity-relation', relationTypeId: 'part_of', sourceItemsId: 'identity-action',
        targetItemsId: 'identity-goal', operationId: 'identity-readd', actorType: 'user', nowIso: NOW
      }), (error) => error.code === 'idempotency_conflict' && error.status === 409);
      const readded = fixture.store.createRelation({
        id: 'identity-relation-2', relationTypeId: 'part_of', sourceItemsId: 'identity-action',
        targetItemsId: 'identity-goal', operationId: 'identity-readd', actorType: 'user', nowIso: NOW
      });
      assert.equal(readded.relation.status, 'active');
    });
  } finally {
    await fixture.close();
  }
});

test('Symmetric private Relation types canonicalize endpoints and remain user-scoped', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'symmetric-z', 'action', 'New');
      seedActivity(fixture.store, 'symmetric-a', 'action', 'New');
      fixture.store.db.prepare(`
        INSERT INTO relation_types (
          id, user_id, key, title, directionality, source_label, target_label,
          is_ordered, status, is_system, created_by_actor_type, created_by_actor_id,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, 'symmetric', '', '', 0, 'active', 0, 'user', ?, ?, ?)
      `).run('related-user-type', OWNER, 'related', 'Связано', OWNER, NOW, NOW);
      fixture.store.db.prepare(`
        INSERT INTO relation_type_endpoint_rules (
          relation_types_id, source_role_key, source_type_key,
          target_role_key, target_type_key, created_at_utc, updated_at_utc
        ) VALUES (?, 'activity', 'action', 'activity', 'action', ?, ?)
      `).run('related-user-type', NOW, NOW);
    });

    const first = owned(fixture, () => fixture.store.createRelation({
      id: 'symmetric-relation-one',
      relationTypeId: 'related-user-type',
      sourceItemsId: 'symmetric-z',
      targetItemsId: 'symmetric-a',
      operationId: 'operation:symmetric-one',
      actorType: 'user',
      nowIso: NOW
    }));
    assert.equal(first.relation.source_items_id, 'symmetric-a');
    assert.equal(first.relation.target_items_id, 'symmetric-z');

    const duplicate = owned(fixture, () => fixture.store.createRelation({
      id: 'symmetric-relation-two',
      relationTypeId: 'related-user-type',
      sourceItemsId: 'symmetric-a',
      targetItemsId: 'symmetric-z',
      operationId: 'operation:symmetric-two',
      actorType: 'user',
      nowIso: NOW
    }));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.relation.id, 'symmetric-relation-one');
    assert.equal(owned(fixture, () => fixture.store.listRelationTypes()).some((type) => type.id === 'related-user-type'), true);
    assert.equal(withUserScope('another-owner', () => fixture.store.listRelationTypes()).some((type) => type.id === 'related-user-type'), false);
  } finally {
    await fixture.close();
  }
});

test('Relation read models keep a constant query count as types and Goal members grow', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'batch-goal', 'goal', 'New');
      seedActivity(fixture.store, 'batch-action-0', 'action', 'New');
      fixture.store.createRelation({
        id: 'batch-relation-0', relationTypeId: 'part_of', sourceItemsId: 'batch-action-0',
        targetItemsId: 'batch-goal', operationId: 'batch-operation-0', actorType: 'user', nowIso: NOW
      });
    });
    const oneType = countDatabaseQueries(fixture.store, () => owned(fixture, () => fixture.store.listRelationTypes()));
    const oneMember = countDatabaseQueries(fixture.store, () => owned(fixture, () => fixture.store.listGoalMembers('batch-goal')));

    owned(fixture, () => {
      fixture.store.db.prepare(`
        INSERT INTO relation_types (
          id, user_id, key, title, directionality, source_label, target_label,
          is_ordered, status, is_system, created_by_actor_type, created_by_actor_id,
          created_at_utc, updated_at_utc
        ) SELECT 'batch-type-' || value, ?, 'batch-' || value, 'Batch ' || value,
          'symmetric', '', '', 0, 'active', 0, 'user', ?, ?, ?
        FROM generate_series(1, 24) AS value
      `).run(OWNER, OWNER, NOW, NOW);
      fixture.store.db.prepare(`
        INSERT INTO relation_type_endpoint_rules (
          relation_types_id, source_role_key, source_type_key,
          target_role_key, target_type_key, created_at_utc, updated_at_utc
        ) SELECT id, 'activity', 'action', 'activity', 'action', ?, ?
          FROM relation_types WHERE user_id = ? AND key LIKE 'batch-%'
      `).run(NOW, NOW, OWNER);
      for (let index = 1; index <= 24; index += 1) {
        seedActivity(fixture.store, `batch-action-${index}`, 'action', 'New');
        fixture.store.createRelation({
          id: `batch-relation-${index}`, relationTypeId: 'part_of', sourceItemsId: `batch-action-${index}`,
          targetItemsId: 'batch-goal', operationId: `batch-operation-${index}`, actorType: 'user', nowIso: NOW
        });
      }
    });
    const manyTypes = countDatabaseQueries(fixture.store, () => owned(fixture, () => fixture.store.listRelationTypes()));
    const manyMembers = countDatabaseQueries(fixture.store, () => owned(fixture, () => fixture.store.listGoalMembers('batch-goal')));
    assert.equal(manyTypes.queries, oneType.queries);
    assert.equal(manyMembers.queries, oneMember.queries);
    assert.equal(manyTypes.value.find((type) => type.id === 'batch-type-1').endpoint_rules.length, 1);
    assert.equal(manyMembers.value.length, 25);

    fixture.store.db.prepare("UPDATE activities SET activity_type_id = 'goal' WHERE id = 'batch-action-0'").run();
    assert.equal(owned(fixture, () => fixture.store.listGoalMembers('batch-goal'))
      .find((member) => member.items_id === 'batch-action-0').valid, false);
    fixture.store.db.prepare("UPDATE items SET deleted_at_utc = ? WHERE id = 'batch-action-0'").run(NOW);
    assert.throws(() => owned(fixture, () => fixture.store.listGoalMembers('batch-goal')),
      (error) => error.code === 'invalid_relation_endpoint' && error.status === 404);
  } finally {
    await fixture.close();
  }
});

function owned(fixture, callback) {
  return withUserScope(OWNER, callback);
}

function seedActivity(store, id, type, status) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, completed_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?)
  `).run(id, type, id, status, NOW, NOW, status === 'Done' ? NOW : null, withUserScopeValue());
  store.ensureActivityRoleLink({
    id, title: id, description_md: '', author: '', created_at_utc: NOW,
    updated_at_utc: NOW, deleted_at_utc: null
  });
}

function seedOperation(store, id, status) {
  const userId = withUserScopeValue();
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
      completed_at_utc, created_at_utc, updated_at_utc, user_id, item_roles_id
    ) VALUES (?, ?, 2, 'operation', 1, ?, ?, ?, ?, ?, ?)
  `).run(id, id, status, status === 'Done' ? NOW : null, NOW, NOW, userId, role.id);
}

function seedRawActivity(store, id) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, 'action', ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, id, NOW, NOW, withUserScopeValue());
  const execution = store.db.prepare(`
    INSERT INTO workflow_executions (
      workflow_definition_id, workflow_definition_version, workflow_id,
      role_contract_id, raw_record_id, status, current_step, attempt_count,
      created_at_utc, updated_at_utc, user_id
    ) VALUES ('activity.raw-normalization', 1, ?, 'activity', ?, 'queued', 'ingest', 0, ?, ?, ?)
    RETURNING id
  `).get(`test:raw:${id}`, id, NOW, NOW, withUserScopeValue());
  store.db.prepare('UPDATE activities SET workflow_execution_id = ? WHERE id = ?').run(execution.id, id);
}

function withUserScopeValue() {
  return OWNER;
}

function relationEvent(eventId, clientSequence, changeType, relationId, payload, baseServerRevision = 0) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    change_type: changeType,
    relation_id: relationId,
    occurred_at_utc: NOW,
    base_server_revision: baseServerRevision,
    payload_version: 1,
    payload
  };
}

function compactRelation(relation) {
  return {
    id: relation.id,
    source: relation.source_items_id,
    target: relation.target_items_id,
    status: relation.status,
    position: relation.position
  };
}

function completionSummary(state) {
  const { member_count, done_count, all_done, eligible } = state;
  return { member_count, done_count, all_done, eligible };
}

function rowCount(fixture, table) {
  assert.match(table, /^[a-z_]+$/);
  return fixture.store.db.prepare(`SELECT count(*)::int AS count FROM ${table}`).get().count;
}

function discoveryWatermark(fixture) {
  return fixture.store.db.prepare(`
    SELECT relevant_sequence, relevant_change_count
    FROM context_discovery_watermarks WHERE user_id = ?
  `).get(OWNER);
}

function countDatabaseQueries(store, callback) {
  const request = store.db.request;
  let queries = 0;
  store.db.request = function (...args) {
    if (args[0] === 'query') queries += 1;
    return request.apply(this, args);
  };
  try {
    return { value: callback(), queries };
  } finally {
    store.db.request = request;
  }
}
