import crypto from 'node:crypto';
import { AbstractAgent, compactEvents, EventType } from '@ag-ui/client';
import { Observable, Subject, map } from 'rxjs';
import { BraiCodexBrokerClient } from './brai-codex-broker-client.js';
import { assistantMessageIdForRun, CodexAguiNormalizer } from './brai-codex-agui.js';
import {
  BRAI_CHAT_OUTPUT_LIMIT_BYTES, sanitizeBraiChatText, safeBraiChatError
} from './brai-chat-sanitize.js';
import { withUserScope } from './user-scope.js';

process.env.COPILOTKIT_TELEMETRY_DISABLED = 'true';

const AGENT_ID = 'brai-codex';
const AGENT_VERSION = '1';
const TITLE_AGENT_ID = 'brai.chat-title';
const TITLE_AGENT_VERSION = '1';
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_RUNTIME_BODY_BYTES = 2 * 1024 * 1024;
const REPLAY_PAGE_SIZE = 500;
const TERMINAL_GRACE_MS = 50;
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ALLOWED_RUNTIME_METHODS = new Set(['info', 'agent/connect', 'agent/run', 'agent/stop']);

function scopedThreadId(userId, publicThreadId) {
  const owner = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 20);
  return `${owner}:${publicThreadId}`;
}

/**
 * The durable store intentionally contains only the public thread id. CopilotKit,
 * however, receives the owner-scoped id from the request rewrite. Keep that
 * boundary explicit when replaying or streaming AG-UI events; otherwise its
 * client discards a valid replay as belonging to another thread.
 */
function eventForRuntimeThread(event, runtimeThreadId) {
  if (!event || typeof event !== 'object') return event;
  let next = event;
  if (typeof event.threadId === 'string' && event.threadId !== runtimeThreadId) {
    next = { ...next, threadId: runtimeThreadId };
  }
  if (event.input && typeof event.input === 'object'
    && typeof event.input.threadId === 'string'
    && event.input.threadId !== runtimeThreadId) {
    next = { ...next, input: { ...event.input, threadId: runtimeThreadId } };
  }
  return next;
}

function lastUserInput(input, runId) {
  const message = [...(input?.messages || [])].reverse().find((item) => item?.role === 'user');
  if (!message) return null;
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  const text = parts.map((part) => {
    if (typeof part === 'string') return part;
    return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();
  const attachmentIds = parts.flatMap((part) => {
    const id = part && typeof part === 'object' ? part.metadata?.attachment_id : null;
    return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? [id] : [];
  });
  return {
    id: PUBLIC_ID.test(message.id || '') ? message.id : stablePublicId('message', runId, text),
    text: sanitizeBraiChatText(text),
    attachmentIds: [...new Set(attachmentIds)].slice(0, 6)
  };
}

function stablePublicId(kind, ...parts) {
  return `${kind}:${crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`;
}

function brokerMessageId(...parts) {
  return `m_${crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40)}`;
}

function idempotencyKey(kind, ...parts) {
  return `chat:${kind}:${crypto.createHash('sha256').update(parts.join('\0')).digest('hex')}`;
}

function titleLlmCallId(state) {
  return `brai-chat-title:${crypto.createHash('sha256')
    .update(`${state.userId}\0${state.publicThreadId}\0${state.runId}`)
    .digest('hex')}`;
}

function chatLlmCallId(state) {
  return `brai-chat:${crypto.createHash('sha256')
    .update(`${state.userId}\0${state.publicThreadId}\0${state.runId}`)
    .digest('hex')}`;
}

function hasAssistantText(state) {
  return [...state.messageText.entries()].some(([messageId, text]) =>
    state.messageRoles.get(messageId) !== 'user' && text.trim());
}

function observableError(message) {
  return new Observable((subscriber) => subscriber.error(new Error(message)));
}

function runtimeError(code, status) {
  return Object.assign(new Error(code), { status });
}

function publicRuntimeError(error) {
  if (Number.isInteger(error?.status) && /^[a-z0-9_]{1,80}$/.test(error?.message ?? '')) {
    return error;
  }
  const safe = safeBraiChatError(error);
  return Object.assign(new Error(safe.code), { code: safe.code, status: 503 });
}

function publicEvents(subject, onFirstSubscribe) {
  let started = false;
  return new Observable((subscriber) => {
    const subscription = subject.subscribe({
      next: (record) => subscriber.next(record.event),
      error: (error) => subscriber.error(publicRuntimeError(error)),
      complete: () => subscriber.complete()
    });
    if (!started) {
      started = true;
      onFirstSubscribe();
    }
    return () => subscription.unsubscribe();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function replayAfter(headers = {}) {
  const mode = headers['x-brai-chat-replay-mode'] ?? headers['X-Brai-Chat-Replay-Mode'];
  if (mode !== 'resume') return 0;
  const raw = headers['last-event-id'] ?? headers['Last-Event-ID']
    ?? headers['x-brai-chat-after'] ?? headers['X-Brai-Chat-After'] ?? '0';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function turnStatus(value) {
  return value === 'interrupted' ? 'interrupted' : value === 'failed' ? 'failed' : 'completed';
}

function isTerminalTurn(turn) {
  return turn?.status === 'completed' || turn?.status === 'interrupted' || turn?.status === 'failed';
}

function turnHasClientMessage(turn, clientUserMessageId) {
  return Boolean(turn?.items?.some((item) =>
    item?.type === 'userMessage' && item.clientId === clientUserMessageId));
}

function isTerminalItem(item) {
  return !['inProgress', 'in_progress', 'running', 'pending'].includes(item?.status);
}

function eventSource(event) {
  return event.messageId || event.toolCallId || event.value?.source_event_id || null;
}

function readyGeneratedAttachmentIds(events) {
  return [...new Set((events || []).flatMap((event) =>
    event?.type === EventType.CUSTOM
      && event.name === 'brai.artifact.v1'
      && event.value?.kind === 'image'
      && event.value?.status === 'ready'
      && PUBLIC_ID.test(event.value?.attachment_id || '')
      ? [event.value.attachment_id] : []))].slice(0, 1_000);
}

function eventStream(event) {
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    return { key: `text:${event.messageId}`, chunk: event.delta || '' };
  }
  if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
    return { key: `reasoning:${event.messageId}`, chunk: event.delta || '' };
  }
  if (event.type === EventType.TOOL_CALL_ARGS) {
    return { key: `tool-args:${event.toolCallId}`, chunk: event.delta || '' };
  }
  if (event.type === EventType.CUSTOM && typeof event.value?.delta === 'string') {
    const source = event.value.source_event_id ?? event.value.item_id ?? 'run';
    const index = Number.isSafeInteger(event.value.index) ? event.value.index : 0;
    return { key: `custom:${event.name}:${source}:${index}`, chunk: event.value.delta };
  }
  return null;
}

function stableEventIdentity(state, event, source = {}) {
  if (source.stableId) return `${source.stableId}:${source.index ?? 0}`;
  const stream = eventStream(event);
  const offset = stream ? state.streamOffsets.get(stream.key) || 0 : 0;
  const kind = [event.type, event.name, event.value?.kind, event.value?.status,
    event.value?.message_id, event.outcome?.type].filter(Boolean).join(':');
  return `${eventSource(event) ?? state.runId}\0${kind}\0${offset}`;
}

function validTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function notificationDeltaKey(method, params = {}) {
  if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
    return `${method}:${params.itemId ?? ''}`;
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    return `${method}:${params.itemId ?? ''}:${Number.isSafeInteger(params.summaryIndex) ? params.summaryIndex : 0}`;
  }
  return null;
}

function searchableEventText(event) {
  const values = [];
  const visit = (value, key = '') => {
    if (typeof value === 'string' && !/(?:^|_)(?:id|run_id|thread_id)$/.test(key)) values.push(value);
    else if (Array.isArray(value)) value.slice(0, 100).forEach((item) => visit(item, key));
    else if (value && typeof value === 'object') {
      Object.entries(value).slice(0, 100).forEach(([childKey, item]) => visit(item, childKey));
    }
  };
  visit(event);
  return sanitizeBraiChatText(values.join('\n'));
}

function publicInput(input, publicThreadId, userMessage) {
  return {
    threadId: publicThreadId,
    runId: input.runId,
    state: {},
    messages: [{ id: userMessage.id, role: 'user', content: userMessage.text }],
    tools: [],
    context: [],
    forwardedProps: {}
  };
}

function normalizeGeneratedTitle(value) {
  const title = sanitizeBraiChatText(value, { maxBytes: 160 })
    .replace(/^[#>*_\-\s]+/u, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["«„]|["»“]$/g, '')
    .trim()
    .slice(0, 80)
    .trim();
  return title && title !== 'Новый чат' ? title : null;
}

class BraiCodexAgent extends AbstractAgent {
  constructor({ coordinator, store, userId, publicThreadId, runtimeThreadId }) {
    super({ agentId: AGENT_ID, description: 'Брай на базе Codex' });
    this.coordinator = coordinator;
    this.store = store;
    this.userId = userId;
    this.publicThreadId = publicThreadId;
    this.runtimeThreadId = runtimeThreadId;
  }

  run(input) {
    return this.coordinator.run({ store: this.store, userId: this.userId, publicThreadId: this.publicThreadId, input })
      .pipe(map((event) => eventForRuntimeThread(event, this.runtimeThreadId)));
  }

  abortRun() {
    void this.coordinator.stop({
      store: this.store, userId: this.userId, publicThreadId: this.publicThreadId
    }).catch(() => undefined);
  }

  clone() {
    const clone = new BraiCodexAgent({
      coordinator: this.coordinator,
      store: this.store,
      userId: this.userId,
      publicThreadId: this.publicThreadId,
      runtimeThreadId: this.runtimeThreadId
    });
    clone.messages = structuredClone(this.messages);
    clone.state = structuredClone(this.state);
    return clone;
  }
}

class BraiPersistentAgentRunner {
  constructor({ coordinator, store, userId, publicThreadId, runtimeThreadId }) {
    this.coordinator = coordinator;
    this.store = store;
    this.userId = userId;
    this.publicThreadId = publicThreadId;
    this.runtimeThreadId = runtimeThreadId;
  }

  run({ agent, input }) {
    return agent.run(input);
  }

  connect({ headers } = {}) {
    return this.coordinator.connect({
      store: this.store, userId: this.userId, publicThreadId: this.publicThreadId, headers
    }).pipe(map((event) => eventForRuntimeThread(event, this.runtimeThreadId)));
  }

  isRunning() {
    return this.coordinator.isRunning({
      store: this.store, userId: this.userId, publicThreadId: this.publicThreadId
    }).catch((error) => { throw publicRuntimeError(error); });
  }

  stop() {
    return this.coordinator.stop({
      store: this.store, userId: this.userId, publicThreadId: this.publicThreadId
    }).catch((error) => { throw publicRuntimeError(error); });
  }
}

export class BraiChatTurnCoordinator {
  constructor({
    broker = new BraiCodexBrokerClient(),
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    titleGenerator = null
  } = {}) {
    this.broker = broker;
    this.turnTimeoutMs = turnTimeoutMs;
    this.titleGenerator = titleGenerator;
    this.active = new Map();
    this.recovering = new Map();
    this.disconnectRecoveries = new Map();
    this.broker.on?.('disconnect', () => this.#recoverDisconnected());
  }

  run({ store, userId, publicThreadId, input }) {
    if (!RUN_ID.test(input?.runId || '')) return observableError('Invalid run id');
    const key = `${userId}\0${publicThreadId}`;
    const current = this.active.get(key);
    if (current && !current.done) return observableError('Thread already running');
    const persisted = withUserScope(userId, () => store.getBraiChatThreadRuntime(publicThreadId));
    if (persisted?.active_turn_id) return observableError('Thread already running');

    const subject = new Subject();
    const state = this.#createState({
      key, store, userId, publicThreadId, runId: input.runId, input, subject
    });
    this.active.set(key, state);
    return publicEvents(subject,
      () => queueMicrotask(() => this.#launch(state).catch(() => undefined)));
  }

  async steer({ store, userId, publicThreadId, messageId, text }) {
    if (!PUBLIC_ID.test(messageId || '')) throw runtimeError('invalid_message_id', 400);
    const input = typeof text === 'string' ? text.trim() : '';
    if (!input || Buffer.byteLength(input, 'utf8') > BRAI_CHAT_OUTPUT_LIMIT_BYTES) {
      throw runtimeError('invalid_message_text', 400);
    }
    const content = sanitizeBraiChatText(input);
    const state = await this.#reconcileActive({ store, userId, publicThreadId });
    if (!state || state.done || !state.internalThreadId || !state.internalTurnId) {
      throw runtimeError('chat_turn_not_active', 409);
    }

    const steering = state.queue.then(async () => {
      if (state.done || !state.internalTurnId) throw runtimeError('chat_turn_not_active', 409);
      const existing = withUserScope(userId, () => store.getBraiChatMessage(publicThreadId, messageId));
      if (existing && (existing.turn_id ?? existing.turnId) !== state.runId) {
        throw runtimeError('message_id_conflict', 409);
      }
      const saved = withUserScope(userId, () => store.putBraiChatMessage({
        id: messageId,
        threadId: publicThreadId,
        turnId: state.runId,
        idempotencyKey: idempotencyKey('steer', state.runId, messageId),
        role: 'user',
        content,
        status: 'completed',
        dispatchStatus: 'pending',
        model: state.effectiveModel,
        reasoningEffort: state.effectiveReasoningEffort
      }));
      if (!saved) throw runtimeError('not_found', 404);
      if (existing?.dispatch_status === 'delivered') return true;
      withUserScope(userId, () => store.updateBraiChatMessage(messageId, {
        dispatch_status: 'pending'
      }));

      try {
        await this.#publishAll(state, [
          { type: EventType.TEXT_MESSAGE_START, messageId, role: 'user' },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content },
          { type: EventType.TEXT_MESSAGE_END, messageId }
        ], { stableId: `steer:${messageId}` });
        await this.broker.request('steerTurn', {
          userId,
          threadId: state.internalThreadId,
          turnId: state.internalTurnId,
          text: content,
          clientUserMessageId: brokerMessageId('steer', state.runId, messageId),
          attachments: []
        });
        withUserScope(userId, () => store.updateBraiChatMessage(messageId, {
          dispatch_status: 'delivered'
        }));
        return true;
      } catch (error) {
        const safe = safeBraiChatError(error);
        try {
          withUserScope(userId, () => store.updateBraiChatMessage(messageId, {
            dispatch_status: 'failed'
          }));
          await this.#publish(state, {
            type: EventType.CUSTOM,
            name: 'brai.message_status.v1',
            value: { message_id: messageId, status: 'failed', code: safe.code, message: safe.message }
          }, { stableId: `steer-status:${messageId}` });
        } catch {
          // The original active turn remains authoritative if failure projection also fails.
        }
        throw runtimeError(safe.code, 503);
      }
    });
    state.queue = steering.catch(() => undefined);
    return await steering;
  }

  connect({ store, userId, publicThreadId, headers = {} }) {
    return new Observable((subscriber) => {
      let liveSubscription = null;
      let cancelled = false;
      void (async () => {
        const state = await this.#reconcileActive({ store, userId, publicThreadId, refresh: true });
        if (cancelled) return;
        let buffering = Boolean(state && !state.done);
        let liveTerminal = null;
        const buffered = [];
        const requestedAfter = replayAfter(headers);
        let lastSequence = requestedAfter;
        if (buffering) {
          liveSubscription = state.subject.subscribe({
            next: (record) => {
              if (buffering) buffered.push(record);
              else if (record.sequence > lastSequence) {
                lastSequence = record.sequence;
                subscriber.next(record.event);
              }
            },
            error: (error) => {
              if (buffering) liveTerminal = { error };
              else subscriber.error(publicRuntimeError(error));
            },
            complete: () => {
              if (buffering) liveTerminal = { complete: true };
              else subscriber.complete();
            }
          });
        }
        const replay = withUserScope(userId, () => this.#replayForConnect(
          store, publicThreadId, requestedAfter, (event) => subscriber.next(event)
        ));
        if (!replay.found) return subscriber.complete();
        void this.#cleanupDurableGeneratedArtifacts({ store, userId, publicThreadId });
        lastSequence = replay.lastSequence;
        buffering = false;
        for (const record of buffered) {
          if (record.sequence <= lastSequence) continue;
          lastSequence = record.sequence;
          subscriber.next(record.event);
        }
        if (liveTerminal?.error) subscriber.error(publicRuntimeError(liveTerminal.error));
        else if (liveTerminal?.complete || !state || state.done) subscriber.complete();
      })().catch((error) => subscriber.error(publicRuntimeError(error)));
      return () => {
        cancelled = true;
        liveSubscription?.unsubscribe();
      };
    });
  }

  async isRunning({ store, userId, publicThreadId }) {
    const state = await this.#reconcileActive({ store, userId, publicThreadId });
    return Boolean(state && !state.done);
  }

  async stop({ store, userId, publicThreadId }) {
    const state = await this.#reconcileActive({ store, userId, publicThreadId });
    if (!state || state.done) return false;
    if (!state.internalTurnId) {
      state.stopRequested = true;
      await state.turnReady;
    }
    if (state.done || !state.internalTurnId) return false;
    await this.broker.request('interruptTurn', {
      userId,
      threadId: state.internalThreadId,
      turnId: state.internalTurnId
    });
    await delay(TERMINAL_GRACE_MS);
    await state.queue;
    if (!state.done) {
      try {
        await this.#reconcileActive({ store, userId, publicThreadId, refresh: true });
      } catch {
        // A safe synthetic interrupted terminal remains available below.
      }
    }
    if (!state.done) await this.#finish(state, { status: 'interrupted' });
    return true;
  }

  #createState({
    key, store, userId, publicThreadId, runId, input = null, subject = new Subject(),
    internalThreadId = null, internalTurnId = null, userMessageId = null,
    startedAtUtc = null, deadlineAtUtc = null, effectiveModel = null,
    effectiveReasoningEffort = null
  }) {
    let resolveTurnReady;
    const turnReady = new Promise((resolve) => { resolveTurnReady = resolve; });
    const startedAt = validTimestamp(startedAtUtc) ?? Date.now();
    const deadline = validTimestamp(deadlineAtUtc) ?? startedAt + this.turnTimeoutMs;
    return {
      key, store, userId, publicThreadId, runId, input, subject,
      done: false, normalizer: null, streamOffsets: new Map(), messageText: new Map(),
      messageRoles: new Map(), assistantMessageIds: new Set(),
      userMessageText: null, hasAssistantOutput: false,
      internalThreadId, internalTurnId, userMessageId, brokerSubscriptionId: null,
      unsubscribeBroker: null, timeout: null, queue: Promise.resolve(),
      reconciling: false, pendingNotifications: [], terminalStatus: null,
      stopRequested: false, timeoutTriggered: false, turnReady, resolveTurnReady,
      startedAtUtc: new Date(startedAt).toISOString(),
      deadlineAtUtc: new Date(deadline).toISOString(), deadline,
      effectiveModel, effectiveReasoningEffort, brokerWatermark: 0,
      brokerEpoch: null, lastNotificationSequence: 0,
      snapshotCoverage: new Map(), titleGenerationAttempted: false,
      generatedImageReady: false
    };
  }

  async #launch(state) {
    try {
      const userMessage = lastUserInput(state.input, state.runId);
      if (!userMessage?.text) throw new Error('empty_message');
      if (userMessage.attachmentIds.length > 5) throw new Error('too_many_attachments');
      state.userMessageId = brokerMessageId(state.runId, userMessage.id);
      state.userMessageText = userMessage.text;

      const thread = withUserScope(state.userId, () => state.store.getBraiChatThreadRuntime(state.publicThreadId));
      if (!thread || thread.archived_at_utc) throw new Error('thread_not_found');
      state.effectiveModel = thread.model;
      state.effectiveReasoningEffort = thread.reasoning_effort;

      const persistedUserMessage = withUserScope(state.userId, () =>
        state.store.putBraiChatUserMessageWithAttachments({
          message: {
            id: userMessage.id,
            threadId: state.publicThreadId,
            turnId: state.runId,
            idempotencyKey: idempotencyKey('user', state.runId, userMessage.id),
            role: 'user',
            content: userMessage.text,
            status: 'completed',
            model: thread.model,
            reasoningEffort: thread.reasoning_effort
          },
          attachmentIds: userMessage.attachmentIds
        }));
      if (!persistedUserMessage) throw new Error('message_persistence_failed');
      const effectiveAttachmentIds = Array.isArray(persistedUserMessage.attachmentIds)
        ? persistedUserMessage.attachmentIds : [];

      state.normalizer = new CodexAguiNormalizer({
        publicThreadId: state.publicThreadId,
        runId: state.runId,
        input: publicInput(state.input, state.publicThreadId, userMessage)
      });
      await this.#publishAll(state, state.normalizer.translate('turn/started', {}));
      const attachments = effectiveAttachmentIds.map((id) => ({
        id, threadId: state.publicThreadId
      }));

      if (thread.codex_thread_id) {
        await this.broker.request('resumeThread', {
          userId: state.userId, threadId: thread.codex_thread_id, attachments
        });
        state.internalThreadId = thread.codex_thread_id;
      } else {
        const created = await this.broker.request('startThread', {
          userId: state.userId,
          model: thread.model,
          reasoningEffort: thread.reasoning_effort,
          attachments
        });
        state.internalThreadId = created?.threadId;
        if (!state.internalThreadId) throw new Error('thread_start_failed');
        withUserScope(state.userId, () => state.store.setBraiChatCodexThreadId(state.publicThreadId, state.internalThreadId));
      }

      await this.#subscribeState(state);
      this.#persistActive(state);
      let started;
      try {
        started = await this.broker.request('startTurn', {
          userId: state.userId,
          threadId: state.internalThreadId,
          text: userMessage.text,
          model: thread.model,
          reasoningEffort: thread.reasoning_effort,
          clientUserMessageId: state.userMessageId,
          attachments
        }, { timeoutMs: 30_000 });
      } catch (error) {
        let recovered;
        try {
          recovered = await this.#readActiveTurn(state);
        } catch {
          this.#suspendForReconciliation(state, error);
          return;
        }
        if (!recovered) {
          this.#suspendForReconciliation(state, error);
          return;
        }
        started = { turnId: recovered.id, recovered };
      }
      if (state.done) return;
      state.internalTurnId = started?.turnId;
      if (!state.internalTurnId) throw new Error('turn_start_failed');
      this.#persistActive(state);
      state.resolveTurnReady();
      if (started.recovered) await this.#reconcileTurn(state, started.recovered);
      if (state.done) return;
      if (state.stopRequested) {
        await this.broker.request('interruptTurn', {
          userId: state.userId, threadId: state.internalThreadId, turnId: state.internalTurnId
        });
        await state.queue;
        if (!state.done) await this.#finish(state, { status: 'interrupted' });
        return;
      }
      this.#armTimeout(state);
    } catch (error) {
      await this.#fail(state, error);
    }
  }

  #persistActive(state) {
    withUserScope(state.userId, () => state.store.setBraiChatActiveTurn(state.publicThreadId, {
      runId: state.runId,
      codexTurnId: state.internalTurnId,
      userMessageId: state.userMessageId,
      startedAtUtc: state.startedAtUtc,
      deadlineAtUtc: state.deadlineAtUtc,
      model: state.effectiveModel,
      reasoningEffort: state.effectiveReasoningEffort
    }));
  }

  #armTimeout(state) {
    if (state.timeout || state.done) return;
    state.timeout = setTimeout(() => void this.#timeout(state), Math.max(0, state.deadline - Date.now()));
    state.timeout.unref?.();
  }

  #acceptBrokerWatermark(state, response) {
    if (!Number.isSafeInteger(response?.notificationWatermark)) return;
    const epoch = typeof response.notificationEpoch === 'string' ? response.notificationEpoch : null;
    if (epoch && epoch !== state.brokerEpoch) {
      state.brokerEpoch = epoch;
      state.lastNotificationSequence = response.notificationWatermark;
    } else {
      state.lastNotificationSequence = Math.max(
        state.lastNotificationSequence, response.notificationWatermark
      );
    }
    state.brokerWatermark = response.notificationWatermark;
  }

  async #subscribeState(state) {
    if (!state.unsubscribeBroker) {
      state.unsubscribeBroker = this.broker.subscribe({
        userId: state.userId, threadId: state.internalThreadId
      }, (method, params, metadata = {}) => {
        const notification = [
          method, params, metadata.notificationSequence, metadata.notificationEpoch
        ];
        if (state.reconciling) state.pendingNotifications.push(notification);
        else this.#enqueueNotification(state, ...notification);
      });
    }
    const previous = state.brokerSubscriptionId;
    const subscribed = await this.broker.request('subscribe', {
      userId: state.userId, threadId: state.internalThreadId
    });
    state.brokerSubscriptionId = subscribed?.subscriptionId ?? null;
    this.#acceptBrokerWatermark(state, subscribed);
    if (previous && previous !== state.brokerSubscriptionId) {
      void this.broker.request('unsubscribe', { subscriptionId: previous }).catch(() => undefined);
    }
  }

  #recoverDisconnected() {
    for (const state of this.active.values()) {
      if (state.done || this.disconnectRecoveries.has(state.key)) continue;
      const recovery = (async () => {
        let attempt = 0;
        while (!state.done && Date.now() < state.deadline) {
          try {
            await this.#reconcileActive({
              store: state.store,
              userId: state.userId,
              publicThreadId: state.publicThreadId,
              refresh: true
            });
            return;
          } catch {
            attempt += 1;
            await delay(Math.min(250 * (2 ** Math.min(attempt, 3)), 2_000));
          }
        }
      })().finally(() => this.disconnectRecoveries.delete(state.key));
      this.disconnectRecoveries.set(state.key, recovery);
    }
  }

  async #reconcileActive({ store, userId, publicThreadId, refresh = false }) {
    const key = `${userId}\0${publicThreadId}`;
    if (this.recovering.has(key)) return await this.recovering.get(key);
    const current = this.active.get(key);
    if (!refresh && current && !current.done) return current;
    const recovery = (async () => {
      let state = current;
      const thread = withUserScope(userId, () => store.getBraiChatThreadRuntime(publicThreadId));
      if (!thread?.active_turn_id) return state && !state.done ? state : null;
      const created = !state || state.done;
      if (created) {
        if (!RUN_ID.test(thread.active_turn_id)) throw new Error('Invalid persisted run id');
        state = this.#createState({
          key, store, userId, publicThreadId, runId: thread.active_turn_id,
          internalThreadId: thread.codex_thread_id,
          internalTurnId: thread.active_codex_turn_id,
          userMessageId: thread.active_user_message_id,
          startedAtUtc: thread.active_turn_started_at_utc ?? thread.updated_at_utc,
          deadlineAtUtc: thread.active_turn_deadline_at_utc,
          effectiveModel: thread.active_turn_model ?? thread.model,
          effectiveReasoningEffort: thread.active_turn_reasoning_effort ?? thread.reasoning_effort
        });
        state.normalizer = new CodexAguiNormalizer({
          publicThreadId, runId: state.runId, started: true
        });
        this.active.set(key, state);
      }
      if (!state.internalThreadId) {
        await this.#fail(state, new Error('thread reconciliation failed'));
        return null;
      }
      state.reconciling = true;
      try {
        await this.#subscribeState(state);
        const turn = await this.#readActiveTurn(state);
        if (state.done) return null;
        if (!turn) {
          if (!created) throw new Error('turn reconciliation failed');
          await this.#fail(state, new Error('turn reconciliation failed'));
          return null;
        }
        state.internalTurnId = turn.id;
        this.#persistActive(state);
        state.resolveTurnReady();
        await this.#reconcileTurn(state, turn);
        this.#armTimeout(state);
        return state.done ? null : state;
      } catch (error) {
        if (!created) throw error;
        state.done = true;
        state.resolveTurnReady();
        state.unsubscribeBroker?.();
        state.subject.error(publicRuntimeError(error));
        this.active.delete(key);
        throw error;
      } finally {
        state.reconciling = false;
        const pending = state.pendingNotifications.splice(0);
        for (const [method, params, sequence, epoch] of pending) {
          if ((!epoch || epoch === state.brokerEpoch)
            && Number.isSafeInteger(sequence) && sequence <= state.brokerWatermark) continue;
          this.#enqueueNotification(state, method, params, sequence, epoch);
        }
        state.snapshotCoverage.clear();
      }
    })().finally(() => this.recovering.delete(key));
    this.recovering.set(key, recovery);
    return await recovery;
  }

  async #readActiveTurn(state) {
    const response = await this.broker.request('readThread', {
      userId: state.userId, threadId: state.internalThreadId, includeTurns: true
    });
    this.#acceptBrokerWatermark(state, response);
    const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
    return turns.find((turn) => turn.id === state.internalTurnId)
      ?? turns.find((turn) => turn.items?.some((item) =>
        item.type === 'userMessage' && item.clientId === state.userMessageId
      ))
      ?? [...turns].reverse().find((turn) => turn.status === 'inProgress')
      ?? null;
  }

  #suspendForReconciliation(state, error) {
    if (state.done) return;
    state.done = true;
    state.resolveTurnReady();
    state.unsubscribeBroker?.();
    if (state.brokerSubscriptionId) {
      void this.broker.request('unsubscribe', {
        subscriptionId: state.brokerSubscriptionId
      }).catch(() => undefined);
    }
    state.subject.error(publicRuntimeError(error));
    this.active.delete(state.key);
  }

  async #reconcileTurn(state, turn) {
    const persisted = withUserScope(state.userId, () => this.#persistedTurnState(state));
    const matchedSnapshotMessages = new Set();
    state.streamOffsets = persisted.streamOffsets;
    state.messageText = new Map(persisted.messageText);
    state.messageRoles = new Map(persisted.messageRoles);
    state.userMessageText ??= persisted.userMessageText;
    state.hasAssistantOutput ||= persisted.hasAssistantOutput;
    state.generatedImageReady ||= persisted.generatedImageReady;
    state.assistantMessageIds = new Set(
      [...persisted.messageText.keys()].filter((id) => persisted.messageRoles.get(id) !== 'user')
    );
    if (isTerminalTurn(turn)) state.terminalStatus = turnStatus(turn.status);
    await this.#reconcileSteers(state, turn);
    for (const item of turn.items || []) {
      if (!item || item.type === 'userMessage' || item.type === 'hookPrompt') continue;
      if (item.type === 'agentMessage' && item.text) {
        const snapshotText = sanitizeBraiChatText(item.text);
        const match = [...persisted.messageText.entries()].find(([messageId, text]) =>
          text && persisted.messageRoles.get(messageId) !== 'user'
            && !matchedSnapshotMessages.has(messageId) && snapshotText.startsWith(text));
        if (match) {
          state.normalizer.bindSnapshotItemId(item.id, match[0]);
          matchedSnapshotMessages.add(match[0]);
        }
      }
      if (item.type === 'reasoning') {
        for (const [summaryIndex, delta] of (item.summary || []).entries()) {
          const method = 'item/reasoning/summaryTextDelta';
          const params = { itemId: item.id, summaryIndex, delta };
          const events = state.normalizer.translate(method, params);
          this.#rememberSnapshotCoverage(state, persisted, notificationDeltaKey(method, params), events);
          await this.#publishReconciled(state, persisted, events);
        }
        continue;
      }
      await this.#publishReconciled(state, persisted,
        state.normalizer.translate('item/started', { item }));
      if (item.type === 'agentMessage' && item.text) {
        const method = 'item/agentMessage/delta';
        const params = { itemId: item.id, delta: item.text };
        const events = state.normalizer.translate(method, params);
        this.#rememberSnapshotCoverage(state, persisted, notificationDeltaKey(method, params), events);
        await this.#publishReconciled(state, persisted, events);
      }
      if (item.type === 'commandExecution' && item.aggregatedOutput) {
        const method = 'item/commandExecution/outputDelta';
        const params = { itemId: item.id, delta: item.aggregatedOutput };
        const events = state.normalizer.translate(method, params);
        this.#rememberSnapshotCoverage(state, persisted, notificationDeltaKey(method, params), events);
        await this.#publishReconciled(state, persisted, events);
      }
      if (isTerminalTurn(turn) || (item.type !== 'agentMessage' && isTerminalItem(item))) {
        const params = { item, turnId: turn.id };
        const events = await this.#materializeGeneratedArtifact(
          state, params, state.normalizer.translate('item/completed', params)
        );
        if (readyGeneratedAttachmentIds(events).length) state.generatedImageReady = true;
        await this.#publishReconciled(state, persisted, events);
        void this.#cleanupDurableGeneratedArtifacts(
          state, readyGeneratedAttachmentIds(events)
        );
      }
    }
    if (isTerminalTurn(turn) && !state.done) {
      const fallback = state.generatedImageReady && !hasAssistantText(state)
        ? state.normalizer.assistantFallback('Изображение готово.') : [];
      await this.#publishReconciled(state, persisted, [
        ...fallback, ...state.normalizer.translate('turn/completed', { turn })
      ]);
      await this.#completeState(state);
    }
  }

  async #reconcileSteers(state, turn) {
    const messages = withUserScope(state.userId, () =>
      state.store.listBraiChatUndeliveredSteers(state.publicThreadId, state.runId));
    for (const message of messages) {
      await this.#publishAll(state, [
        { type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: 'user' },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: message.content },
        { type: EventType.TEXT_MESSAGE_END, messageId: message.id }
      ], { stableId: `steer:${message.id}` });
      const clientUserMessageId = brokerMessageId('steer', state.runId, message.id);
      if (turnHasClientMessage(turn, clientUserMessageId)) {
        withUserScope(state.userId, () => state.store.updateBraiChatMessage(message.id, {
          dispatch_status: 'delivered'
        }));
        continue;
      }
      if (isTerminalTurn(turn)) {
        withUserScope(state.userId, () => state.store.updateBraiChatMessage(message.id, {
          dispatch_status: 'failed'
        }));
        await this.#publish(state, {
          type: EventType.CUSTOM,
          name: 'brai.message_status.v1',
          value: {
            message_id: message.id, status: 'failed', code: 'chat_turn_not_active',
            message: 'Активный ответ уже завершён'
          }
        }, { stableId: `steer-status:${message.id}` });
        continue;
      }
      try {
        await this.broker.request('steerTurn', {
          userId: state.userId,
          threadId: state.internalThreadId,
          turnId: turn.id,
          text: message.content,
          clientUserMessageId,
          attachments: []
        });
        withUserScope(state.userId, () => state.store.updateBraiChatMessage(message.id, {
          dispatch_status: 'delivered'
        }));
      } catch (error) {
        const safe = safeBraiChatError(error);
        withUserScope(state.userId, () => state.store.updateBraiChatMessage(message.id, {
          dispatch_status: 'failed'
        }));
        await this.#publish(state, {
          type: EventType.CUSTOM,
          name: 'brai.message_status.v1',
          value: { message_id: message.id, status: 'failed', code: safe.code, message: safe.message }
        }, { stableId: `steer-status:${message.id}` });
        throw error;
      }
    }
  }

  #persistedTurnState(state) {
    const result = {
      payloadCounts: new Map(), messageText: new Map(), messageRoles: new Map(),
      reasoningText: new Map(), toolOutput: new Map(),
      streamOffsets: new Map(), streamText: new Map(), userMessageText: null,
      hasAssistantOutput: false, generatedImageReady: false
    };
    this.#replay(state.store, state.publicThreadId, 0, (record) => {
      if (record.turn_id !== state.runId) return;
      const event = record.safe_payload;
      if (event.type === EventType.RUN_STARTED && !result.userMessageText) {
        const userMessage = event.input?.messages?.find((message) => message?.role === 'user');
        result.userMessageText = typeof userMessage?.content === 'string'
          ? userMessage.content : null;
      }
      const serialized = JSON.stringify(event);
      result.payloadCounts.set(serialized, (result.payloadCounts.get(serialized) || 0) + 1);
      const stream = eventStream(event);
      if (stream) {
        result.streamOffsets.set(stream.key,
          (result.streamOffsets.get(stream.key) || 0) + Buffer.byteLength(stream.chunk, 'utf8'));
        result.streamText.set(stream.key, `${result.streamText.get(stream.key) || ''}${stream.chunk}`);
      }
      if (event.type === EventType.TEXT_MESSAGE_START) {
        result.messageRoles.set(event.messageId, event.role);
      } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        result.messageText.set(event.messageId, `${result.messageText.get(event.messageId) || ''}${event.delta}`);
        if (result.messageRoles.get(event.messageId) !== 'user') result.hasAssistantOutput = true;
      } else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
        result.reasoningText.set(event.messageId,
          `${result.reasoningText.get(event.messageId) || ''}${event.delta}`);
        result.hasAssistantOutput = true;
      } else if (event.type === EventType.TOOL_CALL_START) {
        result.hasAssistantOutput = true;
      } else if (event.type === EventType.CUSTOM && event.name === 'brai.artifact.v1'
        && event.value?.kind === 'image' && event.value?.status === 'ready') {
        result.generatedImageReady = true;
      } else if (event.type === EventType.CUSTOM && event.value?.kind === 'command_output') {
        const id = event.value.source_event_id;
        result.toolOutput.set(id, `${result.toolOutput.get(id) || ''}${event.value.delta || ''}`);
      }
    });
    return result;
  }

  async #publishReconciled(state, persisted, events) {
    for (let event of events) {
      if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
        const current = persisted.messageText.get(event.messageId) || '';
        if (!event.delta.startsWith(current)) continue;
        const delta = event.delta.slice(current.length);
        if (!delta) continue;
        event = { ...event, delta };
        persisted.messageText.set(event.messageId, `${current}${delta}`);
      } else if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
        const current = persisted.reasoningText.get(event.messageId) || '';
        if (!event.delta.startsWith(current)) continue;
        const delta = event.delta.slice(current.length);
        if (!delta) continue;
        event = { ...event, delta };
        persisted.reasoningText.set(event.messageId, `${current}${delta}`);
      } else if (event.type === EventType.CUSTOM && event.value?.kind === 'command_output') {
        const id = event.value.source_event_id;
        const current = persisted.toolOutput.get(id) || '';
        if (!event.value.delta.startsWith(current)) continue;
        const delta = event.value.delta.slice(current.length);
        if (!delta) continue;
        event = { ...event, value: { ...event.value, delta } };
        persisted.toolOutput.set(id, `${current}${delta}`);
      }
      const serialized = JSON.stringify(event);
      const count = persisted.payloadCounts.get(serialized) || 0;
      if (count > 0) {
        persisted.payloadCounts.set(serialized, count - 1);
        continue;
      }
      await this.#publish(state, event);
    }
  }

  #rememberSnapshotCoverage(state, persisted, key, events) {
    if (!key) return;
    for (const event of events) {
      const stream = eventStream(event);
      if (!stream) continue;
      const current = persisted.streamText.get(stream.key) || '';
      if (stream.chunk.startsWith(current)) state.snapshotCoverage.set(key, stream.chunk.slice(current.length));
    }
  }

  #consumeSnapshotCoverage(state, method, params) {
    const key = notificationDeltaKey(method, params);
    const coverage = key ? state.snapshotCoverage.get(key) : null;
    if (!coverage || typeof params?.delta !== 'string') return params;
    if (coverage.startsWith(params.delta)) {
      state.snapshotCoverage.set(key, coverage.slice(params.delta.length));
      return null;
    }
    if (params.delta.startsWith(coverage)) {
      state.snapshotCoverage.delete(key);
      const delta = params.delta.slice(coverage.length);
      return delta ? { ...params, delta } : null;
    }
    state.snapshotCoverage.delete(key);
    return params;
  }

  #replay(store, publicThreadId, after, emit) {
    let cursor = after;
    while (true) {
      const replay = store.replayBraiChatEvents(publicThreadId, {
        after: cursor, limit: REPLAY_PAGE_SIZE
      });
      if (!replay) return false;
      for (const event of replay.items) emit(event);
      if (replay.next_cursor == null) return true;
      const next = Number(replay.next_cursor);
      if (!Number.isSafeInteger(next) || next <= cursor) throw new Error('Invalid replay cursor');
      cursor = next;
    }
  }

  #replayForConnect(store, publicThreadId, after, emit) {
    const boundary = store.findBraiChatReplayBoundary?.(publicThreadId, after) ?? 0;
    const replayAfterSequence = boundary > 0 ? boundary - 1 : after;
    let lastSequence = replayAfterSequence;
    let compact = boundary > 0 ? [] : null;
    const flush = ({ terminal = false } = {}) => {
      if (!compact?.length) return;
      const events = terminal ? compactEvents(compact) : compact;
      for (const event of events) emit(event);
      compact = [];
    };
    const found = this.#replay(store, publicThreadId, replayAfterSequence, (record) => {
      lastSequence = record.sequence;
      if (!compact) {
        emit(record.safe_payload);
        return;
      }
      compact.push(record.safe_payload);
      if (record.safe_payload?.type === EventType.RUN_FINISHED
        || record.safe_payload?.type === EventType.RUN_ERROR) flush({ terminal: true });
    });
    flush();
    return { found, lastSequence };
  }

  async #materializeGeneratedArtifact(state, params, events) {
    const item = params?.item;
    if (!item || (item.type !== 'imageGeneration' && item.type !== 'imageView')) return events;
    const artifactIndex = events.findIndex((event) =>
      event.type === EventType.CUSTOM && event.name === 'brai.artifact.v1'
        && event.value?.kind === 'image');
    if (artifactIndex < 0) return events;
    const source = events[artifactIndex].value;
    const resultIndex = events.findIndex((event) =>
      event.type === EventType.TOOL_CALL_RESULT
        && event.toolCallId === source.source_event_id);
    const messageId = assistantMessageIdForRun(state.runId);
    const attachmentId = `attachment_${crypto.createHash('sha256')
      .update(`${state.userId}\0${state.publicThreadId}\0${state.runId}\0${item.id}`)
      .digest('hex').slice(0, 32)}`;
    const baseValue = {
      ...source,
      source_message_id: messageId
    };
    let exported = false;
    try {
      let attachment = withUserScope(state.userId, () =>
        state.store.getBraiChatAttachment(attachmentId));
      if (!attachment) {
        const metadata = await this.broker.request('exportGeneratedArtifact', {
          userId: state.userId,
          threadId: state.internalThreadId,
          turnId: params.turnId ?? state.internalTurnId,
          itemId: item.id,
          publicThreadId: state.publicThreadId,
          attachmentId
        });
        exported = true;
        const saved = withUserScope(state.userId, () =>
          state.store.addBraiChatAttachments(state.publicThreadId, [metadata]));
        attachment = saved?.[0] ?? null;
        if (!attachment) throw new Error('generated_artifact_persistence_failed');
      }
      const message = withUserScope(state.userId, () => state.store.putBraiChatMessage({
        id: messageId,
        threadId: state.publicThreadId,
        turnId: state.runId,
        idempotencyKey: idempotencyKey('assistant', state.runId, messageId),
        role: 'assistant',
        content: 'Изображение готово.',
        status: state.terminalStatus || 'streaming',
        model: state.effectiveModel,
        reasoningEffort: state.effectiveReasoningEffort
      }));
      if (!message) throw new Error('generated_artifact_message_persistence_failed');
      const linked = withUserScope(state.userId, () => state.store.linkBraiChatAttachments({
        threadId: state.publicThreadId,
        messageId,
        attachmentIds: [attachmentId]
      }));
      if (!linked?.length) throw new Error('generated_artifact_link_failed');
      attachment = linked[0];
      state.messageRoles.set(messageId, 'assistant');
      state.assistantMessageIds.add(messageId);
      events[artifactIndex] = {
        ...events[artifactIndex],
        value: {
          ...baseValue,
          status: 'ready',
          attachment_id: attachment.id,
          name: attachment.filename,
          media_type: attachment.media_type,
          byte_size: attachment.byte_size
        }
      };
      if (resultIndex >= 0) {
        events[resultIndex] = {
          ...events[resultIndex],
          content: JSON.stringify({
            status: 'ready',
            attachment_id: attachment.id,
            name: attachment.filename,
            media_type: attachment.media_type,
            byte_size: attachment.byte_size
          })
        };
      }
    } catch (error) {
      if (exported) {
        try {
          withUserScope(state.userId, () =>
            state.store.deleteUnlinkedBraiChatAttachment(attachmentId));
        } catch {
          // The filesystem cleanup below remains safe and idempotent.
        }
        await this.broker.request('removeExportedArtifact', {
          userId: state.userId,
          threadId: state.internalThreadId,
          turnId: params.turnId ?? state.internalTurnId,
          itemId: item.id,
          publicThreadId: state.publicThreadId,
          attachmentId
        }).catch(() => undefined);
      }
      const safe = safeBraiChatError(error);
      events[artifactIndex] = {
        ...events[artifactIndex],
        value: {
          ...baseValue,
          status: 'failed',
          code: safe.code,
          message: safe.message,
          retryable: true
        }
      };
      if (resultIndex >= 0) {
        events[resultIndex] = {
          ...events[resultIndex],
          content: JSON.stringify({ status: 'failed', code: safe.code, retryable: true })
        };
      }
    }
    return events;
  }

  async #cleanupDurableGeneratedArtifacts(state, attachmentIds = null) {
    try {
      const ids = attachmentIds ?? withUserScope(state.userId, () =>
        state.store.listBraiChatReadyGeneratedAttachmentIds?.(
          state.publicThreadId, 1_000
        ) ?? []);
      const selected = [...new Set((ids || []).filter((id) =>
        PUBLIC_ID.test(id)))].slice(0, 1_000);
      if (!selected.length) return;
      await this.broker.request('cleanupGeneratedArtifacts', {
        userId: state.userId,
        publicThreadId: state.publicThreadId,
        attachmentIds: selected
      }, { timeoutMs: 5_000 });
    } catch {
      // The durable attachment and artifact event remain authoritative for a later retry.
    }
  }

  #enqueueNotification(state, method, params, notificationSequence = null, notificationEpoch = null) {
    if (notificationEpoch && notificationEpoch !== state.brokerEpoch) {
      state.brokerEpoch = notificationEpoch;
      state.lastNotificationSequence = 0;
    }
    if (Number.isSafeInteger(notificationSequence)) {
      if (notificationSequence <= state.lastNotificationSequence) return;
      state.lastNotificationSequence = notificationSequence;
    }
    params = this.#consumeSnapshotCoverage(state, method, params);
    if (!params) return;
    state.queue = state.queue.then(async () => {
      if (state.done || !state.normalizer) return;
      if (method === 'turn/completed' && state.timeoutTriggered) return;
      if (method === 'turn/completed') state.terminalStatus = turnStatus(params?.turn?.status);
      if (method === 'error') state.terminalStatus = 'failed';
      let events = await this.#materializeGeneratedArtifact(
        state, params, state.normalizer.translate(method, params)
      );
      const readyIds = readyGeneratedAttachmentIds(events);
      if (readyIds.length) state.generatedImageReady = true;
      if (method === 'turn/completed' && state.generatedImageReady && !hasAssistantText(state)) {
        events = [...state.normalizer.assistantFallback('Изображение готово.'), ...events];
      }
      await this.#publishAll(state, events);
      void this.#cleanupDurableGeneratedArtifacts(state, readyIds);
      if (method === 'turn/completed' || method === 'error') await this.#completeState(state);
    }).catch((error) => this.#fail(state, error));
  }

  async #publishAll(state, events, source = {}) {
    for (const [index, event] of events.entries()) await this.#publish(state, event, { ...source, index });
  }

  async #publish(state, event, source = {}) {
    if (state.done) return;
    const serialized = JSON.stringify(event);
    const identity = stableEventIdentity(state, event, source);
    const stableSourceEventId = `source_${crypto.createHash('sha256').update(identity).digest('hex')}`;
    const searchableText = searchableEventText(event);
    const isAssistantEnd = event.type === EventType.TEXT_MESSAGE_END
      && state.messageRoles.get(event.messageId) !== 'user';
    const messageProjection = isAssistantEnd ? {
      id: event.messageId,
      threadId: state.publicThreadId,
      turnId: state.runId,
      idempotencyKey: idempotencyKey('assistant', state.runId, event.messageId),
      role: 'assistant',
      content: sanitizeBraiChatText(state.messageText.get(event.messageId) || ''),
      status: state.terminalStatus || 'streaming',
      model: state.effectiveModel,
      reasoningEffort: state.effectiveReasoningEffort
    } : null;

    const eventId = crypto.randomUUID();
    const saved = withUserScope(state.userId, () => state.store.appendBraiChatEvent({
      id: eventId,
      threadId: state.publicThreadId,
      turnId: state.runId,
      sourceEventId: stableSourceEventId,
      idempotencyKey: idempotencyKey('event', state.runId, identity),
      type: event.type,
      safePayload: event,
      searchableText,
      truncated: serialized.includes('Вывод обрезан'),
      messageProjection
    }));
    if (!saved) throw new Error('event_persistence_failed');
    if (saved.id !== eventId) return;

    const stream = eventStream(event);
    if (stream) {
      state.streamOffsets.set(stream.key,
        (state.streamOffsets.get(stream.key) || 0) + Buffer.byteLength(stream.chunk, 'utf8'));
    }

    if (event.type === EventType.TEXT_MESSAGE_START) {
      state.messageRoles.set(event.messageId, event.role);
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      state.messageText.set(event.messageId, `${state.messageText.get(event.messageId) || ''}${event.delta}`);
      if (state.messageRoles.get(event.messageId) !== 'user') state.hasAssistantOutput = true;
    } else if (event.type === EventType.REASONING_MESSAGE_CONTENT
      || event.type === EventType.TOOL_CALL_START) {
      state.hasAssistantOutput = true;
    } else if (isAssistantEnd) {
      state.assistantMessageIds.add(event.messageId);
    }
    state.subject.next({ event, sequence: saved.sequence });
  }

  async #finish(state, turn) {
    if (state.done || !state.normalizer) return;
    state.terminalStatus = turnStatus(turn?.status);
    const fallback = state.generatedImageReady && !hasAssistantText(state)
      ? state.normalizer.assistantFallback('Изображение готово.') : [];
    await this.#publishAll(state, [
      ...fallback, ...state.normalizer.translate('turn/completed', { turn })
    ]);
    await this.#completeState(state);
  }

  async #generateTitle(state) {
    if (state.titleGenerationAttempted || state.terminalStatus !== 'completed'
      || !state.hasAssistantOutput || !this.titleGenerator) return;
    state.titleGenerationAttempted = true;
    const startedAt = Date.now();
    let status = 'failed';
    let outcome = 'unavailable';
    let titleApplied = false;
    let errorCode = null;
    try {
      const assistantMessages = [...state.messageText.entries()]
        .filter(([id]) => state.messageRoles.get(id) !== 'user')
        .map(([, content]) => content);
      const generated = await this.titleGenerator({
        userId: state.userId,
        userMessage: state.userMessageText,
        assistantMessages,
        model: state.effectiveModel,
        reasoningEffort: state.effectiveReasoningEffort
      });
      const title = normalizeGeneratedTitle(generated);
      if (title) {
        const thread = withUserScope(state.userId, () =>
          state.store.setBraiChatGeneratedTitle(state.publicThreadId, title));
        titleApplied = thread?.title === title;
        status = 'done';
        outcome = titleApplied ? 'generated' : 'not_applied';
      } else {
        errorCode = 'title_unavailable';
      }
    } catch (error) {
      errorCode = safeBraiChatError(error).code;
      outcome = 'failed';
    } finally {
      try {
        withUserScope(state.userId, () => state.store.recordAiLog({
          agentId: TITLE_AGENT_ID,
          agentVersion: TITLE_AGENT_VERSION,
          status,
          aiTitle: status === 'done'
            ? 'Смысловой заголовок чата обработан'
            : 'Смысловой заголовок чата не создан',
          flowId: state.publicThreadId,
          flowCommand: TITLE_AGENT_ID,
          traceId: `brai-chat-title:${state.runId}`,
          runId: state.runId,
          llmCallId: titleLlmCallId(state),
          userId: state.userId,
          jsonData: {
            schema: 'brai.chat_title.ai_log.v1',
            outcome,
            model: state.effectiveModel ?? null,
            reasoning_effort: state.effectiveReasoningEffort ?? null,
            duration_ms: Math.max(0, Date.now() - startedAt),
            title_applied: titleApplied,
            ...(errorCode ? { error_code: errorCode } : {})
          }
        }));
      } catch {
        // Chat completion and manual title precedence remain authoritative if observability fails.
      }
    }
  }

  async #timeout(state) {
    if (state.done) return;
    state.timeoutTriggered = true;
    state.terminalStatus = 'failed';
    try {
      await this.broker.request('interruptTurn', {
        userId: state.userId,
        threadId: state.internalThreadId,
        turnId: state.internalTurnId
      });
    } catch {
      // The safe timeout result still wins if the broker has already stopped the turn.
    }
    await delay(TERMINAL_GRACE_MS);
    await state.queue;
    if (state.done) return;
    await this.#fail(state, new Error('turn timeout'));
  }

  async #fail(state, error) {
    if (state.done) return;
    const safe = safeBraiChatError(error);
    state.terminalStatus = 'failed';
    try {
      if (state.normalizer) {
        await this.#publishAll(state, state.normalizer.translate('turn/completed', {
          turn: { status: 'failed', error }
        }));
      } else {
        await this.#publish(state, {
          type: EventType.CUSTOM,
          name: 'brai.turn_status.v1',
          value: { status: 'failed', code: safe.code, run_id: state.runId }
        });
        await this.#publish(state, { type: EventType.RUN_ERROR, ...safe });
      }
    } finally {
      await this.#completeState(state);
    }
  }

  async #completeState(state) {
    if (state.done) return;
    state.done = true;
    if (state.timeout) clearTimeout(state.timeout);
    state.resolveTurnReady();
    state.unsubscribeBroker?.();
    if (state.brokerSubscriptionId) {
      void this.broker.request('unsubscribe', {
        subscriptionId: state.brokerSubscriptionId
      }).catch(() => undefined);
    }
    if (state.terminalStatus) {
      for (const messageId of state.assistantMessageIds) {
        try {
          withUserScope(state.userId, () => state.store.updateBraiChatMessage(messageId, {
            status: state.terminalStatus
          }));
        } catch {
          // The terminal event remains durable even if message projection repair is deferred.
        }
      }
    }
    try {
      withUserScope(state.userId, () => state.store.setBraiChatActiveTurn(state.publicThreadId));
    } catch {
      // Completion remains terminal even if later reconciliation must clear DB state.
    }
    try {
      withUserScope(state.userId, () => state.store.recordAiLog({
        agentId: AGENT_ID,
        agentVersion: AGENT_VERSION,
        status: state.terminalStatus === 'failed' ? 'failed' : 'done',
        aiTitle: state.terminalStatus === 'failed' ? 'Ответ Брая завершился ошибкой' : 'Ответ Брая завершён',
        flowId: state.publicThreadId,
        flowCommand: AGENT_ID,
        traceId: `brai-chat:${state.runId}`,
        runId: state.runId,
        llmCallId: chatLlmCallId(state),
        userId: state.userId,
        jsonData: {
          schema: 'brai.chat.ai_log.v1',
          outcome: state.terminalStatus ?? 'completed',
          model: state.effectiveModel ?? null,
          reasoning_effort: state.effectiveReasoningEffort ?? null,
          duration_ms: Math.max(0, Date.now() - Date.parse(state.startedAtUtc)),
          has_assistant_text: hasAssistantText(state),
          has_generated_image: state.generatedImageReady
        }
      }));
    } catch {
      // Runtime completion remains authoritative if observability is unavailable.
    }
    state.subject.complete();
    this.active.delete(state.key);
    void this.#generateTitle(state);
  }
}

export function createBraiChatRuntime({
  broker, socketPath, turnTimeoutMs, titleGenerator = null
} = {}) {
  const resolvedBroker = broker || new BraiCodexBrokerClient({ socketPath });
  const resolvedTitleGenerator = titleGenerator ?? (async ({
    userId, userMessage, assistantMessages, model, reasoningEffort
  }) => {
    const response = await resolvedBroker.request('generateTitle', {
      userId,
      userMessage: typeof userMessage === 'string' ? userMessage : '',
      assistantText: assistantMessages.join('\n\n'),
      model,
      reasoningEffort
    }, { timeoutMs: 35_000 });
    return response?.title ?? null;
  });
  const coordinator = new BraiChatTurnCoordinator({
    broker: resolvedBroker, turnTimeoutMs, titleGenerator: resolvedTitleGenerator
  });

  return {
    steer(input) {
      return coordinator.steer(input).catch((error) => { throw publicRuntimeError(error); });
    },

    async listModels({ userId }) {
      try {
        const data = [];
        const cursors = new Set();
        let cursor = null;
        do {
          const response = await resolvedBroker.request('listModels', {
            userId, limit: 100, ...(cursor ? { cursor } : {})
          });
          data.push(...(response?.data || []));
          cursor = response?.nextCursor ?? null;
          if (cursor && cursors.has(cursor)) throw new Error('Codex model pagination loop');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        const models = data.filter((model) => !model.hidden).map((model) => ({
          version: 1,
          id: model.id,
          display_name: sanitizeBraiChatText(model.displayName || model.id, { maxBytes: 200 }),
          description: sanitizeBraiChatText(model.description || '', { maxBytes: 1_000 }),
          reasoning_efforts: (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort),
          default_reasoning_effort: model.defaultReasoningEffort,
          is_default: Boolean(model.isDefault)
        }));
        return {
          models,
          default_model: models.find((model) => model.is_default)?.id ?? models[0]?.id ?? null
        };
      } catch (error) {
        throw publicRuntimeError(error);
      }
    },

    async handleRequest({ req, res, url, store, sendJson, readJson, userId }) {
      let envelope;
      try {
        envelope = await readJson(req, { limit: MAX_RUNTIME_BODY_BYTES });
      } catch {
        sendJson(req, res, 400, { error: 'invalid_runtime_request' });
        return;
      }
      if (!envelope || !ALLOWED_RUNTIME_METHODS.has(envelope.method)) {
        sendJson(req, res, 404, { error: 'runtime_method_not_found' });
        return;
      }

      const publicThreadId = envelope.body?.threadId ?? envelope.params?.threadId ?? null;
      if (envelope.method !== 'info') {
        const thread = typeof publicThreadId === 'string'
          ? withUserScope(userId, () => store.getBraiChatThreadRuntime(publicThreadId))
          : null;
        if (!thread) {
          sendJson(req, res, 404, { error: 'chat_thread_not_found' });
          return;
        }
      }

      const namespacedThreadId = publicThreadId ? scopedThreadId(userId, publicThreadId) : null;
      const rewritten = structuredClone(envelope);
      if (rewritten.body?.threadId) {
        rewritten.body.threadId = namespacedThreadId;
        rewritten.body.forwardedProps = {
          ...(rewritten.body.forwardedProps || {}),
          brai_public_thread_id: publicThreadId
        };
      }
      if (rewritten.params?.threadId) rewritten.params.threadId = namespacedThreadId;

      const [{ CopilotSseRuntime, createCopilotRuntimeHandler }] = await Promise.all([
        import('@copilotkit/runtime/v2')
      ]);
      const runner = new BraiPersistentAgentRunner({
        coordinator, store, userId, publicThreadId, runtimeThreadId: namespacedThreadId
      });
      const runtime = new CopilotSseRuntime({
        agents: {
          [AGENT_ID]: new BraiCodexAgent({
            coordinator, store, userId, publicThreadId, runtimeThreadId: namespacedThreadId
          })
        },
        runner,
        debug: false,
        forwardHeaders: { allow: ['last-event-id', 'x-brai-chat-after', 'x-brai-chat-replay-mode'] }
      });
      const handler = createCopilotRuntimeHandler({ runtime, mode: 'single-route' });
      const replayHeaders = Object.fromEntries([
        ['last-event-id', req.headers['last-event-id']],
        ['x-brai-chat-after', req.headers['x-brai-chat-after']],
        ['x-brai-chat-replay-mode', req.headers['x-brai-chat-replay-mode']]
      ].filter(([, value]) => typeof value === 'string'));
      const request = new Request(url.href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: req.headers.accept || 'application/json', ...replayHeaders
        },
        body: JSON.stringify(rewritten)
      });
      const response = await handler(request);
      const responseHeaders = new Headers(response.headers);
      const isEventStream = responseHeaders.get('content-type')
        ?.toLowerCase().startsWith('text/event-stream');
      if (isEventStream) {
        responseHeaders.set('cache-control', 'no-cache, no-transform');
        responseHeaders.set('content-encoding', 'identity');
        responseHeaders.set('x-accel-buffering', 'no');
        responseHeaders.delete('content-length');
        res.socket?.setNoDelay?.(true);
      }
      res.writeHead(response.status, Object.fromEntries(responseHeaders.entries()));
      if (isEventStream) res.flushHeaders?.();
      if (!response.body) {
        res.end();
        return;
      }
      try {
        for await (const chunk of response.body) {
          if (res.destroyed) break;
          res.write(Buffer.from(chunk));
          if (isEventStream) res.flush?.();
        }
      } finally {
        if (!res.destroyed) res.end();
      }
    },

    close() {
      resolvedBroker.close?.();
    }
  };
}
