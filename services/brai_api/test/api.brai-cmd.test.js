import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, jsonRequest, TOKEN } from '../test-support/api.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
  0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

test('Brai Cmd access tokens, health, admin summary, and migrations work in Brai API', async () => {
  const fixture = await createFixture(['2026-07-03T12:00:00.000Z']);
  try {
    for (const table of ['brai_cmd_settings', 'brai_cmd_access_tokens', 'brai_cmd_usage_events']) {
      assert.ok(fixture.store.db.prepare('SELECT to_regclass(?) AS table_name').get(table).table_name);
      assert.ok(fixture.store.db.prepare('SELECT title FROM table_descriptions WHERE table_name = ?').get(table));
    }
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 47').get().description,
      'add Brai Cmd dictation runtime'
    );
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM agents WHERE id = 'brai-cmd.dictate.transcription'").get());

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

    const tokenRows = fixture.store.db.prepare('SELECT * FROM brai_cmd_access_tokens').all();
    assert.equal(tokenRows.length, 1);
    assert.equal(JSON.stringify(tokenRows).includes(access.body.token), false);
    assert.equal(JSON.stringify(tokenRows).includes('device-1'), false);

    const health = await fetch(`${fixture.url}/v1/health`, {
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-brai-cmd-device-id': 'device-1'
      }
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const adminDenied = await fetch(`${fixture.url}/v1/brai-cmd/admin/summary`);
    assert.equal(adminDenied.status, 401);
    const admin = await fetch(`${fixture.url}/v1/brai-cmd/admin/summary`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(admin.status, 200);
    const summary = await admin.json();
    assert.equal(summary.totals.activeTokens, 1);
  } finally {
    await fixture.close();
  }
});

test('Brai Cmd dictation accepts multipart audio and stores only usage metrics', async () => {
  let postProcessCalls = 0;
  let contextReplyCalls = 0;
  const fixture = await createFixture(['2026-07-03T12:10:00.000Z'], {
    braiCmd: {
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

    const usage = fixture.store.db.prepare('SELECT * FROM brai_cmd_usage_events ORDER BY created_at_utc').all();
    assert.equal(usage.length, 2);
    assert.equal(usage.every((row) => row.success === 1), true);
    assert.equal(usage.every((row) => row.audio_bytes === 'fake-audio'.length), true);
    assert.equal(JSON.stringify(usage).includes('processed transcript'), false);
    assert.equal(JSON.stringify(usage).includes('raw transcript'), false);
    const aiLogs = fixture.store.db.prepare('SELECT agent_id, agent_version, status, json_data FROM ai_logs ORDER BY id').all();
    assert.equal(aiLogs.length, 2);
    assert.equal(aiLogs.every((row) => row.agent_id === 'brai-cmd.dictate.transcription'), true);
    assert.equal(aiLogs.every((row) => row.agent_version === '1'), true);
    assert.equal(aiLogs.every((row) => row.status === 'done'), true);
    assert.equal(JSON.parse(aiLogs[0].json_data).outputs.find((output) => output.ref === 'response.text').value, 'processed transcript');
    assert.equal(JSON.parse(aiLogs[1].json_data).outputs.find((output) => output.ref === 'response.text').value, 'context reply');
  } finally {
    await fixture.close();
  }
});

test('Brai Cmd inbox route accepts Android access token and creates Inbox context items', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'brai-cmd-inbox-'));
  const previousFfmpeg = process.env.BRAI_THUMBNAIL_FFMPEG_BIN;
  process.env.BRAI_THUMBNAIL_FFMPEG_BIN = await fakeFfmpeg(storageRoot);
  const fixture = await createFixture(['2026-07-04T12:00:00.000Z'], {
    inboxStorageRoot: storageRoot
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
        'x-brai-cmd-device-id': 'cmd-device'
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
    assert.equal(item.title, 'разбери экран');
    assert.equal(item.explanation_text, 'разбери экран');
    assert.equal(item.description_md, '{\n  "appLabel": "Telegram",\n  "page": {\n    "items": [\n      "hello"\n    ]\n  }\n}');
    assert.equal(item.source, 'brai-cmd');
    assert.equal(item.record_type_id, 1);
    assert.match(item.attachment_links[0], /^\/v1\/inbox\/attachments\/.+\.png$/);
    const preview = await fetch(`${fixture.url}${item.attachment_links[0]}.thumb.jpg`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');

    const duplicate = await jsonRequest(fixture.url, '/v1/brai-cmd/inbox', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access.body.token}`,
        'x-brai-cmd-device-id': 'cmd-device'
      },
      body: JSON.stringify({ text: 'разбери экран', idempotency_key: 'cmd-1' })
    });
    assert.equal(duplicate.status, 200);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM inbox').get().count, 1);
  } finally {
    await fixture.close();
    if (previousFfmpeg === undefined) delete process.env.BRAI_THUMBNAIL_FFMPEG_BIN;
    else process.env.BRAI_THUMBNAIL_FFMPEG_BIN = previousFfmpeg;
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test('Brai Cmd dictation rejects bad requests and records failure usage', async () => {
  const fixture = await createFixture(['2026-07-03T12:20:00.000Z'], {
    braiCmd: {
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
        'x-brai-cmd-device-id': 'device-3',
        'content-type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(response.status, 415);
    assert.equal((await response.json()).code, 'unsupported_media_type');
    assert.equal(
      fixture.store.db.prepare('SELECT success, error_code FROM brai_cmd_usage_events').get().error_code,
      'unsupported_media_type'
    );
    const aiLog = fixture.store.db.prepare('SELECT agent_id, status, json_data FROM ai_logs').get();
    assert.equal(aiLog.agent_id, 'brai-cmd.dictate.transcription');
    assert.equal(aiLog.status, 'failed');
    assert.equal(JSON.parse(aiLog.json_data).metadata.error, 'unsupported_media_type');
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
      'x-brai-cmd-device-id': deviceId,
      'x-brai-cmd-client-version': 'test'
    },
    body: form
  });
  return { status: response.status, body: await response.json() };
}

async function fakeFfmpeg(dir) {
  const file = join(dir, 'fake-ffmpeg');
  await writeFile(file, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv.at(-1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
`);
  await chmod(file, 0o700);
  return file;
}
