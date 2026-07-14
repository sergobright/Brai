import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, jsonRequest, request, waitFor } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const FIRST_KEY = 'sk-account-first-1234';
const REPLACEMENT_KEY = 'sk-account-replacement-5678';
const REJECTED_REPLACEMENT_KEY = 'sk-account-rejected-9999';
const MALFORMED_KEY_SENTINEL = 'sk-provider-sentinel-1234';

test('malformed provider JSON is rejected without logging credential bytes', async () => {
  const errors = [];
  const fixture = await createFixture(Array(6).fill('2026-07-13T11:30:00.000Z'), {
    logger: { error: (...args) => errors.push(args) }
  });
  try {
    seedUser(fixture, 'malformed-user', true);

    const response = await request(fixture.url, '/v1/ai/providers/openai', {
      method: 'PUT',
      body: `{"api_key":"${MALFORMED_KEY_SENTINEL}`
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_json');
    assert.equal(JSON.stringify(errors).includes(MALFORMED_KEY_SENTINEL), false);
    assert.equal(JSON.stringify(errors).includes('sk-provider'), false);
  } finally {
    await fixture.close();
  }
});

test('account AI providers are encrypted, capability-bound, replaceable, and user isolated', async () => {
  const calls = [];
  const fixture = await createFixture(Array(30).fill('2026-07-13T12:00:00.000Z'), {
    userAiFetch: providerFetch(calls)
  });
  try {
    seedUser(fixture, 'user-one', true);
    seedUser(fixture, 'user-two', false);

    const initial = await request(fixture.url, '/v1/ai/settings');
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body.text, null);
    assert.equal(initial.body.model_provider_mode, 'internal');

    const saved = await request(fixture.url, '/v1/ai/providers/openai', {
      method: 'PUT',
      body: JSON.stringify({ api_key: FIRST_KEY })
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.provider.provider_id, 'openai');
    assert.equal(saved.body.provider.key_hint, '1234');
    assert.equal(JSON.stringify(saved.body).includes(FIRST_KEY), false);

    const stored = fixture.store.db.prepare(`
      SELECT encrypted_api_key, key_hint FROM user_provider_credentials
      WHERE user_id = 'user-one' AND provider_id = 'openai'
    `).get();
    assert.match(stored.encrypted_api_key, /^v1\./);
    assert.equal(stored.encrypted_api_key.includes(FIRST_KEY), false);
    assert.equal(stored.key_hint, '1234');

    const models = await request(fixture.url, '/v1/ai/providers/openai/models?capability=vision');
    assert.equal(models.status, 200);
    assert.deepEqual(models.body.models.map((model) => model.id), ['gpt-vision']);

    const configured = await request(fixture.url, '/v1/ai/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        model_provider_mode: 'internal',
        text: { provider_id: 'openai', model: 'gpt-text' },
        vision: { provider_id: 'openai', model: 'gpt-vision' }
      })
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.model_provider_mode, 'internal');
    assert.deepEqual(configured.body.text, { provider_id: 'openai', model: 'gpt-text' });
    assert.deepEqual(configured.body.vision, { provider_id: 'openai', model: 'gpt-vision' });

    const external = await request(fixture.url, '/v1/ai/settings', {
      method: 'PATCH',
      body: JSON.stringify({ model_provider_mode: 'external' })
    });
    assert.equal(external.status, 200);
    assert.equal(external.body.model_provider_mode, 'external');

    const listed = await request(fixture.url, '/v1/ai/providers');
    assert.deepEqual(listed.body.providers[0].in_use_by, ['text', 'vision']);
    assert.equal(JSON.stringify(listed.body).includes(FIRST_KEY), false);
    const blocked = await request(fixture.url, '/v1/ai/providers/openai', { method: 'DELETE' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'provider_in_use');

    const rejectedReplacement = await request(fixture.url, '/v1/ai/providers/openai', {
      method: 'PUT',
      body: JSON.stringify({ api_key: REJECTED_REPLACEMENT_KEY })
    });
    assert.equal(rejectedReplacement.status, 400);
    assert.equal(rejectedReplacement.body.error, 'invalid_key');
    assert.equal(withUserScope('user-one', () => fixture.store.getUserProviderCredential('openai').api_key), FIRST_KEY);
    assert.equal((await request(fixture.url, '/v1/ai/providers')).body.providers[0].key_hint, '1234');

    const replaced = await request(fixture.url, '/v1/ai/providers/openai', {
      method: 'PUT',
      body: JSON.stringify({ api_key: REPLACEMENT_KEY })
    });
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.provider.key_hint, '5678');
    assert.ok(calls.some((call) => call.authorization === `Bearer ${REPLACEMENT_KEY}` && call.kind === 'text_probe'));
    assert.ok(calls.some((call) => call.authorization === `Bearer ${REPLACEMENT_KEY}` && call.kind === 'vision_probe'));

    await withUserScope('user-two', () => {
      assert.deepEqual(fixture.store.listUserProviderCredentials(), []);
      assert.equal(fixture.store.getUserProviderCredential('openai'), null);
    });

    const internal = await request(fixture.url, '/v1/ai/settings', {
      method: 'PATCH',
      body: JSON.stringify({ model_provider_mode: 'internal' })
    });
    assert.deepEqual(internal.body.text, { provider_id: 'openai', model: 'gpt-text' });
    assert.deepEqual(internal.body.vision, { provider_id: 'openai', model: 'gpt-vision' });
    assert.equal((await request(fixture.url, '/v1/ai/providers/openai', { method: 'DELETE' })).status, 200);
    const afterDelete = await request(fixture.url, '/v1/ai/settings');
    assert.deepEqual(afterDelete.body.text, null);
    assert.deepEqual(afterDelete.body.vision, null);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM user_provider_credentials').get().count, 0);

    const logs = fixture.store.db.prepare(`
      SELECT message, json_data FROM logs
      WHERE operation LIKE 'user_ai.%'
    `).all();
    assert.equal(JSON.stringify(logs).includes(FIRST_KEY), false);
    assert.equal(JSON.stringify(logs).includes(REPLACEMENT_KEY), false);
    assert.equal(fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 62').get().description,
      'add account user AI provider credentials and profiles');
  } finally {
    await fixture.close();
  }
});

test('native provider sync imports only missing account keys and returns the canonical account copy', async () => {
  const fixture = await createFixture(Array(20).fill('2026-07-13T13:00:00.000Z'), {
    userAiFetch: providerFetch([])
  });
  try {
    seedUser(fixture, 'native-user', true);
    const anonymous = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Anonymous', deviceId: 'native-device' })
    });
    assert.equal(anonymous.status, 201);
    const issued = await request(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'native-device' })
    });
    assert.equal(issued.status, 201);
    assert.match(issued.body.token, /^bl_/);
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${issued.body.token}`,
        'x-brai-cmd-device-id': 'native-device'
      }
    })).status, 401);

    const activated = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${anonymous.body.token}`,
        'x-brai-cmd-device-id': 'native-device'
      },
      body: JSON.stringify({ link_token: issued.body.token })
    });
    assert.equal(activated.status, 201);
    assert.equal(activated.body.account_user_id, 'native-user');

    const browserDenied = await jsonRequest(fixture.url, '/v1/brai-cmd/provider-credentials/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activated.body.token}`,
        'x-brai-cmd-device-id': 'native-device',
        'sec-fetch-site': 'same-origin'
      },
      body: JSON.stringify({ providers: [] })
    });
    assert.equal(browserDenied.status, 403);
    assert.equal(browserDenied.body.error, 'native_transport_required');

    const first = await nativeSync(fixture, activated.body.token, [{
      provider_id: 'gemini',
      api_key: FIRST_KEY
    }]);
    assert.equal(first.status, 200);
    assert.equal(first.body.account_user_id, 'native-user');
    assert.deepEqual(first.body.imported_provider_ids, ['gemini']);
    assert.equal(first.body.providers[0].api_key, FIRST_KEY);

    const conflict = await nativeSync(fixture, activated.body.token, [{
      provider_id: 'gemini',
      api_key: REPLACEMENT_KEY
    }]);
    assert.deepEqual(conflict.body.imported_provider_ids, []);
    assert.deepEqual(conflict.body.ignored_provider_ids, ['gemini']);
    assert.equal(conflict.body.providers[0].api_key, FIRST_KEY);

    const preliminary = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Anonymous', deviceId: 'anonymous-device' })
    });
    const denied = await jsonRequest(fixture.url, '/v1/brai-cmd/provider-credentials/sync', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${preliminary.body.token}`,
        'x-brai-cmd-device-id': 'anonymous-device'
      },
      body: JSON.stringify({ providers: [] })
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'account_required');

    const log = fixture.store.db.prepare(`
      SELECT json_data FROM logs
      WHERE operation = 'brai_cmd.provider_credentials_sync'
      ORDER BY id DESC LIMIT 1
    `).get();
    assert.ok(log);
    assert.equal(log.json_data.includes(FIRST_KEY), false);
    assert.equal(log.json_data.includes(REPLACEMENT_KEY), false);
  } finally {
    await fixture.close();
  }
});

test('account-bound Brai Cmd inbox writes and runs in the account owner scope', async () => {
  let workflowOwner = null;
  const fixture = await createFixture(Array(12).fill('2026-07-13T13:30:00.000Z'), {
    inboxAutoProcess: true,
    inboxWorkflowStarter: async ({ ownerUserId }) => {
      workflowOwner = ownerUserId;
      return { completion: Promise.resolve() };
    }
  });
  try {
    seedUser(fixture, 'primary-user', true);
    seedUser(fixture, 'secondary-user', false);
    const deviceId = 'secondary-device';
    const anonymous = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Secondary', deviceId })
    });
    const link = fixture.store.issueBraiCmdAccountLink({
      userId: 'secondary-user',
      deviceId,
      displayName: 'Secondary',
      nowIso: '2026-07-13T13:30:00.000Z'
    });
    const activated = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${anonymous.body.token}`,
        'x-brai-cmd-device-id': deviceId
      },
      body: JSON.stringify({ link_token: link.token })
    });
    assert.equal(activated.status, 201);
    assert.equal(activated.body.account_user_id, 'secondary-user');

    const received = await jsonRequest(fixture.url, '/v1/brai-cmd/inbox', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activated.body.token}`,
        'x-brai-cmd-device-id': deviceId
      },
      body: JSON.stringify({
        text: 'Secondary account item',
        idempotency_key: 'secondary-account-item'
      })
    });
    assert.equal(received.status, 201);
    assert.equal(received.body.state.inbox.length, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT user_id FROM inbox WHERE id = ?
    `).get(received.body.inbox_id).user_id, 'secondary-user');
    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM inbox WHERE user_id = 'primary-user'
    `).get().count, 0);
    await waitFor(() => workflowOwner !== null);
    assert.equal(workflowOwner, 'secondary-user');
  } finally {
    await fixture.close();
  }
});

test('provider key and model profile mutations are serialized per account', async () => {
  const calls = [];
  const fixture = await createFixture(Array(30).fill('2026-07-13T14:00:00.000Z'), {
    userAiFetch: providerFetch(calls)
  });
  try {
    seedUser(fixture, 'serialized-user', true);
    assert.equal((await request(fixture.url, '/v1/ai/providers/openai', {
      method: 'PUT',
      body: JSON.stringify({ api_key: FIRST_KEY })
    })).status, 200);
    assert.equal((await request(fixture.url, '/v1/ai/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        model_provider_mode: 'external',
        text: { provider_id: 'openai', model: 'old-text' },
        vision: { provider_id: 'openai', model: 'old-vision' }
      })
    })).status, 200);
    calls.length = 0;

    const [keyResponse, settingsResponse] = await Promise.all([
      request(fixture.url, '/v1/ai/providers/openai', {
        method: 'PUT',
        body: JSON.stringify({ api_key: REPLACEMENT_KEY })
      }),
      request(fixture.url, '/v1/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          model_provider_mode: 'external',
          text: { provider_id: 'openai', model: 'new-text' },
          vision: { provider_id: 'openai', model: 'new-vision' }
        })
      })
    ]);
    assert.equal(keyResponse.status, 200);
    assert.equal(settingsResponse.status, 200);
    assert.ok(calls.some((call) => (
      call.authorization === `Bearer ${REPLACEMENT_KEY}` && call.body?.model === 'new-text'
    )));
    assert.ok(calls.some((call) => (
      call.authorization === `Bearer ${REPLACEMENT_KEY}` && call.body?.model === 'new-vision'
    )));
  } finally {
    await fixture.close();
  }
});

test('account links and Brai Cmd access tokens expire without replacing current access', async () => {
  const fixture = await createFixture(Array(12).fill('2026-07-13T15:00:00.000Z'));
  try {
    seedUser(fixture, 'expiry-user', true);
    const anonymous = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Expiry', deviceId: 'expiry-device' })
    });
    const link = await request(fixture.url, '/v1/brai-cmd/device-token', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'expiry-device' })
    });
    fixture.store.db.prepare(`
      UPDATE brai_cmd_account_link_tokens SET expires_at_utc = '2000-01-01T00:00:00.000Z'
    `).run();

    const expiredLink = await jsonRequest(fixture.url, '/v1/brai-cmd/account-access/activate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${anonymous.body.token}`,
        'x-brai-cmd-device-id': 'expiry-device'
      },
      body: JSON.stringify({ link_token: link.body.token })
    });
    assert.equal(expiredLink.status, 401);
    assert.equal(expiredLink.body.error, 'link_token_expired');
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${anonymous.body.token}`,
        'x-brai-cmd-device-id': 'expiry-device'
      }
    })).status, 200);

    fixture.store.db.prepare(`
      UPDATE brai_cmd_access_tokens SET expires_at_utc = '2000-01-01T00:00:00.000Z'
      WHERE status = 'active'
    `).run();
    assert.equal((await jsonRequest(fixture.url, '/v1/health', {
      headers: {
        authorization: `Bearer ${anonymous.body.token}`,
        'x-brai-cmd-device-id': 'expiry-device'
      }
    })).status, 401);
  } finally {
    await fixture.close();
  }
});

function seedUser(fixture, id, primary) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (?, ?, ?, true, ?, ?)
  `).run(id, id, `${id}@example.test`, '2026-07-13T11:00:00.000Z', '2026-07-13T11:00:00.000Z');
  if (primary) {
    fixture.store.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES ('primary_user_id', ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
    `).run(id, '2026-07-13T11:00:00.000Z');
  }
}

function providerFetch(calls) {
  return async (url, init) => {
    const address = String(url);
    const authorization = init.headers.authorization;
    if (address.endsWith('/models')) {
      calls.push({ kind: 'models', authorization });
      if (authorization === `Bearer ${REJECTED_REPLACEMENT_KEY}`) {
        return response({ error: { code: 'invalid_api_key' } }, 401);
      }
      return response({
        data: [
          { id: 'gpt-text', input_modalities: ['text'], supported_parameters: ['response_format'] },
          { id: 'gpt-vision', input_modalities: ['text', 'image'], supported_parameters: ['response_format'] }
        ]
      });
    }
    const body = JSON.parse(init.body);
    const kind = body.text?.format ? 'text_probe' : 'vision_probe';
    calls.push({ kind, authorization, body });
    return response({ output_text: kind === 'text_probe' ? '{"ok":true}' : 'yes' });
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function nativeSync(fixture, token, providers) {
  return jsonRequest(fixture.url, '/v1/brai-cmd/provider-credentials/sync', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-brai-cmd-device-id': 'native-device'
    },
    body: JSON.stringify({ providers })
  });
}
