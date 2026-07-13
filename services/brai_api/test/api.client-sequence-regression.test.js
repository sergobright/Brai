import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionEvent,
  createFixture,
  inboxEvent,
  request,
  syncEvent
} from '../test-support/api.js';

test('sync APIs store out-of-range Postgres client sequences as ignored events', async () => {
  const fixture = await createFixture(['2026-07-12T20:00:00.000Z']);
  const oversized = 2_147_483_648;

  try {
    const cases = [
      {
        path: '/v1/timer/events/sync',
        event: syncEvent('timer-oversized-sequence', oversized, 'start', '2026-07-12T19:00:00.000Z')
      },
      {
        path: '/v1/activities/events/sync',
        event: actionEvent(
          'activity-oversized-sequence',
          oversized,
          'create',
          'activity-oversized-sequence',
          '2026-07-12T19:00:00.000Z',
          { title: 'Не создавать' }
        )
      },
      {
        path: '/v1/inbox/events/sync',
        event: inboxEvent(
          'inbox-oversized-sequence',
          oversized,
          'create',
          'inbox-oversized-sequence',
          '2026-07-12T19:00:00.000Z',
          { title: 'Не создавать' }
        )
      }
    ];

    for (const entry of cases) {
      const response = await request(fixture.url, entry.path, {
        method: 'POST',
        body: JSON.stringify({
          device: { device_id: `qa-${entry.event.event_id}`, platform: 'web' },
          events: [entry.event]
        })
      });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body.ignored_events, [
        { event_id: entry.event.event_id, reason: 'invalid_client_sequence' }
      ]);
    }

    const rows = fixture.store.db
      .prepare("SELECT event_domain, client_sequence, status, ignore_reason FROM events ORDER BY event_domain")
      .all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => Number.isInteger(row.client_sequence) && row.client_sequence < 0));
    assert.ok(rows.every((row) => row.status === 'ignored' && row.ignore_reason === 'invalid_client_sequence'));
  } finally {
    await fixture.close();
  }
});
