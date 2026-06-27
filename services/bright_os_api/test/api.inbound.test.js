import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOKEN,
  createFixture,
  inboundRequest,
  tableCount
} from '../test-support/api.js';

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
const IMAGE_BASE64 = PNG_BYTES.toString('base64');
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const TEXT_BYTES = Buffer.from('hello inbound file\n', 'utf8');

test('inbound inbox endpoint returns a bearer-protected handshake', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, target: 'inbox' });
  } finally {
    await fixture.close();
  }
});

test('inbound inbox POST creates an inbox row with explanation and attachment link', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-inbound-files-'));
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    inboundStorageRoot: storageRoot,
    inboundTitleGenerator: async () => 'Снимок идеи'
  });

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
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
    assert.equal(response.body.state.inbox[0].title, 'Снимок идеи');
    assert.equal(response.body.state.inbox[0].explanation_text, 'Положить это во входящие');
    assert.equal(response.body.state.inbox[0].source, 'telegram');
    assert.equal(response.body.state.inbox[0].source_key, '');
    assert.equal(response.body.state.inbox[0].response_required, false);
    assert.equal(response.body.state.inbox[0].related_inbox_id, null);
    assert.equal(response.body.state.inbox[0].record_type_id, 1);
    assert.equal(response.body.state.inbox[0].attachment_links.length, 1);
    assert.match(response.body.state.inbox[0].attachment_links[0], /^\/v1\/inbox\/attachments\/.+\.png$/);
    assert.ok(fs.existsSync(path.join(storageRoot, path.basename(response.body.state.inbox[0].attachment_links[0]))));
    const file = await fetch(`${fixture.url}${response.body.state.inbox[0].attachment_links[0]}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG_BYTES);

    const duplicate = await inboundRequest(fixture.url, '/v1/in/inbox', {
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
    assert.equal(tableCount(fixture, 'inbox_events'), 1);
  } finally {
    await fixture.close();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('inbound inbox accepts multiple attachments, description content, and metadata', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-inbound-files-'));
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    inboundStorageRoot: storageRoot,
    inboundTitleGenerator: async () => 'Пакет файлов'
  });

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
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
    assert.equal(item.title, 'Пакет файлов');
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

test('inbound inbox links attach-to-previous messages to the previous inbox item', async () => {
  const fixture = await createFixture([
    '2026-06-27T10:00:00.000Z',
    '2026-06-27T10:01:00.000Z'
  ], {
    inboundTitleGenerator: async (text) => text.includes('первую') ? 'Первая запись' : 'Дополнение'
  });

  try {
    const first = await inboundRequest(fixture.url, '/v1/in/inbox', {
      method: 'POST',
      body: JSON.stringify({
        text: 'создай первую запись',
        source: 'telegram',
        source_key: 'chat-1'
      })
    });
    const second = await inboundRequest(fixture.url, '/v1/in/inbox', {
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

test('inbound inbox rejects unsupported API record types', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
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

test('inbound inbox rejects invalid bearer without mutating inbox', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboundRequest(
      fixture.url,
      '/v1/in/inbox',
      {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
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
    assert.equal(tableCount(fixture, 'inbox_events'), 0);
  } finally {
    await fixture.close();
  }
});

test('inbound API returns unsupported target for unknown connectors', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/finance');

    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'unsupported_target');
  } finally {
    await fixture.close();
  }
});

test('inbound inbox rejects invalid images without mutating inbox', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z']);

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
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
    assert.equal(tableCount(fixture, 'inbox_events'), 0);
  } finally {
    await fixture.close();
  }
});

test('inbound inbox can use Codex CLI title generation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-fake-codex-'));
  const fakeCodex = path.join(tmp, 'codex');
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const expected = ['--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'gpt-5.4-mini', 'exec', '--ephemeral', '--skip-git-repo-check'];
for (let i = 0; i < expected.length; i += 1) {
  if (args[i] !== expected[i]) process.exit(2);
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(3);
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[outputIndex + 1], 'Codex title'));
`);
  fs.chmodSync(fakeCodex, 0o700);
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    codexBin: fakeCodex,
    codexModel: 'gpt-5.4-mini',
    codexTimeoutMs: 1000
  });

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Проверить генерацию заголовка через Codex CLI',
        image_base64: IMAGE_BASE64,
        image_mime: 'image/png'
      })
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.state.inbox[0].title, 'Codex title');
  } finally {
    await fixture.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('inbound inbox falls back to a local title when Codex title generation fails', async () => {
  const fixture = await createFixture(['2026-06-27T10:00:00.000Z'], {
    inboundTitleGenerator: async () => {
      throw new Error('codex unavailable');
    }
  });

  try {
    const response = await inboundRequest(fixture.url, '/v1/in/inbox', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Очень длинное сообщение для заголовка и контекста',
        image_base64: IMAGE_BASE64,
        image_mime: 'image/png'
      })
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.state.inbox[0].title, 'Очень длинное сообщение для заголовка и контекста');
  } finally {
    await fixture.close();
  }
});
