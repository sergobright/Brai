import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createBrightOsServer } from '../src/server.js';

export const TOKEN = 'test-token';
export const WEB_PASSWORD = 'test-password';
export const RELEASE_PASSWORD = 'release-password';
export const SESSION_SECRET = 'test-session-secret';

export async function createFixture(times, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-os-api-'));
  const releaseDir = path.join(tmp, 'releases');
  if (options.releaseFiles) {
    fs.mkdirSync(releaseDir);
    for (const [fileName, content] of Object.entries(options.releaseFiles)) {
      fs.writeFileSync(path.join(releaseDir, fileName), content);
    }
  }
  let index = 0;
  const runtime = createBrightOsServer({
    dbPath: path.join(tmp, 'bright_os.sqlite'),
    token: TOKEN,
    webPassword: options.webPassword,
    releasePassword: options.releasePassword,
    sessionSecret: options.sessionSecret,
    releaseDir: options.releaseFiles ? releaseDir : null,
    now: () => new Date(times[Math.min(index++, times.length - 1)]),
    logger: { error: () => {} }
  });

  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = runtime.server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    store: runtime.store,
    close: async () => {
      await runtime.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

export async function request(baseUrl, pathName, options = {}, authorized = true) {
  return jsonRequest(
    baseUrl,
    pathName,
    {
      ...options,
      headers: authorized
        ? {
            authorization: `Bearer ${TOKEN}`,
            ...(options.headers ?? {})
          }
        : options.headers
    }
  );
}

export async function jsonRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    }
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

export async function textRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, options);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

export async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

export function syncEvent(eventId, clientSequence, type, occurredAtUtc) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    type,
    occurred_at_utc: occurredAtUtc,
    local_timer_id: `local-${eventId}`
  };
}

export function actionEvent(eventId, clientSequence, type, actionId, occurredAtUtc, payload = {}) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    type,
    activity_id: actionId,
    occurred_at_utc: occurredAtUtc,
    payload
  };
}

export function tableCount(fixture, table) {
  assert.match(table, /^[a-z_]+$/);
  return fixture.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

export function seedLegacyDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE timer_sessions (
      id TEXT PRIMARY KEY,
      started_at_utc TEXT NOT NULL,
      ended_at_utc TEXT,
      duration_seconds INTEGER,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE UNIQUE INDEX idx_timer_sessions_one_active
    ON timer_sessions ((ended_at_utc IS NULL))
    WHERE ended_at_utc IS NULL;

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO timer_sessions (
      id, started_at_utc, ended_at_utc, duration_seconds, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'legacy-complete',
    '2026-06-14T08:00:00.000Z',
    '2026-06-14T09:00:00.000Z',
    3600,
    '2026-06-14T08:00:00.000Z',
    '2026-06-14T09:00:00.000Z'
  );
  insert.run(
    'legacy-active',
    '2026-06-14T10:00:00.000Z',
    null,
    null,
    '2026-06-14T10:00:00.000Z',
    '2026-06-14T10:00:00.000Z'
  );
  db.close();
}

export function seedActionsDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_utc TEXT NOT NULL,
      description TEXT NOT NULL
    );

    INSERT INTO schema_migrations (version, applied_at_utc, description)
    VALUES
      (1, '2026-06-16T00:00:00.000Z', 'base timer sessions and settings schema'),
      (2, '2026-06-16T00:00:00.000Z', 'offline-first timer event log and canonical sessions'),
      (3, '2026-06-16T00:00:00.000Z', 'offline-first actions event log and canonical actions');

    CREATE TABLE timer_devices (
      device_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      display_name TEXT,
      created_at_utc TEXT NOT NULL,
      last_seen_at_utc TEXT NOT NULL,
      last_sync_at_utc TEXT,
      last_server_clock_offset_ms INTEGER
    );

    INSERT INTO timer_devices (
      device_id, platform, display_name, created_at_utc, last_seen_at_utc
    ) VALUES (
      'web-device', 'web', 'Bright OS Web', '2026-06-16T09:00:00.000Z', '2026-06-16T09:00:00.000Z'
    );

    CREATE TABLE actions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('New', 'Done')),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      completed_at_utc TEXT,
      last_event_id TEXT
    );

    INSERT INTO actions (
      id, title, status, created_at_utc, updated_at_utc, completed_at_utc, last_event_id
    ) VALUES (
      'action-1', 'Фокус', 'New', '2026-06-16T09:00:00.000Z', '2026-06-16T09:00:00.000Z', NULL, 'create'
    );

    CREATE TABLE action_events (
      event_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      client_sequence INTEGER NOT NULL,
      server_sequence INTEGER NOT NULL UNIQUE,
      action_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'set_status', 'invalid')),
      occurred_at_utc TEXT NOT NULL,
      received_at_utc TEXT NOT NULL,
      payload_json TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
      ignore_reason TEXT,
      payload_version INTEGER NOT NULL,
      FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
    );

    INSERT INTO action_events (
      event_id, device_id, client_sequence, server_sequence, action_id, type,
      occurred_at_utc, received_at_utc, payload_json, status, ignore_reason, payload_version
    ) VALUES (
      'create', 'web-device', 1, 1, 'action-1', 'create',
      '2026-06-16T09:00:00.000Z', '2026-06-16T09:00:00.000Z',
      '{"title":"Фокус"}', 'accepted', NULL, 1
    );
  `);
  db.close();
}
