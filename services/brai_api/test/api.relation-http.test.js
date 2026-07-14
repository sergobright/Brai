import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, request } from '../test-support/api.js';
import { BraiStore } from '../src/store.js';
import { withUserScope } from '../src/user-scope.js';

const OWNER = 'relation-http-owner';
const NOW = '2026-07-13T14:00:00.000Z';

test('Relation HTTP read/sync is authenticated, filtered, bounded, and owner-scoped', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'http-action', 'action', OWNER);
      seedActivity(fixture.store, 'http-goal', 'goal', OWNER);
    });

    assert.equal((await request(fixture.url, '/v1/relations', {}, false)).status, 401);
    assert.equal((await request(fixture.url, '/v1/relations/events/sync', {
      method: 'POST', body: JSON.stringify({ device: { device_id: 'http-relation', platform: 'web' }, events: [] })
    }, false)).status, 401);

    const created = await sync(fixture, [relationEvent(
      'http-create-event', 1, 'create', 'http-relation', {
        relation_type_id: 'part_of', source_items_id: 'http-action',
        target_items_id: 'http-goal', position: 0
      }
    )]);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual(created.body.acknowledged_event_ids, ['http-create-event']);
    assert.deepEqual(created.body.ignored_events, []);
    assert.deepEqual(created.body.deferred_events, []);
    assert.equal(created.body.state.relations[0].id, 'http-relation');

    const state = await request(fixture.url, '/v1/relations');
    assert.equal(state.status, 200);
    const partOf = state.body.relation_types.find((type) => type.id === 'part_of');
    const actionToGoal = partOf?.endpoint_rules.find((rule) => rule.source_type_key === 'action');
    assert.deepEqual({
      key: partOf?.key,
      is_ordered: partOf?.is_ordered,
      is_system: partOf?.is_system,
      source_role_key: actionToGoal?.source_role_key,
      target_role_key: actionToGoal?.target_role_key
    }, {
      key: 'part_of', is_ordered: 1, is_system: 1,
      source_role_key: 'activity', target_role_key: 'activity'
    });
    assert.equal('machine_key' in partOf, false);
    assert.deepEqual(state.body.relations.map((relation) => relation.id), ['http-relation']);
    assert.deepEqual({
      created_by_actor_type: state.body.relations[0].created_by_actor_type,
      created_by_actor_id: state.body.relations[0].created_by_actor_id,
      ended_operation_id: state.body.relations[0].ended_operation_id,
      ended_by_actor_type: state.body.relations[0].ended_by_actor_type
    }, {
      created_by_actor_type: 'user', created_by_actor_id: 'http-relation',
      ended_operation_id: null, ended_by_actor_type: null
    });
    assert.equal('actor_type' in state.body.relations[0], false);
    assert.ok(Number.isInteger(state.body.server_revision));
    assert.ok(state.body.server_time_utc);
    const filtered = await request(fixture.url, '/v1/relations?endpoint_items_id=http-action&relation_type_id=part_of&status=active&limit=1');
    assert.deepEqual(filtered.body.relations.map((relation) => relation.id), ['http-relation']);

    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'http-action-2', 'action', OWNER);
      fixture.store.createRelationWithEvent({
        id: 'http-relation-2', relationTypeId: 'part_of',
        sourceItemsId: 'http-action-2', targetItemsId: 'http-goal',
        operationId: 'http-operation-2', actorType: 'user', nowIso: NOW
      });
    });
    const firstPage = await request(fixture.url, '/v1/relations?status=active&limit=1');
    assert.deepEqual(firstPage.body.relations.map((relation) => relation.id), ['http-relation']);
    assert.equal(firstPage.body.next_cursor, 'http-relation');
    const secondPage = await request(fixture.url, `/v1/relations?status=active&limit=1&cursor=${firstPage.body.next_cursor}`);
    assert.deepEqual(secondPage.body.relations.map((relation) => relation.id), ['http-relation-2']);
    assert.equal(secondPage.body.next_cursor, null);

    withUserScope('other-relation-user', () => {
      seedActivity(fixture.store, 'foreign-http-action', 'action', 'other-relation-user');
      seedActivity(fixture.store, 'foreign-http-goal', 'goal', 'other-relation-user');
      fixture.store.createRelationWithEvent({
        id: 'foreign-http-relation', relationTypeId: 'part_of',
        sourceItemsId: 'foreign-http-action', targetItemsId: 'foreign-http-goal',
        operationId: 'foreign-operation', actorType: 'user', nowIso: NOW
      });
    });
    const isolated = await request(fixture.url, '/v1/relations');
    assert.equal(isolated.body.relations.some((relation) => relation.id === 'foreign-http-relation'), false);

    const ended = await sync(fixture, [relationEvent(
      'http-end-event', 2, 'end', 'http-relation', { reason: 'removed_by_user' }
    )]);
    assert.equal(ended.status, 200);
    const history = await request(fixture.url, '/v1/relations?status=ended&endpoint_items_id=http-goal');
    assert.deepEqual(history.body.relations, []);
    assert.deepEqual(history.body.ended_relations.map((relation) => relation.id), ['http-relation']);
    assert.equal(history.body.ended_relations[0].status, 'ended');

    const oversized = await sync(fixture, Array.from({ length: 501 }, (_, index) => ({
      event_id: `oversized-${index}`, client_sequence: index + 10,
      change_type: 'invalid', occurred_at_utc: NOW, payload_version: 1, payload: {}
    })));
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error, 'relation_batch_too_large');
  } finally {
    await fixture.close();
  }
});

test('Relation product state returns the 100 most recently ended intervals', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'recent-history-action', 'action', OWNER);
      seedActivity(fixture.store, 'recent-history-goal', 'goal', OWNER);
      for (let index = 0; index < 105; index += 1) {
        const suffix = String(index).padStart(3, '0');
        const relationId = `recent-history-${suffix}`;
        fixture.store.createRelationWithEvent({
          id: relationId, relationTypeId: 'part_of',
          sourceItemsId: 'recent-history-action', targetItemsId: 'recent-history-goal',
          operationId: `recent-history-create-${suffix}`, actorType: 'user', actorId: OWNER,
          nowIso: historyAt(index * 2)
        });
        fixture.store.endRelationWithEvent({
          id: relationId, operationId: `recent-history-end-${suffix}`,
          actorType: 'user', actorId: OWNER, reason: 'history_regression',
          nowIso: historyAt(index * 2 + 1)
        });
      }
    });

    const state = await request(fixture.url, '/v1/relations');
    assert.equal(state.status, 200);
    assert.equal(state.body.ended_relations.length, 100);
    assert.equal(state.body.ended_relations[0].id, 'recent-history-104');
    assert.equal(state.body.ended_relations.at(-1).id, 'recent-history-005');
    assert.equal(state.body.ended_relations.some((relation) => relation.id === 'recent-history-004'), false);

    const fullHistoryPage = await request(fixture.url, '/v1/relations?status=ended&limit=2');
    assert.deepEqual(fullHistoryPage.body.ended_relations.map((relation) => relation.id), [
      'recent-history-000', 'recent-history-001'
    ]);
    assert.equal(fullHistoryPage.body.next_cursor, 'recent-history-001');
  } finally {
    await fixture.close();
  }
});

test('Relation GET and sync responses expose one revision-consistent snapshot', async () => {
  const fixture = await createFixture([NOW]);
  const concurrent = new BraiStore(fixture.databaseUrl);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'snapshot-action-a', 'action', OWNER);
      seedActivity(fixture.store, 'snapshot-action-b', 'action', OWNER);
      seedActivity(fixture.store, 'snapshot-goal', 'goal', OWNER);
      fixture.store.createRelationWithEvent({
        id: 'snapshot-relation-a', relationTypeId: 'part_of',
        sourceItemsId: 'snapshot-action-a', targetItemsId: 'snapshot-goal',
        operationId: 'snapshot-operation-a', actorType: 'user', nowIso: NOW
      });
    });

    const originalList = fixture.store.listRelations;
    let injectedRead = false;
    fixture.store.listRelations = function listWithConcurrentCommit(options) {
      const rows = originalList.call(this, options);
      if (!injectedRead && options.status === 'active' && !options.cursor) {
        injectedRead = true;
        withUserScope(OWNER, () => concurrent.createRelationWithEvent({
          id: 'snapshot-relation-b', relationTypeId: 'part_of',
          sourceItemsId: 'snapshot-action-b', targetItemsId: 'snapshot-goal',
          operationId: 'snapshot-operation-b', actorType: 'user', nowIso: NOW
        }));
      }
      return rows;
    };
    const first = await request(fixture.url, '/v1/relations?status=active&limit=10');
    fixture.store.listRelations = originalList;

    assert.equal(first.status, 200);
    assert.equal(first.body.server_revision, 1);
    assert.deepEqual(first.body.relations.map((relation) => relation.id), ['snapshot-relation-a']);
    const current = await request(fixture.url, '/v1/relations?status=active&limit=10');
    assert.equal(current.body.server_revision, 2);
    assert.deepEqual(current.body.relations.map((relation) => relation.id), [
      'snapshot-relation-a', 'snapshot-relation-b'
    ]);

    withUserScope(OWNER, () => seedActivity(fixture.store, 'snapshot-action-c', 'action', OWNER));
    const originalSync = fixture.store.syncRelationEvents;
    fixture.store.syncRelationEvents = function syncWithConcurrentCommit(input) {
      const result = originalSync.call(this, input);
      withUserScope(OWNER, () => concurrent.createRelationWithEvent({
        id: 'snapshot-relation-concurrent', relationTypeId: 'part_of',
        sourceItemsId: 'snapshot-action-c', targetItemsId: 'snapshot-goal',
        operationId: 'snapshot-operation-concurrent', actorType: 'user', nowIso: NOW
      }));
      return result;
    };
    const synced = await sync(fixture, [], 'snapshot-sync-device');
    fixture.store.syncRelationEvents = originalSync;

    assert.equal(synced.status, 200);
    assert.equal(synced.body.server_revision, synced.body.state.server_revision);
    assert.equal(synced.body.state.server_revision, 3);
    assert.equal(synced.body.state.relations.some((relation) => relation.id === 'snapshot-relation-concurrent'), true);
  } finally {
    concurrent.close();
    await fixture.close();
  }
});

test('Relation HTTP sync ignores reserved decision provenance from every owner', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'provenance-http-action', 'action', OWNER);
      seedActivity(fixture.store, 'provenance-http-goal', 'goal', OWNER);
    });
    const ownDecision = recordDecision(fixture.store, OWNER, 1);
    const foreignDecision = recordDecision(fixture.store, 'foreign-provenance-owner', 2);
    const forged = await sync(fixture, [
      relationEvent('own-provenance-event', 1, 'create', 'own-provenance-relation', {
        relation_type_id: 'part_of', source_items_id: 'provenance-http-action',
        target_items_id: 'provenance-http-goal', origin_decision_id: ownDecision.id
      }),
      relationEvent('foreign-provenance-event', 2, 'create', 'foreign-provenance-relation', {
        relation_type_id: 'part_of', source_items_id: 'provenance-http-action',
        target_items_id: 'provenance-http-goal', origin_decision_id: foreignDecision.id
      })
    ], 'provenance-http-device');

    assert.equal(forged.status, 200, JSON.stringify(forged.body));
    assert.deepEqual(forged.body.acknowledged_event_ids, ['own-provenance-event', 'foreign-provenance-event']);
    assert.deepEqual(forged.body.ignored_events, [
      { event_id: 'own-provenance-event', reason: 'origin_decision_id_reserved' },
      { event_id: 'foreign-provenance-event', reason: 'origin_decision_id_reserved' }
    ]);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM relations
      WHERE id IN ('own-provenance-relation', 'foreign-provenance-relation')
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('Relation HTTP sync defers endpoint normalization and retries the same event exactly once', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => {
      seedActivity(fixture.store, 'deferred-http-goal', 'goal', OWNER);
      seedRawActivity(fixture.store, 'deferred-http-action', OWNER);
    });
    const event = relationEvent('deferred-http-event', 1, 'create', 'deferred-http-relation', {
      relation_type_id: 'part_of', source_items_id: 'deferred-http-action',
      target_items_id: 'deferred-http-goal'
    });
    const deferred = await sync(fixture, [event], 'deferred-http-device');
    assert.equal(deferred.status, 200);
    assert.deepEqual(deferred.body.acknowledged_event_ids, []);
    assert.deepEqual(deferred.body.ignored_events, []);
    assert.deepEqual(deferred.body.deferred_events, [
      { event_id: 'deferred-http-event', reason: 'endpoint_not_ready' }
    ]);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM events WHERE event_id = 'deferred-http-event'").get().count, 0);

    withUserScope(OWNER, () => fixture.store.ensureActivityRoleLink(
      fixture.store.db.prepare("SELECT * FROM activities WHERE id = 'deferred-http-action'").get()
    ));
    const accepted = await sync(fixture, [event], 'deferred-http-device');
    assert.deepEqual(accepted.body.acknowledged_event_ids, ['deferred-http-event']);
    assert.deepEqual(accepted.body.deferred_events, []);
    assert.equal(accepted.body.state.relations.some((relation) => relation.id === 'deferred-http-relation'), true);
    const replay = await sync(fixture, [event], 'deferred-http-device');
    assert.equal(replay.status, 200);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM relations WHERE id = 'deferred-http-relation'").get().count, 1);

    const conflict = await sync(fixture, [{
      ...event, payload: { ...event.payload, position: 9 }
    }], 'deferred-http-device');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, 'idempotency_conflict');
  } finally {
    await fixture.close();
  }
});

test('Goal planner trigger is authenticated and reuses one stable execution', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    withUserScope(OWNER, () => seedActivity(fixture.store, 'planner-http-goal', 'goal', OWNER));
    const unauthorized = await request(fixture.url, '/v1/goals/planner-http-goal/plan', { method: 'POST' }, false);
    assert.equal(unauthorized.status, 401);
    const first = await request(fixture.url, '/v1/goals/planner-http-goal/plan', { method: 'POST' });
    assert.ok([200, 202].includes(first.status), JSON.stringify(first.body));
    assert.ok(first.body.workflow_id);
    const replay = await request(fixture.url, '/v1/goals/planner-http-goal/plan', { method: 'POST' });
    assert.ok([200, 202].includes(replay.status), JSON.stringify(replay.body));
    assert.equal(replay.body.workflow_id, first.body.workflow_id);
    const missing = await request(fixture.url, '/v1/goals/missing-goal/plan', { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Relation Owner', 'relation-http@example.test', true, now(), now())
  `).run(OWNER);
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(OWNER, NOW);
}

function seedActivity(store, id, type, userId) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, type, id, NOW, NOW, userId);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW });
}

function seedRawActivity(store, id, userId) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, 'action', ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, id, NOW, NOW, userId);
  const execution = store.db.prepare(`
    INSERT INTO workflow_executions (
      workflow_definition_id, workflow_definition_version, workflow_id,
      role_contract_id, raw_record_id, status, current_step, attempt_count,
      created_at_utc, updated_at_utc, user_id
    ) VALUES ('activity.raw-normalization', 1, ?, 'activity', ?, 'queued', 'ingest', 0, ?, ?, ?)
    RETURNING id
  `).get(`test:raw:${id}`, id, NOW, NOW, userId);
  store.db.prepare('UPDATE activities SET workflow_execution_id = ? WHERE id = ?').run(execution.id, id);
}

function sync(fixture, events, deviceId = 'http-relation') {
  return request(fixture.url, '/v1/relations/events/sync', {
    method: 'POST',
    body: JSON.stringify({ device: { device_id: deviceId, platform: 'web' }, events })
  });
}

function relationEvent(eventId, clientSequence, changeType, relationId, payload) {
  return {
    event_id: eventId, client_sequence: clientSequence, change_type: changeType,
    relation_id: relationId, occurred_at_utc: NOW, base_server_revision: 0,
    payload_version: 1, payload
  };
}

function recordDecision(store, userId, triggerRevision) {
  return withUserScope(userId, () => {
    const agent = store.getAgent('goal.item-matcher');
    return store.recordContextDecision({
      agentId: agent.id, agentVersion: agent.version,
      promptVersion: agent.prompt_version, model: 'test-model', schemaVersion: agent.schema_version,
      decisionKind: 'relation_add', triggerRevision, confidence: 0.8,
      rationale: 'Reserved provenance boundary regression', evidence: [],
      proposal: { relation_type_id: 'part_of', source_items_id: 'unused-action', target_items_id: 'unused-goal' },
      nowIso: NOW
    }).decision;
  });
}

function historyAt(minutes) {
  return new Date(Date.parse('2026-07-01T00:00:00.000Z') + minutes * 60_000).toISOString();
}
