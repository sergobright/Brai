import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocket } from 'ws';
import { TOKEN, createFixture, onceOpen, request, tableCount } from '../test-support/api.js';

const NOW = '2026-07-13T12:00:00.000Z';
const OWNER = 'expected-owner';

test('expected owner header rejects a changed scope before mutation and accepts the authenticated owner', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedPrimaryUser(fixture);
    const before = {
      events: tableCount(fixture, 'events'),
      sessions: tableCount(fixture, 'focus_sessions')
    };

    const rejected = await request(fixture.url, '/v1/timer/start', {
      method: 'POST',
      headers: { 'x-brai-expected-user-id': 'different-owner' }
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body, { error: 'user_scope_changed' });
    assert.deepEqual({
      events: tableCount(fixture, 'events'),
      sessions: tableCount(fixture, 'focus_sessions')
    }, before);

    const accepted = await request(fixture.url, '/v1/timer/start', {
      method: 'POST',
      headers: { 'x-brai-expected-user-id': OWNER }
    });
    assert.equal(accepted.status, 201);
    assert.equal(tableCount(fixture, 'focus_sessions'), before.sessions + 1);

    const preflight = await fetch(`${fixture.url}/v1/timer/start`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.brai.one' }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-brai-expected-user-id/);
  } finally {
    await fixture.close();
  }
});

test('expected owner query rejects a changed WebSocket scope and accepts the authenticated owner', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedPrimaryUser(fixture);
    const rejectedStatus = await websocketUpgradeStatus(
      `${fixture.url}/v1/live?token=${TOKEN}&expected_user_id=different-owner`
    );
    assert.equal(rejectedStatus, 409);

    const ws = new WebSocket(
      `${fixture.wsUrl}/v1/live?token=${TOKEN}&expected_user_id=${encodeURIComponent(OWNER)}`
    );
    await onceOpen(ws);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await fixture.close();
  }
});

function seedPrimaryUser(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Expected Owner', 'owner@example.com', true, ?, ?)
  `).run(OWNER, NOW, NOW);
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?)
  `).run(OWNER, NOW);
}

function websocketUpgradeStatus(url) {
  return new Promise((resolve, reject) => {
    const upgrade = http.request(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
        'sec-websocket-version': '13'
      }
    });
    upgrade.once('response', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    upgrade.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('unexpected_websocket_upgrade'));
    });
    upgrade.once('error', reject);
    upgrade.end();
  });
}
