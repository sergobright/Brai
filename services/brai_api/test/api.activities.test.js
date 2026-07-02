import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  TOKEN,
  actionEvent,
  activityTypeCount,
  createFixture,
  jsonRequest,
  onceOpen,
  request,
  tableCount,
  waitFor
} from '../test-support/api.js';

test('actions event sync is idempotent and returns canonical state', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);
  const body = {
    device: { device_id: 'web-device', platform: 'web' },
    events: [actionEvent('action-create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: '  Фокус  ' })]
  };

  try {
    const first = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.acknowledged_event_ids, ['action-create']);
    assert.equal(first.body.server_revision, 1);
    assert.equal(first.body.state.activities.length, 1);
    assert.equal(first.body.state.activities[0].title, 'Фокус');
    assert.equal(first.body.state.activities[0].status, 'New');

    const second = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.server_revision, 1);
    assert.equal(second.body.state.activities.length, 1);
    assert.equal(tableCount(fixture, 'activity_events'), 1);

    const state = await request(fixture.url, '/v1/activities');
    assert.equal(state.status, 200);
    assert.equal(state.body.activities.length, 1);
    assert.equal(state.body.activities[0].id, 'action-1');
  } finally {
    await fixture.close();
  }
});

test('actions sync deletes activities idempotently', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);
  const body = {
    device: { device_id: 'web-device', platform: 'web' },
    events: [
      actionEvent('action-create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' }),
      actionEvent('action-delete', 2, 'delete', 'action-1', '2026-06-16T09:05:00.000Z')
    ]
  };

  try {
    const first = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.acknowledged_event_ids, ['action-create', 'action-delete']);
    assert.equal(first.body.server_revision, 2);
    assert.equal(first.body.state.activities.length, 0);
    assert.equal(first.body.state.archived_activities.length, 1);
    assert.equal(first.body.state.archived_activities[0].deleted_at_utc, '2026-06-16T09:05:00.000Z');

    const second = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.server_revision, 2);
    assert.equal(second.body.state.activities.length, 0);
    assert.equal(second.body.state.archived_activities.length, 1);
    assert.equal(tableCount(fixture, 'activity_events'), 2);
    assert.equal(activityTypeCount(fixture, 'action'), 1);

    const legacy = await request(fixture.url, '/v1/actions');
    assert.equal(legacy.body.actions.length, 0);
  } finally {
    await fixture.close();
  }
});

test('actions sync restores archived activities to the active top', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-old', 1, 'create', 'action-old', '2026-06-16T08:00:00.000Z', { title: 'Старое' }),
          actionEvent('create-archived', 2, 'create', 'action-archived', '2026-06-16T08:10:00.000Z', { title: 'Архивное' }),
          actionEvent('done-archived', 3, 'set_status', 'action-archived', '2026-06-16T08:20:00.000Z', { status: 'Done' }),
          actionEvent('delete-archived', 4, 'delete', 'action-archived', '2026-06-16T08:30:00.000Z'),
          actionEvent('restore-archived', 5, 'restore', 'action-archived', '2026-06-16T08:40:00.000Z')
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.state.activities.map((activity) => [activity.id, activity.status, activity.completed_at_utc]),
      [
        ['action-archived', 'New', null],
        ['action-old', 'New', null]
      ]
    );
    assert.equal(response.body.state.activities[0].restored_at_utc, '2026-06-16T08:40:00.000Z');
    assert.equal(response.body.state.activities[0].deleted_at_utc, null);
    assert.equal(response.body.state.archived_activities.length, 0);

    const duplicate = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [actionEvent('restore-archived', 5, 'restore', 'action-archived', '2026-06-16T08:40:00.000Z')]
      })
    });
    assert.equal(duplicate.body.server_revision, 5);
    assert.equal(tableCount(fixture, 'activity_events'), 5);
  } finally {
    await fixture.close();
  }
});

test('actions sync updates title and status from accepted events', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Первое' }),
          actionEvent('done', 3, 'set_status', 'action-1', '2026-06-16T09:20:00.000Z', { status: 'Done' }),
          actionEvent('rename', 2, 'update_title', 'action-1', '2026-06-16T09:10:00.000Z', { title: 'Второе' })
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state.activities.length, 1);
    assert.equal(response.body.state.activities[0].title, 'Второе');
    assert.equal(response.body.state.activities[0].status, 'Done');
    assert.equal(response.body.state.activities[0].completed_at_utc, '2026-06-16T09:20:00.000Z');
  } finally {
    await fixture.close();
  }
});

test('actions sync applies late events to only the affected activity', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-1', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Первое' }),
          actionEvent('done-1', 2, 'set_status', 'action-1', '2026-06-16T09:20:00.000Z', { status: 'Done' }),
          actionEvent('create-2', 3, 'create', 'action-2', '2026-06-16T09:00:00.000Z', { title: 'Второе' })
        ]
      })
    });

    fixture.store.db.exec(`
      CREATE TRIGGER fail_activity_delete
      BEFORE DELETE ON activities
      WHEN old.id = 'action-2'
      BEGIN
        SELECT RAISE(ABORT, 'unrelated activity was rebuilt');
      END;
    `);

    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('rename-late', 4, 'update_title', 'action-1', '2026-06-16T09:10:00.000Z', {
            title: 'Переименовано'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    const action1 = response.body.state.activities.find((activity) => activity.id === 'action-1');
    const action2 = response.body.state.activities.find((activity) => activity.id === 'action-2');
    assert.equal(action1.title, 'Переименовано');
    assert.equal(action1.status, 'Done');
    assert.equal(action2.title, 'Второе');
  } finally {
    await fixture.close();
  }
});

test('actions sync replays previously orphaned updates after a late create', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('rename-first', 1, 'update_title', 'action-late', '2026-06-16T09:01:00.000Z', {
            title: 'После создания'
          })
        ]
      })
    });
    assert.equal(activityTypeCount(fixture, 'action'), 0);

    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-late', 2, 'create', 'action-late', '2026-06-16T09:00:00.000Z', {
            title: 'До переименования'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.state.activities[0].id, 'action-late');
    assert.equal(response.body.state.activities[0].title, 'После создания');
  } finally {
    await fixture.close();
  }
});

test('actions sync manually reorders new activities', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-1', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Первое' }),
          actionEvent('create-2', 2, 'create', 'action-2', '2026-06-16T09:01:00.000Z', { title: 'Второе' }),
          actionEvent('reorder', 3, 'reorder', 'action-1', '2026-06-16T09:02:00.000Z', {
            ordered_ids: ['action-1', 'action-2']
          }),
          actionEvent('create-3', 4, 'create', 'action-3', '2026-06-16T09:03:00.000Z', { title: 'Третье' }),
          actionEvent('done-1', 5, 'set_status', 'action-1', '2026-06-16T09:04:00.000Z', { status: 'Done' })
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.state.activities.map((activity) => [activity.id, activity.status, activity.sort_order]),
      [
        ['action-3', 'New', null],
        ['action-2', 'New', 1],
        ['action-1', 'Done', null]
      ]
    );

    const duplicate = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('reorder', 3, 'reorder', 'action-1', '2026-06-16T09:02:00.000Z', {
            ordered_ids: ['action-2', 'action-1']
          })
        ]
      })
    });
    assert.equal(duplicate.body.server_revision, 5);
    assert.equal(tableCount(fixture, 'activity_events'), 5);
  } finally {
    await fixture.close();
  }
});

test('actions sync replaces manual order without rebuilding all activities', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-a', 1, 'create', 'action-a', '2026-06-16T09:00:00.000Z', { title: 'A' }),
          actionEvent('create-b', 2, 'create', 'action-b', '2026-06-16T09:00:00.000Z', { title: 'B' }),
          actionEvent('order-ab', 3, 'reorder', 'action-a', '2026-06-16T09:01:00.000Z', {
            ordered_ids: ['action-a', 'action-b']
          }),
          actionEvent('order-b', 4, 'reorder', 'action-b', '2026-06-16T09:02:00.000Z', {
            ordered_ids: ['action-b']
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    const byId = new Map(response.body.state.activities.map((activity) => [activity.id, activity]));
    assert.equal(byId.get('action-a').sort_order, null);
    assert.equal(byId.get('action-b').sort_order, 0);
  } finally {
    await fixture.close();
  }
});

test('actions sync applies existing reorder to a late-created activity', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-existing', 1, 'create', 'action-existing', '2026-06-16T09:00:00.000Z', {
            title: 'Существующая'
          }),
          actionEvent('reorder', 2, 'reorder', 'action-existing', '2026-06-16T09:02:00.000Z', {
            ordered_ids: ['action-late', 'action-existing']
          })
        ]
      })
    });

    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-late', 3, 'create', 'action-late', '2026-06-16T09:01:00.000Z', {
            title: 'Опоздавшая'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.state.activities.map((activity) => [activity.id, activity.sort_order]),
      [
        ['action-late', 0],
        ['action-existing', 1]
      ]
    );
  } finally {
    await fixture.close();
  }
});

test('actions sync preserves markdown descriptions and clears them', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' }),
          actionEvent('describe', 2, 'update_description', 'action-1', '2026-06-16T09:01:00.000Z', {
            description_md: '  **Важно**\r\n\r\n- пункт  '
          }),
          actionEvent('clear', 3, 'update_description', 'action-1', '2026-06-16T09:02:00.000Z', {
            description_md: ''
          })
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state.activities.length, 1);
    assert.equal(response.body.state.activities[0].description_md, '');

    const duplicate = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          actionEvent('describe', 2, 'update_description', 'action-1', '2026-06-16T09:01:00.000Z', {
            description_md: 'ignored'
          })
        ]
      })
    });
    assert.equal(duplicate.body.server_revision, 3);
    assert.equal(tableCount(fixture, 'activity_events'), 3);
  } finally {
    await fixture.close();
  }
});

test('actions sync normalizes markdown description line endings', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' }),
          actionEvent('describe', 2, 'update_description', 'action-1', '2026-06-16T09:01:00.000Z', {
            description_md: 'первая\r\nвторая\rтретья'
          })
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state.activities[0].description_md, 'первая\nвторая\nтретья');
  } finally {
    await fixture.close();
  }
});

test('future and malformed action events are stored as ignored', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          actionEvent('future', 1, 'create', 'action-future', '2026-06-16T10:06:00.000Z', { title: 'Будущее' }),
          actionEvent('empty', 2, 'create', 'action-empty', '2026-06-16T09:00:00.000Z', { title: '   ' }),
          actionEvent('bad-status', 3, 'set_status', 'action-1', '2026-06-16T09:00:00.000Z', { status: 'Later' })
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ignored_events, [
      { event_id: 'future', reason: 'future_timestamp' },
      { event_id: 'empty', reason: 'title_required' },
      { event_id: 'bad-status', reason: 'invalid_status' }
    ]);
    assert.equal(response.body.state.activities.length, 0);
    assert.equal(tableCount(fixture, 'activity_events'), 3);
    assert.equal(activityTypeCount(fixture, 'action'), 0);
  } finally {
    await fixture.close();
  }
});

test('unauthorized action sync stores no actions or action events', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await jsonRequest(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' })]
      })
    });
    assert.equal(response.status, 401);
    assert.equal(tableCount(fixture, 'activity_events'), 0);
    assert.equal(activityTypeCount(fixture, 'action'), 0);
  } finally {
    await fixture.close();
  }
});

test('websocket receives actions synced events', async () => {
  const fixture = await createFixture([
    '2026-06-16T10:00:00.000Z',
    '2026-06-16T10:00:01.000Z'
  ]);

  try {
    const messages = [];
    const ws = new WebSocket(`${fixture.wsUrl}/v1/live?token=${TOKEN}`);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await onceOpen(ws);

    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' })]
      })
    });
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === 'activities_synced' &&
          message.activities_state?.activities?.[0]?.title === 'Фокус'
      )
    );

    ws.close();
  } finally {
    await fixture.close();
  }
});

test('legacy actions endpoints remain compatibility aliases', async () => {
  const fixture = await createFixture(['2026-06-16T10:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/actions/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:00:00.000Z', { title: 'Фокус' })]
      })
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.state.actions[0].title, 'Фокус');

    const state = await request(fixture.url, '/v1/actions');
    assert.equal(state.body.actions[0].title, 'Фокус');
    assert.equal(activityTypeCount(fixture, 'action'), 1);
  } finally {
    await fixture.close();
  }
});

test('actions sync does not change timer revision or sessions', async () => {
  const fixture = await createFixture([
    '2026-06-16T08:00:00.000Z',
    '2026-06-16T09:00:00.000Z',
    '2026-06-16T10:00:00.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    await request(fixture.url, '/v1/timer/stop', { method: 'POST' });
    const before = await request(fixture.url, '/v1/timer/state');
    const historyBefore = await request(fixture.url, '/v1/sessions');

    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [actionEvent('create', 1, 'create', 'action-1', '2026-06-16T09:30:00.000Z', { title: 'Фокус' })]
      })
    });

    const after = await request(fixture.url, '/v1/timer/state');
    const historyAfter = await request(fixture.url, '/v1/sessions');
    assert.equal(after.body.server_revision, before.body.server_revision);
    assert.deepEqual(historyAfter.body.sessions, historyBefore.body.sessions);
  } finally {
    await fixture.close();
  }
});
