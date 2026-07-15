import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { EventType } from '@ag-ui/core';
import { BraiChatTurnCoordinator, createBraiChatRuntime } from '../src/brai-chat-runtime.js';

class FakeBroker extends EventEmitter {
  constructor({
    readThread = null, modelPages = null, modelError = null, startTurnError = null,
    steerTurn = null, steerTurnError = null, onInterrupt = null
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
  const messageAttachments = new Map();
  return {
    events,
    messages,
    messageAttachments,
    thread: {
      id: 'public-thread',
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
    linkBraiChatAttachments({ attachmentIds }) {
      return attachmentIds.map((id) => ({ id }));
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
    store, userId: 'user-a', publicThreadId: 'public-thread', headers: { 'last-event-id': '500' }
  }).subscribe({ next: (event) => replayed.push(event.value.sequence), error: reject, complete: resolve }));

  assert.equal(replayed.length, 605);
  assert.equal(replayed[0], 501);
  assert.equal(replayed.at(-1), 1_105);
  assert.deepEqual(store.replayCalls, [{ after: 500, limit: 500 }, { after: 1_000, limit: 500 }]);
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

test('CopilotKit connect forwards Last-Event-ID into durable replay', async () => {
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
    req: { headers: { accept: 'text/event-stream', 'last-event-id': '2' } },
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
