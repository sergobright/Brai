import { parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

const LOG_RETENTION_DAYS = 180;
const MAX_LOG_LIMIT = 500;

export const eventsLogsMethods = {
  insertEventRecord(event) {
    const eventDomain = sanitizeText(event.eventDomain);
    const eventType = sanitizeText(event.eventType);
    const rawEventId = sanitizeText(event.eventId) ?? sanitizeText(event.id);
    if (!rawEventId || !eventDomain || !eventType) return null;
    const id = sanitizeText(event.id) ?? `${eventDomain}:${rawEventId}`;
    const requestedItemsId = sanitizeText(event.itemsId);
    const itemsId = requestedItemsId
      ? this.db.prepare('SELECT id FROM items WHERE id = ?').get(requestedItemsId)?.id ?? null
      : null;
    const subjectType = sanitizeText(event.subjectType) ?? eventDomain;
    const itemRolesId = Number.isInteger(event.itemRolesId)
      ? event.itemRolesId
      : itemsId
        ? this.db.prepare(`
            SELECT r.id
            FROM item_roles r
            JOIN item_role_types t ON t.id = r.item_role_types_id
            WHERE r.items_id = ? AND r.status = 'active' AND t.title_system = ?
            LIMIT 1
          `).get(itemsId, subjectType)?.id ?? null
        : null;
    const domainSequence = event.domainSequence ?? this.nextPostgresCounter(`events.domain_sequence.${eventDomain}`);
    const serverSequence = event.serverSequence ?? this.nextPostgresCounter('events.server_sequence');
    const result = this.db.prepare(`
      INSERT INTO events (
        id, event_domain, event_id, event_type, event_action, title, items_id, item_roles_id, subject_type, subject_id,
        actor_type, actor_id, device_id, client_sequence, server_sequence, domain_sequence, status, ignore_reason,
        occurred_at_utc, received_at_utc, base_server_revision, payload_version, payload_json,
        trace_id, created_at_utc, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      id,
      eventDomain,
      rawEventId,
      eventType,
      sanitizeText(event.eventAction) ?? `${eventDomain}.${eventType}`,
      sanitizeText(event.title) ?? `${eventDomain}.${eventType}`,
      itemsId,
      itemRolesId,
      subjectType,
      sanitizeText(event.subjectId),
      sanitizeText(event.actorType) ?? 'user',
      sanitizeText(event.actorId),
      sanitizeText(event.deviceId),
      Number.isInteger(event.clientSequence) ? event.clientSequence : null,
      serverSequence,
      domainSequence,
      sanitizeText(event.status) ?? 'accepted',
      sanitizeText(event.ignoreReason),
      event.occurredAtUtc,
      event.receivedAtUtc,
      Number.isInteger(event.baseServerRevision) ? event.baseServerRevision : null,
      Number.isInteger(event.payloadVersion) ? event.payloadVersion : 1,
      event.payloadJson ?? '{}',
      sanitizeText(event.traceId),
      event.createdAtUtc ?? event.receivedAtUtc ?? new Date().toISOString(),
      scopedUserId()
    );
    return result.changes > 0 ? domainSequence : null;
  },

  getEventDomainRevision(domain) {
    const scope = scopeSql();
    const row = this.db
      .prepare(`
        SELECT COALESCE(MAX(domain_sequence), 0) AS revision
        FROM events
        WHERE event_domain = ?
          ${scope.clause}
      `)
      .get(domain, ...scope.params);
    return row.revision;
  },

  existingEvent(domain, id) {
    const row = this.db.prepare('SELECT event_id, status, ignore_reason FROM events WHERE event_domain = ? AND event_id = ?').get(domain, id);
    return row
      ? { event_id: row.event_id, ignore_reason: row.status === 'ignored' ? row.ignore_reason ?? 'ignored' : null }
      : null;
  },

  existingIgnoredEvent(domain, id) {
    const row = this.db
      .prepare("SELECT event_id, reason FROM logs WHERE event_domain = ? AND event_id = ? AND operation = 'sync.event_ignored' ORDER BY id DESC LIMIT 1")
      .get(domain, id);
    return row ? { event_id: row.event_id, ignore_reason: row.reason ?? 'ignored' } : null;
  },

  existingDeviceSequence(domain, deviceId, clientSequence) {
    return this.db.prepare(`
      SELECT id FROM events WHERE event_domain = ? AND device_id = ? AND client_sequence = ?
      UNION ALL
      SELECT event_id AS id FROM logs WHERE event_domain = ? AND device_id = ? AND client_sequence = ? AND event_id IS NOT NULL
      LIMIT 1
    `).get(domain, deviceId, clientSequence, domain, deviceId, clientSequence) ?? null;
  },

  recordSyncIgnoredEvent({ domain, eventId, deviceId, clientSequence, receivedAt, reason, rawEvent }) {
    this.recordLog({
      dt: receivedAt,
      source: 'sync',
      operation: 'sync.event_ignored',
      status: 'skipped',
      severityText: 'WARN',
      eventId,
      eventDomain: domain,
      deviceId,
      clientSequence,
      reason,
      message: `${domain}.${reason}`,
      jsonData: ignoredEventSummary(domain, rawEvent)
    });
  },

  recordLog(input = {}) {
    const dt = input.dt ?? new Date().toISOString();
    const expiresAt = input.expiresAtUtc ?? new Date(Date.parse(dt) + LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO logs (
        trace_id, span_id, parent_span_id, dt, observed_at_utc, severity_text, severity_number,
        service, source, operation, status, duration_ms, user_id, items_id, event_domain, event_id, device_id,
        client_sequence, reason, message, json_data, expires_at_utc, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sanitizeText(input.traceId),
      sanitizeText(input.spanId),
      sanitizeText(input.parentSpanId),
      dt,
      input.observedAtUtc ?? new Date().toISOString(),
      sanitizeText(input.severityText) ?? (input.status === 'failed' ? 'ERROR' : 'INFO'),
      Number.isInteger(input.severityNumber) ? input.severityNumber : null,
      sanitizeText(input.service) ?? 'brai-api',
      sanitizeText(input.source) ?? 'runtime',
      sanitizeText(input.operation) ?? 'runtime.event',
      sanitizeText(input.status) ?? 'done',
      Number.isInteger(input.durationMs) ? input.durationMs : null,
      input.userId === undefined ? scopedUserId() : sanitizeText(input.userId),
      sanitizeText(input.itemsId),
      sanitizeText(input.eventDomain),
      sanitizeText(input.eventId),
      sanitizeText(input.deviceId),
      Number.isInteger(input.clientSequence) ? input.clientSequence : null,
      sanitizeText(input.reason),
      sanitizeText(input.message) ?? '',
      JSON.stringify(input.jsonData ?? {}),
      expiresAt,
      input.createdAtUtc ?? new Date().toISOString()
    );
  },

  listEvents({ limit = 100 } = {}) {
    const rowLimit = boundedLimit(limit);
    const scope = scopeSql();
    return this.db.prepare(`
      SELECT *
      FROM events
      WHERE 1 = 1
        ${scope.clause}
      ORDER BY occurred_at_utc DESC, server_sequence DESC
      LIMIT ?
    `).all(...scope.params, rowLimit).map((row) => ({ ...row, payload_json: parseJsonObject(row.payload_json) }));
  },

  listLogs({ limit = 100 } = {}) {
    const rowLimit = boundedLimit(limit);
    const scope = scopeSql();
    return this.db.prepare(`
      SELECT *
      FROM logs
      WHERE (user_id IS NULL OR ${scope.where})
      ORDER BY dt DESC, id DESC
      LIMIT ?
    `).all(...scope.params, rowLimit).map((row) => ({ ...row, json_data: parseJsonObject(row.json_data) }));
  },

  purgeExpiredLogs(nowIso = new Date().toISOString()) {
    return this.db.prepare('DELETE FROM logs WHERE expires_at_utc <= ?').run(nowIso).changes;
  }
};

function boundedLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 100, MAX_LOG_LIMIT));
}

function ignoredEventSummary(domain, rawEvent) {
  const event = rawEvent && typeof rawEvent === 'object' && !Array.isArray(rawEvent) ? rawEvent : {};
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : null;
  return {
    domain,
    type: sanitizeText(event.type) ?? sanitizeText(event.change_type) ?? null,
    has_payload: Boolean(payload),
    payload_keys: payload ? Object.keys(payload).sort().slice(0, 20) : [],
    raw_key_count: Object.keys(event).length
  };
}
