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

export const inboxEventMethods = {
  listInbox() {
    return this.db
      .prepare(
        `
          SELECT * FROM inbox
          WHERE deleted_at_utc IS NULL
          ORDER BY created_at_utc DESC, updated_at_utc DESC, id ASC
        `
      )
      .all()
      .map(formatInboxItem);
  }
,

  getInboxServerRevision() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) AS revision FROM inbox_events')
      .get();
    return row.revision;
  }
,

  inboxIdForEvent(eventId) {
    const id = sanitizeText(eventId);
    if (!id) return null;
    return this.db
      .prepare('SELECT inbox_id FROM inbox_events WHERE event_id = ?')
      .get(id)?.inbox_id ?? null;
  }
,

  latestInboxIdForInbound({ source, sourceKey }) {
    const cleanSourceKey = sanitizeText(sourceKey);
    if (cleanSourceKey) {
      return this.db
        .prepare(
          `
            SELECT id FROM inbox
            WHERE deleted_at_utc IS NULL
              AND source_key = ?
            ORDER BY created_at_utc DESC, updated_at_utc DESC
            LIMIT 1
          `
        )
        .get(cleanSourceKey)?.id ?? null;
    }

    const cleanSource = sanitizeText(source);
    if (cleanSource) {
      return this.db
        .prepare(
          `
            SELECT id FROM inbox
            WHERE deleted_at_utc IS NULL
              AND source = ?
            ORDER BY created_at_utc DESC, updated_at_utc DESC
            LIMIT 1
          `
        )
        .get(cleanSource)?.id ?? null;
    }

    return this.db
      .prepare(
        `
          SELECT id FROM inbox
          WHERE deleted_at_utc IS NULL
          ORDER BY created_at_utc DESC, updated_at_utc DESC
          LIMIT 1
        `
      )
      .get()?.id ?? null;
  }
,

  createInboundInboxItem({
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
    nowIso
  }) {
    const receivedAt = nowIso ?? new Date().toISOString();
    const deviceId = 'inbound-api';

    const run = this.db.transaction(() => {
      this.upsertDevice(
        {
          device_id: deviceId,
          platform: 'server',
          display_name: 'Inbound API'
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
          record_type_id: recordTypeId
        }
      }, receivedAt);

      if (result.accepted_event) this.projectAcceptedInboxEvents([result.accepted_event], receivedAt);
      return result;
    });
    return run();
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

    return {
      server_revision: this.getInboxServerRevision(),
      server_time_utc: receivedAt,
      acknowledged_event_ids: acknowledged,
      ignored_events: ignored
    };
  }
,

  ingestInboxEvent(deviceId, rawEvent, receivedAt) {
    const eventId = sanitizeText(rawEvent?.event_id);
    if (!eventId) return { event_id: null };

    const existing = this.db
      .prepare('SELECT event_id, status, ignore_reason FROM inbox_events WHERE event_id = ?')
      .get(eventId);
    if (existing) {
      return {
        event_id: eventId,
        ignored:
          existing.status === 'ignored'
            ? { event_id: eventId, reason: existing.ignore_reason ?? 'ignored' }
            : null
      };
    }

    const clientSequence = Number(rawEvent?.client_sequence);
    if (!Number.isInteger(clientSequence)) {
      this.insertIgnoredInboxEvent({
        eventId,
        deviceId,
        clientSequence: -this.nextInboxServerSequence(),
        receivedAt,
        reason: 'invalid_client_sequence',
        rawEvent
      });
      return { event_id: eventId, ignored: { event_id: eventId, reason: 'invalid_client_sequence' } };
    }

    const existingSequence = this.db
      .prepare('SELECT event_id FROM inbox_events WHERE device_id = ? AND client_sequence = ?')
      .get(deviceId, clientSequence);
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
    const serverSequence = this.nextInboxServerSequence();
    const result = this.db
      .prepare(
        `
          INSERT INTO inbox_events (
            event_id, device_id, client_sequence, server_sequence, inbox_id,
            type, occurred_at_utc, received_at_utc, payload_json,
            status, ignore_reason, payload_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING
        `
      )
      .run(
        event.event_id,
        event.device_id,
        event.client_sequence,
        serverSequence,
        event.inbox_id ?? null,
        event.type,
        event.occurred_at_utc,
        event.received_at_utc,
        event.payload_json ?? null,
        event.status,
        event.ignore_reason ?? null,
        event.payload_version
      );
    return result.changes > 0 ? serverSequence : null;
  }
,

  nextInboxServerSequence() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) + 1 AS next FROM inbox_events')
      .get();
    return row.next;
  }
,

  nextInboxClientSequence(deviceId) {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(client_sequence), 0) + 1 AS next FROM inbox_events WHERE device_id = ?')
      .get(deviceId);
    return row.next;
  }
,

  projectAcceptedInboxEvents(events, nowIso) {
    const inboxIds = new Set(events.map((event) => event.inbox_id).filter(Boolean));
    for (const inboxId of inboxIds) this.projectInboxItem(inboxId, nowIso);
  }
,

  projectInboxItem(inboxId, nowIso) {
    const events = this.db
      .prepare(
        `
          SELECT * FROM inbox_events
          WHERE status = 'accepted'
            AND inbox_id = ?
          ORDER BY occurred_at_utc ASC, server_sequence ASC
        `
      )
      .all(inboxId);

    let item = null;

    for (const event of events) {
      const payload = parseJsonObject(event.payload_json);

      if (event.type === 'create') {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        item = {
          id: inboxId,
          title,
          description_text: normalizeMarkdownSource(payload.description_md ?? item?.description_text ?? ''),
          source: sanitizeText(payload.source) ?? item?.source ?? '',
          source_key: sanitizeText(payload.source_key) ?? item?.source_key ?? '',
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
            : item?.explanation_text ?? '',
          normalization_text: item?.normalization_text ?? '',
          is_normalized: item?.is_normalized ?? 0,
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
      } else if (event.type === 'delete' && item) {
        item.deleted_at_utc = event.occurred_at_utc;
        item.updated_at_utc = event.occurred_at_utc;
        item.last_event_id = event.event_id;
      }
    }

    if (!item) {
      this.db.prepare('DELETE FROM inbox WHERE id = ?').run(inboxId);
      return;
    }

    this.db
      .prepare(
        `
          INSERT INTO inbox (
            id, title, description_text, source, source_key, response_required,
            related_inbox_id, record_type_id, item_date, author, preliminary_section,
            urgency, attachment_links_json, explanation_text, normalization_text,
            is_normalized, created_at_utc, updated_at_utc, deleted_at_utc, last_event_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            last_event_id = excluded.last_event_id
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
        item.last_event_id ?? null
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
