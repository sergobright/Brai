import {
  ACTIVITY_EVENT_PAYLOAD_VERSION,
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_STATUSES,
  FUTURE_EVENT_TOLERANCE_MS,
  formatActivity,
  normalizeActionPayload,
  normalizeMarkdownSource,
  normalizeOrderedIds,
  parseJsonObject,
  sanitizeText
} from './store-helpers.js';

export const activityEventMethods = {
  listActivities() {
    return this.db
      .prepare(
        `
          SELECT * FROM activities
          WHERE deleted_at_utc IS NULL
          ORDER BY
            CASE status WHEN 'New' THEN 0 ELSE 1 END ASC,
            CASE status WHEN 'New' THEN CASE WHEN sort_order IS NULL THEN 0 ELSE 1 END END ASC,
            CASE WHEN status = 'New' AND sort_order IS NULL THEN COALESCE(restored_at_utc, created_at_utc) END DESC,
            CASE status WHEN 'New' THEN sort_order END ASC,
            CASE status WHEN 'Done' THEN completed_at_utc END DESC,
            updated_at_utc DESC,
            id ASC
        `
      )
      .all()
      .map(formatActivity);
  }
,

  listArchivedActivities() {
    return this.db
      .prepare(
        `
          SELECT * FROM activities
          WHERE deleted_at_utc IS NOT NULL
          ORDER BY deleted_at_utc DESC, updated_at_utc DESC, id ASC
        `
      )
      .all()
      .map(formatActivity);
  }
,

  getActivityServerRevision() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) AS revision FROM activity_events')
      .get();
    return row.revision;
  }
,

  syncActivityEvents({ device, events, lastKnownServerTimeUtc = null, nowIso }) {
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
        const result = this.ingestActivityEvent(deviceId, rawEvent, receivedAt);
        if (result.event_id) acknowledged.push(result.event_id);
        if (result.ignored) ignored.push(result.ignored);
      }

      this.recomputeActivities(receivedAt);
    });
    run();

    return {
      server_revision: this.getActivityServerRevision(),
      server_time_utc: receivedAt,
      acknowledged_event_ids: acknowledged,
      ignored_events: ignored
    };
  }
,

  ingestActivityEvent(deviceId, rawEvent, receivedAt) {
    const eventId = sanitizeText(rawEvent?.event_id);
    if (!eventId) return { event_id: null };

    const existing = this.db
      .prepare('SELECT event_id, status, ignore_reason FROM activity_events WHERE event_id = ?')
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
      this.insertIgnoredActivityEvent({
        eventId,
        deviceId,
        clientSequence: -this.nextActivityServerSequence(),
        receivedAt,
        reason: 'invalid_client_sequence',
        rawEvent
      });
      return { event_id: eventId, ignored: { event_id: eventId, reason: 'invalid_client_sequence' } };
    }

    const existingSequence = this.db
      .prepare(
        'SELECT event_id FROM activity_events WHERE device_id = ? AND client_sequence = ?'
      )
      .get(deviceId, clientSequence);
    if (existingSequence) {
      return {
        event_id: eventId,
        ignored: { event_id: eventId, reason: 'duplicate_client_sequence' }
      };
    }

    const rawType = sanitizeText(rawEvent?.type);
    const activityId = sanitizeText(rawEvent?.activity_id) ?? sanitizeText(rawEvent?.action_id);
    const occurredMs = Date.parse(rawEvent?.occurred_at_utc);
    const payload = normalizeActionPayload(rawEvent?.payload);
    let type = rawType;
    let status = 'accepted';
    let ignoreReason = null;
    let occurredAt = rawEvent?.occurred_at_utc;

    if (!ACTIVITY_EVENT_TYPES.has(rawType)) {
      type = 'invalid';
      status = 'ignored';
      ignoreReason = 'invalid_type';
      occurredAt = receivedAt;
      payload.raw_type = rawType;
    } else if (!activityId) {
      status = 'ignored';
      ignoreReason = 'activity_id_required';
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
    } else if (rawType === 'set_status' && !ACTIVITY_STATUSES.has(payload.status)) {
      status = 'ignored';
      ignoreReason = 'invalid_status';
      occurredAt = new Date(occurredMs).toISOString();
    } else if (rawType === 'reorder' && !Array.isArray(payload.ordered_ids)) {
      status = 'ignored';
      ignoreReason = 'ordered_ids_required';
      occurredAt = new Date(occurredMs).toISOString();
    } else {
      occurredAt = new Date(occurredMs).toISOString();
      if (payload.title) payload.title = sanitizeText(payload.title);
      if (typeof payload.description_md === 'string') {
        payload.description_md = normalizeMarkdownSource(payload.description_md);
      }
      if (Array.isArray(payload.ordered_ids)) {
        payload.ordered_ids = normalizeOrderedIds(payload.ordered_ids);
      }
    }

    this.insertActivityEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      activity_id: activityId,
      type,
      occurred_at_utc: occurredAt,
      received_at_utc: receivedAt,
      payload_json: JSON.stringify(payload),
      status,
      ignore_reason: ignoreReason,
      payload_version: ACTIVITY_EVENT_PAYLOAD_VERSION
    });

    return {
      event_id: eventId,
      ignored: ignoreReason ? { event_id: eventId, reason: ignoreReason } : null
    };
  }
,

  insertIgnoredActivityEvent({ eventId, deviceId, clientSequence, receivedAt, reason, rawEvent }) {
    this.insertActivityEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      activity_id: sanitizeText(rawEvent?.activity_id) ?? sanitizeText(rawEvent?.action_id),
      type: 'invalid',
      occurred_at_utc: receivedAt,
      received_at_utc: receivedAt,
      payload_json: JSON.stringify({ raw_event: rawEvent }),
      status: 'ignored',
      ignore_reason: reason,
      payload_version: ACTIVITY_EVENT_PAYLOAD_VERSION
    });
  }
,

  insertActivityEvent(event) {
    this.db
      .prepare(
        `
          INSERT INTO activity_events (
            event_id, device_id, client_sequence, server_sequence, activity_id,
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
        this.nextActivityServerSequence(),
        event.activity_id ?? null,
        event.type,
        event.occurred_at_utc,
        event.received_at_utc,
        event.payload_json ?? null,
        event.status,
        event.ignore_reason ?? null,
        event.payload_version
      );
  }
,

  nextActivityServerSequence() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) + 1 AS next FROM activity_events')
      .get();
    return row.next;
  }
,

  recomputeActivities(nowIso) {
    const events = this.db
      .prepare(
        `
          SELECT * FROM activity_events
          WHERE status = 'accepted'
          ORDER BY occurred_at_utc ASC, server_sequence ASC
        `
      )
      .all();
    const activities = new Map();

    for (const event of events) {
      const activityId = sanitizeText(event.activity_id);
      if (!activityId) continue;
      const payload = parseJsonObject(event.payload_json);
      const existing = activities.get(activityId);

      if (event.type === 'create') {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        activities.set(activityId, {
          id: activityId,
          title,
          description_md: existing?.description_md ?? '',
          status: existing?.status ?? 'New',
          created_at_utc: existing?.created_at_utc ?? event.occurred_at_utc,
          updated_at_utc: event.occurred_at_utc,
          completed_at_utc: existing?.completed_at_utc ?? null,
          sort_order: existing?.sort_order ?? null,
          deleted_at_utc: null,
          restored_at_utc: existing?.restored_at_utc ?? null,
          last_event_id: event.event_id
        });
      } else if (event.type === 'update_title' && existing) {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        existing.title = title;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      } else if (event.type === 'update_description' && existing) {
        existing.description_md = normalizeMarkdownSource(payload.description_md ?? '');
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      } else if (event.type === 'set_status' && existing && ACTIVITY_STATUSES.has(payload.status)) {
        existing.status = payload.status;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.completed_at_utc = payload.status === 'Done' ? event.occurred_at_utc : null;
        existing.sort_order = null;
        existing.last_event_id = event.event_id;
      } else if (event.type === 'reorder') {
        const orderedIds = normalizeOrderedIds(payload.ordered_ids);
        const ordered = new Set(orderedIds);
        for (const activity of activities.values()) {
          if (activity.status === 'New' && ordered.has(activity.id)) {
            activity.sort_order = orderedIds.indexOf(activity.id);
            activity.updated_at_utc = event.occurred_at_utc;
            activity.last_event_id = event.event_id;
          } else if (activity.status === 'New') {
            activity.sort_order = null;
          }
        }
      } else if (event.type === 'delete') {
        if (!existing) continue;
        existing.deleted_at_utc = event.occurred_at_utc;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.sort_order = null;
        existing.last_event_id = event.event_id;
      } else if (event.type === 'restore') {
        if (!existing) continue;
        existing.deleted_at_utc = null;
        existing.restored_at_utc = event.occurred_at_utc;
        existing.status = 'New';
        existing.completed_at_utc = null;
        existing.sort_order = null;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      }
    }

    this.db.prepare('DELETE FROM activities').run();
    const insertActivity = this.db.prepare(`
      INSERT INTO activities (
        id, title, description_md, status, created_at_utc, updated_at_utc, completed_at_utc,
        sort_order, deleted_at_utc, restored_at_utc, last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const activity of activities.values()) {
      insertActivity.run(
        activity.id,
        activity.title,
        activity.description_md ?? '',
        activity.status,
        activity.created_at_utc,
        activity.updated_at_utc ?? nowIso,
        activity.completed_at_utc ?? null,
        Number.isInteger(activity.sort_order) ? activity.sort_order : null,
        activity.deleted_at_utc ?? null,
        activity.restored_at_utc ?? null,
        activity.last_event_id ?? null
      );
    }
  }

};
