import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createFixture, jsonRequest, request, waitFor } from '../test-support/api.js';
import { createBraiChatUploadGate } from '../src/brai-chat-routes.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = Array(80).fill('2026-07-15T05:00:00.000Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('attachment upload gate bounds total and per-owner buffering', () => {
  const gate = createBraiChatUploadGate({ maxConcurrent: 3, maxPerUser: 2 });
  const releaseA1 = gate.tryAcquire('owner-a');
  const releaseA2 = gate.tryAcquire('owner-a');
  const releaseB = gate.tryAcquire('owner-b');
  assert.equal(typeof releaseA1, 'function');
  assert.equal(typeof releaseA2, 'function');
  assert.equal(typeof releaseB, 'function');
  assert.equal(gate.tryAcquire('owner-a'), null);
  assert.equal(gate.tryAcquire('owner-c'), null);
  releaseA1();
  const releaseC = gate.tryAcquire('owner-c');
  assert.equal(typeof releaseC, 'function');
  releaseA1();
  releaseA2();
  releaseB();
  releaseC();
});

test('chat replay boundary rewinds only to RUN_STARTED of the matching turn', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'boundary-owner'),
    braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'boundary-owner');
    withUserScope('boundary-owner', () => {
      const thread = fixture.store.createBraiChatThread({ id: 'boundary-thread' });
      const append = (id, turnId, type) => fixture.store.appendBraiChatEvent({
        id,
        threadId: thread.id,
        turnId,
        idempotencyKey: `boundary:${id}`,
        type,
        safePayload: { type }
      });
      append('boundary-event-1', 'previous-run', 'RUN_STARTED');
      append('boundary-event-2', 'previous-run', 'RUN_FINISHED');
      append('boundary-event-3', 'prestart-error-run', 'RUN_ERROR');
      append('boundary-event-4', 'error-run', 'RUN_STARTED');
      append('boundary-event-5', 'error-run', 'CUSTOM');
      append('boundary-event-6', 'error-run', 'RUN_ERROR');
      append('boundary-event-7', 'finished-run', 'RUN_STARTED');
      append('boundary-event-8', 'finished-run', 'RUN_FINISHED');

      assert.equal(fixture.store.findBraiChatReplayBoundary(thread.id, 2), 0);
      assert.equal(fixture.store.findBraiChatReplayBoundary(thread.id, 3), 0);
      assert.equal(fixture.store.findBraiChatReplayBoundary(thread.id, 4), 4);
      assert.equal(fixture.store.findBraiChatReplayBoundary(thread.id, 5), 4);
      assert.equal(fixture.store.findBraiChatReplayBoundary(thread.id, 7), 7);
    });
  } finally {
    await fixture.close();
  }
});

test('Better-Auth chat API isolates owners and supports lifecycle, settings, replay and search anchors', async () => {
  let activeUser = 'chat-owner-a';
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => activeUser),
    braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'chat-owner-a');
    seedUser(fixture, 'chat-owner-b');

    const models = await request(fixture.url, '/v1/brai-chat/models');
    assert.equal(models.status, 200);
    assert.deepEqual(models.body, {
      models: [{
        id: 'codex-1', display_name: 'GPT-5.6-Luna',
        reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'low'
      }],
      default_model: 'codex-1',
      default_reasoning_effort: 'medium'
    });

    const created = await chatJson(fixture, '/v1/brai-chat/threads', { method: 'POST', body: '{}' });
    assert.equal(created.status, 201);
    assert.equal(created.body.thread.title, 'Новый чат');
    assert.equal(created.body.thread.version, 1);
    assert.equal(created.body.thread.model, 'codex-1');
    assert.equal(created.body.thread.reasoning_effort, 'medium');
    const threadId = created.body.thread.id;

    const configured = await chatJson(fixture, `/v1/brai-chat/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ model: 'codex-1', reasoning_effort: 'high' })
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.thread.reasoning_effort, 'high');

    withUserScope('chat-owner-a', () => {
      fixture.store.setBraiChatCodexThreadId(threadId, 'internal-codex-thread');
      const active = fixture.store.setBraiChatActiveTurn(threadId, {
        runId: 'public-turn', codexTurnId: 'internal-codex-turn', userMessageId: 'm_stablemessage'
      });
      assert.equal(active.active_codex_turn_id, 'internal-codex-turn');
      const first = fixture.store.putBraiChatMessage({
        id: 'public-message', threadId, turnId: 'public-turn', idempotencyKey: 'message-key',
        role: 'user', content: 'searchable alpha text', model: 'codex-1', reasoningEffort: 'high'
      });
      const duplicate = fixture.store.putBraiChatMessage({
        id: 'ignored-message', threadId, idempotencyKey: 'message-key',
        role: 'user', content: 'ignored duplicate'
      });
      assert.equal(duplicate.id, first.id);
      const retry = fixture.store.putBraiChatMessage({
        id: 'public-message', threadId, turnId: 'retry-turn', idempotencyKey: 'retry-message-key',
        role: 'user', content: 'searchable alpha text'
      });
      assert.equal(retry.sequence, first.sequence);
      assert.equal(retry.turn_id, 'public-turn');
      assert.throws(() => fixture.store.putBraiChatMessage({
        id: 'public-message', threadId, idempotencyKey: 'conflicting-message-key',
        role: 'user', content: 'changed retry text'
      }), (error) => error.status === 409 && error.message === 'message_id_conflict');
      const event = fixture.store.appendBraiChatEvent({
        id: 'public-event', threadId, messageId: first.id, turnId: 'public-turn',
        idempotencyKey: 'event-key', type: 'command', safePayload: { command: 'alpha' },
        searchableText: 'sanitized beta command output'
      });
      const duplicateEvent = fixture.store.appendBraiChatEvent({
        id: 'ignored-event', threadId, idempotencyKey: 'event-key', type: 'command'
      });
      assert.equal(duplicateEvent.id, event.id);
    });

    const read = await request(fixture.url, `/v1/brai-chat/threads/${threadId}`);
    assert.equal(read.status, 200);
    assert.equal(JSON.stringify(read.body).includes('internal-codex-thread'), false);
    assert.equal(JSON.stringify(read.body).includes('internal-codex-turn'), false);
    assert.equal(read.body.thread.active_turn_id, 'public-turn');
    assert.equal(Object.hasOwn(read.body.thread, 'user_id'), false);
    withUserScope('chat-owner-a', () => fixture.store.setBraiChatActiveTurn(threadId));

    const messages = await request(fixture.url, `/v1/brai-chat/threads/${threadId}/messages?cursor=0&limit=1`);
    assert.equal(messages.status, 200);
    assert.equal(messages.body.messages.length, 1);
    assert.equal(messages.body.messages[0].id, 'public-message');
    assert.deepEqual(messages.body.messages[0].attachments, []);
    assert.equal(messages.body.next_cursor, '1');

    const events = await request(fixture.url, `/v1/brai-chat/threads/${threadId}/events?after=0`);
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].message_id, 'public-message');
    assert.deepEqual(events.body.events[0].safe_payload, { command: 'alpha' });

    const messageSearch = await request(fixture.url, '/v1/brai-chat/search?q=alpha');
    assert.ok(messageSearch.body.results.some((hit) =>
      hit.source_type === 'message' && hit.message_id === 'public-message' && hit.thread_id === threadId
    ));
    const eventSearch = await request(fixture.url, '/v1/brai-chat/search?q=beta');
    assert.ok(eventSearch.body.results.some((hit) =>
      hit.source_type === 'event' && hit.event_id === 'public-event' && hit.message_id === 'public-message'
    ));

    const archived = await chatJson(fixture, `/v1/brai-chat/threads/${threadId}/archive`, { method: 'POST' });
    assert.ok(archived.body.thread.archived_at_utc);
    assert.deepEqual((await request(fixture.url, '/v1/brai-chat/threads')).body.threads, []);
    assert.equal((await request(fixture.url, '/v1/brai-chat/threads?archived=archived')).body.threads.length, 1);
    const restored = await chatJson(fixture, `/v1/brai-chat/threads/${threadId}/restore`, { method: 'POST' });
    assert.equal(restored.body.thread.archived_at_utc, null);

    const inherited = await chatJson(fixture, '/v1/brai-chat/threads', { method: 'POST', body: '{}' });
    assert.equal(inherited.body.thread.model, 'codex-1');
    assert.equal(inherited.body.thread.reasoning_effort, 'medium');
    withUserScope('chat-owner-a', () => fixture.store.putBraiChatMessage({
      threadId: inherited.body.thread.id,
      idempotencyKey: 'auto-title-key',
      role: 'user',
      content: 'one two three four five six seven eight nine'
    }));
    assert.equal((await request(fixture.url, `/v1/brai-chat/threads/${inherited.body.thread.id}`)).body.thread.title,
      'Новый чат');
    withUserScope('chat-owner-a', () =>
      fixture.store.setBraiChatGeneratedTitle(inherited.body.thread.id, 'Семантический заголовок'));
    assert.equal((await request(fixture.url, `/v1/brai-chat/threads/${inherited.body.thread.id}`)).body.thread.title,
      'Семантический заголовок');
    await chatJson(fixture, `/v1/brai-chat/threads/${inherited.body.thread.id}`, {
      method: 'PATCH', body: JSON.stringify({ title: 'Ручной заголовок' })
    });
    withUserScope('chat-owner-a', () =>
      fixture.store.setBraiChatGeneratedTitle(inherited.body.thread.id, 'Не должен победить'));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT title, title_source FROM brai_chat_threads WHERE id = ?
    `).get(inherited.body.thread.id), {
      title: 'Ручной заголовок', title_source: 'manual'
    });

    activeUser = 'chat-owner-b';
    const crossOwner = await request(fixture.url, `/v1/brai-chat/threads/${threadId}`);
    assert.equal(crossOwner.status, 404);
    assert.deepEqual(crossOwner.body, { error: 'not_found' });
    assert.deepEqual((await request(fixture.url, '/v1/brai-chat/search?q=alpha')).body.results, []);
  } finally {
    await fixture.close();
  }
});

test('authenticated steer route validates input, scopes ownership and maps inactive conflict safely', async () => {
  let activeUser = 'steer-owner';
  let mode = 'inactive';
  const calls = [];
  const runtime = {
    ...modelRuntime(),
    steer: async (input) => {
      calls.push(input);
      if (mode === 'inactive') throw Object.assign(new Error('chat_turn_not_active'), { status: 409 });
      return true;
    }
  };
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => activeUser),
    braiChatRuntime: runtime
  });
  try {
    seedUser(fixture, 'steer-owner');
    seedUser(fixture, 'steer-other');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const path = `/v1/brai-chat/threads/${thread.id}/steer`;

    const invalid = await chatJson(fixture, path, {
      method: 'POST', body: JSON.stringify({ message_id: 'bad/message', text: 'Ещё' })
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_steer_request');
    assert.equal(calls.length, 0);

    const inactive = await chatJson(fixture, path, {
      method: 'POST', body: JSON.stringify({ message_id: 'steer-message', text: 'Ещё' })
    });
    assert.equal(inactive.status, 409);
    assert.deepEqual(inactive.body, { error: 'chat_turn_not_active' });
    assert.equal(calls.length, 1);

    mode = 'success';
    const accepted = await chatJson(fixture, path, {
      method: 'POST', body: JSON.stringify({ message_id: 'steer-message-2', text: ' Продолжи ' })
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { accepted: true });
    assert.equal(calls[1].userId, 'steer-owner');
    assert.equal(calls[1].publicThreadId, thread.id);
    assert.equal(calls[1].messageId, 'steer-message-2');
    assert.equal(calls[1].text, 'Продолжи');
    assert.equal(calls[1].store, fixture.store);

    activeUser = 'steer-other';
    const crossOwner = await chatJson(fixture, path, {
      method: 'POST', body: JSON.stringify({ message_id: 'steer-message-3', text: 'Чужой' })
    });
    assert.equal(crossOwner.status, 404);
    assert.deepEqual(crossOwner.body, { error: 'not_found' });
    assert.equal(calls.length, 2);
  } finally {
    await fixture.close();
  }
});

test('chat runtime CORS preflight allows both durable replay cursor headers', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'cors-owner'),
    braiChatRuntime: modelRuntime()
  });
  try {
    const response = await fetch(`${fixture.url}/v1/brai-chat/runtime`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'last-event-id,x-brai-chat-after,x-brai-chat-replay-mode'
      }
    });
    assert.equal(response.status, 204);
    const allowed = response.headers.get('access-control-allow-headers') ?? '';
    assert.match(allowed, /(?:^|,)last-event-id(?:,|$)/);
    assert.match(allowed, /(?:^|,)x-brai-chat-after(?:,|$)/);
    assert.match(allowed, /(?:^|,)x-brai-chat-replay-mode(?:,|$)/);
  } finally {
    await fixture.close();
  }
});

test('chat runtime preserves trusted Capacitor CORS on direct CopilotKit responses', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'runtime-cors-owner'),
    braiChatRuntime: {
      ...modelRuntime(),
      handleRequest: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      }
    }
  });
  try {
    seedUser(fixture, 'runtime-cors-owner');
    const response = await fetch(`${fixture.url}/v1/brai-chat/runtime`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://localhost' },
      body: JSON.stringify({ method: 'info' })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await fixture.close();
  }
});

test('model route pins Luna medium even when the runtime default is different', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'model-owner'),
    braiChatRuntime: {
      listModels: async () => ({
        models: [
          { id: 'model-a', display_name: 'A', reasoning_efforts: [], default_reasoning_effort: null },
          { id: 'model-b', display_name: 'GPT-5.6-Luna', reasoning_efforts: ['medium', 'high'], default_reasoning_effort: 'high' }
        ],
        default_model: 'model-b'
      })
    }
  });
  try {
    const response = await request(fixture.url, '/v1/brai-chat/models');
    assert.equal(response.status, 200);
    assert.equal(response.body.default_model, 'model-b');
    assert.equal(response.body.default_reasoning_effort, 'medium');
  } finally {
    await fixture.close();
  }
});

test('chat route normalizes upstream failures before the response and logger boundary', async () => {
  const logs = [];
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'safe-error-owner'),
    logger: { error: (value) => logs.push(value) },
    braiChatRuntime: {
      listModels: async () => {
        throw new Error('connect /run/private-broker.sock Authorization: top-secret-value');
      }
    }
  });
  try {
    const response = await request(fixture.url, '/v1/brai-chat/models');
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'upstream_auth' });
    const serialized = JSON.stringify(logs);
    assert.match(serialized, /upstream_auth/);
    assert.equal(serialized.includes('/run/private-broker.sock'), false);
    assert.equal(serialized.includes('top-secret-value'), false);
  } finally {
    await fixture.close();
  }
});

test('chat auth fails closed before the runtime hook', async () => {
  let runtimeCalls = 0;
  const fixture = await createFixture(NOW, {
    createAuth: () => ({
      auth: { api: { getSession: async () => { throw new Error('auth down'); } } },
      healthCheck: async () => {}, testEmailLogin: async () => {}, close: async () => {}
    }),
    braiChatRuntime: { listModels: async () => { runtimeCalls += 1; return []; } },
    authBackendTimeoutMs: 25
  });
  try {
    const response = await request(fixture.url, '/v1/brai-chat/models');
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'auth_backend_unavailable');
    assert.equal(runtimeCalls, 0);
  } finally {
    await fixture.close();
  }
});

test('private image attachments verify signatures and clean files when validation or DB persistence fails', async () => {
  let activeUser = 'attachment-owner';
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => activeUser),
    vaultRoot,
    braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'attachment-owner');
    seedUser(fixture, 'attachment-other');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', { method: 'POST', body: '{}' })).body.thread;

    const rejected = new FormData();
    rejected.append('files', new Blob([PNG], { type: 'text/plain' }), 'valid-wrong-mime.png');
    rejected.append('files', new Blob([Buffer.from('not an image')], { type: 'image/png' }), 'fake.png');
    const invalid = await multipartRequest(fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, rejected);
    assert.equal(invalid.status, 400);
    assert.equal(listFiles(vaultRoot).length, 0);

    const form = new FormData();
    form.append('files', new Blob([PNG], { type: 'text/plain' }), 'actual.png');
    const uploaded = await multipartRequest(fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.attachments[0].media_type, 'image/png');
    assert.equal(JSON.stringify(uploaded.body).includes('relative_path'), false);
    assert.equal(listFiles(vaultRoot).length, 1);

    const disposableForm = new FormData();
    disposableForm.append('files', new Blob([PNG]), 'discard.png');
    const disposable = await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, disposableForm
    );
    const deleted = await fetch(
      `${fixture.url}/v1/brai-chat/attachments/${disposable.body.attachments[0].id}`,
      { method: 'DELETE', headers: { origin: 'http://localhost' } }
    );
    assert.equal(deleted.status, 200);
    assert.equal(listFiles(vaultRoot).length, 1);

    const attachmentId = uploaded.body.attachments[0].id;
    const internal = withUserScope('attachment-owner', () =>
      fixture.store.getBraiChatAttachmentRecords([attachmentId], { threadId: thread.id })
    );
    assert.equal(internal[0].relative_path, `Brai/Chat/${thread.id}/${attachmentId}`);
    assert.equal(fs.existsSync(path.join(vaultRoot, 'attachment-owner', internal[0].relative_path)), true);
    withUserScope('attachment-owner', () => {
      fixture.store.putBraiChatMessage({
        id: 'attachment-message', threadId: thread.id, idempotencyKey: 'attachment-message-key',
        role: 'user', content: 'Посмотри изображение'
      });
      fixture.store.linkBraiChatAttachments({
        threadId: thread.id, messageId: 'attachment-message', attachmentIds: [attachmentId]
      });
    });
    assert.equal((await fetch(`${fixture.url}/v1/brai-chat/attachments/${attachmentId}`, {
      method: 'DELETE', headers: { origin: 'http://localhost' }
    })).status, 404);
    const restored = await request(fixture.url, `/v1/brai-chat/threads/${thread.id}/messages`);
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.messages[0].attachments, [{
      ...uploaded.body.attachments[0], message_id: 'attachment-message'
    }]);
    const download = await fetch(`${fixture.url}/v1/brai-chat/attachments/${attachmentId}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.match(download.headers.get('content-disposition'), /^inline;/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
    const explicitDownload = await fetch(
      `${fixture.url}/v1/brai-chat/attachments/${attachmentId}?download=1`
    );
    assert.equal(explicitDownload.status, 200);
    assert.match(explicitDownload.headers.get('content-disposition'), /^attachment;/);
    assert.equal(explicitDownload.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await explicitDownload.arrayBuffer()), PNG);

    const attachmentPath = path.join(vaultRoot, 'attachment-owner', internal[0].relative_path);
    const outsideFile = path.join(os.tmpdir(), `brai-chat-outside-${crypto.randomUUID()}`);
    fs.writeFileSync(outsideFile, 'host secret');
    fs.rmSync(attachmentPath);
    fs.symlinkSync(outsideFile, attachmentPath);
    assert.equal((await fetch(`${fixture.url}/v1/brai-chat/attachments/${attachmentId}`)).status, 404);
    fs.rmSync(outsideFile, { force: true });

    const beforeFailure = listFiles(vaultRoot).length;
    const original = fixture.store.addBraiChatAttachments;
    fixture.store.addBraiChatAttachments = () => { throw new Error('db unavailable'); };
    const failedForm = new FormData();
    failedForm.append('files', new Blob([PNG]), 'cleanup.png');
    const failed = await multipartRequest(fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, failedForm);
    fixture.store.addBraiChatAttachments = original;
    assert.equal(failed.status, 500);
    assert.equal(listFiles(vaultRoot).length, beforeFailure);

    activeUser = 'attachment-other';
    assert.equal((await fetch(`${fixture.url}/v1/brai-chat/attachments/${attachmentId}`)).status, 404);
    assert.equal((await fetch(
      `${fixture.url}/v1/brai-chat/attachments/${attachmentId}?download=1`
    )).status, 404);
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('attachment upload opportunistically reaps stale reservations and file-only orphans', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'reap-owner'), vaultRoot, braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'reap-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const staleForm = new FormData();
    staleForm.append('files', new Blob([PNG]), 'stale.png');
    const stale = await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, staleForm
    );
    const staleId = stale.body.attachments[0].id;
    const directory = path.join(vaultRoot, 'reap-owner', 'Brai', 'Chat', thread.id);
    const stalePath = path.join(directory, staleId);
    const orphanId = crypto.randomUUID();
    const orphanPath = path.join(directory, orphanId);
    fs.writeFileSync(orphanPath, PNG);
    fixture.store.db.prepare(`
      UPDATE brai_chat_attachments SET created_at_utc = ? WHERE id = ?
    `).run('2026-07-13T00:00:00.000Z', staleId);
    const old = new Date('2026-07-13T00:00:00.000Z');
    fs.utimesSync(stalePath, old, old);
    fs.utimesSync(orphanPath, old, old);

    const freshForm = new FormData();
    freshForm.append('files', new Blob([PNG]), 'fresh.png');
    assert.equal((await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, freshForm
    )).status, 201);

    assert.equal(withUserScope('reap-owner', () =>
      fixture.store.getBraiChatAttachment(staleId)), null);
    assert.equal(fs.existsSync(stalePath), false);
    assert.equal(fs.existsSync(orphanPath), false);
    assert.equal(listFiles(vaultRoot).length, 1);
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('attachment reaper removes stale reservations without a later upload', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'scheduled-reap-owner'),
    vaultRoot,
    braiChatRuntime: modelRuntime(),
    braiChatAttachmentReapIntervalMs: 10
  });
  try {
    seedUser(fixture, 'scheduled-reap-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const form = new FormData();
    form.append('files', new Blob([PNG]), 'abandoned.png');
    const uploaded = await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form
    );
    const attachmentId = uploaded.body.attachments[0].id;
    const directory = path.join(vaultRoot, 'scheduled-reap-owner', 'Brai', 'Chat', thread.id);
    const attachmentPath = path.join(directory, attachmentId);
    const orphanPath = path.join(directory, crypto.randomUUID());
    fs.writeFileSync(orphanPath, PNG);
    fixture.store.db.prepare(`
      UPDATE brai_chat_attachments SET created_at_utc = ? WHERE id = ?
    `).run('2026-07-13T00:00:00.000Z', attachmentId);
    const old = new Date('2026-07-13T00:00:00.000Z');
    fs.utimesSync(attachmentPath, old, old);
    fs.utimesSync(orphanPath, old, old);

    await waitFor(() => !fs.existsSync(attachmentPath) && !fs.existsSync(orphanPath)
      && withUserScope('scheduled-reap-owner', () =>
        fixture.store.getBraiChatAttachment(attachmentId)) == null);
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('attachment upload rejects an oversized declared body before buffering', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'declared-size-owner'), braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'declared-size-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const response = await declaredSizeRequest(
      fixture.url,
      `/v1/brai-chat/threads/${thread.id}/attachments`,
      52 * 1024 * 1024
    );
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { error: 'attachments_too_large' });
  } finally {
    await fixture.close();
  }
});

test('attachment rejection attempts every file cleanup without masking the database error', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const logs = [];
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'cleanup-owner'), vaultRoot, braiChatRuntime: modelRuntime(),
    logger: { error: (...args) => logs.push(args) }
  });
  const originalAdd = fixture.store.addBraiChatAttachments;
  const originalRm = fs.rmSync;
  try {
    seedUser(fixture, 'cleanup-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    fixture.store.addBraiChatAttachments = () => { throw new Error('db unavailable'); };
    let cleanupCalls = 0;
    fs.rmSync = (target, options) => {
      if (String(target).startsWith('/proc/self/fd/')) {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error('injected cleanup failure');
      }
      return originalRm(target, options);
    };
    const form = new FormData();
    form.append('files', new Blob([PNG]), 'first.png');
    form.append('files', new Blob([PNG]), 'second.png');
    const response = await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form
    );

    assert.equal(response.status, 500);
    assert.equal(cleanupCalls, 2);
    assert.equal(listFiles(vaultRoot).length, 1);
    assert.ok(logs.some((args) => JSON.stringify(args).includes('brai_chat_attachment_cleanup_failed')));
  } finally {
    fs.rmSync = originalRm;
    fixture.store.addBraiChatAttachments = originalAdd;
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('attachment upload refuses a symlinked Vault parent', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-outside-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'symlink-owner'), vaultRoot, braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'symlink-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const userRoot = path.join(vaultRoot, 'symlink-owner');
    fs.mkdirSync(userRoot);
    fs.symlinkSync(outside, path.join(userRoot, 'Brai'));

    const form = new FormData();
    form.append('files', new Blob([PNG]), 'blocked.png');
    const response = await multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form
    );

    assert.equal(response.status, 404);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('attachment download refuses a symlinked user Vault parent even for matching metadata', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-outside-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'download-symlink-owner'), vaultRoot,
    braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'download-symlink-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const attachmentId = crypto.randomUUID();
    const outsideDirectory = path.join(outside, 'Brai', 'Chat', thread.id);
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.writeFileSync(path.join(outsideDirectory, attachmentId), PNG);
    fs.symlinkSync(outside, path.join(vaultRoot, 'download-symlink-owner'));
    fixture.store.db.prepare(`
      INSERT INTO brai_chat_attachments (
        id, user_id, brai_chat_threads_id, brai_chat_messages_id, original_name,
        relative_path, verified_media_type, byte_size, checksum_sha256, created_at_utc
      ) VALUES (?, ?, ?, NULL, 'outside.png', ?, 'image/png', ?, ?, ?)
    `).run(attachmentId, 'download-symlink-owner', thread.id,
      `Brai/Chat/${thread.id}/${attachmentId}`, PNG.length,
      crypto.createHash('sha256').update(PNG).digest('hex'), NOW[0]);

    const response = await fetch(`${fixture.url}/v1/brai-chat/attachments/${attachmentId}`);
    assert.equal(response.status, 404);
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('generated image metadata links to an assistant message and is returned in durable history', async () => {
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'generated-owner'),
    braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'generated-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const messageId = 'assistant_generated_image';
    const attachmentId = 'attachment_generated_image';
    withUserScope('generated-owner', () => {
      fixture.store.putBraiChatMessage({
        id: messageId,
        threadId: thread.id,
        turnId: 'turn_generated_image',
        idempotencyKey: 'assistant-generated-image',
        role: 'assistant',
        content: '',
        status: 'completed'
      });
      fixture.store.addBraiChatAttachments(thread.id, [{
        id: attachmentId,
        original_name: 'spring.png',
        relative_path: `Brai/Chat/${thread.id}/${attachmentId}`,
        media_type: 'image/png',
        byte_size: PNG.length,
        checksum_sha256: crypto.createHash('sha256').update(PNG).digest('hex')
      }], NOW[0]);
      fixture.store.linkBraiChatAttachments({
        threadId: thread.id,
        messageId,
        attachmentIds: [attachmentId]
      });
      fixture.store.appendBraiChatEvent({
        id: 'generated-image-artifact-event',
        threadId: thread.id,
        messageId,
        turnId: 'turn_generated_image',
        idempotencyKey: 'generated-image-artifact-event',
        type: 'CUSTOM',
        safePayload: {
          type: 'CUSTOM',
          name: 'brai.artifact.v1',
          value: {
            kind: 'image',
            status: 'ready',
            attachment_id: attachmentId
          }
        }
      });
      assert.deepEqual(
        fixture.store.listBraiChatReadyGeneratedAttachmentIds(thread.id),
        [attachmentId]
      );
    });

    const history = await chatJson(
      fixture, `/v1/brai-chat/threads/${thread.id}/messages`, {}
    );
    const assistant = history.body.messages.find((message) => message.id === messageId);
    assert.equal(assistant.attachments.length, 1);
    assert.deepEqual(assistant.attachments[0], {
      version: 1,
      id: attachmentId,
      thread_id: thread.id,
      message_id: messageId,
      filename: 'spring.png',
      media_type: 'image/png',
      byte_size: PNG.length,
      checksum_sha256: crypto.createHash('sha256').update(PNG).digest('hex'),
      created_at_utc: NOW[0]
    });
  } finally {
    await fixture.close();
  }
});

test('selected attachments enforce 50 MiB atomically without starving later uploads', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'aggregate-owner'), vaultRoot, braiChatRuntime: modelRuntime()
  });
  try {
    seedUser(fixture, 'aggregate-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const image = Buffer.alloc(26 * 1024 * 1024);
    PNG.copy(image);
    const forms = [new FormData(), new FormData()];
    forms.forEach((form, index) => form.append('files', new Blob([image]), `large-${index}.png`));
    const responses = await Promise.all(forms.map((form) => multipartRequest(
      fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form
    )));

    assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 201]);
    const uploaded = responses.map(({ body }) => body.attachments[0]);
    const reservations = fixture.store.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
      FROM brai_chat_attachments
      WHERE user_id = ? AND brai_chat_threads_id = ? AND brai_chat_messages_id IS NULL
    `).get('aggregate-owner', thread.id);
    assert.equal(Number(reservations.count), 2);
    assert.equal(Number(reservations.bytes), image.length * 2);
    assert.equal(listFiles(vaultRoot).length, 2);

    const message = {
      id: 'aggregate-message', threadId: thread.id, idempotencyKey: 'aggregate-message-key',
      role: 'user', content: 'Проверь лимит'
    };
    assert.throws(() => withUserScope('aggregate-owner', () =>
      fixture.store.putBraiChatUserMessageWithAttachments({
        message, attachmentIds: uploaded.map(({ id }) => id)
      })), (error) => error.status === 413 && error.message === 'attachments_too_large');
    assert.equal(Number(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count FROM brai_chat_messages WHERE id = ?
    `).get(message.id).count), 0);
    assert.equal(fixture.store.db.prepare(`
      SELECT title_source FROM brai_chat_threads WHERE id = ?
    `).get(thread.id).title_source, 'default');
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT brai_chat_messages_id FROM brai_chat_attachments
      WHERE id IN (?, ?) ORDER BY id
    `).all(...uploaded.map(({ id }) => id)).map((row) => row.brai_chat_messages_id), [null, null]);

    const saved = withUserScope('aggregate-owner', () =>
      fixture.store.putBraiChatUserMessageWithAttachments({
        message, attachmentIds: [uploaded[0].id]
      }));
    assert.equal(saved.message.id, message.id);
    assert.equal(withUserScope('aggregate-owner', () =>
      fixture.store.putBraiChatUserMessageWithAttachments({
        message, attachmentIds: [uploaded[0].id]
      })).message.id, message.id);
    assert.deepEqual(withUserScope('aggregate-owner', () =>
      fixture.store.putBraiChatUserMessageWithAttachments({
        message, attachmentIds: []
      })).attachmentIds, [uploaded[0].id]);
    assert.throws(() => withUserScope('aggregate-owner', () =>
      fixture.store.putBraiChatUserMessageWithAttachments({
        message, attachmentIds: [uploaded[1].id]
      })), (error) => error.status === 409 && error.message === 'message_attachments_conflict');
  } finally {
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

test('concurrent attachment writers preserve the first message attachment set', async () => {
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-chat-vault-'));
  const fixture = await createFixture(NOW, {
    createAuth: authRuntime(() => 'writer-owner'), vaultRoot, braiChatRuntime: modelRuntime()
  });
  const pool = fixture.openDatabasePool();
  let lockClient;
  const workers = [];
  try {
    seedUser(fixture, 'writer-owner');
    const thread = (await chatJson(fixture, '/v1/brai-chat/threads', {
      method: 'POST', body: '{}'
    })).body.thread;
    const uploads = [];
    for (const name of ['first.png', 'second.png']) {
      const form = new FormData();
      form.append('files', new Blob([PNG]), name);
      uploads.push((await multipartRequest(
        fixture.url, `/v1/brai-chat/threads/${thread.id}/attachments`, form
      )).body.attachments[0]);
    }
    lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    await lockClient.query(
      'SELECT id FROM brai_chat_threads WHERE user_id = $1 AND id = $2 FOR UPDATE',
      ['writer-owner', thread.id]
    );

    const message = {
      id: 'concurrent-message', threadId: thread.id, idempotencyKey: 'concurrent-message-key',
      role: 'user', content: 'Один набор'
    };
    for (const [index, attachment] of uploads.entries()) {
      workers.push(startAttachmentWriter({
        databaseUrl: fixture.databaseUrl, applicationName: `brai-chat-writer-${index + 1}`,
        userId: 'writer-owner', message, attachmentId: attachment.id
      }));
    }
    const results = workers.map(({ result }) => result);
    await waitForBlockedWriters(pool, workers.map(({ applicationName }) => applicationName));
    await lockClient.query('COMMIT');
    lockClient.release();
    lockClient = null;

    const outcomes = await Promise.all(results);
    assert.equal(outcomes.filter(({ ok }) => ok).length, 1);
    assert.deepEqual(outcomes.filter(({ ok }) => !ok).map(({ error }) => error), [
      'message_attachments_conflict'
    ]);
    const linked = fixture.store.db.prepare(`
      SELECT id FROM brai_chat_attachments
      WHERE brai_chat_messages_id = ? ORDER BY id
    `).all(message.id).map((row) => row.id);
    assert.equal(linked.length, 1);
    assert.ok(uploads.some(({ id }) => id === linked[0]));
  } finally {
    if (lockClient) {
      await lockClient.query('ROLLBACK').catch(() => {});
      lockClient.release();
    }
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
    await pool.end();
    await fixture.close();
    fs.rmSync(vaultRoot, { recursive: true, force: true });
  }
});

function authRuntime(currentUser) {
  return () => ({
    auth: {
      api: {
        getSession: async () => new Response(JSON.stringify({
          session: { id: `session-${currentUser()}` },
          user: { id: currentUser(), email: `${currentUser()}@example.test`, name: currentUser() }
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    },
    healthCheck: async () => {}, testEmailLogin: async () => {}, close: async () => {}
  });
}

function modelRuntime() {
  return {
    listModels: async () => ({
      models: [{
        id: 'codex-1', display_name: 'GPT-5.6-Luna',
        reasoning_efforts: ['low', 'medium', 'high'], default_reasoning_effort: 'low'
      }],
      default_model: 'codex-1'
    })
  };
}

function seedUser(fixture, id) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (?, ?, ?, true, ?, ?)
  `).run(id, id, `${id}@example.test`, NOW[0], NOW[0]);
}

function chatJson(fixture, pathname, options) {
  return jsonRequest(fixture.url, pathname, {
    ...options,
    headers: { origin: 'http://localhost', ...(options.headers ?? {}) }
  });
}

async function multipartRequest(baseUrl, pathname, form) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST', headers: { origin: 'http://localhost' }, body: form
  });
  return { status: response.status, body: await response.json() };
}

function declaredSizeRequest(baseUrl, pathname, contentLength) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, baseUrl), {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        'content-type': 'multipart/form-data; boundary=declared-size',
        'content-length': String(contentLength)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name);
}

function startAttachmentWriter({ databaseUrl, applicationName, userId, message, attachmentId }) {
  const url = new URL(databaseUrl);
  url.searchParams.set('application_name', applicationName);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.storeUrl), import(workerData.scopeUrl)]).then(([storeModule, scopeModule]) => {
      const store = new storeModule.BraiStore(workerData.databaseUrl);
      try {
        const value = scopeModule.withUserScope(workerData.userId, () =>
          store.putBraiChatUserMessageWithAttachments({
            message: workerData.message, attachmentIds: [workerData.attachmentId]
          }));
        parentPort.postMessage({ ok: true, attachmentIds: value.attachmentIds });
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error.message });
      } finally {
        store.db.close();
        parentPort.close();
      }
    });
  `, {
    eval: true,
    workerData: {
      databaseUrl: url.href,
      storeUrl: new URL('../src/store.js', import.meta.url).href,
      scopeUrl: new URL('../src/user-scope.js', import.meta.url).href,
      userId,
      message,
      attachmentId
    }
  });
  const result = new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  return { applicationName, worker, result };
}

async function waitForBlockedWriters(pool, applicationNames) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query(`
      SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE application_name = ANY($1::text[]) AND wait_event_type = 'Lock'
    `, [applicationNames]);
    if (result.rows[0].count === applicationNames.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('concurrent chat writers did not reach the thread lock');
}
