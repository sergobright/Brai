import { EventType } from '@ag-ui/core';
import crypto from 'node:crypto';
import {
  BRAI_CHAT_OUTPUT_LIMIT_BYTES,
  BRAI_CHAT_TRUNCATION_MARKER,
  sanitizeBraiChatFilename,
  sanitizeBraiChatText,
  safeBraiChatError
} from './brai-chat-sanitize.js';

const RAW_REASONING_METHODS = new Set([
  'item/reasoning/textDelta',
  'item/reasoning/rawContentDelta'
]);
const TOOL_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'imageGeneration',
  'imageView'
]);

function safeId(value, fallback) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? value : fallback;
}

export function assistantMessageIdForRun(runId) {
  const safeRunId = safeId(runId, 'run');
  const digest = crypto.createHash('sha256')
    .update(`${safeRunId}\0assistant`).digest('hex').slice(0, 24);
  return `assistant:${digest}`;
}

function toolName(item) {
  if (item.type === 'commandExecution') return 'command';
  if (item.type === 'fileChange') return 'file_change';
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return sanitizeBraiChatText(item.tool || 'tool', { maxBytes: 120 });
  }
  if (item.type === 'webSearch') return 'web_search';
  if (item.type === 'imageGeneration') return 'image_generation';
  if (item.type === 'imageView') return 'image_view';
  return 'tool';
}

function toolArgs(item) {
  if (item.type === 'commandExecution') return { command: sanitizeBraiChatText(item.command) };
  if (item.type === 'fileChange') return { files: Array.isArray(item.changes) ? item.changes.length : 0 };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return { arguments: sanitizeJsonValue(item.arguments) };
  }
  if (item.type === 'webSearch') return { query: sanitizeBraiChatText(item.query || '', { maxBytes: 2_000 }) };
  if (item.type === 'imageGeneration') {
    const prompt = sanitizeBraiChatText(item.revisedPrompt || '', { maxBytes: 4_000 });
    return prompt ? { prompt } : {};
  }
  if (item.type === 'imageView') return { image: sanitizeBraiChatFilename(item.path) };
  return {};
}

function sanitizeJsonValue(value, depth = 0) {
  if (depth > 5) return '[слишком глубокая структура]';
  if (typeof value === 'string') return sanitizeBraiChatText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeJsonValue(item, depth + 1));
  if (!value || typeof value !== 'object') return null;

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (/reasoning|encrypted|authorization|credential|token|secret|password|path|cwd/i.test(key)) continue;
    result[key] = sanitizeJsonValue(item, depth + 1);
  }
  return result;
}

function custom(name, value) {
  return { type: EventType.CUSTOM, name, value };
}

function utf8Prefix(value, maxBytes) {
  return Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8').replace(/\uFFFD$/u, '');
}

function boundedItemDelta(state, value, maxBytes = BRAI_CHAT_OUTPUT_LIMIT_BYTES) {
  if (state.truncated) return '';

  const safe = sanitizeBraiChatText(value, { maxBytes });
  const sanitizerTruncated = safe.endsWith(BRAI_CHAT_TRUNCATION_MARKER);
  const content = sanitizerTruncated ? safe.slice(0, -BRAI_CHAT_TRUNCATION_MARKER.length) : safe;
  const contentLimit = maxBytes - Buffer.byteLength(BRAI_CHAT_TRUNCATION_MARKER, 'utf8');
  const remaining = Math.max(0, contentLimit - state.outputBytes);
  const delta = utf8Prefix(content, remaining);
  const deltaBytes = Buffer.byteLength(delta, 'utf8');
  state.outputBytes += deltaBytes;

  if (sanitizerTruncated || Buffer.byteLength(content, 'utf8') > deltaBytes) {
    state.truncated = true;
    return `${delta}${BRAI_CHAT_TRUNCATION_MARKER}`;
  }
  return delta;
}

function itemResult(item, output) {
  if (item.type === 'commandExecution') {
    return sanitizeBraiChatText(output || item.aggregatedOutput || `Команда завершена: ${item.status || 'unknown'}`);
  }
  if (item.type === 'fileChange') return `${Array.isArray(item.changes) ? item.changes.length : 0} файлов изменено`;
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return sanitizeBraiChatText(JSON.stringify(sanitizeJsonValue(item.result ?? item.contentItems ?? item.error ?? {})));
  }
  return sanitizeBraiChatText(item.status || 'Готово');
}

function artifactValue(item, turnId) {
  if (item.type === 'fileChange') {
    return {
      kind: 'file_change',
      source_event_id: item.id,
      turn_id: turnId,
      files: (item.changes || []).slice(0, 100).map((change) => ({
        name: sanitizeBraiChatFilename(change.path),
        kind: sanitizeBraiChatText(change.kind || change.type || 'update', { maxBytes: 80 })
      }))
    };
  }
  if (item.type === 'imageGeneration' || item.type === 'imageView') {
    return {
      kind: 'image',
      source_event_id: item.id,
      turn_id: turnId,
      name: sanitizeBraiChatFilename(item.path || item.id || 'image')
    };
  }
  return null;
}

export class CodexAguiNormalizer {
  constructor({ publicThreadId, runId, input = null, started = false }) {
    this.publicThreadId = safeId(publicThreadId, 'thread');
    this.runId = safeId(runId, 'run');
    this.started = started;
    this.finished = false;
    this.input = input;
    this.textItems = new Map();
    this.reasoningItems = new Map();
    this.reasoningStarted = false;
    this.reasoningEnded = false;
    this.toolItems = new Map();
    this.publicItemIds = new Map();
    this.toolParentMessageId = assistantMessageIdForRun(this.runId);
    const reasoningDigest = crypto.createHash('sha256')
      .update(`${this.runId}\0reasoning`).digest('hex').slice(0, 24);
    this.reasoningGroupId = `reasoning:${reasoningDigest}`;
  }

  bindSnapshotItemId(internalId, publicId) {
    const boundId = safeId(publicId, null);
    if (!boundId) return false;
    const key = typeof internalId === 'string' && internalId ? internalId : null;
    if (!key) return false;
    this.publicItemIds.set(key, boundId);
    return true;
  }

  translate(method, params = {}) {
    if (this.finished || RAW_REASONING_METHODS.has(method) || method === 'item/reasoning/textDelta') return [];
    const events = [];

    if (method === 'turn/started') {
      if (this.started) return [];
      this.started = true;
      events.push({
        type: EventType.RUN_STARTED,
        threadId: this.publicThreadId,
        runId: this.runId,
        ...(this.input ? { input: this.input } : {})
      });
      events.push(custom('brai.turn_status.v1', { status: 'running', run_id: this.runId }));
      return events;
    }

    if (method === 'item/agentMessage/delta') {
      const itemId = this.#itemId(params.itemId, 'message');
      if (!this.textItems.has(itemId)) {
        this.textItems.set(itemId, { hasDelta: false, ended: false, outputBytes: 0, truncated: false });
        events.push({ type: EventType.TEXT_MESSAGE_START, messageId: itemId, role: 'assistant' });
      }
      const delta = boundedItemDelta(this.textItems.get(itemId), params.delta);
      if (delta) {
        this.textItems.get(itemId).hasDelta = true;
        events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: itemId, delta });
      }
      return events;
    }

    if (method === 'item/reasoning/summaryPartAdded'
      || method === 'item/reasoning/summaryPartCompleted'
      || method === 'item/reasoning/summaryTextDelta') {
      const summaryIndex = Number.isSafeInteger(params.summaryIndex) ? params.summaryIndex : 0;
      const internalItemId = typeof params.itemId === 'string' ? params.itemId : 'reasoning:fallback';
      const itemId = this.#itemId(`${internalItemId}:summary:${summaryIndex}`, 'reasoning');
      const state = this.reasoningItems.get(itemId) || {
        internalItemId, summaryIndex, started: false, ended: false, outputBytes: 0, truncated: false
      };
      const reasoningEvents = [];
      if (!this.reasoningStarted) {
        this.reasoningStarted = true;
        reasoningEvents.push({
          type: EventType.REASONING_START,
          messageId: this.reasoningGroupId
        });
      }
      if (!state.started) {
        state.started = true;
        reasoningEvents.push({
          type: EventType.REASONING_MESSAGE_START,
          messageId: itemId,
          role: 'reasoning'
        });
      }
      if (method === 'item/reasoning/summaryTextDelta') {
        const delta = boundedItemDelta(state, params.delta, 8_192);
        if (delta) reasoningEvents.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: itemId,
          delta
        });
      }
      if (method === 'item/reasoning/summaryPartCompleted' && !state.ended) {
        state.ended = true;
        reasoningEvents.push({ type: EventType.REASONING_MESSAGE_END, messageId: itemId });
      }
      this.reasoningItems.set(itemId, state);
      return reasoningEvents;
    }

    if (method === 'item/commandExecution/outputDelta') {
      const itemId = this.#itemId(params.itemId, 'tool');
      const state = this.toolItems.get(itemId) || {
        item: { id: itemId, type: 'commandExecution' }, output: '', outputBytes: 0, truncated: false
      };
      const delta = boundedItemDelta(state, params.delta);
      if (!delta) return [];
      state.output += delta;
      this.toolItems.set(itemId, state);
      return [custom('brai.detail.v1', {
        kind: 'command_output',
        source_event_id: itemId,
        delta
      })];
    }

    if (method === 'item/started') return this.#itemStarted(params.item);
    if (method === 'item/completed') return this.#itemCompleted(params.item, params.turnId);

    if (method === 'error') {
      const safe = safeBraiChatError(params.error);
      const events = [
        custom('brai.turn_status.v1', { status: 'failed', code: safe.code, run_id: this.runId }),
        ...this.#closeReasoning(),
        { type: EventType.RUN_ERROR, ...safe }
      ];
      this.finished = true;
      return events;
    }

    if (method === 'turn/completed') return this.#turnCompleted(params.turn);
    return [];
  }

  #itemStarted(item) {
    if (!item || typeof item !== 'object') return [];
    const itemId = this.#itemId(
      item.id, item.type === 'agentMessage' ? 'message' : item.type || 'item'
    );
    if (item.type === 'reasoning') {
      if (!this.reasoningItems.has(itemId)) {
        this.reasoningItems.set(itemId, {
          started: false, ended: false, outputBytes: 0, truncated: false
        });
      }
      return [];
    }
    if (item.type === 'agentMessage') {
      if (this.textItems.has(itemId)) return [];
      this.textItems.set(itemId, { hasDelta: false, ended: false, outputBytes: 0, truncated: false });
      return [{ type: EventType.TEXT_MESSAGE_START, messageId: itemId, role: 'assistant' }];
    }
    if (!TOOL_TYPES.has(item.type) || this.toolItems.has(itemId)) return [];

    this.toolItems.set(itemId, {
      item: { ...item, id: itemId }, output: '', ended: false, outputBytes: 0, truncated: false
    });
    const args = toolArgs(item);
    return [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: itemId,
        toolCallName: toolName(item),
        parentMessageId: this.toolParentMessageId
      },
      ...(Object.keys(args).length
        ? [{ type: EventType.TOOL_CALL_ARGS, toolCallId: itemId, delta: JSON.stringify(args) }]
        : []),
      custom('brai.detail.v1', {
        kind: item.type,
        source_event_id: itemId,
        label: toolName(item),
        status: 'running'
      })
    ];
  }

  #itemCompleted(item, turnId) {
    if (!item || typeof item !== 'object') return [];
    const itemId = this.#itemId(
      item.id, item.type === 'agentMessage' ? 'message' : item.type || 'item'
    );
    if (item.type === 'reasoning') {
      const events = [];
      for (const [messageId, state] of this.reasoningItems) {
        if (state.internalItemId !== item.id || !state.started || state.ended) continue;
        state.ended = true;
        events.push({ type: EventType.REASONING_MESSAGE_END, messageId });
      }
      return events;
    }
    if (item.type === 'agentMessage') {
      const state = this.textItems.get(itemId) || {
        hasDelta: false, ended: false, outputBytes: 0, truncated: false
      };
      const events = [];
      if (!this.textItems.has(itemId)) events.push({ type: EventType.TEXT_MESSAGE_START, messageId: itemId, role: 'assistant' });
      if (!state.hasDelta && item.text) {
        events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: itemId, delta: boundedItemDelta(state, item.text) });
      }
      if (!state.ended) events.push({ type: EventType.TEXT_MESSAGE_END, messageId: itemId });
      this.textItems.set(itemId, { ...state, ended: true });
      return events;
    }
    if (!TOOL_TYPES.has(item.type)) return [];

    const state = this.toolItems.get(itemId) || {
      item: { ...item, id: itemId }, output: '', ended: false, outputBytes: 0, truncated: false
    };
    const events = [];
    if (!this.toolItems.has(itemId)) events.push(...this.#itemStarted(item));
    if (!state.ended) events.push({ type: EventType.TOOL_CALL_END, toolCallId: itemId });
    const result = itemResult(item, state.output);
    events.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${itemId}:result`,
      toolCallId: itemId,
      content: result,
      role: 'tool'
    });
    events.push(custom('brai.detail.v1', {
      kind: item.type,
      source_event_id: itemId,
      status: sanitizeBraiChatText(item.status || 'completed', { maxBytes: 80 }),
      result
    }));
    const artifact = artifactValue({ ...item, id: itemId }, this.runId);
    if (artifact) events.push(custom('brai.artifact.v1', artifact));
    this.toolItems.set(itemId, { ...state, ended: true });
    return events;
  }

  #turnCompleted(turn = {}) {
    const events = this.#closeReasoning();
    for (const [messageId, state] of this.textItems) {
      if (!state.ended) events.push({ type: EventType.TEXT_MESSAGE_END, messageId });
    }
    for (const [toolCallId, state] of this.toolItems) {
      if (!state.ended) events.push({ type: EventType.TOOL_CALL_END, toolCallId });
    }

    const status = turn.status || 'completed';
    if (status === 'failed') {
      const safe = safeBraiChatError(turn.error);
      events.push(custom('brai.turn_status.v1', { status: 'failed', code: safe.code, run_id: this.runId }));
      events.push({ type: EventType.RUN_ERROR, ...safe });
    } else {
      events.push(custom('brai.turn_status.v1', {
        status: status === 'interrupted' ? 'interrupted' : 'completed',
        run_id: this.runId
      }));
      events.push({
        type: EventType.RUN_FINISHED,
        threadId: this.publicThreadId,
        runId: this.runId,
        result: { status: status === 'interrupted' ? 'interrupted' : 'completed' },
        outcome: { type: 'success' }
      });
    }
    this.finished = true;
    return events;
  }

  assistantFallback(text) {
    const content = sanitizeBraiChatText(text, { maxBytes: 1_000 });
    if (!content) return [];
    const messageId = this.toolParentMessageId;
    return [
      { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: content },
      { type: EventType.TEXT_MESSAGE_END, messageId }
    ];
  }

  #closeReasoning() {
    const events = [];
    for (const [messageId, state] of this.reasoningItems) {
      if (state.started && !state.ended) {
        state.ended = true;
        events.push({ type: EventType.REASONING_MESSAGE_END, messageId });
      }
    }
    if (this.reasoningStarted && !this.reasoningEnded) {
      this.reasoningEnded = true;
      events.push({ type: EventType.REASONING_END, messageId: this.reasoningGroupId });
    }
    return events;
  }

  #itemId(internalId, kind) {
    const key = typeof internalId === 'string' && internalId ? internalId : `${kind}:fallback`;
    if (!this.publicItemIds.has(key)) {
      const digest = crypto.createHash('sha256').update(`${this.runId}\0${kind}\0${key}`).digest('hex').slice(0, 24);
      this.publicItemIds.set(key, `${kind}:${digest}`);
    }
    return this.publicItemIds.get(key);
  }
}
