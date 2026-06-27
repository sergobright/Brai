import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  inboxEvent,
  request,
  tableCount
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
