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
const expected = ['--sandbox', 'read-only', '--ask-for-approval', 'never', 'exec', '--ephemeral', '--skip-git-repo-check'];
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
