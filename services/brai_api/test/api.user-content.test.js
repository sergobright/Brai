import test from 'node:test';
import assert from 'node:assert/strict';
import { withUserScope } from '../src/user-scope.js';
import { createFixture, inboxEvent, request } from '../test-support/api.js';

function seedPrimaryUser(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES ('test-user', 'Test User', 'test-user@example.com', true, ?, ?)
  `).run('2026-07-13T08:00:00.000Z', '2026-07-13T08:00:00.000Z');
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', 'test-user', ?)
  `).run('2026-07-13T08:00:00.000Z');
}

test('context rail width is stored per authenticated user', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    seedPrimaryUser(fixture);
    const initial = await request(fixture.url, '/v1/preferences');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, { context_rail_width_px: 256 });

    const updated = await request(fixture.url, '/v1/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ context_rail_width_px: 384 })
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, { context_rail_width_px: 384 });
    assert.deepEqual((await request(fixture.url, '/v1/preferences')).body, updated.body);

    const invalid = await request(fixture.url, '/v1/preferences', {
      method: 'PATCH',
      body: JSON.stringify({ context_rail_width_px: 600 })
    });
    assert.equal(invalid.status, 400);
  } finally {
    await fixture.close();
  }
});

test('archive roles are dynamic and item history follows entity and role links', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    seedPrimaryUser(fixture);
    const userId = fixture.store.primaryUser().id;
    fixture.store.db.prepare(`
      INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
      VALUES ('archived-activity', ?, 'Архивная задача', 'Проверить архив', 'Пользователь', ?, ?, ?)
    `).run(userId, '2026-07-13T09:00:00.000Z', '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z');
    const role = fixture.store.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json)
      VALUES ('archived-activity', 1, ?, ?, 'deleted', '{}') RETURNING id
    `).get('2026-07-13T09:00:00.000Z', '2026-07-13T10:00:00.000Z');
    fixture.store.db.prepare(`
      INSERT INTO activities (
        id, activity_type_id, title, description_md, author, reason, status,
        created_at_utc, updated_at_utc, deleted_at_utc, item_roles_id, user_id
      ) VALUES ('archived-activity', 'action', 'Архивная задача', 'Проверить архив', 'Пользователь', '', 'New', ?, ?, ?, ?, ?)
    `).run('2026-07-13T09:00:00.000Z', '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z', role.id, userId);
    fixture.store.db.prepare(`
      INSERT INTO item_role_types (id, title_system, title, description, payload_table, is_system, created_at_utc)
      VALUES (99, 'future_role', 'Future role', 'Future role test', '', 0, ?)
    `).run('2026-07-13T09:00:00.000Z');
    fixture.store.db.prepare(`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES ('other-user', 'Other User', 'other-user@example.com', true, ?, ?)
    `).run('2026-07-13T08:00:00.000Z', '2026-07-13T08:00:00.000Z');
    fixture.store.db.prepare(`
      INSERT INTO items (id, user_id, title, created_at_utc, updated_at_utc, deleted_at_utc)
      VALUES ('other-archived', 'other-user', 'Чужая задача', ?, ?, ?)
    `).run('2026-07-13T09:00:00.000Z', '2026-07-13T10:00:00.000Z', '2026-07-13T10:00:00.000Z');
    fixture.store.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json)
      VALUES ('other-archived', 1, ?, ?, 'deleted', '{}')
    `).run('2026-07-13T09:00:00.000Z', '2026-07-13T10:00:00.000Z');

    withUserScope(userId, () => {
      fixture.store.insertEventRecord({
        eventDomain: 'activity',
        eventId: 'entity-linked-event',
        eventType: 'delete',
        eventAction: 'activity.delete',
        title: 'Activity archived',
        itemRolesId: role.id,
        subjectType: 'activity',
        subjectId: 'another-subject-id',
        occurredAtUtc: '2026-07-13T10:00:00.000Z',
        receivedAtUtc: '2026-07-13T10:00:00.000Z',
        payloadJson: JSON.stringify({ source: 'test' })
      });
    });

    const archive = await request(fixture.url, '/v1/archive?role=activity');
    assert.equal(archive.status, 200);
    assert.equal(archive.body.roles.some((entry) => entry.title_system === 'future_role'), true);
    assert.equal(archive.body.roles.find((entry) => entry.title_system === 'activity').archived_count, 1);
    assert.equal(archive.body.items[0].id, 'archived-activity');
    assert.equal(archive.body.items[0].payload.description_md, 'Проверить архив');

    const history = await request(fixture.url, '/v1/items/archived-activity/events');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.events.map((event) => event.event_id), ['entity-linked-event']);
    assert.deepEqual(history.body.events[0].payload_json, { source: 'test' });
  } finally {
    await fixture.close();
  }
});

test('Inbox reorder and restore keep manual order and restore to New at the top', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    const sync = async (events) => request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({ device: { device_id: 'web-device', platform: 'web' }, events })
    });
    await sync([
      inboxEvent('create-a', 1, 'create', 'inbox-a', '2026-07-13T09:00:00.000Z', { title: 'A' }),
      inboxEvent('create-b', 2, 'create', 'inbox-b', '2026-07-13T09:01:00.000Z', { title: 'B' }),
      inboxEvent('reorder-ab', 3, 'reorder', 'inbox-a', '2026-07-13T09:02:00.000Z', { ordered_ids: ['inbox-a', 'inbox-b'] }),
      inboxEvent('delete-a', 4, 'delete', 'inbox-a', '2026-07-13T09:03:00.000Z')
    ]);
    const restored = await sync([
      inboxEvent('restore-a', 5, 'restore', 'inbox-a', '2026-07-13T09:04:00.000Z')
    ]);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.state.inbox.map((item) => item.id), ['inbox-a', 'inbox-b']);
    assert.equal(restored.body.state.inbox[0].status, 'New');
    assert.equal(restored.body.state.inbox[0].restored_at_utc, '2026-07-13T09:04:00.000Z');
  } finally {
    await fixture.close();
  }
});
