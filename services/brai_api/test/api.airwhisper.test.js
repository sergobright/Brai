import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, jsonRequest, TOKEN } from '../test-support/api.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

test('AirWhisper access tokens, health, admin summary, and migrations work in Brai API', async () => {
  const fixture = await createFixture(['2026-07-03T12:00:00.000Z']);
  try {
    for (const table of ['airwhisper_settings', 'airwhisper_access_tokens', 'airwhisper_usage_events']) {
      assert.ok(fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      assert.ok(fixture.store.db.prepare('SELECT title FROM table_descriptions WHERE table_name = ?').get(table));
    }
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 47').get().description,
      'add AirWhisper dictation runtime'
    );
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM handlers WHERE id = 'airwhisper.dictate.transcription'").get());

    const denied = await fetch(`${fixture.url}/v1/health`);
    assert.equal(denied.status, 401);

    const access = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({
        displayName: ' Demo  User ',
        deviceId: 'device-1',
        clientVersion: '9',
        appPackage: 'world.brightos.brai'
      })
    });
    assert.equal(access.status, 201);
    assert.match(access.body.token, /^aw_/);
    assert.equal(access.body.displayName, 'Demo User');

    const tokenRows = fixture.store.db.prepare('SELECT * FROM airwhisper_access_tokens').all();
    assert.equal(tokenRows.length, 1);
    assert.equal(JSON.stringify(tokenRows).includes(access.body.token), false);
    assert.equal(JSON.stringify(tokenRows).includes('device-1'), false);

    const health = await fetch(`${fixture.url}/v1/health`, {
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-airwhisper-device-id': 'device-1'
      }
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const adminDenied = await fetch(`${fixture.url}/v1/airwhisper/admin/summary`);
    assert.equal(adminDenied.status, 401);
    const admin = await fetch(`${fixture.url}/v1/airwhisper/admin/summary`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(admin.status, 200);
    const summary = await admin.json();
    assert.equal(summary.totals.activeTokens, 1);
  } finally {
    await fixture.close();
  }
});

test('AirWhisper imports legacy token hashes and usage once', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'brai-airwhisper-'));
  const legacyPath = join(tempDir, 'airwhisper-store.json');
  const rawToken = 'aw_legacy-token';
  const deviceId = 'legacy-device';
  await writeFile(legacyPath, JSON.stringify({
    settings: { registrationEnabled: false },
    tokens: [{
      id: 'legacy-token-1',
      displayName: 'Legacy User',
      tokenHash: sha256(rawToken),
      deviceIdHash: sha256(deviceId),
      status: 'active',
      source: 'self_service',
      createdAt: '2026-06-01T00:00:00.000Z',
      activatedAt: '2026-06-01T00:00:00.000Z',
      lastUsedAt: null,
      clientVersion: 'old-apk',
      appPackage: 'dev.airwhisper'
    }],
    usageEvents: [{
      id: 'legacy-usage-1',
      accessTokenId: 'legacy-token-1',
      createdAt: '2026-06-02T00:00:00.000Z',
      success: true,
      audioBytes: 42,
      audioDurationMs: 1000,
      provider: 'groq',
      model: 'whisper-large-v3',
      fallbackUsed: false,
      transcriptionMs: 200,
      totalMs: 300,
      transcriptChars: 12,
      clientVersion: 'old-apk'
    }]
  }));

  const previousPath = process.env.BRAI_AIRWHISPER_LEGACY_STORE_PATH;
  process.env.BRAI_AIRWHISPER_LEGACY_STORE_PATH = legacyPath;
  const fixture = await createFixture(['2026-07-03T12:05:00.000Z']);
  try {
    assert.equal(fixture.store.airWhisperSettings().registrationEnabled, false);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM airwhisper_access_tokens').get().count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM airwhisper_usage_events').get().count, 1);
    assert.equal(JSON.stringify(fixture.store.airWhisperAdminSummary()).includes(rawToken), false);

    const health = await fetch(`${fixture.url}/v1/health`, {
      headers: {
        authorization: `Bearer ${rawToken}`,
        'x-airwhisper-device-id': deviceId
      }
    });
    assert.equal(health.status, 200);

    fixture.store.migrate();
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM airwhisper_access_tokens').get().count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM airwhisper_usage_events').get().count, 1);
    assert.ok(fixture.store.db.prepare("SELECT value FROM airwhisper_settings WHERE key = 'legacy_store_imported_path'").get());
  } finally {
    await fixture.close();
    if (previousPath === undefined) delete process.env.BRAI_AIRWHISPER_LEGACY_STORE_PATH;
    else process.env.BRAI_AIRWHISPER_LEGACY_STORE_PATH = previousPath;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('AirWhisper dictation accepts multipart audio and stores only usage metrics', async () => {
  let postProcessCalls = 0;
  let contextReplyCalls = 0;
  const fixture = await createFixture(['2026-07-03T12:10:00.000Z'], {
    airWhisper: {
      deps: {
        transcribeAudio: async (file) => {
          assert.equal(file.fieldName, 'audio');
          assert.equal(file.filename, 'voice.m4a');
          assert.equal(file.contentType, 'audio/mp4');
          assert.equal(file.data.toString('utf8'), 'fake-audio');
          return { text: 'raw transcript', provider: 'fake', model: 'fake-whisper', fallbackUsed: false };
        },
        postProcessTranscript: async (text, prompt) => {
          postProcessCalls += 1;
          assert.equal(text, 'raw transcript');
          assert.equal(prompt, 'fix it');
          return { text: 'processed transcript', provider: 'fake', model: 'fake-post' };
        },
        generateContextReply: async (command, contextJson) => {
          contextReplyCalls += 1;
          assert.equal(command, 'raw transcript');
          assert.equal(JSON.parse(contextJson).messenger, 'telegram');
          return { text: 'context reply', provider: 'fake', model: 'fake-context' };
        }
      }
    }
  });

  try {
    const access = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Tester', deviceId: 'device-2' })
    });
    const token = access.body.token;

    const processed = await dictate(fixture.url, token, 'device-2', {
      postProcessingEnabled: 'true',
      postProcessingPrompt: 'fix it'
    });
    assert.equal(processed.status, 200);
    assert.equal(processed.body.text, 'processed transcript');
    assert.equal(processed.body.postProcessed, true);
    assert.equal(postProcessCalls, 1);

    const context = await dictate(fixture.url, token, 'device-2', {
      headerContextEnabled: 'true',
      normalizedContextJson: JSON.stringify({ messenger: 'telegram', messages: [] })
    });
    assert.equal(context.status, 200);
    assert.equal(context.body.text, 'context reply');
    assert.equal(contextReplyCalls, 1);

    const usage = fixture.store.db.prepare('SELECT * FROM airwhisper_usage_events ORDER BY created_at_utc').all();
    assert.equal(usage.length, 2);
    assert.equal(usage.every((row) => row.success === 1), true);
    assert.equal(usage.every((row) => row.audio_bytes === 'fake-audio'.length), true);
    assert.equal(JSON.stringify(usage).includes('processed transcript'), false);
    assert.equal(JSON.stringify(usage).includes('raw transcript'), false);
  } finally {
    await fixture.close();
  }
});

test('Brai Cmd inbox route accepts Android access token and creates Inbox context items', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'brai-cmd-inbox-'));
  const fixture = await createFixture(['2026-07-04T12:00:00.000Z'], {
    inboundStorageRoot: storageRoot,
    inboundTitleGenerator: async () => 'Команда с контекстом'
  });

  try {
    const denied = await jsonRequest(fixture.url, '/v1/brai-cmd/inbox', {
      method: 'POST',
      body: JSON.stringify({ text: 'без токена' })
    });
    assert.equal(denied.status, 401);

    const access = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Tester', deviceId: 'cmd-device' })
    });
    const response = await jsonRequest(fixture.url, '/v1/brai-cmd/inbox', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-airwhisper-device-id': 'cmd-device'
      },
      body: JSON.stringify({
        text: 'разбери экран',
        description_json: { appLabel: 'Telegram', page: { items: ['hello'] } },
        attachments: [{ base64: PNG_BYTES.toString('base64'), mime: 'image/png', name: 'screen.png' }],
        idempotency_key: 'cmd-1'
      })
    });

    assert.equal(response.status, 201);
    const item = response.body.state.inbox[0];
    assert.equal(item.title, 'Команда с контекстом');
    assert.equal(item.explanation_text, 'разбери экран');
    assert.equal(item.description_md, '{\n  "appLabel": "Telegram",\n  "page": {\n    "items": [\n      "hello"\n    ]\n  }\n}');
    assert.equal(item.source, 'brai-cmd');
    assert.equal(item.record_type_id, 1);
    assert.match(item.attachment_links[0], /^\/v1\/inbox\/attachments\/.+\.png$/);

    const duplicate = await jsonRequest(fixture.url, '/v1/brai-cmd/inbox', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-airwhisper-device-id': 'cmd-device'
      },
      body: JSON.stringify({ text: 'разбери экран', idempotency_key: 'cmd-1' })
    });
    assert.equal(duplicate.status, 200);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM inbox').get().count, 1);
  } finally {
    await fixture.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('AirWhisper dictation rejects bad requests and records failure usage', async () => {
  const fixture = await createFixture(['2026-07-03T12:20:00.000Z'], {
    airWhisper: {
      deps: {
        transcribeAudio: async () => {
          throw new Error('should not transcribe');
        }
      }
    }
  });

  try {
    const access = await jsonRequest(fixture.url, '/v1/access/request', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'Tester', deviceId: 'device-3' })
    });
    const response = await fetch(`${fixture.url}/v1/dictate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-airwhisper-device-id': 'device-3',
        'content-type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'unsupported_media_type');
    assert.equal(
      fixture.store.db.prepare('SELECT success, error_code FROM airwhisper_usage_events').get().error_code,
      'unsupported_media_type'
    );
  } finally {
    await fixture.close();
  }
});

async function dictate(baseUrl, token, deviceId, fields = {}) {
  const form = new FormData();
  form.set('audioDurationMs', '1234');
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('audio', new Blob([Buffer.from('fake-audio')], { type: 'audio/mp4' }), 'voice.m4a');
  const response = await fetch(`${baseUrl}/v1/dictate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-airwhisper-device-id': deviceId,
      'x-airwhisper-client-version': 'test'
    },
    body: form
  });
  return { status: response.status, body: await response.json() };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
