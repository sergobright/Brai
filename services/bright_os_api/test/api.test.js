import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  TOKEN,
  actionEvent,
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
    '2026-06-14T13:30:00.000Z',
    '2026-06-14T13:30:01.000Z',
    '2026-06-14T13:30:02.000Z',
    '2026-06-14T13:30:03.000Z'
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

test('action focus events split focus sessions into activity intervals', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:30:00.000Z',
    '2026-06-14T12:30:01.000Z',
    '2026-06-14T12:30:02.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-action-1', 1, 'create', 'action-1', '2026-06-14T08:00:00.000Z', { title: 'Письмо' }),
          actionEvent('create-action-2', 2, 'create', 'action-2', '2026-06-14T08:01:00.000Z', { title: 'Звонок' })
        ]
      })
    });

    const synced = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('focus-start', 1, 'start', '2026-06-14T09:00:00.000Z'),
          {
            ...syncEvent('activity-start', 2, 'start_activity_focus', '2026-06-14T09:30:00.000Z'),
            metadata: { activity_id: 'action-1' }
          },
          {
            ...syncEvent('activity-switch', 3, 'switch_activity_focus', '2026-06-14T10:00:00.000Z'),
            metadata: { activity_id: 'action-2' }
          },
          {
            ...syncEvent('activity-stop', 4, 'stop_activity_focus', '2026-06-14T10:20:00.000Z'),
            metadata: { activity_id: 'action-2' }
          },
          syncEvent('focus-stop', 5, 'stop', '2026-06-14T11:00:00.000Z')
        ]
      })
    });

    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body.ignored_events, []);
    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].duration_seconds, 7200);
    assert.equal(history.body.sessions[0].activity_interval_count, 2);
    assert.equal(history.body.sessions[0].primary_activity_id, 'action-1');
    assert.equal(history.body.sessions[0].primary_activity_title, 'Письмо');
    assert.deepEqual(
      history.body.sessions[0].intervals.map((interval) => [
        interval.activity_id,
        interval.activity_title,
        interval.started_at_utc,
        interval.ended_at_utc,
        interval.duration_seconds
      ]),
      [
        [null, null, '2026-06-14T09:00:00.000Z', '2026-06-14T09:30:00.000Z', 1800],
        ['action-1', 'Письмо', '2026-06-14T09:30:00.000Z', '2026-06-14T10:00:00.000Z', 1800],
        ['action-2', 'Звонок', '2026-06-14T10:00:00.000Z', '2026-06-14T10:20:00.000Z', 1200],
        [null, null, '2026-06-14T10:20:00.000Z', '2026-06-14T11:00:00.000Z', 2400]
      ]
    );
  } finally {
    await fixture.close();
  }
});

test('deleting active activity closes its interval and keeps parent focus active', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:30:00.000Z',
    '2026-06-14T12:30:01.000Z',
    '2026-06-14T12:30:02.000Z',
    '2026-06-14T12:30:03.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('create-action-1', 1, 'create', 'action-1', '2026-06-14T08:00:00.000Z', { title: 'Письмо' })
        ]
      })
    });

    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('activity-start', 1, 'start_activity_focus', '2026-06-14T09:00:00.000Z'),
            metadata: { activity_id: 'action-1' }
          }
        ]
      })
    });

    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          actionEvent('delete-action-1', 2, 'delete', 'action-1', '2026-06-14T09:20:00.000Z')
        ]
      })
    });

    const state = await request(fixture.url, '/v1/timer/state');
    assert.equal(state.body.active_activity_id, null);
    assert.equal(state.body.active_interval.activity_id, null);
    assert.equal(state.body.active_interval.started_at_utc, '2026-06-14T09:20:00.000Z');
    assert.deepEqual(
      state.body.active_session.intervals.map((interval) => [
        interval.activity_id,
        interval.started_at_utc,
        interval.ended_at_utc,
        interval.duration_seconds
      ]),
      [
        ['action-1', '2026-06-14T09:00:00.000Z', '2026-06-14T09:20:00.000Z', 1200],
        [null, '2026-06-14T09:20:00.000Z', null, null]
      ]
    );

    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [syncEvent('focus-stop', 2, 'stop', '2026-06-14T10:00:00.000Z')]
      })
    });

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].duration_seconds, 3600);
    assert.deepEqual(
      history.body.sessions[0].intervals.map((interval) => [
        interval.activity_id,
        interval.started_at_utc,
        interval.ended_at_utc,
        interval.duration_seconds
      ]),
      [
        ['action-1', '2026-06-14T09:00:00.000Z', '2026-06-14T09:20:00.000Z', 1200],
        [null, '2026-06-14T09:20:00.000Z', '2026-06-14T10:00:00.000Z', 2400]
      ]
    );
  } finally {
    await fixture.close();
  }
});

test('event sync edits completed single-interval focus sessions idempotently', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:00:03.000Z',
    '2026-06-14T12:00:04.000Z',
    '2026-06-14T12:00:05.000Z',
    '2026-06-14T12:00:06.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('web-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('web-stop', 2, 'stop', '2026-06-14T11:00:00.000Z')
        ]
      })
    });
    const before = await request(fixture.url, '/v1/sessions');
    const sessionId = before.body.sessions[0].id;
    const editBody = {
      device: { device_id: 'web-device', platform: 'web' },
      events: [
        {
          ...syncEvent('edit-session', 3, 'edit_session', '2026-06-14T12:00:00.000Z'),
          metadata: {
            focus_session_id: sessionId,
            started_at_utc: '2026-06-14T10:15:00.000Z',
            ended_at_utc: '2026-06-14T11:45:00.000Z'
          }
        }
      ]
    };

    const edited = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify(editBody)
    });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.ignored_events, []);

    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions[0].id, sessionId);
    assert.equal(history.body.sessions[0].started_at_utc, '2026-06-14T10:15:00.000Z');
    assert.equal(history.body.sessions[0].ended_at_utc, '2026-06-14T11:45:00.000Z');
    assert.equal(history.body.sessions[0].duration_seconds, 5400);

    const goal = await request(
      fixture.url,
      '/v1/goals/challenge?now=2026-06-14T12:30:00.000Z'
    );
    assert.equal(goal.body.days.find((item) => item.date === '2026-06-14').completed_seconds, 5400);

    assert.equal(
      fixture.store.db
        .prepare('SELECT COUNT(*) AS count FROM focus_session_intervals WHERE focus_session_id = ?')
        .get(sessionId).count,
      1
    );

    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify(editBody)
    });
    assert.equal(
      fixture.store.db
        .prepare('SELECT COUNT(*) AS count FROM focus_session_intervals WHERE focus_session_id = ?')
        .get(sessionId).count,
      1
    );

    assert.equal(
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'focus_session_versions'")
        .get().count,
      0
    );
  } finally {
    await fixture.close();
  }
});

test('event sync ignores invalid focus session edits', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:00:03.000Z',
    '2026-06-14T12:00:04.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('web-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('web-stop', 2, 'stop', '2026-06-14T11:00:00.000Z')
        ]
      })
    });
    const before = await request(fixture.url, '/v1/sessions');
    const sessionId = before.body.sessions[0].id;

    const response = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('bad-edit', 3, 'edit_session', '2026-06-14T12:00:00.000Z'),
            metadata: {
              focus_session_id: sessionId,
              started_at_utc: '2026-06-14T11:45:00.000Z',
              ended_at_utc: '2026-06-14T10:15:00.000Z'
            }
          }
        ]
      })
    });

    assert.deepEqual(response.body.ignored_events, [
      { event_id: 'bad-edit', reason: 'invalid_session_range' }
    ]);
    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions[0].duration_seconds, 3600);
    assert.equal(
      fixture.store.db
        .prepare('SELECT COUNT(*) AS count FROM focus_session_intervals WHERE focus_session_id = ?')
        .get(sessionId).count,
      1
    );
  } finally {
    await fixture.close();
  }
});

test('event sync soft-deletes completed focus sessions idempotently', async () => {
  const fixture = await createFixture([
    '2026-06-14T12:00:03.000Z',
    '2026-06-14T12:00:04.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('web-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('web-stop', 2, 'stop', '2026-06-14T11:00:00.000Z')
        ]
      })
    });
    const before = await request(fixture.url, '/v1/sessions');
    const sessionId = before.body.sessions[0].id;

    const deleted = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('delete-session', 3, 'delete_session', '2026-06-14T12:00:00.000Z'),
            metadata: { focus_session_id: sessionId }
          }
        ]
      })
    });
    assert.deepEqual(deleted.body.ignored_events, []);
    assert.equal((await request(fixture.url, '/v1/sessions')).body.sessions.length, 0);
    assert.equal(
      (await request(fixture.url, '/v1/goals/challenge?now=2026-06-14T12:30:00.000Z'))
        .body.days.find((item) => item.date === '2026-06-14').completed_seconds,
      0
    );
    assert.equal(
      fixture.store.db
        .prepare('SELECT deleted_at_utc FROM focus_sessions WHERE id = ?')
        .get(sessionId).deleted_at_utc,
      '2026-06-14T12:00:00.000Z'
    );
    assert.equal(
      fixture.store.db
        .prepare('SELECT COUNT(*) AS count FROM focus_session_intervals WHERE focus_session_id = ?')
        .get(sessionId).count,
      1
    );

    const duplicate = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('delete-session-again', 4, 'delete_session', '2026-06-14T12:05:00.000Z'),
            metadata: { focus_session_id: sessionId }
          }
        ]
      })
    });
    assert.deepEqual(duplicate.body.ignored_events, []);

    const editAfterDelete = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('edit-deleted', 5, 'edit_session', '2026-06-14T12:04:00.000Z'),
            metadata: {
              focus_session_id: sessionId,
              started_at_utc: '2026-06-14T10:15:00.000Z',
              ended_at_utc: '2026-06-14T11:45:00.000Z'
            }
          }
        ]
      })
    });
    assert.deepEqual(editAfterDelete.body.ignored_events, [
      { event_id: 'edit-deleted', reason: 'focus_session_deleted' }
    ]);
  } finally {
    await fixture.close();
  }
});

test('event sync rejects focus session edits that overlap neighbors', async () => {
  const fixture = await createFixture([
    '2026-06-14T13:30:00.000Z',
    '2026-06-14T13:30:01.000Z',
    '2026-06-14T13:30:02.000Z',
    '2026-06-14T13:30:03.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('first-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('first-stop', 2, 'stop', '2026-06-14T11:00:00.000Z'),
          syncEvent('second-start', 3, 'start', '2026-06-14T12:00:00.000Z'),
          syncEvent('second-stop', 4, 'stop', '2026-06-14T13:00:00.000Z')
        ]
      })
    });
    const sessions = (await request(fixture.url, '/v1/sessions')).body.sessions;
    const first = sessions.find((session) => session.started_at_utc === '2026-06-14T10:00:00.000Z');

    const overlapping = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('overlap-edit', 5, 'edit_session', '2026-06-14T13:30:00.000Z'),
            metadata: {
              focus_session_id: first.id,
              started_at_utc: '2026-06-14T10:30:00.000Z',
              ended_at_utc: '2026-06-14T12:30:00.000Z'
            }
          }
        ]
      })
    });
    assert.deepEqual(overlapping.body.ignored_events, [
      { event_id: 'overlap-edit', reason: 'focus_session_overlap' }
    ]);

    const touching = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('touching-edit', 6, 'edit_session', '2026-06-14T13:31:00.000Z'),
            metadata: {
              focus_session_id: first.id,
              started_at_utc: '2026-06-14T11:00:00.000Z',
              ended_at_utc: '2026-06-14T12:00:00.000Z'
            }
          }
        ]
      })
    });
    assert.deepEqual(touching.body.ignored_events, []);
  } finally {
    await fixture.close();
  }
});

test('event sync rejects focus session edits that overlap active intervals', async () => {
  const fixture = await createFixture([
    '2026-06-14T13:30:00.000Z',
    '2026-06-14T13:30:01.000Z',
    '2026-06-14T13:30:02.000Z',
    '2026-06-14T13:30:03.000Z'
  ]);

  try {
    await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          syncEvent('first-start', 1, 'start', '2026-06-14T10:00:00.000Z'),
          syncEvent('first-stop', 2, 'stop', '2026-06-14T11:00:00.000Z'),
          syncEvent('active-start', 3, 'start', '2026-06-14T11:30:00.000Z')
        ]
      })
    });
    const sessions = (await request(fixture.url, '/v1/sessions')).body.sessions;
    const completed = sessions.find((session) => session.started_at_utc === '2026-06-14T10:00:00.000Z');

    const overlapping = await request(fixture.url, '/v1/timer/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          {
            ...syncEvent('active-overlap-edit', 4, 'edit_session', '2026-06-14T13:30:00.000Z'),
            metadata: {
              focus_session_id: completed.id,
              started_at_utc: '2026-06-14T10:00:00.000Z',
              ended_at_utc: '2026-06-14T11:45:00.000Z'
            }
          }
        ]
      })
    });

    assert.deepEqual(overlapping.body.ignored_events, [
      { event_id: 'active-overlap-edit', reason: 'focus_session_overlap' }
    ]);
    const history = await request(fixture.url, '/v1/sessions');
    assert.equal(history.body.sessions.find((session) => session.id === completed.id).duration_seconds, 3600);
    assert.equal((await request(fixture.url, '/v1/timer/state')).body.active_session.started_at_utc, '2026-06-14T11:30:00.000Z');
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
