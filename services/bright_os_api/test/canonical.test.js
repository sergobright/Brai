import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalSessions } from '../src/canonical.js';

test('canonical merge unions overlapping, containing, and touching intervals', () => {
  const sessions = buildCanonicalSessions([
    event('a-start', 'device-a', 1, 'start', '2026-06-14T10:00:00.000Z'),
    event('a-stop', 'device-a', 2, 'stop', '2026-06-14T11:00:00.000Z'),
    event('b-start', 'device-b', 1, 'start', '2026-06-14T10:30:00.000Z'),
    event('b-stop', 'device-b', 2, 'stop', '2026-06-14T12:00:00.000Z'),
    event('c-start', 'device-c', 1, 'start', '2026-06-14T12:00:00.000Z'),
    event('c-stop', 'device-c', 2, 'stop', '2026-06-14T12:30:00.000Z')
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].started_at_utc, '2026-06-14T10:00:00.000Z');
  assert.equal(sessions[0].ended_at_utc, '2026-06-14T12:30:00.000Z');
  assert.equal(sessions[0].duration_seconds, 9000);
});

test('canonical merge keeps real gaps as separate sessions', () => {
  const sessions = buildCanonicalSessions([
    event('a-start', 'device-a', 1, 'start', '2026-06-14T10:00:00.000Z'),
    event('a-stop', 'device-a', 2, 'stop', '2026-06-14T11:00:00.000Z'),
    event('b-start', 'device-b', 1, 'start', '2026-06-14T11:05:00.000Z'),
    event('b-stop', 'device-b', 2, 'stop', '2026-06-14T12:00:00.000Z')
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].duration_seconds, 3600);
  assert.equal(sessions[1].duration_seconds, 3300);
});

test('canonical merge keeps one active session while any device remains open', () => {
  const sessions = buildCanonicalSessions([
    event('a-start', 'device-a', 1, 'start', '2026-06-14T10:00:00.000Z'),
    event('a-stop', 'device-a', 2, 'stop', '2026-06-14T11:00:00.000Z'),
    event('b-start', 'device-b', 1, 'start', '2026-06-14T10:30:00.000Z')
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].started_at_utc, '2026-06-14T10:00:00.000Z');
  assert.equal(sessions[0].ended_at_utc, null);
  assert.equal(sessions[0].duration_seconds, null);
});

test('global stop closes open device timelines without manual conflict state', () => {
  const sessions = buildCanonicalSessions([
    event('a-start', 'device-a', 1, 'start', '2026-06-14T10:00:00.000Z'),
    event('global-stop', 'legacy-server', 1, 'stop', '2026-06-14T11:00:00.000Z', {
      global_stop: true
    }),
    event('a-stop', 'device-a', 2, 'stop', '2026-06-14T12:00:00.000Z')
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ended_at_utc, '2026-06-14T11:00:00.000Z');
  assert.equal(sessions[0].duration_seconds, 3600);
});

function event(eventId, deviceId, sequence, type, occurredAt, metadata = {}) {
  return {
    event_id: eventId,
    device_id: deviceId,
    client_sequence: sequence,
    server_sequence: sequence,
    type,
    occurred_at_utc: occurredAt,
    received_at_utc: occurredAt,
    status: 'accepted',
    metadata_json: JSON.stringify(metadata)
  };
}
