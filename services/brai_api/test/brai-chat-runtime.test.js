import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { EventType } from '@ag-ui/core';
import { BraiChatTurnCoordinator, createBraiChatRuntime } from '../src/brai-chat-runtime.js';

class FakeBroker extends EventEmitter {
  constructor({
    readThread = null, modelPages = null, modelError = null, startTurnError = null,
    steerTurn = null, steerTurnError = null, onInterrupt = null,
    generatedArtifactError = null, generatedCleanupError = null
  } = {}) {
    super();
    this.listener = null;
    this.requests = [];
    this.readThread = readThread;
    this.modelPages = modelPages;
    this.modelError = modelError;
    this.startTurnError = startTurnError;
    this.steerTurn = steerTurn;
    this.steerTurnError = steerTurnError;
    this.onInterrupt = onInterrupt;
    this.generatedArtifactError = generatedArtifactError;
    this.generatedCleanupError = generatedCleanupError;
    this.subscriptionSequence = 0;
    this.notificationSequence = 0;
    this.notificationEpoch = 'fake-broker-epoch';
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'startThread') return { threadId: 'internal-thread-secret' };
    if (method === 'startTurn' && this.startTurnError) throw this.startTurnError;
    if (method === 'startTurn') return { turnId: 'internal-turn-secret' };
    if (method === 'steerTurn' && this.steerTurnError) throw this.steerTurnError;
    if (method === 'steerTurn') return typeof this.steerTurn === 'function'
      ? this.steerTurn(params, this.requests) : {};
    if (method === 'subscribe') return {
      subscriptionId: `subscription-${++this.subscriptionSequence}`,
      notificationWatermark: this.notificationSequence,
      notificationEpoch: this.notificationEpoch
    };
    if (method === 'interruptTurn') {
      if (this.onInterrupt) setImmediate(() => this.onInterrupt());
      return {};
    }
    if (method === 'readThread') {
      const notificationWatermark = this.notificationSequence;
      const result = typeof this.readThread === 'function'
        ? this.readThread(params, this.requests) : this.readThread;
      return {
        ...(result || {}), notificationWatermark,
        notificationEpoch: this.notificationEpoch
      };
    }
    if (method === 'listModels') {
      if (this.modelError) throw this.modelError;
      const index = params.cursor ? Number(params.cursor.slice(1)) : 0;
      return this.modelPages?.[index] ?? { data: [], nextCursor: null };
    }
    if (method === 'exportGeneratedArtifact') {
      if (this.generatedArtifactError) throw this.generatedArtifactError;
      return {
        id: params.attachmentId,
        original_name: 'spring.png',
        relative_path: `Brai/Chat/${params.publicThreadId}/${params.attachmentId}`,
        media_type: 'image/png',
        byte_size: 8,
        checksum_sha256: 'a'.repeat(64)
      };
    }
    if (method === 'removeExportedArtifact') return { removed: true };
    if (method === 'cleanupGeneratedArtifacts') {
      if (this.generatedCleanupError) throw this.generatedCleanupError;
      return { cleaned: params.attachmentIds.length, pending: 0 };
    }
    return {};
  }

  subscribe(_filter, listener) {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  notify(method, params) {
    this.notificationSequence += 1;
    this.listener?.(method, params, {
      notificationSequence: this.notificationSequence,
      notificationEpoch: this.notificationEpoch
    });
  }
}

function fakeStore() {
  const events = [];
  const messages = [];
  const attachments = [];
  const aiLogs = [];
  const messageAttachments = new Map();
  return {
    events,
    messages,
    attachments,
    aiLogs,
    messageAttachments,
    thread: {
      id: 'public-thread',
      title: 'Новый чат',
      title_source: 'default',
      model: 'gpt-test',
      reasoning_effort: 'medium',
      archived_at_utc: null,
      active_turn_id: null,
      active_codex_turn_id: null,
      active_user_message_id: null,
      active_turn_started_at_utc: null,
      active_turn_deadline_at_utc: null,
      active_turn_model: null,
      active_turn_reasoning_effort: null,
      codex_thread_id: null
    },
    replayCalls: [],
    onReplay: null,
    getBraiChatThreadRuntime() { return { ...this.thread }; },
    setBraiChatGeneratedTitle(_threadId, title) {
      if (this.thread.title_source !== 'default') return { ...this.thread };
      this.thread.title = title;
      this.thread.title_source = 'generated';
      return { ...this.thread };
    },
    recordAiLog(input) {
      const existing = input.llmCallId
        ? this.aiLogs.find((item) => item.llmCallId === input.llmCallId) : null;
      if (existing) return existing.id;
      const saved = { id: this.aiLogs.length + 1, ...structuredClone(input) };
      this.aiLogs.push(saved);
      return saved.id;
    },
    setBraiChatCodexThreadId(_threadId, codexThreadId) { this.thread.codex_thread_id = codexThreadId; },
    setBraiChatActiveTurn(_threadId, active = {}) {
      this.thread.active_turn_id = active.runId ?? null;
      this.thread.active_codex_turn_id = active.codexTurnId ?? null;
      this.thread.active_user_message_id = active.userMessageId ?? null;
      this.thread.active_turn_started_at_utc = active.startedAtUtc ?? null;
      this.thread.active_turn_deadline_at_utc = active.deadlineAtUtc ?? null;
      this.thread.active_turn_model = active.model ?? null;
      this.thread.active_turn_reasoning_effort = active.reasoningEffort ?? null;
      return { ...this.thread };
    },
    putBraiChatMessage(message) {
      const sameId = this.messages.find((item) => item.id === message.id);
      if (sameId) {
        if (sameId.threadId === message.threadId && sameId.role === message.role
          && sameId.content === message.content) return sameId;
        throw Object.assign(new Error('message_id_conflict'), { status: 409 });
      }
      const existing = this.messages.find((item) => item.idempotencyKey === message.idempotencyKey);
      if (existing) return existing;
      this.messages.push({ ...message, dispatch_status: message.dispatchStatus ?? null });
      return this.messages.at(-1);
    },
    getBraiChatMessage(threadId, messageId) {
      return this.messages.find((item) => item.threadId === threadId && item.id === messageId) ?? null;
    },
    updateBraiChatMessage(messageId, input) {
      const message = this.messages.find((item) => item.id === messageId);
      if (!message) return null;
      Object.assign(message, input);
      return message;
    },
    listBraiChatUndeliveredSteers(threadId, turnId) {
      return this.messages.filter((message) => message.threadId === threadId
        && message.turnId === turnId && message.role === 'user'
        && ['pending', 'failed'].includes(message.dispatch_status));
    },
    addBraiChatAttachments(threadId, records) {
      return records.map((record) => {
        const saved = {
          version: 1,
          id: record.id,
          thread_id: threadId,
          message_id: null,
          filename: record.original_name,
          media_type: record.media_type,
          byte_size: record.byte_size,
          checksum_sha256: record.checksum_sha256
        };
        this.attachments.push(saved);
        return saved;
      });
    },
    getBraiChatAttachment(attachmentId) {
      return this.attachments.find((item) => item.id === attachmentId) ?? null;
    },
    deleteUnlinkedBraiChatAttachment(attachmentId) {
      const index = this.attachments.findIndex((item) =>
        item.id === attachmentId && item.message_id == null);
      if (index < 0) return null;
      return this.attachments.splice(index, 1)[0];
    },
    linkBraiChatAttachments({ messageId, attachmentIds }) {
      return attachmentIds.map((id) => {
        let attachment = this.attachments.find((item) => item.id === id);
        if (!attachment) {
          attachment = {
            version: 1,
            id,
            thread_id: 'public-thread',
            message_id: null,
            filename: `${id}.png`,
            media_type: 'image/png',
            byte_size: 8,
            checksum_sha256: 'a'.repeat(64)
          };
          this.attachments.push(attachment);
        }
        attachment.message_id = messageId;
        return attachment;
      });
    },
    putBraiChatUserMessageWithAttachments({ message, attachmentIds }) {
      const existing = this.messages.find((item) => item.id === message.id);
      const saved = this.putBraiChatMessage(message);
      if (existing) {
        const original = this.messageAttachments.get(message.id) || [];
        if (attachmentIds.length && (attachmentIds.length !== original.length
          || attachmentIds.some((id) => !original.includes(id)))) {
          throw Object.assign(new Error('message_attachments_conflict'), { status: 409 });
        }
        return { message: saved, attachmentIds: original };
      }
      const linked = this.linkBraiChatAttachments({
        threadId: message.threadId, messageId: message.id, attachmentIds
      });
      if (linked.length !== attachmentIds.length) return null;
      this.messageAttachments.set(message.id, [...attachmentIds]);
      return { message: saved, attachmentIds: [...attachmentIds] };
    },
    appendBraiChatEvent(event) {
      const existing = this.events.find((item) => item.idempotencyKey === event.idempotencyKey);
      if (event.messageProjection) this.putBraiChatMessage(event.messageProjection);
      if (existing) return { id: existing.id, sequence: this.events.indexOf(existing) + 1 };
      this.events.push(event);
      return { id: event.id, sequence: this.events.length };
    },
    replayBraiChatEvents(_threadId, { after = 0, limit = 200 } = {}) {
      this.replayCalls.push({ after, limit });
      this.onReplay?.({ after, limit, call: this.replayCalls.length });
      const items = this.events.map((event, index) => ({
        id: event.id ?? `event-${index + 1}`,
        sequence: index + 1,
        turn_id: event.turnId ?? null,
        safe_payload: event.safePayload ?? event.safe_payload
      })).filter((event) => event.sequence > after).slice(0, limit);
      return {
        items,
        next_cursor: items.length === limit ? String(items.at(-1).sequence) : null
      };
    },
    findBraiChatReplayBoundary(_threadId, after) {
      const nextIndex = this.events.findIndex((_event, index) => index + 1 > after);
      if (nextIndex < 0) return 0;
      const next = this.events[nextIndex];
      const nextPayload = next.safePayload ?? next.safe_payload;
      const nextTurnId = next.turnId ?? next.turn_id ?? null;
      if (nextPayload?.type === EventType.RUN_STARTED || !nextTurnId) return 0;
      for (let index = nextIndex - 1; index >= 0; index -= 1) {
        const event = this.events[index];
        const payload = event.safePayload ?? event.safe_payload;
        const turnId = event.turnId ?? event.turn_id ?? null;
        if (turnId === nextTurnId && payload?.type === EventType.RUN_STARTED) {
          return index + 1;
        }
      }
      return 0;
    },
    listBraiChatReadyGeneratedAttachmentIds() {
      return [...new Set(this.events.flatMap((event) => {
        const payload = event.safePayload ?? event.safe_payload;
        return payload?.type === EventType.CUSTOM
          && payload.name === 'brai.artifact.v1'
          && payload.value?.kind === 'image'
          && payload.value?.status === 'ready'
          && typeof payload.value?.attachment_id === 'string'
          ? [payload.value.attachment_id] : [];
      }))];
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition_not_reached');
}

test('run waits for its subscriber so AG-UI starts with RUN_STARTED', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const observable = coordinator.run({
    store,
    userId: 'user-a',
    publicThreadId: 'public-thread',
    input: {
      threadId: 'scoped-thread',
      runId: 'public-run',
      messages: [{ id: 'user-message', role: 'user', content: 'Привет' }]
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  const streamed = [];
  observable.subscribe((event) => streamed.push(event));
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  broker.notify('item/agentMessage/delta', {
    threadId: 'internal-thread-secret',
    turnId: 'internal-turn-secret',
    itemId: 'internal-message-secret',
    delta: 'Готово'
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret',
    turnId: 'internal-turn-secret',
    item: { type: 'agentMessage', id: 'internal-message-secret', text: 'Готово' }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret',
    turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.events.some((event) => event.type === EventType.RUN_FINISHED));

  assert.equal(streamed[0]?.type, EventType.RUN_STARTED);
});

test('turn continues and persists after the HTTP subscriber detaches', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const streamed = [];
  const observable = coordinator.run({
    store,
    userId: 'user-a',
    publicThreadId: 'public-thread',
    input: {
      threadId: 'scoped-thread',
      runId: 'public-run',
      messages: [{ id: 'user-message', role: 'user', content: 'Привет' }]
    }
  });
  const subscription = observable.subscribe((event) => {
    assert.equal(store.events.at(-1).safePayload, event, 'event must persist before fan-out');
    streamed.push(event);
  });

  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  subscription.unsubscribe();
  broker.notify('item/agentMessage/delta', {
    threadId: 'internal-thread-secret',
    turnId: 'internal-turn-secret',
    itemId: 'internal-message-secret',
    delta: 'Готово'
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret',
    turnId: 'internal-turn-secret',
    item: { type: 'agentMessage', id: 'internal-message-secret', text: 'Готово' }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret',
    turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.events.some((event) => event.type === EventType.RUN_FINISHED));

  assert.ok(streamed.some((event) => event.type === EventType.RUN_STARTED));
  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'Готово' && message.status === 'completed'
  ));
  assert.equal(JSON.stringify(store.events).includes('internal-message-secret'), false);
  assert.equal(JSON.stringify(store.events).includes('internal-turn-secret'), false);
  assert.equal(store.thread.active_turn_id, null);
});

test('connect replays only persisted safe AG-UI payloads', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  store.events.push({ safePayload: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'public-message', delta: 'Сохранено' } });
  const coordinator = new BraiChatTurnCoordinator({ broker });
  const replayed = [];

  await new Promise((resolve, reject) => coordinator.connect({
    store,
    userId: 'user-a',
    publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

  assert.deepEqual(replayed, [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'public-message', delta: 'Сохранено' }]);
});

test('safe reasoning streams through standard AG-UI events and survives reconnect', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'reasoning-run',
      messages: [{ id: 'reasoning-user', role: 'user', content: 'Проверь решение' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('item/reasoning/summaryTextDelta', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    itemId: 'private-reasoning-item', summaryIndex: 0, delta: 'Сверяю ограничения'
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: { type: 'reasoning', id: 'private-reasoning-item', summary: ['Сверяю ограничения'] }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));
  assert.deepEqual(replayed.filter((event) => event.type.startsWith('REASONING_'))
    .map((event) => event.type), [
    EventType.REASONING_START,
    EventType.REASONING_MESSAGE_START,
    EventType.REASONING_MESSAGE_CONTENT,
    EventType.REASONING_MESSAGE_END,
    EventType.REASONING_END
  ]);
  assert.equal(replayed.find((event) =>
    event.type === EventType.REASONING_MESSAGE_CONTENT).delta, 'Сверяю ограничения');
  assert.equal(JSON.stringify(store.events).includes('private-reasoning-item'), false);
});

test('tool and image-only run remains visible in durable history after reconnect', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'image-only-run',
      messages: [{ id: 'image-only-user', role: 'user', content: 'Создай изображение' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('item/started', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: { type: 'imageGeneration', id: 'private-image-item', status: 'inProgress' }
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: {
      type: 'imageGeneration', id: 'private-image-item',
      status: 'completed', path: '/tmp/private-output.png'
    }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

  const toolStart = replayed.find((event) => event.type === EventType.TOOL_CALL_START);
  assert.match(toolStart.parentMessageId, /^assistant:/);
  const toolResult = replayed.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.deepEqual(JSON.parse(toolResult.content), {
    status: 'ready',
    attachment_id: store.attachments[0].id,
    name: 'spring.png',
    media_type: 'image/png',
    byte_size: 8
  });
  const imageArtifact = replayed.find((event) =>
    event.type === EventType.CUSTOM && event.name === 'brai.artifact.v1'
      && event.value.kind === 'image');
  assert.equal(imageArtifact.value.status, 'ready');
  assert.match(imageArtifact.value.attachment_id, /^attachment_/);
  assert.equal(imageArtifact.value.source_message_id, toolStart.parentMessageId);
  assert.equal(store.attachments.length, 1);
  assert.equal(store.attachments[0].message_id, toolStart.parentMessageId);
  assert.ok(broker.requests.some(({ method, params }) =>
    method === 'exportGeneratedArtifact'
      && params.itemId === 'private-image-item'
      && !Object.hasOwn(params, 'path')));
  assert.ok(broker.requests.some(({ method, params }) =>
    method === 'cleanupGeneratedArtifacts'
      && params.publicThreadId === 'public-thread'
      && params.attachmentIds.length === 1
      && params.attachmentIds[0] === imageArtifact.value.attachment_id
      && !Object.hasOwn(params, 'path')));
  assert.ok(replayed.some((event) => event.type === EventType.RUN_FINISHED));
  assert.equal(replayed.filter((event) => event.type === EventType.CUSTOM
    && event.name === 'brai.artifact.v1' && event.value.kind === 'image').length, 1);
  assert.equal(replayed.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta).join(''), 'Изображение готово.');
  const chatLogs = store.aiLogs.filter((log) => log.agentId === 'brai-codex');
  assert.equal(chatLogs.length, 1);
  assert.equal(chatLogs[0].jsonData.has_generated_image, true);
  assert.equal(chatLogs[0].jsonData.has_assistant_text, true);
  assert.equal(JSON.stringify(replayed).includes('/tmp/private-output.png'), false);
  assert.equal(JSON.stringify(replayed).includes('private-image-item'), false);
});

test('generated image export failure keeps the tool-only history and exposes a retryable artifact error', async () => {
  const broker = new FakeBroker({
    generatedArtifactError: Object.assign(new Error('unavailable'), {
      code: 'BRAI_GENERATED_ARTIFACT_UNAVAILABLE'
    })
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'image-failure-run',
      messages: [{ id: 'image-failure-user', role: 'user', content: 'Создай изображение' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('item/started', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: { type: 'imageGeneration', id: 'private-failed-image', status: 'inProgress' }
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: {
      type: 'imageGeneration', id: 'private-failed-image',
      status: 'failed', path: '/tmp/failed-output.png'
    }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  const artifact = store.events.map((event) => event.safePayload).find((event) =>
    event?.type === EventType.CUSTOM && event.name === 'brai.artifact.v1');
  assert.equal(artifact.value.status, 'failed');
  assert.equal(artifact.value.retryable, true);
  assert.equal(store.attachments.length, 0);
  assert.ok(store.events.some((event) => event.safePayload?.type === EventType.TOOL_CALL_RESULT));
  assert.ok(store.events.some((event) => event.safePayload?.type === EventType.RUN_FINISHED));
  assert.equal(JSON.stringify(store.events).includes('/tmp/failed-output.png'), false);
});

test('generated source cleanup failure preserves durable history and reconnect retries opaque cleanup', async () => {
  const cleanupError = Object.assign(new Error('temporary cleanup failure'), {
    code: 'BRAI_GENERATED_ARTIFACT_CLEANUP_FAILED'
  });
  const broker = new FakeBroker({ generatedCleanupError: cleanupError });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'image-cleanup-run',
      messages: [{ id: 'image-cleanup-user', role: 'user', content: 'Создай изображение' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: {
      type: 'imageGeneration', id: 'private-cleanup-image',
      status: 'completed', path: '/tmp/cleanup-output.png'
    }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  await waitFor(() => broker.requests.filter(({ method }) =>
    method === 'cleanupGeneratedArtifacts').length === 1);

  const beforeReconnect = JSON.stringify({
    events: store.events, messages: store.messages, attachments: store.attachments
  });
  const readyArtifact = store.events.map((event) => event.safePayload).find((event) =>
    event?.type === EventType.CUSTOM && event.name === 'brai.artifact.v1'
      && event.value?.status === 'ready');
  assert.ok(readyArtifact);
  assert.equal(store.attachments[0].message_id, readyArtifact.value.source_message_id);

  broker.generatedCleanupError = null;
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    headers: { 'last-event-id': String(store.events.length) }
  }).subscribe({ error: reject, complete: resolve }));
  await waitFor(() => broker.requests.filter(({ method }) =>
    method === 'cleanupGeneratedArtifacts').length === 2);

  const cleanupRequests = broker.requests.filter(({ method }) =>
    method === 'cleanupGeneratedArtifacts');
  assert.deepEqual(cleanupRequests.map(({ params }) => params.attachmentIds), [
    [readyArtifact.value.attachment_id],
    [readyArtifact.value.attachment_id]
  ]);
  assert.ok(cleanupRequests.every(({ params }) =>
    !Object.hasOwn(params, 'path')
      && Object.keys(params).sort().join(',') === 'attachmentIds,publicThreadId,userId'));
  assert.equal(JSON.stringify({
    events: store.events, messages: store.messages, attachments: store.attachments
  }), beforeReconnect);
});

test('generated image recovery always repairs the assistant message link for an existing attachment row', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const runId = 'image-recovery-run';
  const itemId = 'private-image-recovery-item';
  const attachmentId = `attachment_${crypto.createHash('sha256')
    .update(`user-a\0public-thread\0${runId}\0${itemId}`)
    .digest('hex').slice(0, 32)}`;
  store.attachments.push({
    version: 1,
    id: attachmentId,
    thread_id: 'public-thread',
    message_id: null,
    filename: 'spring.png',
    media_type: 'image/png',
    byte_size: 8,
    checksum_sha256: 'a'.repeat(64)
  });
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId,
      messages: [{ id: 'image-recovery-user', role: 'user', content: 'Верни изображение' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: {
      type: 'imageGeneration', id: itemId,
      status: 'completed', path: '/tmp/recovered-output.png'
    }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  assert.equal(broker.requests.some(({ method }) => method === 'exportGeneratedArtifact'), false);
  assert.match(store.attachments[0].message_id, /^assistant:/);
  assert.ok(store.messages.some((message) =>
    message.id === store.attachments[0].message_id && message.role === 'assistant'));
});

test('upstream error publishes one terminal event and completes before a late turn notification', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'error-run',
      messages: [{ id: 'error-user', role: 'user', content: 'Сломайся безопасно' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  broker.notify('error', {
    threadId: 'internal-thread-secret',
    turnId: 'internal-turn-secret',
    error: { message: 'private upstream failure' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret',
    turn: { id: 'internal-turn-secret', status: 'failed' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const terminals = store.events.map((event) => event.safePayload)
    .filter((event) => event?.type === EventType.RUN_ERROR
      || event?.type === EventType.RUN_FINISHED);
  assert.deepEqual(terminals.map((event) => event.type), [EventType.RUN_ERROR]);
});

test('successful first assistant turn selects a semantic title while manual rename wins', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const titleInputs = [];
  const coordinator = new BraiChatTurnCoordinator({
    broker,
    turnTimeoutMs: 10_000,
    titleGenerator: async (input) => {
      titleInputs.push(input);
      return 'Хайку про весну';
    }
  });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'title-run',
      messages: [{ id: 'title-user', role: 'user', content: 'напиши хайку про весну' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  assert.equal(store.thread.title, 'Новый чат');

  broker.notify('item/agentMessage/delta', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    itemId: 'title-assistant', delta: 'Весенний ветер'
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: { type: 'agentMessage', id: 'title-assistant', text: 'Весенний ветер' }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  await waitFor(() => store.thread.title_source === 'generated');
  assert.equal(store.thread.title, 'Хайку про весну');
  assert.equal(store.thread.title_source, 'generated');
  assert.equal(titleInputs[0].userId, 'user-a');
  assert.equal(titleInputs[0].userMessage, 'напиши хайку про весну');
  assert.deepEqual(titleInputs[0].assistantMessages, ['Весенний ветер']);
  await waitFor(() => store.aiLogs.some((log) => log.agentId === 'brai.chat-title'));
  const titleLog = store.aiLogs.find((log) => log.agentId === 'brai.chat-title');
  assert.equal(titleLog.agentVersion, '1');
  assert.equal(titleLog.status, 'done');
  assert.equal(titleLog.jsonData.schema, 'brai.chat_title.ai_log.v1');
  assert.equal(titleLog.jsonData.title_applied, true);
  assert.equal(JSON.stringify(titleLog).includes('напиши хайку'), false);
  assert.equal(JSON.stringify(titleLog).includes('Весенний ветер'), false);
  assert.equal(JSON.stringify(titleLog).includes('Хайку про весну'), false);
  assert.equal(store.aiLogs.filter((log) => log.agentId === 'brai-codex').length, 1);

  store.thread.title = 'Моё название';
  store.thread.title_source = 'manual';
  assert.equal(store.setBraiChatGeneratedTitle('public-thread', 'Другое название').title,
    'Моё название');
});

test('semantic title generator failure leaves the default title unchanged', async () => {
  for (const titleGenerator of [
    async () => null,
    async () => { throw new Error('title model unavailable'); }
  ]) {
    const broker = new FakeBroker();
    const store = fakeStore();
    const coordinator = new BraiChatTurnCoordinator({
      broker, turnTimeoutMs: 10_000, titleGenerator
    });
    coordinator.run({
      store, userId: 'user-a', publicThreadId: 'public-thread',
      input: {
        runId: crypto.randomUUID(),
        messages: [{ id: crypto.randomUUID(), role: 'user', content: 'Не копируй меня в title' }]
      }
    }).subscribe(() => {});
    await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
    broker.notify('item/agentMessage/delta', {
      threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
      itemId: 'title-failure-assistant', delta: 'Ответ'
    });
    broker.notify('item/completed', {
      threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
      item: { type: 'agentMessage', id: 'title-failure-assistant', text: 'Ответ' }
    });
    broker.notify('turn/completed', {
      threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
    });
    await waitFor(() => store.thread.active_turn_id === null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.thread.title, 'Новый чат');
    assert.equal(store.thread.title_source, 'default');
    await waitFor(() => store.aiLogs.some((log) => log.agentId === 'brai.chat-title'));
    const titleLog = store.aiLogs.find((log) => log.agentId === 'brai.chat-title');
    assert.equal(titleLog.status, 'failed');
    assert.equal(titleLog.jsonData.title_applied, false);
    assert.equal(JSON.stringify(titleLog).includes('Не копируй меня'), false);
    assert.equal(store.aiLogs.filter((log) => log.agentId === 'brai-codex').length, 1);
  }
});

test('manual rename during background title generation wins and records one completed AI call', async () => {
  let resolveTitle;
  const titleResult = new Promise((resolve) => { resolveTitle = resolve; });
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({
    broker,
    turnTimeoutMs: 10_000,
    titleGenerator: () => titleResult
  });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'manual-title-race-run',
      messages: [{ id: 'manual-title-user', role: 'user', content: 'Подбери название' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  broker.notify('item/agentMessage/delta', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    itemId: 'manual-title-assistant', delta: 'Готово'
  });
  broker.notify('item/completed', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    item: { type: 'agentMessage', id: 'manual-title-assistant', text: 'Готово' }
  });
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  store.thread.title = 'Ручной заголовок';
  store.thread.title_source = 'manual';
  resolveTitle('Модельный заголовок');
  await waitFor(() => store.aiLogs.some((log) => log.agentId === 'brai.chat-title'));

  assert.equal(store.thread.title, 'Ручной заголовок');
  assert.equal(store.thread.title_source, 'manual');
  const titleLog = store.aiLogs.find((log) => log.agentId === 'brai.chat-title');
  assert.equal(titleLog.status, 'done');
  assert.equal(titleLog.jsonData.title_applied, false);
  assert.equal(store.aiLogs.filter((log) => log.agentId === 'brai.chat-title').length, 1);
  assert.equal(store.aiLogs.filter((log) => log.agentId === 'brai-codex').length, 1);
});

test('restart recovery generates a title from already persisted assistant output', async () => {
  const store = fakeStore();
  store.thread.active_turn_id = 'recovered-title-run';
  store.thread.active_codex_turn_id = 'internal-recovered-title-turn';
  store.thread.active_user_message_id = 'internal-recovered-title-user';
  store.thread.codex_thread_id = 'internal-thread-secret';
  store.events.push(
    {
      turnId: 'recovered-title-run',
      safePayload: {
        type: EventType.RUN_STARTED,
        threadId: 'public-thread',
        runId: 'recovered-title-run',
        input: {
          messages: [{ id: 'recovered-user', role: 'user', content: 'О чём этот диалог?' }]
        }
      }
    },
    {
      turnId: 'recovered-title-run',
      safePayload: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'recovered-assistant',
        role: 'assistant'
      }
    },
    {
      turnId: 'recovered-title-run',
      safePayload: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'recovered-assistant',
        delta: 'О весеннем ветре'
      }
    },
    {
      turnId: 'recovered-title-run',
      safePayload: {
        type: EventType.TEXT_MESSAGE_END,
        messageId: 'recovered-assistant'
      }
    }
  );
  const broker = new FakeBroker({
    readThread: {
      thread: {
        turns: [{
          id: 'internal-recovered-title-turn',
          status: 'completed',
          items: []
        }]
      }
    }
  });
  const titleInputs = [];
  const coordinator = new BraiChatTurnCoordinator({
    broker,
    titleGenerator: async (input) => {
      titleInputs.push(input);
      return 'Весенний разговор';
    }
  });

  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ error: reject, complete: resolve }));
  await waitFor(() => store.thread.title_source === 'generated');

  assert.equal(store.thread.title, 'Весенний разговор');
  assert.equal(titleInputs[0].userMessage, 'О чём этот диалог?');
  assert.deepEqual(titleInputs[0].assistantMessages, ['О весеннем ветре']);
});

test('concurrent run is rejected and client message id is stable and broker-safe', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const first = coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'public-run',
      messages: [{ id: 'public.message:1', role: 'user', content: 'Привет' }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  const error = await new Promise((resolve) => coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'second-run', messages: [{ id: 'second-message', role: 'user', content: 'Ещё' }] }
  }).subscribe({ error: resolve }));
  assert.equal(error.message, 'Thread already running');
  assert.equal(broker.requests.some((request) => request.method === 'steerTurn'), false);

  const start = broker.requests.find((request) => request.method === 'startTurn');
  assert.match(start.params.clientUserMessageId, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  assert.notEqual(start.params.clientUserMessageId, 'public.message:1');
  assert.equal(store.thread.active_user_message_id, start.params.clientUserMessageId);
  assert.equal(store.thread.active_codex_turn_id, 'internal-turn-secret');
  assert.ok(store.events.every((event) => event.idempotencyKey.length < 200));

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  first.unsubscribe();
});

test('selected attachments are mounted before a new Codex thread is created', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const subscription = coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'attachment-run',
      messages: [{
        id: 'attachment-message', role: 'user', content: [
          { type: 'text', text: 'Посмотри изображение' },
          { type: 'image', metadata: { attachment_id: 'attachment-one' } }
        ]
      }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  const selected = [{ id: 'attachment-one', threadId: 'public-thread' }];
  assert.deepEqual(broker.requests.find((request) => request.method === 'startThread').params.attachments, selected);
  assert.deepEqual(broker.requests.find((request) => request.method === 'startTurn').params.attachments, selected);
  assert.equal(broker.requests.some((request) => request.method === 'ensureRuntime'), false);

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  subscription.unsubscribe();
});

test('selected attachments are mounted before an existing Codex thread is resumed', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  store.thread.codex_thread_id = 'existing-internal-thread';
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const subscription = coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: {
      runId: 'resume-attachment-run',
      messages: [{
        id: 'resume-attachment-message', role: 'user', content: [
          { type: 'text', text: 'Продолжи с изображением' },
          { type: 'image', metadata: { attachment_id: 'attachment-two' } }
        ]
      }]
    }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  const selected = [{ id: 'attachment-two', threadId: 'public-thread' }];
  assert.deepEqual(broker.requests.find((request) => request.method === 'resumeThread').params.attachments, selected);
  assert.deepEqual(broker.requests.find((request) => request.method === 'startTurn').params.attachments, selected);

  broker.notify('turn/completed', {
    threadId: 'existing-internal-thread', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  subscription.unsubscribe();
});

test('retry reuses the original message attachment set when replay omits image parts', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const run = (runId, content) => coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId, messages: [{ id: 'image-retry-message', role: 'user', content }] }
  }).subscribe(() => {});

  run('image-retry-one', [
    { type: 'text', text: 'Посмотри изображение' },
    { type: 'image', metadata: { attachment_id: 'attachment-original' } }
  ]);
  await waitFor(() => broker.requests.filter(({ method }) => method === 'startTurn').length === 1);
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  run('image-retry-two', 'Посмотри изображение');
  await waitFor(() => broker.requests.filter(({ method }) => method === 'startTurn').length === 2);
  const expected = [{ id: 'attachment-original', threadId: 'public-thread' }];
  assert.deepEqual(broker.requests.filter(({ method }) => method === 'resumeThread').at(-1).params.attachments, expected);
  assert.deepEqual(broker.requests.filter(({ method }) => method === 'startTurn').at(-1).params.attachments, expected);

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
});

test('invalid run id fails as an Observable error before broker dispatch', async () => {
  const broker = new FakeBroker();
  const coordinator = new BraiChatTurnCoordinator({ broker });
  const error = await new Promise((resolve) => coordinator.run({
    store: fakeStore(), userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'x'.repeat(201), messages: [{ role: 'user', content: 'Привет' }] }
  }).subscribe({ error: resolve }));
  assert.equal(error.message, 'Invalid run id');
  assert.deepEqual(broker.requests, []);
});

test('steer persists and streams one idempotent user message before broker dispatch', async () => {
  const store = fakeStore();
  const broker = new FakeBroker({
    steerTurn: () => {
      assert.equal(store.messages.find((message) => message.id === 'steer-message')?.content, 'Продолжи');
      assert.equal(store.events.filter((event) => event.safePayload?.messageId === 'steer-message').length, 3);
      return {};
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const streamed = [];
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'steer-run', messages: [{ id: 'initial-message', role: 'user', content: 'Начать' }] }
  }).subscribe((event) => streamed.push(event));
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  assert.equal(await coordinator.steer({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    messageId: 'steer-message', text: 'Продолжи'
  }), true);
  assert.equal(await coordinator.steer({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    messageId: 'steer-message', text: 'Продолжи'
  }), true);

  const steerRequests = broker.requests.filter((request) => request.method === 'steerTurn');
  assert.equal(steerRequests.length, 1);
  assert.match(steerRequests[0].params.clientUserMessageId, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  assert.equal(steerRequests[0].params.text, 'Продолжи');
  assert.equal(store.messages.filter((message) => message.id === 'steer-message').length, 1);
  assert.equal(store.messages.find((message) => message.id === 'steer-message').status, 'completed');
  assert.equal(store.messages.find((message) => message.id === 'steer-message').dispatch_status, 'delivered');
  assert.equal(store.messages.find((message) => message.id === 'steer-message').model, 'gpt-test');
  assert.equal(store.messages.find((message) => message.id === 'steer-message').reasoningEffort, 'medium');
  const persistedUserEvents = store.events
    .map((event) => event.safePayload)
    .filter((event) => event.messageId === 'steer-message');
  assert.deepEqual(persistedUserEvents.map((event) => event.type), [
    EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END
  ]);
  assert.equal(persistedUserEvents[0].role, 'user');
  assert.deepEqual(streamed.filter((event) => event.messageId === 'steer-message'), persistedUserEvents);

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));
  assert.deepEqual(replayed.filter((event) => event.messageId === 'steer-message'), persistedUserEvents);
});

test('steer rejects invalid or inactive requests before broker dispatch', async () => {
  const broker = new FakeBroker();
  const coordinator = new BraiChatTurnCoordinator({ broker });
  const input = { store: fakeStore(), userId: 'user-a', publicThreadId: 'public-thread' };

  await assert.rejects(coordinator.steer({
    ...input, messageId: 'invalid/message', text: 'Текст'
  }), (error) => error.status === 400 && error.message === 'invalid_message_id');
  await assert.rejects(coordinator.steer({
    ...input, messageId: 'valid-message', text: 'Текст'
  }), (error) => error.status === 409 && error.message === 'chat_turn_not_active');
  assert.equal(broker.requests.some((request) => request.method === 'steerTurn'), false);
});

test('steer failure is durably retryable with the same broker client message id', async () => {
  const broker = new FakeBroker({ steerTurnError: new Error('Authorization: host-secret-value') });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'steer-failure-run', messages: [{ id: 'initial-message', role: 'user', content: 'Начать' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  await assert.rejects(coordinator.steer({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    messageId: 'failed-steer-message', text: 'Продолжи'
  }), (error) => error.status === 503 && error.message === 'upstream_auth');
  assert.equal(store.messages.find((message) => message.id === 'failed-steer-message').status, 'completed');
  assert.equal(store.messages.find((message) => message.id === 'failed-steer-message').dispatch_status, 'failed');
  assert.equal(store.thread.active_turn_id, 'steer-failure-run');
  assert.ok(store.events.some((event) =>
    event.safePayload?.name === 'brai.message_status.v1'
      && event.safePayload.value.message_id === 'failed-steer-message'
      && event.safePayload.value.code === 'upstream_auth'
  ));
  assert.equal(JSON.stringify(store.events).includes('host-secret-value'), false);
  assert.equal(store.events.some((event) => event.type === EventType.RUN_ERROR), false);

  const firstClientMessageId = broker.requests.find((request) => request.method === 'steerTurn')
    .params.clientUserMessageId;
  broker.steerTurnError = null;
  assert.equal(await coordinator.steer({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    messageId: 'failed-steer-message', text: 'Продолжи'
  }), true);
  const attempts = broker.requests.filter((request) => request.method === 'steerTurn');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].params.clientUserMessageId, firstClientMessageId);
  assert.equal(store.messages.find((message) => message.id === 'failed-steer-message').dispatch_status, 'delivered');
  assert.equal(store.events.filter((event) =>
    event.safePayload?.messageId === 'failed-steer-message').length, 3);

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
});

test('turn completion waits behind an in-flight steer operation', async () => {
  let releaseSteer;
  const broker = new FakeBroker({
    steerTurn: () => new Promise((resolve) => { releaseSteer = resolve; })
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'steer-race-run', messages: [{ id: 'initial-message', role: 'user', content: 'Начать' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  const steering = coordinator.steer({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    messageId: 'race-steer-message', text: 'Ещё'
  });
  await waitFor(() => broker.requests.some((request) => request.method === 'steerTurn'));
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.thread.active_turn_id, 'steer-race-run');
  releaseSteer({});
  assert.equal(await steering, true);
  await waitFor(() => store.thread.active_turn_id === null);
  assert.equal(store.messages.find((message) => message.id === 'race-steer-message').status, 'completed');
});

test('retry starts a new turn from the same public user message without duplicating or editing it', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const run = (runId) => coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId, messages: [{ id: 'retry-message', role: 'user', content: 'Повтори' }] }
  }).subscribe(() => {});

  run('retry-run-one');
  await waitFor(() => broker.requests.filter((request) => request.method === 'startTurn').length === 1);
  const firstClientId = broker.requests.find((request) => request.method === 'startTurn').params.clientUserMessageId;
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);

  run('retry-run-two');
  await waitFor(() => broker.requests.filter((request) => request.method === 'startTurn').length === 2);
  const starts = broker.requests.filter((request) => request.method === 'startTurn');
  assert.notEqual(starts[1].params.clientUserMessageId, firstClientId);
  assert.equal(store.messages.filter((message) => message.id === 'retry-message').length, 1);
  assert.equal(store.messages.find((message) => message.id === 'retry-message').turnId, 'retry-run-one');
  assert.equal(store.messages.find((message) => message.id === 'retry-message').content, 'Повтори');

  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret', turn: { id: 'internal-turn-secret', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
});

test('lost startTurn response recovers the exact turn through the durable client message id', async () => {
  const broker = new FakeBroker({
    startTurnError: new Error('socket closed after dispatch'),
    readThread: (_params, requests) => {
      const start = requests.find((request) => request.method === 'startTurn');
      return {
        thread: {
          turns: [{
            id: 'recovered-internal-turn', status: 'inProgress',
            items: [{ type: 'userMessage', id: 'upstream-user', clientId: start.params.clientUserMessageId }]
          }]
        }
      };
    }
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'recover-run', messages: [{ id: 'recover-message', role: 'user', content: 'Продолжить' }] }
  }).subscribe(() => {});
  await waitFor(() => store.thread.active_codex_turn_id === 'recovered-internal-turn');

  assert.equal(broker.requests.filter((request) => request.method === 'startTurn').length, 1);
  assert.match(store.thread.active_user_message_id, /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
  broker.notify('turn/completed', {
    threadId: 'internal-thread-secret',
    turn: { id: 'recovered-internal-turn', status: 'completed' }
  });
  await waitFor(() => store.thread.active_turn_id === null);
});

test('restart reconciliation subscribes before thread/read and preserves interrupted partial output', async () => {
  const store = fakeStore();
  store.thread.codex_thread_id = 'internal-thread-secret';
  store.thread.active_turn_id = 'persisted-run';
  store.thread.active_codex_turn_id = 'internal-turn-secret';
  store.thread.active_user_message_id = 'm_persisted000000000000000000000000000000';
  const broker = new FakeBroker({
    readThread: {
      thread: {
        turns: [{
          id: 'internal-turn-secret', status: 'interrupted',
          items: [
            { type: 'userMessage', id: 'upstream-user', clientId: store.thread.active_user_message_id, content: [] },
            { type: 'agentMessage', id: 'upstream-assistant', text: 'Частичный ответ' }
          ]
        }]
      }
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker });
  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

  assert.ok(broker.requests.findIndex((request) => request.method === 'subscribe')
    < broker.requests.findIndex((request) => request.method === 'readThread'));
  assert.ok(replayed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === 'Частичный ответ'));
  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'Частичный ответ' && message.status === 'interrupted'
  ));
  assert.equal(store.thread.active_turn_id, null);
  assert.equal(JSON.stringify(store.events).includes('internal-turn-secret'), false);
});

test('restart reconciliation delivers a persisted steer outbox exactly once', async (t) => {
  const setup = (items, status = 'inProgress') => {
    const store = fakeStore();
    Object.assign(store.thread, {
      codex_thread_id: 'internal-thread-secret', active_turn_id: 'persisted-steer-run',
      active_codex_turn_id: 'internal-turn-secret',
      active_user_message_id: 'm_initial0000000000000000000000000000000'
    });
    store.messages.push({
      id: 'persisted-steer-message', threadId: 'public-thread', turnId: 'persisted-steer-run',
      idempotencyKey: 'persisted-steer-key', role: 'user', content: 'Доиграй сообщение',
      status: 'completed', dispatch_status: 'pending'
    });
    const broker = new FakeBroker({
      readThread: { thread: { turns: [{ id: 'internal-turn-secret', status, items }] } }
    });
    return { store, broker, coordinator: new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 }) };
  };
  const clientMessageId = `m_${crypto.createHash('sha256')
    .update(['steer', 'persisted-steer-run', 'persisted-steer-message'].join('\0'))
    .digest('hex').slice(0, 40)}`;

  await t.test('dispatches a message missing from the active upstream turn', async () => {
    const { store, broker, coordinator } = setup([]);
    const subscription = coordinator.connect({
      store, userId: 'user-a', publicThreadId: 'public-thread'
    }).subscribe(() => {});
    await waitFor(() => store.messages[0].dispatch_status === 'delivered');
    assert.equal(broker.requests.filter(({ method }) => method === 'steerTurn').length, 1);
    assert.equal(broker.requests.find(({ method }) => method === 'steerTurn')
      .params.clientUserMessageId, clientMessageId);
    assert.equal(store.events.filter((event) =>
      event.safePayload?.messageId === 'persisted-steer-message').length, 3);
    subscription.unsubscribe();
  });

  await t.test('repairs pending after upstream accepted the message', async () => {
    const { store, broker, coordinator } = setup([
      { type: 'userMessage', id: 'upstream-steer', clientId: clientMessageId }
    ]);
    const subscription = coordinator.connect({
      store, userId: 'user-a', publicThreadId: 'public-thread'
    }).subscribe(() => {});
    await waitFor(() => store.messages[0].dispatch_status === 'delivered');
    assert.equal(broker.requests.some(({ method }) => method === 'steerTurn'), false);
    subscription.unsubscribe();
  });

  await t.test('marks a missing message failed after the upstream turn ended', async () => {
    const { store, broker, coordinator } = setup([], 'completed');
    await new Promise((resolve, reject) => coordinator.connect({
      store, userId: 'user-a', publicThreadId: 'public-thread'
    }).subscribe({ error: reject, complete: resolve }));
    assert.equal(store.messages[0].dispatch_status, 'failed');
    assert.equal(broker.requests.some(({ method }) => method === 'steerTurn'), false);
    assert.ok(store.events.some((event) =>
      event.safePayload?.name === 'brai.message_status.v1'
        && event.safePayload.value.code === 'chat_turn_not_active'));
  });
});

test('connect paginates replay strictly after the acknowledged sequence', async () => {
  const store = fakeStore();
  for (let sequence = 1; sequence <= 1_105; sequence += 1) {
    store.events.push({
      id: `event-${sequence}`,
      turnId: 'historic-run',
      safePayload: { type: EventType.CUSTOM, name: 'page', value: { sequence } }
    });
  }
  const coordinator = new BraiChatTurnCoordinator({ broker: new FakeBroker() });
  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    headers: { 'last-event-id': '500', 'x-brai-chat-replay-mode': 'resume' }
  }).subscribe({ next: (event) => replayed.push(event.value.sequence), error: reject, complete: resolve }));

  assert.equal(replayed.length, 605);
  assert.equal(replayed[0], 501);
  assert.equal(replayed.at(-1), 1_105);
  assert.deepEqual(store.replayCalls, [{ after: 500, limit: 500 }, { after: 1_000, limit: 500 }]);
});

test('cold replay immediately before a terminal event includes its matching run start', async (t) => {
  for (const terminalType of [EventType.RUN_FINISHED, EventType.RUN_ERROR]) {
    await t.test(terminalType, async () => {
      const store = fakeStore();
      const terminal = terminalType === EventType.RUN_FINISHED
        ? {
            type: EventType.RUN_FINISHED,
            threadId: 'public-thread',
            runId: 'historic-run',
            outcome: { type: 'success' }
          }
        : {
            type: EventType.RUN_ERROR,
            code: 'upstream_unavailable',
            message: 'Codex временно недоступен. Попробуйте позже.'
          };
      store.events.push(
        {
          turnId: 'historic-run',
          safePayload: {
            type: EventType.RUN_STARTED,
            threadId: 'public-thread',
            runId: 'historic-run'
          }
        },
        {
          turnId: 'historic-run',
          safePayload: {
            type: EventType.TEXT_MESSAGE_START,
            messageId: 'historic-message',
            role: 'assistant'
          }
        },
        {
          turnId: 'historic-run',
          safePayload: {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: 'historic-message',
            delta: 'Первая '
          }
        },
        {
          turnId: 'historic-run',
          safePayload: {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: 'historic-message',
            delta: 'часть'
          }
        },
        {
          turnId: 'historic-run',
          safePayload: {
            type: EventType.TEXT_MESSAGE_END,
            messageId: 'historic-message'
          }
        },
        { turnId: 'historic-run', safePayload: terminal }
      );
      const coordinator = new BraiChatTurnCoordinator({ broker: new FakeBroker() });
      const replayed = [];
      await new Promise((resolve, reject) => coordinator.connect({
        store,
        userId: 'user-a',
        publicThreadId: 'public-thread',
        headers: { 'last-event-id': '5' }
      }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

      assert.equal(replayed[0].type, EventType.RUN_STARTED);
      assert.equal(replayed[0].runId, 'historic-run');
      assert.equal(replayed.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((event) => event.delta).join(''), 'Первая часть');
      assert.equal(replayed.at(-1).type, terminalType);
      assert.deepEqual(store.replayCalls, [{ after: 0, limit: 500 }]);
    });
  }
});

test('standalone pre-start RUN_ERROR does not borrow a prior run boundary', async () => {
  const store = fakeStore();
  store.events.push(
    {
      turnId: 'previous-run',
      safePayload: {
        type: EventType.RUN_STARTED,
        threadId: 'public-thread',
        runId: 'previous-run'
      }
    },
    {
      turnId: 'previous-run',
      safePayload: {
        type: EventType.RUN_FINISHED,
        threadId: 'public-thread',
        runId: 'previous-run',
        outcome: { type: 'success' }
      }
    },
    {
      turnId: 'prestart-error-run',
      safePayload: {
        type: EventType.RUN_ERROR,
        code: 'upstream_unavailable',
        message: 'Codex временно недоступен. Попробуйте позже.'
      }
    }
  );
  const coordinator = new BraiChatTurnCoordinator({ broker: new FakeBroker() });
  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store,
    userId: 'user-a',
    publicThreadId: 'public-thread',
    headers: { 'last-event-id': '2', 'x-brai-chat-replay-mode': 'resume' }
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

  assert.deepEqual(replayed.map((event) => event.type), [EventType.RUN_ERROR]);
  assert.deepEqual(store.replayCalls, [{ after: 2, limit: 500 }]);
});

test('connect closes the replay/live handoff without dropping or duplicating a boundary event', async () => {
  const broker = new FakeBroker({
    readThread: {
      thread: { turns: [{ id: 'internal-turn-secret', status: 'inProgress', items: [] }] }
    }
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'handoff-run', messages: [{ id: 'handoff-message', role: 'user', content: 'Начать' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  store.onReplay = ({ call }) => {
    if (call !== 2) return;
    broker.notify('item/agentMessage/delta', {
      threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
      itemId: 'handoff-assistant', delta: 'На границе'
    });
  };
  const replayed = [];
  const subscription = coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe((event) => replayed.push(event));
  await waitFor(() => replayed.some((event) => event.delta === 'На границе'));

  assert.equal(replayed.filter((event) => event.delta === 'На границе').length, 1);
  subscription.unsubscribe();
});

test('restart snapshot covers notifications received before readThread responds', async () => {
  const store = fakeStore();
  store.thread.codex_thread_id = 'internal-thread-secret';
  store.thread.active_turn_id = 'persisted-run';
  store.thread.active_codex_turn_id = 'internal-turn-secret';
  store.thread.active_user_message_id = 'm_persisted000000000000000000000000000000';
  let broker;
  broker = new FakeBroker({
    readThread: () => {
      broker.notify('item/agentMessage/delta', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        itemId: 'snapshot-assistant', delta: 'Из снимка'
      });
      return {
        thread: {
          turns: [{
            id: 'internal-turn-secret', status: 'completed',
            items: [{ type: 'agentMessage', id: 'snapshot-assistant', text: 'Из снимка' }]
          }]
        }
      };
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker });
  const replayed = [];
  await new Promise((resolve, reject) => coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe({ next: (event) => replayed.push(event), error: reject, complete: resolve }));

  assert.equal(replayed.filter((event) => event.delta === 'Из снимка').length, 1);
  assert.equal(store.events.filter((event) => event.safePayload?.delta === 'Из снимка').length, 1);
});

test('restart snapshot reuses a persisted assistant message when upstream item ids change', async () => {
  const store = fakeStore();
  Object.assign(store.thread, {
    codex_thread_id: 'internal-thread-secret',
    active_turn_id: 'persisted-id-change-run',
    active_codex_turn_id: 'internal-turn-secret',
    active_user_message_id: 'm_persisted000000000000000000000000000000'
  });
  const messageId = 'message:live-notification-id';
  for (const safePayload of [
    {
      type: EventType.RUN_STARTED,
      threadId: 'public-thread',
      runId: 'persisted-id-change-run'
    },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Сохранённый ответ' },
    { type: EventType.TEXT_MESSAGE_END, messageId }
  ]) {
    store.events.push({
      id: `persisted-${store.events.length + 1}`,
      turnId: 'persisted-id-change-run',
      safePayload
    });
  }
  const broker = new FakeBroker({
    readThread: {
      thread: {
        turns: [{
          id: 'internal-turn-secret',
          status: 'inProgress',
          items: [{
            type: 'agentMessage',
            id: 'item-2',
            text: 'Сохранённый ответ'
          }]
        }]
      }
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const subscription = coordinator.connect({
    store,
    userId: 'user-a',
    publicThreadId: 'public-thread'
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'readThread'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(store.events.filter((event) =>
    event.safePayload?.type === EventType.TEXT_MESSAGE_START).length, 1);
  assert.equal(store.events.filter((event) =>
    event.safePayload?.type === EventType.TEXT_MESSAGE_CONTENT
      && event.safePayload.delta === 'Сохранённый ответ').length, 1);
  subscription.unsubscribe();
});

test('restart processes a sequenced notification emitted after the read watermark', async () => {
  const store = fakeStore();
  Object.assign(store.thread, {
    codex_thread_id: 'internal-thread-secret', active_turn_id: 'persisted-run',
    active_codex_turn_id: 'internal-turn-secret',
    active_user_message_id: 'm_persisted000000000000000000000000000000'
  });
  let broker;
  broker = new FakeBroker({
    readThread: () => {
      broker.notify('item/agentMessage/delta', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        itemId: 'after-snapshot-assistant', delta: 'После снимка'
      });
      return {
        thread: { turns: [{ id: 'internal-turn-secret', status: 'inProgress', items: [] }] }
      };
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  const subscription = coordinator.connect({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }).subscribe(() => {});
  await waitFor(() => store.events.some((event) => event.safePayload?.delta === 'После снимка'));
  assert.equal(store.events.filter((event) => event.safePayload?.delta === 'После снимка').length, 1);
  subscription.unsubscribe();
});

test('restart keeps the persisted absolute deadline and effective turn settings', async () => {
  const store = fakeStore();
  const started = new Date(Date.now() - 100).toISOString();
  const deadline = new Date(Date.now() + 20).toISOString();
  Object.assign(store.thread, {
    model: 'new-thread-model', reasoning_effort: 'high',
    codex_thread_id: 'internal-thread-secret', active_turn_id: 'deadline-run',
    active_codex_turn_id: 'internal-turn-secret',
    active_user_message_id: 'm_deadline00000000000000000000000000000',
    active_turn_started_at_utc: started, active_turn_deadline_at_utc: deadline,
    active_turn_model: 'effective-model', active_turn_reasoning_effort: 'low'
  });
  const broker = new FakeBroker({
    readThread: {
      thread: { turns: [{
        id: 'internal-turn-secret', status: 'inProgress',
        items: [{ type: 'agentMessage', id: 'deadline-assistant', text: 'Частично' }]
      }] }
    }
  });
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  await Promise.race([
    new Promise((resolve, reject) => coordinator.connect({
      store, userId: 'user-a', publicThreadId: 'public-thread'
    }).subscribe({ error: reject, complete: resolve })),
    new Promise((_, reject) => setTimeout(() => reject(new Error('deadline_not_enforced')), 500))
  ]);

  const assistant = store.messages.find((message) => message.role === 'assistant');
  assert.equal(store.thread.active_turn_id, null);
  assert.equal(assistant.model, 'effective-model');
  assert.equal(assistant.reasoningEffort, 'low');
  assert.ok(broker.requests.some((request) => request.method === 'interruptTurn'));
});

test('broker disconnect reconciles a terminal turn from thread/read', async () => {
  let snapshot = { thread: { turns: [{ id: 'internal-turn-secret', status: 'inProgress', items: [] }] } };
  const broker = new FakeBroker({ readThread: () => snapshot });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'disconnect-run', messages: [{ id: 'disconnect-message', role: 'user', content: 'Начать' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  snapshot = {
    thread: {
      turns: [{
        id: 'internal-turn-secret', status: 'completed',
        items: [{ type: 'agentMessage', id: 'disconnect-assistant', text: 'После разрыва' }]
      }]
    }
  };
  broker.emit('disconnect');
  await waitFor(() => store.thread.active_turn_id === null);

  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'После разрыва' && message.status === 'completed'
  ));
});

test('stop drains queued deltas and stores the partial assistant message as interrupted', async () => {
  const broker = new FakeBroker();
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'stop-run', messages: [{ id: 'stop-message', role: 'user', content: 'Стоп' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  broker.notify('item/agentMessage/delta', {
    threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
    itemId: 'partial-message', delta: 'Уже готово'
  });

  assert.equal(await coordinator.stop({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }), true);
  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'Уже готово' && message.status === 'interrupted'
  ));
  assert.equal(store.thread.active_turn_id, null);
});

test('stop waits for a terminal notification delivered just after interrupt response', async () => {
  let broker;
  broker = new FakeBroker({
    onInterrupt: () => {
      broker.notify('item/agentMessage/delta', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        itemId: 'late-assistant', delta: 'Поздняя часть'
      });
      broker.notify('item/completed', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        item: { type: 'agentMessage', id: 'late-assistant', text: 'Поздняя часть' }
      });
      broker.notify('turn/completed', {
        threadId: 'internal-thread-secret',
        turn: { id: 'internal-turn-secret', status: 'interrupted' }
      });
    }
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 10_000 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'late-stop-run', messages: [{ id: 'late-stop-message', role: 'user', content: 'Стоп' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));

  assert.equal(await coordinator.stop({
    store, userId: 'user-a', publicThreadId: 'public-thread'
  }), true);
  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'Поздняя часть' && message.status === 'interrupted'
  ));
});

test('timeout keeps failed status when interrupt emits a late item completion', async () => {
  let broker;
  broker = new FakeBroker({
    onInterrupt: () => {
      broker.notify('item/agentMessage/delta', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        itemId: 'timeout-assistant', delta: 'До таймаута'
      });
      broker.notify('item/completed', {
        threadId: 'internal-thread-secret', turnId: 'internal-turn-secret',
        item: { type: 'agentMessage', id: 'timeout-assistant', text: 'До таймаута' }
      });
      broker.notify('turn/completed', {
        threadId: 'internal-thread-secret',
        turn: { id: 'internal-turn-secret', status: 'interrupted' }
      });
    }
  });
  const store = fakeStore();
  const coordinator = new BraiChatTurnCoordinator({ broker, turnTimeoutMs: 5 });
  coordinator.run({
    store, userId: 'user-a', publicThreadId: 'public-thread',
    input: { runId: 'timeout-run', messages: [{ id: 'timeout-message', role: 'user', content: 'Долго' }] }
  }).subscribe(() => {});
  await waitFor(() => broker.requests.some((request) => request.method === 'startTurn'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.thread.active_turn_id, null);

  assert.ok(store.messages.some((message) =>
    message.role === 'assistant' && message.content === 'До таймаута' && message.status === 'failed'
  ));
  assert.ok(store.events.some((event) => event.type === EventType.RUN_ERROR));
});

test('model discovery follows pagination and exposes the upstream default', async () => {
  const broker = new FakeBroker({
    modelPages: [
      { data: [{ id: 'model-a', displayName: 'A', isDefault: false }], nextCursor: 'p1' },
      { data: [{ id: 'model-b', displayName: 'B', isDefault: true }], nextCursor: null }
    ]
  });
  const runtime = createBraiChatRuntime({ broker });
  const result = await runtime.listModels({ userId: 'user-a' });
  assert.deepEqual(result.models.map((model) => model.id), ['model-a', 'model-b']);
  assert.equal(result.default_model, 'model-b');
  assert.deepEqual(broker.requests.filter((request) => request.method === 'listModels').map((request) => request.params), [
    { userId: 'user-a', limit: 100 },
    { userId: 'user-a', limit: 100, cursor: 'p1' }
  ]);
});

test('model discovery exposes only a stable safe upstream error', async () => {
  const runtime = createBraiChatRuntime({
    broker: new FakeBroker({
      modelError: new Error('connect /run/private-broker.sock Authorization: top-secret-value')
    })
  });
  await assert.rejects(runtime.listModels({ userId: 'user-a' }), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'upstream_auth');
    assert.equal(error.message, 'upstream_auth');
    assert.equal(JSON.stringify(error).includes('private-broker.sock'), false);
    assert.equal(JSON.stringify(error).includes('top-secret-value'), false);
    return true;
  });
});

test('self-hosted CopilotKit single endpoint advertises only the Brai agent', async () => {
  const runtime = createBraiChatRuntime({ broker: new FakeBroker() });
  const chunks = [];
  let jsonLimit = null;
  const res = {
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end() { this.ended = true; }
  };
  await runtime.handleRequest({
    req: { headers: { accept: 'application/json' } },
    res,
    url: new URL('https://api.example.test/v1/brai-chat/runtime'),
    store: fakeStore(),
    userId: 'user-a-long-enough',
    readJson: async (_req, options) => { jsonLimit = options.limit; return { method: 'info' }; },
    sendJson: () => assert.fail('CopilotKit handler should own a valid info response')
  });

  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(res.status, 200);
  assert.equal(jsonLimit, 2 * 1024 * 1024);
  assert.ok(JSON.stringify(body).includes('brai-codex'));
  assert.equal(process.env.COPILOTKIT_TELEMETRY_DISABLED, 'true');
});

test('CopilotKit resume connect forwards an acknowledged Last-Event-ID into durable replay', async () => {
  const runtime = createBraiChatRuntime({ broker: new FakeBroker() });
  const store = fakeStore();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    store.events.push({
      id: `cursor-event-${sequence}`,
      safePayload: { type: EventType.CUSTOM, name: 'cursor', value: { sequence } }
    });
  }
  const chunks = [];
  const res = {
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end() { this.ended = true; }
  };
  await runtime.handleRequest({
    req: {
      headers: {
        accept: 'text/event-stream',
        'last-event-id': '2',
        'x-brai-chat-replay-mode': 'resume'
      }
    },
    res,
    url: new URL('https://api.example.test/v1/brai-chat/runtime'),
    store,
    userId: 'user-a-long-enough',
    readJson: async () => ({
      method: 'agent/connect',
      params: { agentId: 'brai-codex' },
      body: {
        threadId: 'public-thread', runId: 'connect-run', state: {}, messages: [],
        tools: [], context: [], forwardedProps: {}
      }
    }),
    sendJson: () => assert.fail('CopilotKit handler should own a valid connect response')
  });

  const body = Buffer.concat(chunks).toString('utf8');
  assert.equal(res.status, 200);
  assert.deepEqual(store.replayCalls, [{ after: 2, limit: 500 }]);
  assert.equal(body.includes('"sequence":1'), false);
  assert.equal(body.includes('"sequence":2'), false);
  assert.equal(body.includes('"sequence":3'), true);
});

test('CopilotKit replay scopes durable public thread ids to the connected runtime thread', async () => {
  const runtime = createBraiChatRuntime({ broker: new FakeBroker() });
  const store = fakeStore();
  store.events.push({
    id: 'scoped-replay-start',
    turnId: 'scoped-replay-run',
    safePayload: {
      type: EventType.RUN_STARTED,
      threadId: 'public-thread',
      runId: 'scoped-replay-run',
      input: { threadId: 'public-thread', runId: 'scoped-replay-run', messages: [] }
    }
  });
  const chunks = [];
  const res = {
    destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    end() { this.ended = true; }
  };
  const userId = 'user-a-long-enough';
  const scopedThreadId = `${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 20)}:public-thread`;
  await runtime.handleRequest({
    req: { headers: { accept: 'text/event-stream' } },
    res,
    url: new URL('https://api.example.test/v1/brai-chat/runtime'),
    store,
    userId,
    readJson: async () => ({
      method: 'agent/connect',
      params: { agentId: 'brai-codex' },
      body: {
        threadId: 'public-thread', runId: 'connect-run', state: {}, messages: [],
        tools: [], context: [], forwardedProps: {}
      }
    }),
    sendJson: () => assert.fail('CopilotKit handler should own a valid connect response')
  });

  const body = Buffer.concat(chunks).toString('utf8');
  assert.equal(res.status, 200);
  assert.equal(body.includes(`\"threadId\":\"${scopedThreadId}\"`), true);
  assert.equal(body.includes('\"threadId\":\"public-thread\"'), false);
});

test('CopilotKit connect replays an incomplete active run without compacting it away', async () => {
  const runtime = createBraiChatRuntime({ broker: new FakeBroker() });
  const store = fakeStore();
  const turnId = 'active-connect-run';
  const records = [
    { type: EventType.RUN_STARTED, threadId: 'public-thread', runId: turnId },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'user-active', role: 'user' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'user-active', delta: 'Нарисуй весну' },
    { type: EventType.TEXT_MESSAGE_END, messageId: 'user-active' },
    { type: EventType.TEXT_MESSAGE_START, messageId: 'assistant-active', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'assistant-active', delta: 'Рисую изображение' },
    { type: EventType.TOOL_CALL_START, toolCallId: 'image-active', toolCallName: 'image_generation' }
  ];
  for (const [index, safePayload] of records.entries()) {
    store.events.push({
      id: `active-event-${index + 1}`,
      turnId,
      safePayload
    });
  }
  const chunks = [];
  let flushHeadersCalls = 0;
  let flushCalls = 0;
  let noDelayCalls = 0;
  const res = {
    destroyed: false,
    socket: { setNoDelay(value) { assert.equal(value, true); noDelayCalls += 1; } },
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    flushHeaders() { flushHeadersCalls += 1; },
    write(chunk) { chunks.push(Buffer.from(chunk)); },
    flush() { flushCalls += 1; },
    end() { this.ended = true; }
  };
  await runtime.handleRequest({
    req: { headers: { accept: 'text/event-stream', 'last-event-id': '5' } },
    res,
    url: new URL('https://api.example.test/v1/brai-chat/runtime'),
    store,
    userId: 'user-a-long-enough',
    readJson: async () => ({
      method: 'agent/connect',
      params: { agentId: 'brai-codex' },
      body: {
        threadId: 'public-thread', runId: 'connect-active-run', state: {}, messages: [],
        tools: [], context: [], forwardedProps: {}
      }
    }),
    sendJson: () => assert.fail('CopilotKit handler should own a valid connect response')
  });

  const body = Buffer.concat(chunks).toString('utf8');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], 'identity');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(flushHeadersCalls, 1);
  assert.ok(flushCalls > 0);
  assert.equal(noDelayCalls, 1);
  assert.equal(body.includes('Рисую изображение'), true);
  assert.equal(body.includes('image_generation'), true);
});
