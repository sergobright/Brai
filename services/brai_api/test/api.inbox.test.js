import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  inboxEvent,
  request,
  tableCount,
  waitFor
} from '../test-support/api.js';

test('inbox sync is idempotent and returns canonical state', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z'
  ]);
  const body = {
    device: { device_id: 'web-device', platform: 'web' },
    events: [
      inboxEvent('inbox-create', 1, 'create', 'inbox-1', '2026-06-26T11:00:00.000Z', {
        title: '  Идея  ',
        description_md: 'первая строка'
      }),
      inboxEvent('inbox-description', 2, 'update_description', 'inbox-1', '2026-06-26T11:05:00.000Z', {
        description_md: '**важно**\r\nвторая'
      })
    ]
  };

  try {
    const first = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.acknowledged_event_ids, ['inbox-create', 'inbox-description']);
    assert.equal(first.body.server_revision, 2);
    assert.equal(first.body.state.inbox.length, 1);
    assert.equal(first.body.state.inbox[0].title, 'Идея');
    assert.equal(first.body.state.inbox[0].description_md, '**важно**\nвторая');
    assert.equal(first.body.state.inbox[0].record_type_id, 4);

    const second = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.server_revision, 2);
    assert.equal(tableCount(fixture, 'inbox_events'), 2);

    const state = await request(fixture.url, '/v1/inbox');
    assert.equal(state.status, 200);
    assert.equal(state.body.inbox[0].id, 'inbox-1');
  } finally {
    await fixture.close();
  }
});

test('inbox sync deletes items without a foreign-key dependency on inbox rows', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('delete-missing', 1, 'delete', 'offline-created-later', '2026-06-26T10:00:00.000Z')
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ignored_events, []);
    assert.equal(tableCount(fixture, 'inbox'), 0);
    assert.equal(tableCount(fixture, 'inbox_events'), 1);
  } finally {
    await fixture.close();
  }
});

test('inbox sync create schedules AI processing', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z',
    '2026-06-26T12:00:02.000Z'
  ], {
    inboxAutoProcess: true,
    inboxNormalizer: async ({ item, imageDescription, classes }) => {
      assert.equal(item.title, 'Разобрать заметку');
      assert.equal(item.description_md, 'сырой контекст');
      assert.equal(imageDescription, '');
      assert.ok(classes.some((entry) => entry.key === 'note'));
      return {
        title: 'Нормализованная заметка',
        description: 'Пользователь добавил заметку и хочет сохранить контекст.',
        class_key: 'note',
        normalization: 'UI create event обработан normalizer agent.'
      };
    }
  });

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('ui-inbox-create', 1, 'create', 'ui-inbox-1', '2026-06-26T11:00:00.000Z', {
            title: 'Разобрать заметку',
            description_md: 'сырой контекст'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.state.inbox[0].is_normalized, false);
    await waitFor(() => fixture.store.db.prepare('SELECT is_normalized FROM inbox WHERE id = ?').get('ui-inbox-1')?.is_normalized === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get('ui-inbox-1');
    assert.equal(item.title, 'Нормализованная заметка');
    assert.equal(item.preliminary_section, 'note');
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get().count, 1);
  } finally {
    await fixture.close();
  }
});

test('inbox AI failure leaves item unnormalized', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z'
  ], {
    inboxAutoProcess: true,
    inboxNormalizer: async () => {
      throw new Error('model unavailable');
    }
  });

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('ui-inbox-fail-create', 1, 'create', 'ui-inbox-fail', '2026-06-26T11:00:00.000Z', {
            title: 'Не должен нормализоваться',
            description_md: 'сырой контекст'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    await waitFor(() => fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get().count === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get('ui-inbox-fail');
    assert.equal(item.is_normalized, 0);
    assert.equal(item.title, 'Не должен нормализоваться');
    const log = fixture.store.db.prepare("SELECT status, json_data FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get();
    assert.equal(log.status, 'failed');
    assert.equal(JSON.parse(log.json_data).metadata.error, 'model unavailable');
    const state = await request(fixture.url, '/v1/inbox');
    assert.equal(state.body.inbox[0].ai_processing_status, 'failed');
    assert.equal(state.body.inbox[0].ai_processing_error, 'Не разобрал Inbox-запись');
  } finally {
    await fixture.close();
  }
});
