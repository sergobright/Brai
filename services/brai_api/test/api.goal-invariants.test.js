import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvent, createFixture, inboxRequest, request } from '../test-support/api.js';
import { inboxIngestIdempotencyHash } from '../src/inbox.js';
import { withUserScope } from '../src/user-scope.js';

const T0 = '2026-07-13T12:00:00.000Z';

test('Goal Done requires two completed members and later status/delete/restore never resurrects membership', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    createActivities(fixture, [
      ['life-action-a', 'action'], ['life-action-b', 'action'], ['life-goal', 'goal']
    ]);
    activityChange(fixture, 4, 'done-a', 'set_status', 'life-action-a', { status: 'Done' }, at(1));
    activityChange(fixture, 5, 'done-b', 'set_status', 'life-action-b', { status: 'Done' }, at(1));
    createMembership(fixture, 'life-rel-a', 'life-action-a', 'life-goal', 0, at(2));

    const tooSmall = activityChange(fixture, 6, 'goal-done-too-small', 'set_status', 'life-goal', { status: 'Done' }, at(3));
    assert.deepEqual(tooSmall.ignored_events, [
      { event_id: 'goal-done-too-small', reason: 'goal_completion_invariant' }
    ]);
    assert.equal(activity(fixture, 'life-goal').status, 'New');

    createMembership(fixture, 'life-rel-b', 'life-action-b', 'life-goal', 1, at(4));
    const completed = activityChange(fixture, 7, 'goal-done', 'set_status', 'life-goal', { status: 'Done' }, at(5));
    assert.deepEqual(completed.ignored_events, []);
    assert.equal(activity(fixture, 'life-goal').status, 'Done');

    activityChange(fixture, 8, 'reopen-member-a', 'set_status', 'life-action-a', { status: 'New' }, at(6));
    assert.equal(activity(fixture, 'life-action-a').status, 'New');
    assert.equal(activity(fixture, 'life-goal').status, 'New');
    assertGoalReopened(fixture, 'life-goal', 'member_activity_changed');

    activityChange(fixture, 9, 'finish-member-a-again', 'set_status', 'life-action-a', { status: 'Done' }, at(7));
    activityChange(fixture, 10, 'finish-goal-again', 'set_status', 'life-goal', { status: 'Done' }, at(8));
    assert.equal(activity(fixture, 'life-goal').status, 'Done');

    activityChange(fixture, 11, 'delete-member-b', 'delete', 'life-action-b', {}, at(9));
    assert.ok(activity(fixture, 'life-action-b').deleted_at_utc);
    assert.equal(relation(fixture, 'life-rel-b').status, 'ended');
    assert.equal(activity(fixture, 'life-goal').status, 'New');

    activityChange(fixture, 12, 'restore-member-b', 'restore', 'life-action-b', {}, at(10));
    assert.equal(activity(fixture, 'life-action-b').deleted_at_utc, null);
    assert.equal(activity(fixture, 'life-action-b').status, 'New');
    assert.equal(relation(fixture, 'life-rel-b').status, 'ended');
    assert.equal(owner(fixture, () => fixture.store.listGoalMembers('life-goal')).length, 1);

    activityChange(fixture, 13, 'finish-member-b-restored', 'set_status', 'life-action-b', { status: 'Done' }, at(11));
    createMembership(fixture, 'life-rel-b-new', 'life-action-b', 'life-goal', 1, at(12));
    activityChange(fixture, 14, 'finish-goal-third', 'set_status', 'life-goal', { status: 'Done' }, at(13));
    activityChange(fixture, 15, 'delete-goal', 'delete', 'life-goal', {}, at(14));
    assert.ok(activity(fixture, 'life-goal').deleted_at_utc);
    assert.equal(relation(fixture, 'life-rel-a').status, 'ended');
    assert.equal(relation(fixture, 'life-rel-b-new').status, 'ended');
    assert.equal(activity(fixture, 'life-action-a').deleted_at_utc, null);
    assert.equal(activity(fixture, 'life-action-b').deleted_at_utc, null);

    activityChange(fixture, 16, 'restore-goal', 'restore', 'life-goal', {}, at(15));
    assert.equal(activity(fixture, 'life-goal').status, 'New');
    assert.equal(activity(fixture, 'life-goal').deleted_at_utc, null);
    assert.equal(owner(fixture, () => fixture.store.listGoalMembers('life-goal')).length, 0);
  } finally {
    await fixture.close();
  }
});

test('Relation end and Activity type change reopen Done Goals through public sync', async () => {
  const fixture = await createFixture([at(4)]);
  try {
    claimOwner(fixture);
    createActivities(fixture, [
      ['sync-action-a', 'action'], ['sync-action-b', 'action'], ['sync-goal', 'goal']
    ]);
    activityChange(fixture, 4, 'sync-done-a', 'set_status', 'sync-action-a', { status: 'Done' }, at(1));
    activityChange(fixture, 5, 'sync-done-b', 'set_status', 'sync-action-b', { status: 'Done' }, at(1));
    createMembership(fixture, 'sync-rel-a', 'sync-action-a', 'sync-goal', 0, at(2));
    createMembership(fixture, 'sync-rel-b', 'sync-action-b', 'sync-goal', 1, at(2));
    activityChange(fixture, 6, 'sync-goal-done', 'set_status', 'sync-goal', { status: 'Done' }, at(3));

    const unauthorized = await request(fixture.url, '/v1/relations/events/sync', {
      method: 'POST', body: JSON.stringify({ device: { device_id: 'relation-http', platform: 'web' }, events: [] })
    }, false);
    assert.equal(unauthorized.status, 401);
    const ended = await request(fixture.url, '/v1/relations/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'relation-http', platform: 'web' },
        events: [{
          event_id: 'http-end-relation', client_sequence: 1, change_type: 'end',
          relation_id: 'sync-rel-a', occurred_at_utc: at(4), payload_version: 1,
          payload: { reason: 'removed_by_user' }
        }]
      })
    });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(relation(fixture, 'sync-rel-a').status, 'ended');
    assert.equal(activity(fixture, 'sync-goal').status, 'New');

    createMembership(fixture, 'sync-rel-a-new', 'sync-action-a', 'sync-goal', 0, at(5));
    activityChange(fixture, 7, 'sync-goal-done-again', 'set_status', 'sync-goal', { status: 'Done' }, at(6));
    const roleBefore = activity(fixture, 'sync-action-a').item_roles_id;
    activityChange(fixture, 8, 'sync-action-becomes-goal', 'set_type', 'sync-action-a', {
      from_activity_type_id: 'action', to_activity_type_id: 'goal'
    }, at(7));
    assert.equal(activity(fixture, 'sync-action-a').activity_type_id, 'goal');
    assert.equal(activity(fixture, 'sync-action-a').item_roles_id, roleBefore);
    assert.equal(relation(fixture, 'sync-rel-a-new').status, 'ended');
    assert.equal(activity(fixture, 'sync-goal').status, 'New');
  } finally {
    await fixture.close();
  }
});

test('Operation status and deletion reopen Goals without blocking the service mutation', async () => {
  const fixture = await createFixture([at(4)]);
  try {
    claimOwner(fixture);
    createActivities(fixture, [['operation-action', 'action'], ['operation-goal', 'goal']]);
    activityChange(fixture, 3, 'operation-action-done', 'set_status', 'operation-action', { status: 'Done' }, at(1));
    owner(fixture, () => seedOperation(fixture.store, 'operation-member', 'operation:key'));
    createMembership(fixture, 'operation-rel-action', 'operation-action', 'operation-goal', 0, at(2));
    createMembership(fixture, 'operation-rel-service', 'operation-member', 'operation-goal', 1, at(2));
    activityChange(fixture, 4, 'operation-goal-done', 'set_status', 'operation-goal', { status: 'Done' }, at(3));

    const reopened = await inboxRequest(fixture.url, '/v1/inbox/status', {
      method: 'POST', body: JSON.stringify({ idempotency_key: 'operation:key', status: 'New' })
    });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.status, 'New');
    assert.deepEqual(reopened.body.reopened_goal_ids, ['operation-goal']);
    assert.equal(activity(fixture, 'operation-goal').status, 'New');

    const done = await inboxRequest(fixture.url, '/v1/inbox/status', {
      method: 'POST', body: JSON.stringify({ idempotency_key: 'operation:key', status: 'Done' })
    });
    assert.equal(done.status, 200);
    const completedAgain = activityChange(fixture, 5, 'operation-goal-done-again', 'set_status', 'operation-goal', { status: 'Done' }, at(6));
    assert.deepEqual(completedAgain.ignored_events, [], JSON.stringify({
      inbox: fixture.store.db.prepare("SELECT id, status, item_roles_id, is_normalized, preliminary_section, deleted_at_utc FROM inbox WHERE id = 'operation-member'").get(),
      role: fixture.store.db.prepare("SELECT id, status, items_id, item_role_types_id FROM item_roles WHERE items_id = 'operation-member'").get()
    }));
    assert.equal(activity(fixture, 'operation-goal').status, 'Done');

    const deleted = owner(fixture, () => fixture.store.syncInboxEvents({
      device: { device_id: 'operation-delete-device', platform: 'server' },
      events: [{
        event_id: 'operation-delete', client_sequence: 1, type: 'delete',
        inbox_id: 'operation-member', occurred_at_utc: at(7), payload: {}
      }],
      nowIso: at(7)
    }));
    assert.deepEqual(deleted.ignored_events, []);
    assert.equal(relation(fixture, 'operation-rel-service').status, 'ended');
    assert.equal(activity(fixture, 'operation-goal').status, 'New');
  } finally {
    await fixture.close();
  }
});

test('Done Goal rejects New members but accepts completed members and reorder', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedProjectedActivity(fixture.store, 'done-member-a', 'action', 'Done');
      seedProjectedActivity(fixture.store, 'done-member-b', 'action', 'Done');
      seedProjectedActivity(fixture.store, 'new-member-c', 'action', 'New');
      seedProjectedActivity(fixture.store, 'done-goal-editable', 'goal', 'New');
    });
    createMembership(fixture, 'done-edit-rel-a', 'done-member-a', 'done-goal-editable', 0, at(1));
    createMembership(fixture, 'done-edit-rel-b', 'done-member-b', 'done-goal-editable', 1, at(1));
    fixture.store.db.prepare(`
      UPDATE activities SET status = 'Done', completed_at_utc = ? WHERE id = 'done-goal-editable'
    `).run(at(2));

    assert.throws(() => createMembership(
      fixture, 'rejected-new-member', 'new-member-c', 'done-goal-editable', 2, at(3)
    ), (error) => error?.code === 'goal_member_not_done' && error?.status === 409);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM relations WHERE id = 'rejected-new-member'").get().count, 0);
    fixture.store.db.prepare(`
      UPDATE activities SET status = 'Done', completed_at_utc = ? WHERE id = 'new-member-c'
    `).run(at(4));
    createMembership(fixture, 'accepted-done-member', 'new-member-c', 'done-goal-editable', 2, at(4));
    assert.equal(activity(fixture, 'done-goal-editable').status, 'Done');

    owner(fixture, () => fixture.store.reorderRelationsWithEvent({
      relationTypeId: 'part_of', targetItemsId: 'done-goal-editable',
      orderedRelationIds: ['accepted-done-member', 'done-edit-rel-a', 'done-edit-rel-b'],
      baseServerRevision: fixture.store.getRelationServerRevision(),
      operationId: 'reorder-done-goal', actorType: 'user', actorId: 'goal-owner', nowIso: at(5)
    }));
    assert.deepEqual(owner(fixture, () => fixture.store.listGoalMembers('done-goal-editable'))
      .map(({ relation_id, position }) => ({ relation_id, position })), [
      { relation_id: 'accepted-done-member', position: 0 },
      { relation_id: 'done-edit-rel-a', position: 1 },
      { relation_id: 'done-edit-rel-b', position: 2 }
    ]);
    assert.equal(activity(fixture, 'done-goal-editable').status, 'Done');
  } finally {
    await fixture.close();
  }
});

test('same-batch Goal creation cannot bypass the completion invariant', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    const result = owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'same-batch-goal-device', platform: 'web' },
      events: [
        actionEvent('same-batch-goal-create', 1, 'create', 'same-batch-goal', T0, {
          title: 'Same batch Goal', activity_type_id: 'goal'
        }),
        actionEvent('same-batch-goal-done', 2, 'set_status', 'same-batch-goal', T0, { status: 'Done' })
      ],
      nowIso: T0
    }));
    assert.deepEqual(result.ignored_events, [
      { event_id: 'same-batch-goal-done', reason: 'goal_completion_invariant' }
    ]);
    assert.equal(activity(fixture, 'same-batch-goal').status, 'New');
  } finally {
    await fixture.close();
  }
});

test('late event-time type change cannot project an empty Goal as Done', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    createActivities(fixture, [['late-type-goal', 'action']]);
    const futureDone = owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'late-type-device', platform: 'web' },
      events: [actionEvent('late-type-done', 1, 'set_status', 'late-type-goal', at(4), { status: 'Done' })],
      nowIso: T0
    }));
    assert.deepEqual(futureDone.ignored_events, []);
    assert.equal(activity(fixture, 'late-type-goal').status, 'Done');

    const lateType = owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'late-type-device', platform: 'web' },
      events: [actionEvent('late-type-change', 2, 'set_type', 'late-type-goal', at(1), {
        from_activity_type_id: 'action', to_activity_type_id: 'goal'
      })],
      nowIso: at(3)
    }));
    assert.deepEqual(lateType.ignored_events, []);
    assert.equal(activity(fixture, 'late-type-goal').activity_type_id, 'goal');
    assert.equal(activity(fixture, 'late-type-goal').status, 'New');
    assertGoalReopened(fixture, 'late-type-goal', 'activity_type_changed');
    assert.ok(Date.parse(goalReopenedEvent(fixture, 'late-type-goal').occurred_at_utc) > Date.parse(at(4)));
  } finally {
    await fixture.close();
  }
});

test('status received before Goal creation cannot bypass the completion invariant', async () => {
  const fixture = await createFixture([T0]);
  try {
    claimOwner(fixture);
    const statusFirst = owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'create-replay-device', platform: 'web' },
      events: [actionEvent('create-replay-done', 1, 'set_status', 'create-replay-goal', at(4), { status: 'Done' })],
      nowIso: T0
    }));
    assert.deepEqual(statusFirst.ignored_events, []);
    assert.equal(activity(fixture, 'create-replay-goal'), undefined);

    const createLater = owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'create-replay-device', platform: 'web' },
      events: [actionEvent('create-replay-create', 2, 'create', 'create-replay-goal', at(1), {
        title: 'Replay Goal', activity_type_id: 'goal'
      })],
      nowIso: at(3)
    }));
    assert.deepEqual(createLater.ignored_events, []);
    assert.equal(activity(fixture, 'create-replay-goal').activity_type_id, 'goal');
    assert.equal(activity(fixture, 'create-replay-goal').status, 'New');
    assertGoalReopened(fixture, 'create-replay-goal', 'member_activity_changed');
    assert.ok(Date.parse(goalReopenedEvent(fixture, 'create-replay-goal').occurred_at_utc) > Date.parse(at(4)));
  } finally {
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ('goal-owner', 'Goal Owner', 'goal-owner@example.test', true, now(), now())
  `).run();
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', 'goal-owner', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(T0);
}

function owner(fixture, callback) {
  return withUserScope(fixture.store.primaryUserId(), callback);
}

function createActivities(fixture, definitions) {
  owner(fixture, () => fixture.store.syncActivityEvents({
    device: { device_id: 'goal-lifecycle-device', platform: 'web' },
    events: definitions.map(([id, type], index) => actionEvent(
      `create-${id}`, index + 1, 'create', id, T0, { title: id, activity_type_id: type }
    )),
    nowIso: T0
  }));
  owner(fixture, () => definitions.forEach(([id]) => fixture.store.ensureActivityRoleLink(fixture.store.getActivityItem(id))));
}

function activityChange(fixture, sequence, eventId, type, id, payload, nowIso) {
  return owner(fixture, () => fixture.store.syncActivityEvents({
    device: { device_id: 'goal-lifecycle-device', platform: 'web' },
    events: [actionEvent(eventId, sequence, type, id, nowIso, payload)], nowIso
  }));
}

function createMembership(fixture, id, source, target, position, nowIso) {
  return owner(fixture, () => fixture.store.createRelationWithEvent({
    id, relationTypeId: 'part_of', sourceItemsId: source, targetItemsId: target,
    position, operationId: `operation:${id}`, actorType: 'user', actorId: 'goal-owner', nowIso
  }));
}

function seedOperation(store, id, idempotencyKey) {
  const userId = store.primaryUserId();
  const hash = inboxIngestIdempotencyHash(idempotencyKey);
  store.db.prepare(`
    INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, '', '', ?, ?)
  `).run(id, userId, id, T0, T0);
  const role = store.db.prepare(`
    INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
    SELECT ?, id, ?, 'active', '{}' FROM item_role_types WHERE title_system = 'inbox' RETURNING id
  `).get(id, T0);
  store.db.prepare(`
    INSERT INTO inbox (
      id, title, record_type_id, preliminary_section, is_normalized, status,
      completed_at_utc, ingest_idempotency_hash, created_at_utc, updated_at_utc,
      user_id, item_roles_id
    ) VALUES (?, ?, 2, 'operation', 1, 'Done', ?, ?, ?, ?, ?, ?)
  `).run(id, id, T0, hash, T0, T0, userId, role.id);
  store.upsertDevice({
    device_id: 'inbox-api', platform: 'server', display_name: 'Inbox API'
  }, T0);
  store.insertEventRecord({
    eventId: `create-${id}`, eventDomain: 'inbox', eventType: 'create',
    eventAction: 'inbox.create', title: 'Inbox create', itemsId: id,
    itemRolesId: role.id, subjectType: 'inbox', subjectId: id,
    actorType: 'agent', actorId: 'inbox-api', deviceId: 'inbox-api',
    clientSequence: store.nextInboxClientSequence('inbox-api'),
    occurredAtUtc: T0, receivedAtUtc: T0, status: 'accepted', payloadVersion: 1,
    payloadJson: JSON.stringify({
      title: id, record_type_id: 2, preliminary_section: 'operation',
      ingest_idempotency_hash: hash
    })
  });
  store.insertEventRecord({
    eventId: `normalize-${id}`, eventDomain: 'inbox', eventType: 'normalized',
    eventAction: 'inbox.normalized', title: 'Inbox normalized', itemsId: id,
    itemRolesId: role.id, subjectType: 'inbox', subjectId: id,
    actorType: 'agent', actorId: 'inbox-ai', deviceId: 'inbox-api',
    clientSequence: store.nextInboxClientSequence('inbox-api'),
    occurredAtUtc: T0, receivedAtUtc: T0, status: 'accepted', payloadVersion: 1,
    payloadJson: JSON.stringify({
      title: id, preliminary_section: 'operation', is_normalized: true
    })
  });
}

function seedProjectedActivity(store, id, type, status) {
  const userId = store.primaryUserId();
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, completed_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?)
  `).run(id, type, id, status, T0, T0, status === 'Done' ? T0 : null, userId);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: T0, updated_at_utc: T0 });
}

function assertGoalReopened(fixture, goalId, reason) {
  const row = goalReopenedEvent(fixture, goalId);
  assert.ok(row);
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.reason, reason);
  assert.ok(payload.causal_operation_id);
}

function goalReopenedEvent(fixture, goalId) {
  return fixture.store.db.prepare(`
    SELECT occurred_at_utc, payload_json FROM events
    WHERE event_domain = 'activity' AND event_action = 'activity.goal_reopened'
      AND subject_id = ? ORDER BY domain_sequence DESC LIMIT 1
  `).get(goalId);
}

function activity(fixture, id) {
  return fixture.store.db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
}

function relation(fixture, id) {
  return fixture.store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

function at(minutes) {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}
