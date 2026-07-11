import {
  FUTURE_EVENT_TOLERANCE_MS,
  INBOX_EVENT_PAYLOAD_VERSION,
  INBOX_EVENT_TYPES,
  formatInboxItem,
  normalizeMarkdownSource,
  parseJsonArray,
  parseJsonObject,
  sanitizeText
} from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const inboxEventMethods = {
  listInbox() {
    const scope = scopeSql('i');
    return this.db
      .prepare(
        `
          SELECT i.*,
            w.status AS workflow_status,
            w.current_step AS workflow_step,
            w.attempt_count AS workflow_attempt_count,
            w.last_error AS workflow_last_error,
            w.workflow_id AS temporal_workflow_id,
            w.run_id AS temporal_run_id
          FROM inbox i
          LEFT JOIN workflow_executions w ON w.id = i.workflow_execution_id
          WHERE i.deleted_at_utc IS NULL
            ${scope.clause}
          ORDER BY i.created_at_utc DESC, i.updated_at_utc DESC, i.id ASC
        `
      )
      .all(...scope.params)
      .map(formatInboxItem);
  }
,

  getInboxServerRevision() {
    return this.getEventDomainRevision('inbox');
  }
,

  inboxIdForEvent(eventId) {
    const id = sanitizeText(eventId);
    if (!id) return null;
    const scope = scopeSql();
    return this.db
      .prepare(`SELECT subject_id AS inbox_id FROM events WHERE event_id = ? AND event_domain = 'inbox'${scope.clause}`)
      .get(id, ...scope.params)?.inbox_id ?? null;
  }
,

  getInboxItem(inboxId) {
    const id = sanitizeText(inboxId);
    if (!id) return null;
    const scope = scopeSql('i');
    return formatInboxItem(this.db
      .prepare(`
        SELECT i.*,
          w.status AS workflow_status,
          w.current_step AS workflow_step,
          w.attempt_count AS workflow_attempt_count,
          w.last_error AS workflow_last_error,
          w.workflow_id AS temporal_workflow_id,
          w.run_id AS temporal_run_id
        FROM inbox i
        LEFT JOIN workflow_executions w ON w.id = i.workflow_execution_id
        WHERE i.id = ? ${scope.clause}
      `)
      .get(id, ...scope.params));
  }
,

  getInboxIngestFingerprint(inboxId) {
    const id = sanitizeText(inboxId);
    if (!id) return null;
    const scope = scopeSql();
    return this.db.prepare(`
      SELECT ingest_payload_hash
      FROM inbox
      WHERE id = ? ${scope.clause}
    `).get(id, ...scope.params) ?? null;
  }
,

  latestInboxIdForInbox({ source, sourceKey }) {
    const scope = scopeSql();
    const cleanSourceKey = sanitizeText(sourceKey);
    if (cleanSourceKey) {
      return this.db
        .prepare(
          `
          SELECT id FROM inbox
          WHERE deleted_at_utc IS NULL
            AND source_key = ?
            ${scope.clause}
          ORDER BY created_at_utc DESC, updated_at_utc DESC
          LIMIT 1
        `
        )
        .get(cleanSourceKey, ...scope.params)?.id ?? null;
    }

    const cleanSource = sanitizeText(source);
    if (cleanSource) {
      return this.db
        .prepare(
          `
          SELECT id FROM inbox
          WHERE deleted_at_utc IS NULL
            AND source = ?
            ${scope.clause}
          ORDER BY created_at_utc DESC, updated_at_utc DESC
          LIMIT 1
        `
        )
        .get(cleanSource, ...scope.params)?.id ?? null;
    }

    return this.db
      .prepare(
        `
          SELECT id FROM inbox
          WHERE deleted_at_utc IS NULL
            ${scope.clause}
          ORDER BY created_at_utc DESC, updated_at_utc DESC
          LIMIT 1
        `
      )
      .get(...scope.params)?.id ?? null;
  }
,

  createInboxApiItem({
    eventId,
    inboxId,
    title,
    descriptionText,
    explanationText,
    attachmentLinks,
    source,
    sourceKey,
    responseRequired,
    relatedInboxId,
    recordTypeId,
    ingestIdempotencyHash,
    ingestPayloadHash,
    nowIso
  }) {
    const receivedAt = nowIso ?? new Date().toISOString();
    const deviceId = 'inbox-api';

    const run = this.db.transaction(() => {
      this.upsertDevice(
        {
          device_id: deviceId,
          platform: 'server',
          display_name: 'Inbox API'
        },
        receivedAt,
        { lastSyncAtUtc: receivedAt, lastServerClockOffsetMs: 0 }
      );

      const result = this.ingestInboxEvent(deviceId, {
        event_id: eventId,
        client_sequence: this.nextInboxClientSequence(deviceId),
        type: 'create',
        inbox_id: inboxId,
        occurred_at_utc: receivedAt,
        payload: {
          title,
          description_md: descriptionText,
          explanation_text: explanationText,
          attachment_links: attachmentLinks,
          source,
          source_key: sourceKey,
          response_required: responseRequired === true,
          related_inbox_id: relatedInboxId,
          record_type_id: recordTypeId,
          ingest_idempotency_hash: ingestIdempotencyHash,
          ingest_payload_hash: ingestPayloadHash
        }
      }, receivedAt);

      if (result.accepted_event) this.projectAcceptedInboxEvents([result.accepted_event], receivedAt);
      return result;
    });
    return run();
  }
,

  listInboxClasses() {
    return this.db
      .prepare(
        `
          SELECT key, title, description, status
          FROM inbox_classes
          WHERE status IN ('active', 'candidate')
          ORDER BY status ASC, title ASC, key ASC
        `
      )
      .all();
  }
,

  upsertInboxClass({ key, title, description = '', status = 'candidate', createdByAgentId = null, nowIso }) {
    const cleanKey = sanitizeClassKey(key);
    const cleanTitle = sanitizeText(title) ?? cleanKey;
    if (!cleanKey || !cleanTitle) return null;
    const cleanStatus = ['active', 'candidate', 'archived'].includes(status) ? status : 'candidate';
    const updatedAt = nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `
          INSERT INTO inbox_classes (
            key, title, description, status, created_by_agent_id, created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            status = CASE
              WHEN inbox_classes.status = 'active' THEN inbox_classes.status
              ELSE excluded.status
            END,
            updated_at_utc = excluded.updated_at_utc
        `
      )
      .run(
        cleanKey,
        cleanTitle,
        sanitizeText(description) ?? '',
        cleanStatus,
        sanitizeText(createdByAgentId),
        updatedAt,
        updatedAt
      );
    return cleanKey;
  }
,

  syncInboxEvents({ device, events, lastKnownServerTimeUtc = null, nowIso }) {
    const receivedAt = nowIso ?? new Date().toISOString();
    const deviceId = sanitizeText(device?.device_id);
    if (!deviceId) {
      const error = new Error('device_id_required');
      error.status = 400;
      throw error;
    }

    const platform = sanitizeText(device?.platform) ?? 'unknown';
    const displayName = sanitizeText(device?.display_name);
    const serverClockOffsetMs = Number.isFinite(Date.parse(lastKnownServerTimeUtc))
      ? Date.parse(receivedAt) - Date.parse(lastKnownServerTimeUtc)
      : null;
    const acknowledged = [];
    const ignored = [];
    const acceptedEvents = [];

    const run = this.db.transaction(() => {
      this.upsertDevice(
        {
          device_id: deviceId,
          platform,
          display_name: displayName
        },
        receivedAt,
        { lastSyncAtUtc: receivedAt, lastServerClockOffsetMs: serverClockOffsetMs }
      );

      for (const rawEvent of Array.isArray(events) ? events : []) {
        const result = this.ingestInboxEvent(deviceId, rawEvent, receivedAt);
        if (result.event_id) acknowledged.push(result.event_id);
        if (result.ignored) ignored.push(result.ignored);
        if (result.accepted_event) acceptedEvents.push(result.accepted_event);
      }

      this.projectAcceptedInboxEvents(acceptedEvents, receivedAt);
    });
    run();

    const serverRevision = this.getInboxServerRevision();
    recordInboxTechnicalLog(this, {
      dt: receivedAt,
      source: 'sync',
      operation: 'inbox.events_sync',
      status: 'done',
      eventDomain: 'inbox',
      deviceId,
      message: 'Inbox events sync',
      jsonData: {
        accepted_count: acceptedEvents.length,
        ignored_count: ignored.length,
        server_revision: serverRevision,
        platform
      }
    });
    return {
      server_revision: serverRevision,
      server_time_utc: receivedAt,
      acknowledged_event_ids: acknowledged,
      ignored_events: ignored
    };
  }
,

  ingestInboxEvent(deviceId, rawEvent, receivedAt) {
    const eventId = sanitizeText(rawEvent?.event_id);
    if (!eventId) return { event_id: null };

    const existing = this.existingEvent('inbox', eventId) ?? this.existingIgnoredEvent('inbox', eventId);
    if (existing) {
      return {
        event_id: eventId,
        ignored:
          existing.ignore_reason
            ? { event_id: eventId, reason: existing.ignore_reason ?? 'ignored' }
            : null
      };
    }

    const clientSequence = Number(rawEvent?.client_sequence);
    if (!Number.isInteger(clientSequence)) {
      this.insertIgnoredInboxEvent({
        eventId,
        deviceId,
        clientSequence: this.nextInvalidInboxClientSequence(deviceId),
        receivedAt,
        reason: 'invalid_client_sequence',
        rawEvent
      });
      return { event_id: eventId, ignored: { event_id: eventId, reason: 'invalid_client_sequence' } };
    }

    const existingSequence = this.existingDeviceSequence('inbox', deviceId, clientSequence);
    if (existingSequence) {
      return {
        event_id: eventId,
        ignored: { event_id: eventId, reason: 'duplicate_client_sequence' }
      };
    }

    const rawType = sanitizeText(rawEvent?.type);
    const inboxId = sanitizeText(rawEvent?.inbox_id);
    const occurredMs = Date.parse(rawEvent?.occurred_at_utc);
    const payload = normalizeInboxPayload(rawEvent?.payload);
    let type = rawType;
    let status = 'accepted';
    let ignoreReason = null;
    let occurredAt = rawEvent?.occurred_at_utc;

    if (!INBOX_EVENT_TYPES.has(rawType)) {
      type = 'invalid';
      status = 'ignored';
      ignoreReason = 'invalid_type';
      occurredAt = receivedAt;
      payload.raw_type = rawType;
    } else if (!inboxId) {
      status = 'ignored';
      ignoreReason = 'inbox_id_required';
      occurredAt = Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : receivedAt;
    } else if (rawType === 'create' && inboxOwnerDiffers(this, inboxId)) {
      status = 'ignored';
      ignoreReason = 'inbox_id_conflict';
      occurredAt = Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : receivedAt;
    } else if (!Number.isFinite(occurredMs)) {
      status = 'ignored';
      ignoreReason = 'invalid_timestamp';
      occurredAt = receivedAt;
      payload.raw_occurred_at_utc = rawEvent?.occurred_at_utc;
    } else if (occurredMs - Date.parse(receivedAt) > FUTURE_EVENT_TOLERANCE_MS) {
      status = 'ignored';
      ignoreReason = 'future_timestamp';
      occurredAt = new Date(occurredMs).toISOString();
    } else if ((rawType === 'create' || rawType === 'update_title') && !sanitizeText(payload.title)) {
      status = 'ignored';
      ignoreReason = 'title_required';
      occurredAt = new Date(occurredMs).toISOString();
    } else if (rawType === 'update_description' && typeof payload.description_md !== 'string') {
      status = 'ignored';
      ignoreReason = 'description_required';
      occurredAt = new Date(occurredMs).toISOString();
    } else {
      occurredAt = new Date(occurredMs).toISOString();
      if (payload.title) payload.title = sanitizeText(payload.title);
      if (typeof payload.description_md === 'string') {
        payload.description_md = normalizeMarkdownSource(payload.description_md);
      }
      if (rawType === 'normalize') {
        if (payload.preliminary_section) payload.preliminary_section = sanitizeClassKey(payload.preliminary_section);
        if (typeof payload.normalization_text === 'string') {
          payload.normalization_text = normalizeMarkdownSource(payload.normalization_text);
        }
        if (payload.is_normalized !== undefined) payload.is_normalized = normalizeBoolean(payload.is_normalized);
      }
    }

    const serverSequence = this.insertInboxEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      inbox_id: inboxId,
      type,
      occurred_at_utc: occurredAt,
      received_at_utc: receivedAt,
      payload_json: JSON.stringify(payload),
      status,
      ignore_reason: ignoreReason,
      payload_version: INBOX_EVENT_PAYLOAD_VERSION
    });

    return {
      event_id: eventId,
      ignored: ignoreReason ? { event_id: eventId, reason: ignoreReason } : null,
      accepted_event:
        status === 'accepted' && serverSequence
          ? {
              event_id: eventId,
              inbox_id: inboxId,
              type,
              occurred_at_utc: occurredAt,
              server_sequence: serverSequence,
              payload_json: JSON.stringify(payload)
            }
          : null
    };
  }
,

  insertIgnoredInboxEvent({ eventId, deviceId, clientSequence, receivedAt, reason, rawEvent }) {
    this.insertInboxEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      inbox_id: sanitizeText(rawEvent?.inbox_id),
      type: 'invalid',
      occurred_at_utc: receivedAt,
      received_at_utc: receivedAt,
      payload_json: JSON.stringify({ raw_event: rawEvent }),
      status: 'ignored',
      ignore_reason: reason,
      payload_version: INBOX_EVENT_PAYLOAD_VERSION
    });
  }
,

  insertInboxEvent(event) {
    if (event.status === 'ignored') {
      this.recordSyncIgnoredEvent({
        domain: 'inbox',
        eventId: event.event_id,
        deviceId: event.device_id,
        clientSequence: event.client_sequence,
        receivedAt: event.received_at_utc,
        reason: event.ignore_reason ?? 'ignored',
        rawEvent: parseJsonObject(event.payload_json).raw_event ?? event
      });
    }
    const linked = event.inbox_id ? this.getInboxItem(event.inbox_id) : null;
    return this.insertEventRecord({
      eventId: event.event_id,
      eventDomain: 'inbox',
      eventType: event.type,
      eventAction: `inbox.${event.type}`,
      title: `Inbox ${event.type}`,
      itemsId: linked?.item_roles_id ? event.inbox_id : null,
      itemRolesId: linked?.item_roles_id ?? null,
      subjectType: 'inbox',
      subjectId: event.inbox_id,
      actorType: event.device_id === 'inbox-ai' ? 'agent' : 'user',
      actorId: event.device_id,
      deviceId: event.device_id,
      clientSequence: event.client_sequence,
      occurredAtUtc: event.occurred_at_utc,
      receivedAtUtc: event.received_at_utc,
      status: event.status,
      ignoreReason: event.ignore_reason,
      payloadVersion: event.payload_version,
      payloadJson: event.payload_json ?? '{}'
    });
  }
,

  nextInboxServerSequence() {
    return this.nextPostgresCounter('events.domain_sequence.inbox');
  }
,

  nextInvalidInboxClientSequence(deviceId) {
    return -this.nextPostgresCounter(`events.invalid_client_sequence.${deviceId}`);
  }
,

  nextInboxClientSequence(deviceId) {
    return this.nextPostgresCounter(`events.client_sequence.${deviceId}`);
  }
,

  projectAcceptedInboxEvents(events, nowIso) {
    const inboxIds = new Set(events.map((event) => event.inbox_id).filter(Boolean));
    for (const inboxId of inboxIds) this.projectInboxItem(inboxId, nowIso);
    for (const event of events) {
      if (event.type === 'create' && event.inbox_id) {
        this.ensureInboxWorkflowExecution({ inboxId: event.inbox_id, nowIso });
      }
    }
  }
,

  projectInboxItem(inboxId, nowIso) {
    const scope = scopeSql();
    const events = this.db
      .prepare(
        `
          SELECT id, event_id, device_id, subject_id AS inbox_id, event_type AS type,
            occurred_at_utc, received_at_utc, domain_sequence AS server_sequence, payload_json, user_id
          FROM events
          WHERE event_domain = 'inbox'
            AND status = 'accepted'
            AND subject_id = ?
            ${scope.clause}
          ORDER BY occurred_at_utc ASC, domain_sequence ASC
        `
      )
      .all(inboxId, ...scope.params);

    let item = null;

    for (const event of events) {
      const payload = parseJsonObject(event.payload_json);

      if (event.type === 'create') {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        const uiEvent = event.device_id !== 'inbox-api';
        item = {
          id: inboxId,
          title,
          description_text: normalizeMarkdownSource(payload.description_md ?? item?.description_text ?? ''),
          source: sanitizeText(payload.source) ?? item?.source ?? (uiEvent ? 'brai-app' : ''),
          source_key: sanitizeText(payload.source_key) ?? item?.source_key ?? (uiEvent ? event.device_id : ''),
          response_required: normalizeBoolean(payload.response_required) ? 1 : 0,
          related_inbox_id: sanitizeText(payload.related_inbox_id) ?? item?.related_inbox_id ?? null,
          record_type_id: normalizeInboxRecordTypeId(payload.record_type_id, item?.record_type_id ?? 4),
          item_date: item?.item_date ?? null,
          author: item?.author ?? '',
          preliminary_section: item?.preliminary_section ?? '',
          urgency: item?.urgency ?? '',
          attachment_links_json: JSON.stringify(normalizeStringList(
            payload.attachment_links,
            item?.attachment_links_json
          )),
          explanation_text: typeof payload.explanation_text === 'string'
            ? normalizeMarkdownSource(payload.explanation_text)
            : item?.explanation_text ?? (uiEvent ? normalizeMarkdownSource(title) : ''),
          normalization_text: item?.normalization_text ?? '',
          is_normalized: item?.is_normalized ?? 0,
          initial_event_id: item?.initial_event_id ?? event.id,
          ingest_idempotency_hash: event.device_id === 'inbox-api'
            ? sanitizeText(payload.ingest_idempotency_hash) ?? item?.ingest_idempotency_hash ?? null
            : item?.ingest_idempotency_hash ?? null,
          ingest_payload_hash: event.device_id === 'inbox-api'
            ? sanitizeText(payload.ingest_payload_hash) ?? item?.ingest_payload_hash ?? null
            : item?.ingest_payload_hash ?? null,
          created_at_utc: item?.created_at_utc ?? event.occurred_at_utc,
          updated_at_utc: event.occurred_at_utc,
          deleted_at_utc: null,
          last_event_id: event.event_id
        };
      } else if (event.type === 'update_title' && item) {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        item.title = title;
        item.updated_at_utc = event.occurred_at_utc;
        item.last_event_id = event.event_id;
      } else if (event.type === 'update_description' && item) {
        item.description_text = normalizeMarkdownSource(payload.description_md ?? '');
        item.updated_at_utc = event.occurred_at_utc;
        item.last_event_id = event.event_id;
      } else if ((event.type === 'normalize' || event.type === 'normalized') && item) {
        const title = sanitizeText(payload.title);
        if (title) item.title = title;
        if (typeof payload.description_md === 'string') {
          item.description_text = normalizeMarkdownSource(payload.description_md);
        }
        if (payload.preliminary_section) {
          item.preliminary_section = sanitizeClassKey(payload.preliminary_section);
        }
        if (typeof payload.normalization_text === 'string') {
          item.normalization_text = normalizeMarkdownSource(payload.normalization_text);
        }
        if (payload.is_normalized !== undefined) {
          item.is_normalized = normalizeBoolean(payload.is_normalized) ? 1 : 0;
        }
        item.updated_at_utc = event.occurred_at_utc;
        item.last_event_id = event.event_id;
      } else if (event.type === 'delete' && item) {
        item.deleted_at_utc = event.occurred_at_utc;
        item.updated_at_utc = event.occurred_at_utc;
        item.last_event_id = event.event_id;
      }
    }

    if (!item) {
      this.db.prepare(`DELETE FROM inbox WHERE id = ?${scope.clause}`).run(inboxId, ...scope.params);
      return;
    }

    this.db
      .prepare(
        `
          INSERT INTO inbox (
            id, title, description_text, source, source_key, response_required,
            related_inbox_id, record_type_id, item_date, author, preliminary_section,
            urgency, attachment_links_json, explanation_text, normalization_text,
            is_normalized, created_at_utc, updated_at_utc, deleted_at_utc, last_event_id,
            initial_event_id, ingest_idempotency_hash, ingest_payload_hash, user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            description_text = excluded.description_text,
            source = excluded.source,
            source_key = excluded.source_key,
            response_required = excluded.response_required,
            related_inbox_id = excluded.related_inbox_id,
            record_type_id = excluded.record_type_id,
            item_date = excluded.item_date,
            author = excluded.author,
            preliminary_section = excluded.preliminary_section,
            urgency = excluded.urgency,
            attachment_links_json = excluded.attachment_links_json,
            explanation_text = excluded.explanation_text,
            normalization_text = excluded.normalization_text,
            is_normalized = excluded.is_normalized,
            created_at_utc = excluded.created_at_utc,
            updated_at_utc = excluded.updated_at_utc,
            deleted_at_utc = excluded.deleted_at_utc,
            last_event_id = excluded.last_event_id,
            initial_event_id = COALESCE(inbox.initial_event_id, excluded.initial_event_id),
            ingest_idempotency_hash = COALESCE(inbox.ingest_idempotency_hash, excluded.ingest_idempotency_hash),
            ingest_payload_hash = COALESCE(inbox.ingest_payload_hash, excluded.ingest_payload_hash)
          WHERE inbox.user_id IS NOT DISTINCT FROM excluded.user_id
            OR inbox.user_id IS NULL
            OR excluded.user_id IS NULL
        `
      )
      .run(
        item.id,
        item.title,
        item.description_text ?? '',
        item.source ?? '',
        item.source_key ?? '',
        item.response_required === 1 ? 1 : 0,
        item.related_inbox_id ?? null,
        item.record_type_id ?? 4,
        item.item_date ?? null,
        item.author ?? '',
        item.preliminary_section ?? '',
        item.urgency ?? '',
        item.attachment_links_json ?? '[]',
        item.explanation_text ?? '',
        item.normalization_text ?? '',
        item.is_normalized === 1 ? 1 : 0,
        item.created_at_utc,
        item.updated_at_utc ?? nowIso,
        item.deleted_at_utc ?? null,
        item.last_event_id ?? null,
        item.initial_event_id ?? null,
        item.ingest_idempotency_hash ?? null,
        item.ingest_payload_hash ?? null,
        scopedUserId()
      );
  }
};

function normalizeInboxPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

function normalizeStringList(value, fallbackJson = '[]') {
  const raw = Array.isArray(value) ? value : parseJsonArray(fallbackJson);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of raw) {
    const text = sanitizeText(entry);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === 'true';
}

function normalizeInboxRecordTypeId(value, fallback = 4) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 4 ? number : fallback;
}

function sanitizeClassKey(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{1,62}$/.test(text) ? text : '';
}

function inboxOwnerDiffers(store, inboxId) {
  const existing = store.db.prepare('SELECT user_id FROM inbox WHERE id = ?').get(inboxId);
  return Boolean(existing) && existing.user_id !== scopedUserId();
}

export function recordInboxTechnicalLog(store, input) {
  try {
    store.recordLog(input);
  } catch (error) {
    try {
      (store.logger ?? console).error?.('Inbox technical log failed', {
        operation: input.operation,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {}
  }
}
