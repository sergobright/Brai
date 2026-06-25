import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  TOKEN,
  createFixture,
  jsonRequest,
  onceOpen,
  request,
  syncEvent,
  tableCount,
  waitFor
} from '../test-support/api.js';

test('timer lifecycle stores duration and groups history', async () => {
  const fixture = await createFixture([
    '2026-06-12T06:00:00.000Z',
    '2026-06-12T06:00:00.000Z',
    '2026-06-12T08:30:00.000Z'
  ]);

  try {
    const unauthorized = await request(fixture.url, '/v1/timer/state', {}, false);
    assert.equal(unauthorized.status, 401);

    const started = await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    assert.equal(started.status, 201);
    assert.ok(started.body.active_session.id);

    const stopped = await request(fixture.url, '/v1/timer/stop', { method: 'POST' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.completed_session.duration_seconds, 9000);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.status, 200);
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.groups['2026-06-12'].total_seconds, 9000);
  } finally {
    await fixture.close();
  }
});

test('goal summary splits cross-midnight sessions', async () => {
  const fixture = await createFixture([
    '2026-06-12T20:30:00.000Z',
    '2026-06-12T21:30:00.000Z'
  ]);

  try {
    const started = await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    assert.equal(started.status, 201);
    const stopped = await request(fixture.url, '/v1/timer/stop', { method: 'POST' });
    assert.equal(stopped.status, 200);
    const goal = await request(
      fixture.url,
      '/v1/goals/challenge?now=2026-06-13T09:00:00.000Z'
    );
    const day12 = goal.body.days.find((day) => day.date === '2026-06-12');
    const day13 = goal.body.days.find((day) => day.date === '2026-06-13');
    assert.equal(day12.completed_seconds, 1800);
    assert.equal(day13.completed_seconds, 1800);
    assert.equal(goal.body.total_goal_seconds, 1209600);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.groups['2026-06-12'].total_seconds, 1800);
    assert.equal(history.body.groups['2026-06-13'].total_seconds, 1800);
    assert.deepEqual(
      history.body.groups['2026-06-12'].hours['23'].sessions.map((session) => [
        session.started_at_utc,
        session.ended_at_utc,
        session.duration_seconds
      ]),
      [['2026-06-12T20:30:00.000Z', '2026-06-12T21:00:00.000Z', 1800]]
    );
    assert.deepEqual(
      history.body.groups['2026-06-13'].hours['00'].sessions.map((session) => [
        session.started_at_utc,
        session.ended_at_utc,
        session.duration_seconds
      ]),
      [['2026-06-12T21:00:00.000Z', '2026-06-12T21:30:00.000Z', 1800]]
    );
  } finally {
    await fixture.close();
  }
});

test('websocket receives timer events', async () => {
  const fixture = await createFixture([
    '2026-06-12T06:00:00.000Z',
    '2026-06-12T06:00:10.000Z'
  ]);

  try {
    const messages = [];
    const ws = new WebSocket(`${fixture.wsUrl}/v1/live?token=${TOKEN}`);
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await onceOpen(ws);

    await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    await waitFor(() => messages.some((message) => message.type === 'timer_started'));

    await request(fixture.url, '/v1/timer/stop', { method: 'POST' });
    await waitFor(() => messages.some((message) => message.type === 'timer_stopped'));

    ws.close();
  } finally {
    await fixture.close();
  }
});

test('event sync is idempotent and returns canonical state', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:00:03.000Z',
    '2026-06-14T12:00:04.000Z'
  ]);
  const body = {
    device: { device_id: 'web-device', platform: 'web' },
    events: [
      syncEvent('web-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
      syncEvent('web-stop', 2, 'stop', '2026-06-14T11:00:00.000Z')
    ]
  };

  try {
    const first = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.acknowledged_event_ids, ['web-start', 'web-stop']);
    assert.equal(first.body.server_revision, 2);
    assert.equal(first.body.state.active_session, null);

    const second = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.server_revision, 2);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].duration_seconds, 3600);
    assert.equal(tableCount(fixture, 'timer_events'), 2);
  } finally {
    await fixture.close();
  }
});

test('event sync merges overlapping devices without double-counting goals', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:00:03.000Z',
    '2026-06-14T12:00:04.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          syncEvent('android-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('android-stop', 2, 'stop', '2026-06-14T11:00:00.000Z')
        ]
      })
    });
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('web-start', 1, 'start', '2026-06-14T10:30:00.000Z'),
          syncEvent('web-stop', 2, 'stop', '2026-06-14T12:00:00.000Z')
        ]
      })
    });

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].started_at_utc, '2026-06-14T10:00:00.000Z');
    assert.equal(history.body.sessions[0].ended_at_utc, '2026-06-14T12:00:00.000Z');
    assert.equal(history.body.sessions[0].duration_seconds, 7200);

    const goal = await request(
      fixture.url,
      '/v1/goals/challenge?now=2026-06-14T12:30:00.000Z'
    );
    const day = goal.body.days.find((item) => item.date === '2026-06-14');
    assert.equal(day.completed_seconds, 7200);
  } finally {
    await fixture.close();
  }
});

test('event sync sorts out-of-order uploads and keeps real gaps separate', async () => {
  const fixture = await createFixture(['2026-06-14T12:00:03.000Z']);

  try {
    const response = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('web-stop-1', 2, 'stop', '2026-06-14T11:00:00.000Z'),
          syncEvent('web-start-1', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('web-start-2', 3, 'start', '2026-06-14T11:05:00.000Z'),
          syncEvent('web-stop-2', 4, 'stop', '2026-06-14T12:00:00.000Z')
        ]
      })
    });
    assert.equal(response.status, 200);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 2);
    assert.deepEqual(
      history.body.sessions.map((session) => session.duration_seconds).sort((a, b) => a - b),
      [3300, 3600]
    );
  } finally {
    await fixture.close();
  }
});

test('event sync global stop closes an active legacy timer from another device', async () => {
  const fixture = await createFixture([
    '2026-06-14T10:00:00.000Z',
    '2026-06-14T12:00:00.000Z',
    '2026-06-14T12:00:01.000Z'
  ]);

  try {
    const started = await request(fixture.url, '/v1/timer/start', { method: 'POST' });
    assert.equal(started.status, 201);
    assert.ok(started.body.active_session);

    const stopped = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'capacitor-device', platform: 'android' },
        events: [
          {
            ...syncEvent('capacitor-global-stop', 1, 'stop', '2026-06-14T12:00:00.000Z'),
            metadata: { global_stop: true }
          }
        ]
      })
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.state.active_session, null);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].duration_seconds, 7200);
  } finally {
    await fixture.close();
  }
});

test('future and malformed sync events are stored as ignored and excluded from canonical state', async () => {
  const fixture = await createFixture(['2026-06-14T12:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'android-device', platform: 'android' },
        events: [
          syncEvent('future-start', 1, 'start', '2026-06-14T12:06:00.000Z'),
          syncEvent('invalid-type', 2, 'pause', '2026-06-14T11:00:00.000Z')
        ]
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ignored_events, [
      { event_id: 'future-start', reason: 'future_timestamp' },
      { event_id: 'invalid-type', reason: 'invalid_type' }
    ]);
    assert.equal(response.body.state.active_session, null);
    assert.equal(tableCount(fixture, 'timer_events'), 2);
    assert.equal(
      fixture.store.db
        .prepare('SELECT status FROM timer_events WHERE event_id = ?')
        .get('future-start').status,
      'ignored'
    );
  } finally {
    await fixture.close();
  }
});

test('unauthorized event sync stores no devices or events', async () => {
  const fixture = await createFixture(['2026-06-14T12:00:00.000Z']);

  try {
    const response = await jsonRequest(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [syncEvent('web-start', 1, 'start', '2026-06-14T10:00:00.000Z')]
      })
    });
    assert.equal(response.status, 401);
    assert.equal(tableCount(fixture, 'timer_devices'), 0);
    assert.equal(tableCount(fixture, 'timer_events'), 0);
  } finally {
    await fixture.close();
  }
});
