import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionEvent,
  createFixture,
  request,
  syncEvent
} from '../test-support/api.js';

test('global events and technical logs are queryable without mixing AI outputs into logs', async () => {
  const fixture = await createFixture([
    '2026-07-07T10:00:00.000Z',
    '2026-07-07T10:00:01.000Z',
    '2026-07-07T10:00:02.000Z'
  ]);

  try {
    const sync = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('activity-log-create', 1, 'create', 'activity-log-1', '2026-07-07T09:00:00.000Z', {
            title: 'Проверить логи'
          })
        ]
      })
    });
    assert.equal(sync.status, 200);

    const timerSync = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'timer-device', platform: 'web' },
        events: [syncEvent('shared-cross-domain-event', 1, 'start', '2026-07-07T09:05:00.000Z')]
      })
    });
    assert.equal(timerSync.status, 200);

    const activitySync = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'activity-device', platform: 'web' },
        events: [
          actionEvent('shared-cross-domain-event', 1, 'create', 'activity-log-2', '2026-07-07T09:06:00.000Z', {
            title: 'Проверить namespace'
          })
        ]
      })
    });
    assert.equal(activitySync.status, 200);
    assert.deepEqual(
      fixture.store.db
        .prepare('SELECT id, event_domain, event_id FROM events WHERE event_id = ? ORDER BY event_domain')
        .all('shared-cross-domain-event'),
      [
        { id: 'activity:shared-cross-domain-event', event_domain: 'activity', event_id: 'shared-cross-domain-event' },
        { id: 'timer:shared-cross-domain-event', event_domain: 'timer', event_id: 'shared-cross-domain-event' }
      ]
    );

    fixture.store.recordAiLog({
      agentId: 'inbox.normalizer',
      agentVersion: '1',
      dt: '2026-07-07T10:00:02.000Z',
      status: 'done',
      aiTitle: 'Тестовый AI log',
      flowId: 'activity-log-1',
      flowCommand: 'normalize',
      jsonData: {
        outputs: [{ ref: 'secret.output', value: 'SECRET_AI_OUTPUT' }]
      }
    });

    const events = await request(fixture.url, '/v1/events?limit=10');
    assert.equal(events.status, 200);
    assert.equal(events.body.events.some((event) => event.event_domain === 'activity' && event.event_id === 'activity-log-create'), true);

    const logs = await request(fixture.url, '/v1/logs?limit=50');
    assert.equal(logs.status, 200);
    assert.equal(logs.body.logs.some((log) => log.operation === 'activity.events_sync'), true);
    assert.equal(JSON.stringify(logs.body).includes('SECRET_AI_OUTPUT'), false);

    const unauthorizedEvents = await request(fixture.url, '/v1/events', {}, false);
    assert.equal(unauthorizedEvents.status, 401);
    const unauthorizedLogs = await request(fixture.url, '/v1/logs', {}, false);
    assert.equal(unauthorizedLogs.status, 401);
  } finally {
    await fixture.close();
  }
});

test('technical log retention purges only expired logs', async () => {
  const fixture = await createFixture(['2026-07-07T10:00:00.000Z']);

  try {
    fixture.store.recordLog({
      dt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      operation: 'old.log',
      status: 'done',
      expiresAtUtc: '2026-01-02T00:00:00.000Z'
    });
    fixture.store.recordLog({
      dt: '2026-07-07T00:00:00.000Z',
      source: 'test',
      operation: 'fresh.log',
      status: 'done',
      expiresAtUtc: '2027-01-01T00:00:00.000Z'
    });

    assert.equal(fixture.store.purgeExpiredLogs('2026-07-07T10:00:00.000Z'), 1);
    const rows = fixture.store.db.prepare("SELECT operation FROM logs WHERE source = 'test' ORDER BY operation").all();
    assert.deepEqual(rows.map((row) => row.operation), ['fresh.log']);
  } finally {
    await fixture.close();
  }
});
