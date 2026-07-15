import crypto from 'node:crypto';
import { scopedUserId } from './user-scope.js';

const DEFAULT_TITLE = 'Новый чат';
const MESSAGE_STATUSES = new Set(['pending', 'streaming', 'completed', 'failed', 'interrupted']);
const DISPATCH_STATUSES = new Set(['pending', 'delivered', 'failed']);
const MESSAGE_ROLES = new Set(['user', 'assistant']);
const MAX_EVENT_TEXT_BYTES = 64 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 72 * 1024;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export const braiChatStoreMethods = {
  createBraiChatThread({ id = crypto.randomUUID(), nowIso = new Date().toISOString() } = {}) {
    const userId = requireUser();
    const inherited = this.db.prepare(`
      SELECT model, reasoning_effort FROM brai_chat_threads
      WHERE user_id = ? ORDER BY updated_at_utc DESC, id DESC LIMIT 1
    `).get(userId);
    this.db.prepare(`
      INSERT INTO brai_chat_threads (
        id, user_id, title, title_source, model, reasoning_effort,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, 'default', ?, ?, ?, ?)
    `).run(id, userId, DEFAULT_TITLE, inherited?.model ?? null,
      inherited?.reasoning_effort ?? null, nowIso, nowIso);
    return this.getBraiChatThread(id);
  },

  listBraiChatThreads({ archived = 'active' } = {}) {
    const userId = requireUser();
    const archiveSql = archiveFilter(archived);
    return this.db.prepare(`
      SELECT t.* FROM brai_chat_threads t
      WHERE t.user_id = ? AND ${archiveSql}
      ORDER BY updated_at_utc DESC, id DESC
    `).all(userId).map(formatBraiChatThread);
  },

  listBraiChatAttachmentCleanupOwners(limit = 100) {
    const bounded = Math.max(1, Math.min(Number(limit) || 100, 1_000));
    return this.db.prepare(`
      SELECT DISTINCT user_id FROM brai_chat_threads
      ORDER BY user_id LIMIT ?
    `).all(bounded).map((row) => row.user_id);
  },

  getBraiChatThread(threadId) {
    const row = ownedThread(this, threadId);
    return row ? formatBraiChatThread(row) : null;
  },

  getBraiChatThreadRuntime(threadId) {
    const row = ownedThread(this, threadId);
    if (!row) return null;
    return {
      ...formatBraiChatThread(row),
      codex_thread_id: row.codex_thread_id ?? null,
      active_codex_turn_id: row.active_codex_turn_id ?? null,
      active_user_message_id: row.active_user_message_id ?? null,
      active_turn_started_at_utc: row.active_turn_started_at_utc ?? null,
      active_turn_deadline_at_utc: row.active_turn_deadline_at_utc ?? null,
      active_turn_model: row.active_turn_model ?? null,
      active_turn_reasoning_effort: row.active_turn_reasoning_effort ?? null
    };
  },

  updateBraiChatThread(threadId, input, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const current = ownedThread(this, threadId);
    if (!current) return null;
    const hasTitle = Object.hasOwn(input, 'title');
    const title = hasTitle ? requiredTitle(input.title) : current.title;
    const model = Object.hasOwn(input, 'model') ? nullableSetting(input.model, 'invalid_model') : current.model;
    const reasoning = Object.hasOwn(input, 'reasoning_effort')
      ? nullableSetting(input.reasoning_effort, 'invalid_reasoning_effort')
      : current.reasoning_effort;
    this.db.prepare(`
      UPDATE brai_chat_threads SET title = ?, title_source = ?, model = ?,
        reasoning_effort = ?, updated_at_utc = ?
      WHERE user_id = ? AND id = ?
    `).run(title, hasTitle ? 'manual' : current.title_source, model, reasoning, nowIso, userId, threadId);
    return this.getBraiChatThread(threadId);
  },

  archiveBraiChatThread(threadId, archived, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const result = this.db.prepare(`
      UPDATE brai_chat_threads SET archived_at_utc = ?, updated_at_utc = ?
      WHERE user_id = ? AND id = ?
    `).run(archived ? nowIso : null, nowIso, userId, threadId);
    return result.changes ? this.getBraiChatThread(threadId) : null;
  },

  setBraiChatCodexThreadId(threadId, codexThreadId, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const value = nullableSetting(codexThreadId, 'invalid_codex_thread_id');
    const result = this.db.prepare(`
      UPDATE brai_chat_threads SET codex_thread_id = ?, updated_at_utc = ?
      WHERE user_id = ? AND id = ?
    `).run(value, nowIso, userId, threadId);
    return result.changes ? this.getBraiChatThreadRuntime(threadId) : null;
  },

  setBraiChatActiveTurn(threadId, {
    runId = null, codexTurnId = null, userMessageId = null,
    startedAtUtc = null, deadlineAtUtc = null, model = null, reasoningEffort = null
  } = {}, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const publicTurn = nullableSetting(runId, 'invalid_turn_id');
    const internalTurn = nullableSetting(codexTurnId, 'invalid_codex_turn_id');
    const messageId = nullableSetting(userMessageId, 'invalid_message_id');
    const startedAt = nullableSetting(startedAtUtc, 'invalid_turn_started_at');
    const deadlineAt = nullableSetting(deadlineAtUtc, 'invalid_turn_deadline_at');
    const effectiveModel = nullableSetting(model, 'invalid_model');
    const effectiveReasoning = nullableSetting(reasoningEffort, 'invalid_reasoning_effort');
    const result = this.db.prepare(`
      UPDATE brai_chat_threads SET active_turn_id = ?, active_codex_turn_id = ?,
        active_user_message_id = ?, active_turn_started_at_utc = ?,
        active_turn_deadline_at_utc = ?, active_turn_model = ?,
        active_turn_reasoning_effort = ?, updated_at_utc = ?
      WHERE user_id = ? AND id = ?
    `).run(publicTurn, internalTurn, messageId, startedAt, deadlineAt,
      effectiveModel, effectiveReasoning, nowIso, userId, threadId);
    return result.changes ? this.getBraiChatThreadRuntime(threadId) : null;
  },

  putBraiChatMessage({
    id = crypto.randomUUID(), threadId, turnId = null, idempotencyKey,
    role, content, status = 'completed', model = null, reasoningEffort = null,
    dispatchStatus = null,
    nowIso = new Date().toISOString()
  }) {
    const userId = requireUser();
    const normalizedContent = typeof content === 'string' ? content : '';
    const key = requiredText(idempotencyKey, 'invalid_idempotency_key', 200);
    if (!MESSAGE_ROLES.has(role)) throw chatError('invalid_message_role', 400);
    if (!MESSAGE_STATUSES.has(status)) throw chatError('invalid_message_status', 400);
    if (dispatchStatus != null && !DISPATCH_STATUSES.has(dispatchStatus)) {
      throw chatError('invalid_dispatch_status', 400);
    }
    const insert = runAtomic(this, () => {
      const thread = this.db.prepare(`
        SELECT id FROM brai_chat_threads WHERE user_id = ? AND id = ? FOR UPDATE
      `).get(userId, threadId);
      if (!thread) return null;
      const sameId = this.db.prepare(`
        SELECT * FROM brai_chat_messages WHERE id = ?
      `).get(id);
      if (sameId) {
        if (sameId.user_id === userId && sameId.brai_chat_threads_id === threadId
          && sameId.role === role && sameId.content === normalizedContent) return sameId;
        throw chatError('message_id_conflict', 409);
      }
      const existing = this.db.prepare(`
        SELECT * FROM brai_chat_messages
        WHERE user_id = ? AND brai_chat_threads_id = ? AND idempotency_key = ?
      `).get(userId, threadId, key);
      if (existing) return existing;
      const next = Number(this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM brai_chat_messages
        WHERE user_id = ? AND brai_chat_threads_id = ?
      `).get(userId, threadId).next);
      this.db.prepare(`
        INSERT INTO brai_chat_messages (
          id, user_id, brai_chat_threads_id, turn_id, idempotency_key, role,
          content, status, dispatch_status, sequence, model, reasoning_effort,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, userId, threadId, turnId, key, role, normalizedContent, status,
        dispatchStatus, next, model, reasoningEffort, nowIso, nowIso);
      return this.db.prepare('SELECT * FROM brai_chat_messages WHERE user_id = ? AND id = ?').get(userId, id);
    })();
    if (!insert) return null;
    if (role === 'user' && normalizedContent.trim()) {
      tryAutoTitle(this, userId, threadId, normalizedContent, nowIso);
    }
    return formatBraiChatMessage(insert);
  },

  getBraiChatMessage(threadId, messageId) {
    const row = this.db.prepare(`
      SELECT * FROM brai_chat_messages
      WHERE user_id = ? AND brai_chat_threads_id = ? AND id = ?
    `).get(requireUser(), threadId, messageId);
    return row ? formatBraiChatMessage(row) : null;
  },

  listBraiChatMessages(threadId, { cursor = 0, limit = 50 } = {}) {
    const userId = requireUser();
    if (!ownedThread(this, threadId)) return null;
    const rows = this.db.prepare(`
      SELECT * FROM brai_chat_messages
      WHERE user_id = ? AND brai_chat_threads_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(userId, threadId, cursor, limit);
    const messages = rows.map(formatBraiChatMessage);
    if (messages.length) {
      const placeholders = messages.map(() => '?').join(', ');
      const attachments = this.db.prepare(`
        SELECT * FROM brai_chat_attachments
        WHERE user_id = ? AND brai_chat_threads_id = ?
          AND brai_chat_messages_id IN (${placeholders})
        ORDER BY created_at_utc, id
      `).all(userId, threadId, ...messages.map((message) => message.id));
      const byMessage = Map.groupBy(attachments, (attachment) => attachment.brai_chat_messages_id);
      for (const message of messages) {
        message.attachments = (byMessage.get(message.id) || []).map(formatBraiChatAttachment);
      }
    }
    return page(messages, limit);
  },

  updateBraiChatMessage(messageId, input, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const current = this.db.prepare(`
      SELECT * FROM brai_chat_messages WHERE user_id = ? AND id = ?
    `).get(userId, messageId);
    if (!current) return null;
    const content = Object.hasOwn(input, 'content')
      ? (typeof input.content === 'string' ? input.content : null) : current.content;
    const status = Object.hasOwn(input, 'status') ? input.status : current.status;
    const turnId = Object.hasOwn(input, 'turn_id')
      ? nullableSetting(input.turn_id, 'invalid_turn_id') : current.turn_id;
    const dispatchStatus = Object.hasOwn(input, 'dispatch_status')
      ? input.dispatch_status : current.dispatch_status;
    if (content == null) throw chatError('invalid_message_content', 400);
    if (!MESSAGE_STATUSES.has(status)) throw chatError('invalid_message_status', 400);
    if (dispatchStatus != null && !DISPATCH_STATUSES.has(dispatchStatus)) {
      throw chatError('invalid_dispatch_status', 400);
    }
    this.db.prepare(`
      UPDATE brai_chat_messages SET content = ?, status = ?, turn_id = ?,
        dispatch_status = ?, updated_at_utc = ?
      WHERE user_id = ? AND id = ?
    `).run(content, status, turnId, dispatchStatus, nowIso, userId, messageId);
    return formatBraiChatMessage(this.db.prepare(`
      SELECT * FROM brai_chat_messages WHERE user_id = ? AND id = ?
    `).get(userId, messageId));
  },

  listBraiChatUndeliveredSteers(threadId, turnId) {
    return this.db.prepare(`
      SELECT * FROM brai_chat_messages
      WHERE user_id = ? AND brai_chat_threads_id = ? AND turn_id = ?
        AND role = 'user' AND dispatch_status IN ('pending', 'failed')
      ORDER BY sequence
    `).all(requireUser(), threadId, turnId).map(formatBraiChatMessage);
  },

  appendBraiChatEvent({
    id = crypto.randomUUID(), threadId, messageId = null, turnId = null,
    sourceEventId = null, idempotencyKey, type, safePayload = {},
    searchableText = '', truncated = false, messageProjection = null,
    nowIso = new Date().toISOString()
  }) {
    const userId = requireUser();
    const key = requiredText(idempotencyKey, 'invalid_idempotency_key', 200);
    const eventType = requiredText(type, 'invalid_event_type', 120);
    const payloadJson = JSON.stringify(safePayload ?? {});
    const searchText = typeof searchableText === 'string' ? searchableText : '';
    if (Buffer.byteLength(payloadJson) > MAX_EVENT_PAYLOAD_BYTES
      || Buffer.byteLength(searchText) > MAX_EVENT_TEXT_BYTES) {
      throw chatError('event_too_large', 413);
    }
    const insert = this.db.transaction(() => {
      const thread = this.db.prepare(`
        SELECT id FROM brai_chat_threads WHERE user_id = ? AND id = ? FOR UPDATE
      `).get(userId, threadId);
      if (!thread) return null;
      if (messageId && !this.db.prepare(`
        SELECT 1 FROM brai_chat_messages WHERE user_id = ? AND id = ? AND brai_chat_threads_id = ?
      `).get(userId, messageId, threadId)) return null;
      const existing = this.db.prepare(`
        SELECT * FROM brai_chat_events
        WHERE user_id = ? AND brai_chat_threads_id = ? AND idempotency_key = ?
      `).get(userId, threadId, key);
      let saved = existing;
      if (!saved) {
        const next = Number(this.db.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM brai_chat_events
          WHERE user_id = ? AND brai_chat_threads_id = ?
        `).get(userId, threadId).next);
        this.db.prepare(`
          INSERT INTO brai_chat_events (
            id, user_id, brai_chat_threads_id, brai_chat_messages_id, turn_id,
            source_event_id, idempotency_key, sequence, event_type, safe_payload_json,
            searchable_text, truncated, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
        `).run(id, userId, threadId, messageId, turnId, sourceEventId, key, next,
          eventType, payloadJson, searchText, Boolean(truncated), nowIso);
        saved = this.db.prepare('SELECT * FROM brai_chat_events WHERE user_id = ? AND id = ?').get(userId, id);
      }
      if (messageProjection && !this.putBraiChatMessage(messageProjection)) {
        throw chatError('message_projection_failed', 500);
      }
      return saved;
    })();
    return insert ? formatBraiChatEvent(insert) : null;
  },

  replayBraiChatEvents(threadId, { after = 0, limit = 200 } = {}) {
    const userId = requireUser();
    if (!ownedThread(this, threadId)) return null;
    const rows = this.db.prepare(`
      SELECT * FROM brai_chat_events
      WHERE user_id = ? AND brai_chat_threads_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(userId, threadId, after, limit);
    return page(rows.map(formatBraiChatEvent), limit);
  },

  addBraiChatAttachments(threadId, attachments, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    return this.db.transaction(() => {
      const thread = this.db.prepare(`
        SELECT id FROM brai_chat_threads WHERE user_id = ? AND id = ? FOR UPDATE
      `).get(userId, threadId);
      if (!thread) return null;
      return attachments.map((item) => {
        this.db.prepare(`
          INSERT INTO brai_chat_attachments (
            id, user_id, brai_chat_threads_id, brai_chat_messages_id, original_name,
            relative_path, verified_media_type, byte_size, checksum_sha256, created_at_utc
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        `).run(item.id, userId, threadId, item.original_name, item.relative_path,
          item.media_type, item.byte_size, item.checksum_sha256, nowIso);
        return this.getBraiChatAttachment(item.id);
      });
    })();
  },

  getBraiChatAttachment(attachmentId, { internal = false } = {}) {
    const userId = requireUser();
    const row = this.db.prepare(`
      SELECT * FROM brai_chat_attachments WHERE user_id = ? AND id = ?
    `).get(userId, attachmentId);
    if (!row) return null;
    return internal ? { ...formatBraiChatAttachment(row), relative_path: row.relative_path }
      : formatBraiChatAttachment(row);
  },

  getBraiChatAttachmentRecords(attachmentIds, { threadId = null } = {}) {
    const userId = requireUser();
    const ids = normalizedAttachmentIds(attachmentIds);
    if (!ids) return null;
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT * FROM brai_chat_attachments
      WHERE user_id = ? AND id IN (${placeholders})
    `).all(userId, ...ids);
    if (rows.length !== ids.length || (threadId && rows.some((row) => row.brai_chat_threads_id !== threadId))) {
      return null;
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => ({
      ...formatBraiChatAttachment(byId.get(id)),
      relative_path: byId.get(id).relative_path
    }));
  },

  deleteUnlinkedBraiChatAttachment(attachmentId) {
    const row = this.db.prepare(`
      DELETE FROM brai_chat_attachments
      WHERE user_id = ? AND id = ? AND brai_chat_messages_id IS NULL
      RETURNING *
    `).get(requireUser(), attachmentId);
    return row ? { ...formatBraiChatAttachment(row), relative_path: row.relative_path } : null;
  },

  takeStaleUnlinkedBraiChatAttachments(beforeIso, limit = 100) {
    const rows = this.db.prepare(`
      WITH stale AS (
        SELECT id FROM brai_chat_attachments
        WHERE user_id = ? AND brai_chat_messages_id IS NULL AND created_at_utc < ?
        ORDER BY created_at_utc, id LIMIT ? FOR UPDATE SKIP LOCKED
      )
      DELETE FROM brai_chat_attachments attachment USING stale
      WHERE attachment.id = stale.id
      RETURNING attachment.*
    `).all(requireUser(), beforeIso, limit);
    return rows.map((row) => ({
      ...formatBraiChatAttachment(row), relative_path: row.relative_path
    }));
  },

  linkBraiChatAttachments({ threadId, messageId, attachmentIds }) {
    const userId = requireUser();
    const ids = normalizedAttachmentIds(attachmentIds);
    if (!ids) return null;
    const link = runAtomic(this, () => {
      const thread = this.db.prepare(`
        SELECT id FROM brai_chat_threads WHERE user_id = ? AND id = ? FOR UPDATE
      `).get(userId, threadId);
      if (!thread) return false;
      const placeholders = ids.map(() => '?').join(', ');
      const attachments = this.db.prepare(`
        SELECT * FROM brai_chat_attachments
        WHERE user_id = ? AND brai_chat_threads_id = ? AND id IN (${placeholders})
        FOR UPDATE
      `).all(userId, threadId, ...ids);
      if (attachments.length !== ids.length || !this.db.prepare(`
        SELECT 1 FROM brai_chat_messages
        WHERE user_id = ? AND id = ? AND brai_chat_threads_id = ?
      `).get(userId, messageId, threadId)) return false;
      const totalBytes = attachments.reduce((total, item) => total + Number(item.byte_size), 0);
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ATTACHMENT_BYTES) {
        throw chatError('attachments_too_large', 413);
      }
      for (const attachment of attachments) {
        const result = this.db.prepare(`
          UPDATE brai_chat_attachments SET brai_chat_messages_id = ?
          WHERE user_id = ? AND id = ? AND brai_chat_threads_id = ?
            AND (brai_chat_messages_id IS NULL OR brai_chat_messages_id = ?)
        `).run(messageId, userId, attachment.id, threadId, messageId);
        if (!result.changes) throw chatError('not_found', 404);
      }
      return true;
    });
    try {
      if (!link()) return null;
      return ids.map((id) => this.getBraiChatAttachment(id));
    } catch (error) {
      if (error?.message === 'not_found') return null;
      throw error;
    }
  },

  putBraiChatUserMessageWithAttachments({ message, attachmentIds = [] }) {
    const ids = attachmentIds.length ? normalizedAttachmentIds(attachmentIds) : [];
    if (!ids) throw chatError('invalid_attachments', 400);
    return runAtomic(this, () => {
      const userId = requireUser();
      const thread = this.db.prepare(`
        SELECT id FROM brai_chat_threads WHERE user_id = ? AND id = ? FOR UPDATE
      `).get(userId, message.threadId);
      if (!thread) return null;
      const existing = this.getBraiChatMessage(message.threadId, message.id);
      const saved = this.putBraiChatMessage(message);
      if (!saved) return null;
      const linkedIds = () => this.db.prepare(`
        SELECT id FROM brai_chat_attachments
        WHERE user_id = ? AND brai_chat_threads_id = ? AND brai_chat_messages_id = ?
        ORDER BY created_at_utc, id
      `).all(userId, message.threadId, message.id).map((row) => row.id);
      if (existing) {
        const originalIds = linkedIds();
        if (ids.length && !sameValues(ids, originalIds)) {
          throw chatError('message_attachments_conflict', 409);
        }
        return { message: saved, attachmentIds: originalIds };
      }
      if (ids.length) {
        const linked = this.linkBraiChatAttachments({
          threadId: message.threadId, messageId: message.id, attachmentIds: ids
        });
        if (!linked || linked.length !== ids.length) throw chatError('attachment_not_found', 404);
      }
      return { message: saved, attachmentIds: linkedIds() };
    })();
  },

  searchBraiChat(query, { archived = 'all', limit = 20 } = {}) {
    const userId = requireUser();
    const text = typeof query === 'string' ? query.trim().slice(0, 300) : '';
    if (!text) return [];
    const archiveSql = archiveFilter(archived);
    return this.db.prepare(`
      WITH input AS (SELECT plainto_tsquery('simple', ?) AS q), matches AS (
        SELECT t.id AS thread_id, t.title AS thread_title, 'thread' AS source_type,
          t.id AS source_id, NULL::text AS message_id, NULL::text AS event_id,
          t.archived_at_utc,
          ts_headline('simple', t.title, input.q, 'MaxWords=24,MinWords=1,StartSel=<mark>,StopSel=</mark>') AS snippet,
          t.updated_at_utc AS created_at_utc,
          ts_rank(to_tsvector('simple', t.title), input.q) AS rank
        FROM brai_chat_threads t, input
        WHERE t.user_id = ? AND ${archiveSql} AND to_tsvector('simple', t.title) @@ input.q
        UNION ALL
        SELECT t.id, t.title, 'message', m.id, m.id, NULL, t.archived_at_utc,
          ts_headline('simple', m.content, input.q, 'MaxWords=24,MinWords=8,StartSel=<mark>,StopSel=</mark>'),
          m.created_at_utc, ts_rank(to_tsvector('simple', m.content), input.q)
        FROM brai_chat_messages m
        JOIN brai_chat_threads t ON t.user_id = m.user_id AND t.id = m.brai_chat_threads_id, input
        WHERE m.user_id = ? AND ${archiveSql} AND to_tsvector('simple', m.content) @@ input.q
        UNION ALL
        SELECT t.id, t.title, 'event', e.id, e.brai_chat_messages_id, e.id, t.archived_at_utc,
          ts_headline('simple', e.searchable_text, input.q, 'MaxWords=24,MinWords=8,StartSel=<mark>,StopSel=</mark>'),
          e.created_at_utc, ts_rank(to_tsvector('simple', e.searchable_text), input.q)
        FROM brai_chat_events e
        JOIN brai_chat_threads t ON t.user_id = e.user_id AND t.id = e.brai_chat_threads_id, input
        WHERE e.user_id = ? AND ${archiveSql} AND to_tsvector('simple', e.searchable_text) @@ input.q
      ) SELECT * FROM matches ORDER BY rank DESC, created_at_utc DESC, source_id LIMIT ?
    `).all(text, userId, userId, userId, limit).map(formatBraiChatSearchHit);
  }
};

export function formatBraiChatThread(row) {
  return {
    version: 1, id: row.id, title: row.title, model: row.model ?? null,
    reasoning_effort: row.reasoning_effort ?? null,
    archived_at_utc: row.archived_at_utc ?? null,
    active_turn_id: row.active_turn_id ?? null,
    created_at_utc: row.created_at_utc, updated_at_utc: row.updated_at_utc
  };
}

export function formatBraiChatMessage(row) {
  return {
    version: 1, id: row.id, thread_id: row.brai_chat_threads_id,
    turn_id: row.turn_id ?? null, role: row.role, content: row.content,
    status: row.status, sequence: Number(row.sequence), model: row.model ?? null,
    reasoning_effort: row.reasoning_effort ?? null,
    dispatch_status: row.dispatch_status ?? null,
    created_at_utc: row.created_at_utc, updated_at_utc: row.updated_at_utc
  };
}

export function formatBraiChatEvent(row) {
  return {
    version: 1, id: row.id, thread_id: row.brai_chat_threads_id,
    message_id: row.brai_chat_messages_id ?? null, turn_id: row.turn_id ?? null,
    sequence: Number(row.sequence), type: row.event_type,
    safe_payload: typeof row.safe_payload_json === 'string'
      ? JSON.parse(row.safe_payload_json) : row.safe_payload_json,
    truncated: Boolean(row.truncated), created_at_utc: row.created_at_utc
  };
}

export function formatBraiChatAttachment(row) {
  return {
    version: 1, id: row.id, thread_id: row.brai_chat_threads_id,
    message_id: row.brai_chat_messages_id ?? null, filename: row.original_name,
    media_type: row.verified_media_type, byte_size: Number(row.byte_size),
    checksum_sha256: row.checksum_sha256, created_at_utc: row.created_at_utc
  };
}

function formatBraiChatSearchHit(row) {
  return {
    version: 1, id: row.source_id, thread_id: row.thread_id, thread_title: row.thread_title,
    source_type: row.source_type, source_id: row.source_id,
    message_id: row.message_id ?? null, event_id: row.event_id ?? null,
    source_message_id: row.message_id ?? null, source_event_id: row.event_id ?? null,
    archived_at_utc: row.archived_at_utc ?? null,
    snippet: String(row.snippet ?? '').slice(0, 512), created_at_utc: row.created_at_utc
  };
}

function ownedThread(store, threadId) {
  return store.db.prepare('SELECT * FROM brai_chat_threads WHERE user_id = ? AND id = ?')
    .get(requireUser(), threadId);
}

function normalizedAttachmentIds(value) {
  const ids = [...new Set(Array.isArray(value) ? value : [])];
  if (ids.length === 0 || ids.length > 5
    || ids.some((id) => typeof id !== 'string' || !id.trim())) return null;
  return ids;
}

function tryAutoTitle(store, userId, threadId, content, nowIso) {
  try {
    const title = content.trim().replace(/\s+/g, ' ').split(' ').slice(0, 8).join(' ').slice(0, 80).trim();
    if (!title) return;
    store.db.prepare(`
      UPDATE brai_chat_threads SET title = ?, title_source = 'auto', updated_at_utc = ?
      WHERE user_id = ? AND id = ? AND title_source = 'default'
    `).run(title, nowIso, userId, threadId);
  } catch {
    // Title generation is best-effort and must never fail the accepted message.
  }
}

function page(items, limit) {
  const last = items.at(-1);
  return { items, next_cursor: items.length === limit ? String(last.sequence) : null };
}

function archiveFilter(value) {
  if (value === 'all') return 'TRUE';
  if (value === 'archived') return 't.archived_at_utc IS NOT NULL';
  if (value === 'active') return 't.archived_at_utc IS NULL';
  throw chatError('invalid_archive_filter', 400);
}

function requireUser() {
  const userId = scopedUserId();
  if (!userId) throw chatError('user_required', 401);
  return userId;
}

function requiredTitle(value) {
  const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!title || title.length > 80) throw chatError('invalid_title', 400);
  return title;
}

function requiredText(value, code, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw chatError(code, 400);
  return text;
}

function nullableSetting(value, code) {
  if (value == null) return null;
  return requiredText(value, code, 200);
}

function chatError(code, status) {
  const error = new Error(code);
  error.status = status;
  return error;
}

function runAtomic(store, fn) {
  return store.db.currentTxId ? fn : store.db.transaction(fn);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
