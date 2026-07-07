import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  INBOX_API_KEY,
  TOKEN,
  createFixture,
  inboxRequest,
  eventDomainCount,
  tableCount,
  waitFor
} from '../test-support/api.js';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
  0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
  0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb, 0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);
const IMAGE_BASE64 = PNG_BYTES.toString('base64');
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const TEXT_BYTES = Buffer.from('hello inbox file\n', 'utf8');

test('Inbox API short endpoint returns an api-key protected default handshake', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(fixture.url, '/v1/');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, target: 'inbox' });
  } finally {
    await fixture.close();
  }
});

test('Inbox API old target URLs are not supported', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const shortOld = await inboxRequest(fixture.url, '/v1/in');
    const targetOld = await inboxRequest(fixture.url, '/v1/in/inbox');

    assert.equal(shortOld.status, 404);
    assert.equal(targetOld.status, 404);
    assert.equal(shortOld.body.error, 'not_found');
    assert.equal(targetOld.body.error, 'not_found');
    assert.equal(tableCount(fixture, 'inbox'), 0);
  } finally {
    await fixture.close();
  }
});

test('Inbox API POST creates an immediately visible row with explanation and attachment link', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbox-files-'));
  const previousFfmpeg = process.env.BRAI_THUMBNAIL_FFMPEG_BIN;
  process.env.BRAI_THUMBNAIL_FFMPEG_BIN = fakeFfmpeg(storageRoot);
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    inboxStorageRoot: storageRoot
  });

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Положить это во входящие',
        image_base64: IMAGE_BASE64,
        image_mime: 'image/png',
        source: 'telegram',
        idempotency_key: 'message-1'
      })
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.target, 'inbox');
    assert.equal(response.body.state.inbox.length, 1);
    assert.equal(response.body.state.inbox[0].title, 'Положить это во входящие');
    assert.equal(response.body.state.inbox[0].explanation_text, 'Положить это во входящие');
    assert.equal(response.body.state.inbox[0].normalization_text, '');
    assert.equal(response.body.state.inbox[0].is_normalized, false);
    assert.equal(response.body.state.inbox[0].source, 'telegram');
    assert.equal(response.body.state.inbox[0].source_key, '');
    assert.equal(response.body.state.inbox[0].response_required, false);
    assert.equal(response.body.state.inbox[0].related_inbox_id, null);
    assert.equal(response.body.state.inbox[0].record_type_id, 1);
    assert.equal(response.body.state.inbox[0].attachment_links.length, 1);
    assert.match(response.body.state.inbox[0].attachment_links[0], /^\/v1\/inbox\/attachments\/.+\.png$/);
    const attachmentName = path.basename(response.body.state.inbox[0].attachment_links[0]);
    assert.ok(fs.existsSync(path.join(storageRoot, attachmentName)));
    assert.ok(fs.existsSync(path.join(storageRoot, `${attachmentName}.thumb.jpg`)));
    const file = await fetch(`${fixture.url}${response.body.state.inbox[0].attachment_links[0]}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_BYTES);
    const preview = await fetch(`${fixture.url}${response.body.state.inbox[0].attachment_links[0]}.thumb.jpg`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/jpeg');
    assert.ok((await preview.arrayBuffer()).byteLength > 0);

    const duplicate = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Положить это во входящие',
        image_base64: IMAGE_BASE64,
        image_mime: 'image/png',
        idempotency_key: 'message-1'
      })
    });
    assert.equal(duplicate.status, 200);
    assert.equal(tableCount(fixture, 'inbox'), 1);
    assert.equal(eventDomainCount(fixture, 'inbox'), 1);
    assert.equal(tableCount(fixture, 'ai_logs'), 0);
  } finally {
    await fixture.close();
    if (previousFfmpeg === undefined) delete process.env.BRAI_THUMBNAIL_FFMPEG_BIN;
    else process.env.BRAI_THUMBNAIL_FFMPEG_BIN = previousFfmpeg;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Inbox API accepts destination from body or header only when it is inbox', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const bodyTarget = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      headers: { 'x-brai-target': 'inbox' },
      body: JSON.stringify({
        target: 'finance',
        text: 'Пока не сохранять в неизвестное место'
      })
    });
    const headerTarget = await inboxRequest(fixture.url, '/v1/', {
      headers: { 'x-brai-target': 'finance' }
    });

    assert.equal(bodyTarget.status, 404);
    assert.equal(headerTarget.status, 404);
    assert.equal(bodyTarget.body.error, 'unsupported_target');
    assert.equal(headerTarget.body.error, 'unsupported_target');
    assert.equal(tableCount(fixture, 'inbox'), 0);
  } finally {
    await fixture.close();
  }
});

test('Inbox API accepts multiple attachments, description content, and metadata', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbox-files-'));
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    inboxStorageRoot: storageRoot
  });

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Принять пачку вложений',
        description: { kind: 'payload', count: 2 },
        attachments: [
          { base64: PDF_BYTES.toString('base64'), mime: 'application/pdf', name: 'brief.pdf' },
          { base64: TEXT_BYTES.toString('base64'), mime: 'text/plain', name: 'note.txt' }
        ],
        source: 'agent-api',
        source_key: 'agent-42',
        response_required: true,
        record_type_id: 2
      })
    });

    const item = response.body.state.inbox[0];
    assert.equal(response.status, 201);
    assert.equal(item.title, 'Принять пачку вложений');
    assert.equal(item.description_md, '{\n  "kind": "payload",\n  "count": 2\n}');
    assert.equal(item.source, 'agent-api');
    assert.equal(item.source_key, 'agent-42');
    assert.equal(item.response_required, true);
    assert.equal(item.record_type_id, 2);
    assert.equal(item.attachment_links.length, 2);
    assert.match(item.attachment_links[0], /\.pdf$/);
    assert.match(item.attachment_links[1], /\.txt$/);

    const pdf = await fetch(`${fixture.url}${item.attachment_links[0]}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), PDF_BYTES);
  } finally {
    await fixture.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Inbox API links attach-to-previous messages to the previous inbox item', async () => {
  const fixture = await createFixture([
    '2026-06-27T10:00:00.000Z',
    '2026-06-27T10:01:00.000Z'
  ]);

  try {
    const first = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'создай первую запись',
        source: 'telegram',
        source_key: 'chat-1'
      })
    });
    const second = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'прикрепи эти данные к предыдущему сообщению',
        source: 'telegram',
        source_key: 'chat-1'
      })
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.state.inbox[0].related_inbox_id, first.body.inbox_id);
  } finally {
    await fixture.close();
  }
});

test('Inbox API rejects unsupported API record types', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Не принимать неверный тип',
        record_type_id: 4
      })
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_record_type');
    assert.equal(tableCount(fixture, 'inbox'), 0);
  } finally {
    await fixture.close();
  }
});

test('Inbox API rejects invalid api key without mutating inbox', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(
      fixture.url,
      '/v1/',
      {
        method: 'POST',
        headers: { 'x-brai-api-key': 'wrong' },
        body: JSON.stringify({
          text: 'Не сохранять',
          image_base64: IMAGE_BASE64,
          image_mime: 'image/png'
        })
      },
      false
    );

    assert.equal(response.status, 401);
    assert.equal(tableCount(fixture, 'inbox'), 0);
    assert.equal(eventDomainCount(fixture, 'inbox'), 0);
  } finally {
    await fixture.close();
  }
});

test('Inbox API accepts bearer authorization with the inbox api key', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      headers: { authorization: `Bearer ${INBOX_API_KEY}` }
    }, false);

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, target: 'inbox' });
  } finally {
    await fixture.close();
  }
});

test('Inbox API returns unsupported target for unknown connectors', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      headers: { 'x-brai-target': 'finance' }
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'unsupported_target');
  } finally {
    await fixture.close();
  }
});

test('Inbox API rejects invalid images without mutating inbox', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Не сохранять',
        image_base64: Buffer.from('not image').toString('base64'),
        image_mime: 'image/png'
      })
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_image');
    assert.equal(tableCount(fixture, 'inbox'), 0);
    assert.equal(eventDomainCount(fixture, 'inbox'), 0);
  } finally {
    await fixture.close();
  }
});

test('Inbox AI processing describes images, normalizes text, and suggests a new class', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbox-ai-files-'));
  const fixture = await createFixture([
    '2026-06-27T10:00:00.000Z',
    '2026-06-27T10:00:01.000Z',
    '2026-06-27T10:00:02.000Z',
    '2026-06-27T10:00:03.000Z'
  ], {
    inboxStorageRoot: storageRoot,
    inboxAutoProcess: true,
    codexBin: fakeCodex(storageRoot),
    codexModel: 'test-model',
  });

  try {
    const response = await inboxRequest(fixture.url, '/v1/', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Сделать из этого задачу',
        image_base64: IMAGE_BASE64,
        image_mime: 'image/png',
        idempotency_key: 'ai-1'
      })
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.state.inbox[0].is_normalized, false);

    await waitFor(() => fixture.store.db.prepare('SELECT is_normalized FROM inbox WHERE id = ?').get(response.body.inbox_id)?.is_normalized === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get(response.body.inbox_id);
    assert.equal(item.title, 'Подготовить презентацию');
    assert.equal(item.description_text, 'Пользователь хочет поставить задачу подготовить презентацию по экрану Telegram.');
    assert.equal(item.preliminary_section, 'follow_up');
    assert.match(item.normalization_text, /Описание картинки/);
    assert.match(item.normalization_text, /экран Telegram/);
    assert.match(item.normalization_text, /Транскрипт просит/);

    const classRow = fixture.store.db.prepare("SELECT * FROM inbox_classes WHERE key = 'follow_up'").get();
    assert.equal(classRow.status, 'candidate');
    assert.equal(classRow.title, 'Follow-up');

    const logs = fixture.store.db.prepare('SELECT agent_id, status FROM ai_logs ORDER BY id ASC').all();
    assert.deepEqual(logs, [
      { agent_id: 'inbox.image_describer', status: 'done' },
      { agent_id: 'inbox.normalizer', status: 'done' }
    ]);

    const publicLogs = await requestAiLogs(fixture.url);
    assert.equal(publicLogs.status, 200);
    assert.equal(publicLogs.body.logs.length, 2);
    assert.equal(publicLogs.body.logs.every((log) => log.json_data.usage.model === 'test-model'), true);
    assert.equal(publicLogs.body.logs.every((log) => Number.isFinite(log.json_data.timings_ms.total)), true);
  } finally {
    await fixture.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

function fakeFfmpeg(dir) {
  const file = path.join(dir, 'fake-ffmpeg');
  fs.writeFileSync(file, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.argv.at(-1), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
`);
  fs.chmodSync(file, 0o700);
  return file;
}

function fakeCodex(expectedImageDir) {
  const file = path.join(expectedImageDir, 'fake-codex');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
const execIndex = args.indexOf('exec');
const imageIndex = args.indexOf('--image');
if (imageIndex >= 0 && (execIndex < 0 || imageIndex < execIndex)) throw new Error('--image must be an exec option');
if (imageIndex >= 0 && args[args.indexOf('--cd') + 1] !== os.tmpdir()) throw new Error('--cd must avoid project image dir');
if (imageIndex >= 0 && path.dirname(args[imageIndex + 1]) !== ${JSON.stringify(expectedImageDir)}) throw new Error('--image must be absolute storage path');
const outputPath = args[args.indexOf('--output-last-message') + 1];
if (!outputPath) throw new Error('missing output path');
const output = imageIndex >= 0
  ? 'На картинке экран Telegram с сообщением про презентацию.'
  : JSON.stringify({
      title: 'Подготовить презентацию',
      description: 'Пользователь хочет поставить задачу подготовить презентацию по экрану Telegram.',
      class_key: 'follow_up',
      class_title: 'Follow-up',
      class_description: 'Нужно вернуться к вопросу позднее.',
      normalization: 'Транскрипт просит сделать задачу; скрин уточняет контекст.'
    });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output);
`);
  fs.chmodSync(file, 0o700);
  return file;
}

async function requestAiLogs(baseUrl) {
  const response = await fetch(`${baseUrl}/v1/ai-logs`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  return { status: response.status, body: await response.json() };
}
