import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFixture, jsonRequest, request } from '../test-support/api.js';

const NOW = ['2026-07-14T22:00:00.000Z'];

function createAuthRuntime({ getSession, healthCheck = async () => {} }) {
  return () => ({
    auth: { api: { getSession } },
    healthCheck,
    testEmailLogin: async () => { throw new Error('test_email_login_not_configured'); },
    close: async () => {}
  });
}

function sessionResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('Better Auth user and anonymous responses stay authoritative', async () => {
  const userFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({
      getSession: async () => sessionResponse({
        session: { id: 'session-1' },
        user: { id: 'auth-user', email: 'auth@example.test', name: 'Auth User' }
      })
    })
  });
  try {
    const session = await jsonRequest(userFixture.url, '/auth/session');
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, {
      authenticated: true,
      user: { id: 'auth-user', email: 'auth@example.test', name: 'Auth User' }
    });
    assert.equal((await jsonRequest(userFixture.url, '/v1/activities')).status, 200);
  } finally {
    await userFixture.close();
  }

  const anonymousFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({ getSession: async () => sessionResponse(null) })
  });
  try {
    const session = await jsonRequest(anonymousFixture.url, '/auth/session');
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, { authenticated: false, user: null });
    assert.equal((await jsonRequest(anonymousFixture.url, '/v1/activities')).status, 401);
  } finally {
    await anonymousFixture.close();
  }
});

test('Better Auth exceptions and non-OK responses return 503 for session, HTTP, and WebSocket auth', async (t) => {
  const failures = [
    ['exception', async () => { throw new Error('database_unreachable'); }],
    ['non-OK response', async () => sessionResponse({ error: 'upstream_failure' }, 500)],
    ['empty successful response', async () => new Response('', { status: 200 })],
    ['malformed JSON response', async () => new Response('{', { status: 200 })],
    ['malformed object response', async () => sessionResponse({})],
    ['malformed user response', async () => sessionResponse({ session: {}, user: {} })],
    ['never-resolving response', async () => new Promise(() => {})]
  ];

  for (const [name, getSession] of failures) {
    await t.test(name, async () => {
      const fixture = await createFixture(NOW, {
        createAuth: createAuthRuntime({ getSession }),
        authBackendTimeoutMs: 25
      });
      try {
        const session = await jsonRequest(fixture.url, '/auth/session');
        assert.equal(session.status, 503);
        assert.deepEqual(session.body, { error: 'auth_backend_unavailable' });

        const protectedHttp = await request(fixture.url, '/v1/activities');
        assert.equal(protectedHttp.status, 503);
        assert.deepEqual(protectedHttp.body, { error: 'auth_backend_unavailable' });

        assert.equal(await websocketUpgradeStatus(fixture.url), 503);
      } finally {
        await fixture.close();
      }
    });
  }
});

test('health requires both the primary and Better Auth database pools', async () => {
  const authFailureFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({
      getSession: async () => sessionResponse(null),
      healthCheck: async () => { throw new Error('auth_pool_unavailable'); }
    })
  });
  try {
    const health = await jsonRequest(authFailureFixture.url, '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, error: 'auth_backend_unavailable' });
  } finally {
    await authFailureFixture.close();
  }

  const synchronousAuthFailureFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({
      getSession: async () => sessionResponse(null),
      healthCheck: () => { throw new Error('auth_pool_unavailable'); }
    })
  });
  try {
    const health = await jsonRequest(synchronousAuthFailureFixture.url, '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, error: 'auth_backend_unavailable' });
  } finally {
    await synchronousAuthFailureFixture.close();
  }

  const stalledAuthFailureFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({
      getSession: async () => sessionResponse(null),
      healthCheck: async () => new Promise(() => {})
    }),
    authBackendTimeoutMs: 25
  });
  try {
    const health = await jsonRequest(stalledAuthFailureFixture.url, '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, error: 'auth_backend_unavailable' });
  } finally {
    await stalledAuthFailureFixture.close();
  }

  const primaryFailureFixture = await createFixture(NOW, {
    createAuth: createAuthRuntime({ getSession: async () => sessionResponse(null) })
  });
  const originalPrepare = primaryFailureFixture.store.db.prepare;
  try {
    primaryFailureFixture.store.db.prepare = () => { throw new Error('primary_pool_unavailable'); };
    const health = await jsonRequest(primaryFailureFixture.url, '/health');
    assert.equal(health.status, 503);
    assert.deepEqual(health.body, { ok: false, error: 'database_unavailable' });
  } finally {
    primaryFailureFixture.store.db.prepare = originalPrepare;
    await primaryFailureFixture.close();
  }
});

function websocketUpgradeStatus(baseUrl) {
  return new Promise((resolve, reject) => {
    const upgrade = http.request(`${baseUrl}/v1/live`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
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
