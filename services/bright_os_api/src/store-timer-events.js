import { randomUUID } from 'node:crypto';
import { buildCanonicalSessions, compareEvents } from './canonical.js';
import {
  EVENT_PAYLOAD_VERSION,
  FUTURE_EVENT_TOLERANCE_MS,
  LEGACY_DEVICE_ID,
  normalizeMetadata,
  parseJsonObject,
  sanitizeText,
  toNullableInteger
} from './store-helpers.js';

const TIMER_EVENT_TYPES = new Set([
  'start',
  'stop',
  'edit_session',
  'delete_session',
  'start_activity_focus',
  'switch_activity_focus',
  'stop_activity_focus',
  'edit_focus_interval'
]);

export const timerEventMethods = {
  seedLegacyEvents() {
    if (!this.tableExists('timer_sessions')) return;
    const existingEvents = this.db.prepare('SELECT COUNT(*) AS count FROM timer_events').get();
    if (existingEvents.count > 0) return;

    const sessions = this.db
      .prepare('SELECT * FROM timer_sessions ORDER BY started_at_utc ASC, id ASC')
      .all();
    if (sessions.length === 0) return;

    const now = new Date().toISOString();
    this.upsertDevice(
      {
        device_id: LEGACY_DEVICE_ID,
        platform: 'server',
        display_name: 'Legacy server sessions'
      },
      now
    );

    let sequence = 1;
    for (const session of sessions) {
      this.insertEvent({
        event_id: `legacy:${session.id}:start`,
        device_id: LEGACY_DEVICE_ID,
        client_sequence: sequence++,
        type: 'start',
        occurred_at_utc: session.started_at_utc,
        received_at_utc: session.created_at_utc ?? now,
        local_timer_id: session.id,
        base_server_revision: null,
        status: 'accepted',
        ignore_reason: null,
        payload_version: EVENT_PAYLOAD_VERSION,
        metadata_json: JSON.stringify({ legacy_session_id: session.id })
      });

      if (session.ended_at_utc) {
        this.insertEvent({
          event_id: `legacy:${session.id}:stop`,
          device_id: LEGACY_DEVICE_ID,
          client_sequence: sequence++,
          type: 'stop',
          occurred_at_utc: session.ended_at_utc,
          received_at_utc: session.updated_at_utc ?? now,
          local_timer_id: session.id,
          base_server_revision: null,
          status: 'accepted',
          ignore_reason: null,
          payload_version: EVENT_PAYLOAD_VERSION,
          metadata_json: JSON.stringify({ legacy_session_id: session.id })
        });
      }
    }
  }
,

  close() {
    this.db.close();
  }
,

  getActiveSession() {
    const row = this.db
      .prepare(`
        SELECT s.id,
          MIN(i.started_at_utc) AS started_at_utc,
          NULL AS ended_at_utc,
          NULL AS duration_seconds,
          s.created_at_utc, s.updated_at_utc, s.deleted_at_utc, s.deleted_event_id,
          s.start_origin, s.started_by_activity_id
        FROM focus_sessions s
        JOIN focus_session_intervals i ON i.focus_session_id = s.id
        WHERE EXISTS (
            SELECT 1 FROM focus_session_intervals active
            WHERE active.focus_session_id = s.id AND active.ended_at_utc IS NULL
          )
          AND s.deleted_at_utc IS NULL
        GROUP BY s.id
        LIMIT 1
      `)
      .get();
    return this.sessionWithIntervals(row);
  }
,

  getSession(id) {
    const row = this.db
      .prepare(`
        SELECT s.id,
          MIN(i.started_at_utc) AS started_at_utc,
          CASE WHEN SUM(CASE WHEN i.ended_at_utc IS NULL THEN 1 ELSE 0 END) > 0
            THEN NULL ELSE MAX(i.ended_at_utc) END AS ended_at_utc,
          CASE WHEN SUM(CASE WHEN i.ended_at_utc IS NULL THEN 1 ELSE 0 END) > 0
            THEN NULL ELSE SUM(COALESCE(i.duration_seconds, 0)) END AS duration_seconds,
          s.created_at_utc, s.updated_at_utc, s.deleted_at_utc, s.deleted_event_id,
          s.start_origin, s.started_by_activity_id
        FROM focus_sessions s
        JOIN focus_session_intervals i ON i.focus_session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `)
      .get(id);
    return this.sessionWithIntervals(row);
  }
,

  getLatestCompletedSession() {
    const row = this.db
      .prepare(
        `
          SELECT s.id,
            MIN(i.started_at_utc) AS started_at_utc,
            MAX(i.ended_at_utc) AS ended_at_utc,
            SUM(COALESCE(i.duration_seconds, 0)) AS duration_seconds,
            s.created_at_utc, s.updated_at_utc, s.deleted_at_utc, s.deleted_event_id,
            s.start_origin, s.started_by_activity_id
          FROM focus_sessions s
          JOIN focus_session_intervals i ON i.focus_session_id = s.id
          WHERE NOT EXISTS (
              SELECT 1 FROM focus_session_intervals active
              WHERE active.focus_session_id = s.id AND active.ended_at_utc IS NULL
            )
            AND s.deleted_at_utc IS NULL
          GROUP BY s.id
          ORDER BY ended_at_utc DESC, started_at_utc DESC
          LIMIT 1
        `
      )
      .get();
    return this.sessionWithIntervals(row);
  }
,

  getActiveInterval() {
    return this.db
      .prepare(`
        SELECT i.*, a.title AS activity_title
        FROM focus_session_intervals i
        LEFT JOIN activities a ON a.id = i.activity_id
        JOIN focus_sessions s ON s.id = i.focus_session_id
        WHERE i.ended_at_utc IS NULL
          AND s.deleted_at_utc IS NULL
        LIMIT 1
      `)
      .get() ?? null;
  }
,

  getSessionIntervals(sessionId) {
    return this.db
      .prepare(`
        SELECT i.*, a.title AS activity_title
        FROM focus_session_intervals i
        LEFT JOIN activities a ON a.id = i.activity_id
        WHERE i.focus_session_id = ?
        ORDER BY i.started_at_utc ASC, i.id ASC
      `)
      .all(sessionId);
  }
,

  sessionWithIntervals(row) {
    if (!row) return null;
    const intervals = this.getSessionIntervals(row.id);
    return {
      ...row,
      intervals,
      active_interval: intervals.find((interval) => interval.ended_at_utc == null) ?? null
    };
  }
,

  getServerRevision() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) AS revision FROM timer_events')
      .get();
    return row.revision;
  }
,

  startTimer(nowIso) {
    const active = this.getActiveSession();
    if (active) {
      return { session: active, created: false };
    }

    const run = this.db.transaction(() => {
      this.upsertDevice(
        {
          device_id: LEGACY_DEVICE_ID,
          platform: 'server',
          display_name: 'Server timer endpoint'
        },
        nowIso
      );
      this.insertEvent({
        event_id: `server:${randomUUID()}:start`,
        device_id: LEGACY_DEVICE_ID,
        client_sequence: this.nextDeviceSequence(LEGACY_DEVICE_ID),
        type: 'start',
        occurred_at_utc: nowIso,
        received_at_utc: nowIso,
        local_timer_id: `server:${randomUUID()}`,
        base_server_revision: this.getServerRevision(),
        status: 'accepted',
        ignore_reason: null,
        payload_version: EVENT_PAYLOAD_VERSION,
        metadata_json: JSON.stringify({ endpoint: 'start' })
      });
      this.recomputeCanonicalSessions(nowIso);
    });
    run();

    return { session: this.getActiveSession(), created: true };
  }
,

  stopTimer(nowIso) {
    const active = this.getActiveSession();
    if (!active) {
      return { session: null, stopped: false };
    }

    const run = this.db.transaction(() => {
      this.upsertDevice(
        {
          device_id: LEGACY_DEVICE_ID,
          platform: 'server',
          display_name: 'Server timer endpoint'
        },
        nowIso
      );
      this.insertEvent({
        event_id: `server:${randomUUID()}:stop`,
        device_id: LEGACY_DEVICE_ID,
        client_sequence: this.nextDeviceSequence(LEGACY_DEVICE_ID),
        type: 'stop',
        occurred_at_utc: nowIso,
        received_at_utc: nowIso,
        local_timer_id: active.id,
        base_server_revision: this.getServerRevision(),
        status: 'accepted',
        ignore_reason: null,
        payload_version: EVENT_PAYLOAD_VERSION,
        metadata_json: JSON.stringify({ endpoint: 'stop', global_stop: true })
      });
      this.recomputeCanonicalSessions(nowIso);
    });
    run();

    return { session: this.getLatestCompletedSession(), stopped: true };
  }
,

  syncTimerEvents({ device, events, lastKnownServerTimeUtc = null, nowIso }) {
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
        const result = this.ingestClientEvent(deviceId, rawEvent, receivedAt);
        if (result.event_id) acknowledged.push(result.event_id);
        if (result.ignored) ignored.push(result.ignored);
      }

      this.recomputeCanonicalSessions(receivedAt);
    });
    run();

    return {
      server_revision: this.getServerRevision(),
      server_time_utc: receivedAt,
      acknowledged_event_ids: acknowledged,
      ignored_events: ignored
    };
  }
,

  ingestClientEvent(deviceId, rawEvent, receivedAt) {
    const eventId = sanitizeText(rawEvent?.event_id);
    if (!eventId) return { event_id: null };

    const existing = this.db
      .prepare('SELECT event_id, status, ignore_reason FROM timer_events WHERE event_id = ?')
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
      this.insertIgnoredEvent({
        eventId,
        deviceId,
        clientSequence: -this.nextServerSequence(),
        receivedAt,
        reason: 'invalid_client_sequence',
        rawEvent
      });
      return { event_id: eventId, ignored: { event_id: eventId, reason: 'invalid_client_sequence' } };
    }

    const existingSequence = this.db
      .prepare(
        'SELECT event_id FROM timer_events WHERE device_id = ? AND client_sequence = ?'
      )
      .get(deviceId, clientSequence);
    if (existingSequence) {
      return {
        event_id: eventId,
        ignored: { event_id: eventId, reason: 'duplicate_client_sequence' }
      };
    }

    const rawType = sanitizeText(rawEvent?.type);
    const occurredMs = Date.parse(rawEvent?.occurred_at_utc);
    let type = rawType;
    let status = 'accepted';
    let ignoreReason = null;
    let occurredAt = rawEvent?.occurred_at_utc;
    const metadata = normalizeMetadata(rawEvent?.metadata);

    if (!TIMER_EVENT_TYPES.has(rawType)) {
      type = 'invalid';
      status = 'ignored';
      ignoreReason = 'invalid_type';
      occurredAt = receivedAt;
      metadata.raw_type = rawType;
    } else if (!Number.isFinite(occurredMs)) {
      status = 'ignored';
      ignoreReason = 'invalid_timestamp';
      occurredAt = receivedAt;
      metadata.raw_occurred_at_utc = rawEvent?.occurred_at_utc;
    } else if (occurredMs - Date.parse(receivedAt) > FUTURE_EVENT_TOLERANCE_MS) {
      status = 'ignored';
      ignoreReason = 'future_timestamp';
      occurredAt = new Date(occurredMs).toISOString();
    } else if (rawType === 'edit_session') {
      occurredAt = new Date(occurredMs).toISOString();
      const edit = this.normalizeSessionEditMetadata(metadata, receivedAt);
      if (edit.reason) {
        status = 'ignored';
        ignoreReason = edit.reason;
      }
      Object.assign(metadata, edit.metadata);
    } else if (rawType === 'edit_focus_interval') {
      occurredAt = new Date(occurredMs).toISOString();
      const edit = this.normalizeIntervalEditMetadata(metadata, receivedAt);
      if (edit.reason) {
        status = 'ignored';
        ignoreReason = edit.reason;
      }
      Object.assign(metadata, edit.metadata);
    } else if (rawType === 'start_activity_focus' || rawType === 'switch_activity_focus') {
      occurredAt = new Date(occurredMs).toISOString();
      const activityId = sanitizeText(metadata.activity_id) ?? sanitizeText(metadata.action_id);
      if (!activityId) {
        status = 'ignored';
        ignoreReason = 'activity_id_required';
      }
      metadata.activity_id = activityId ?? null;
    } else if (rawType === 'stop_activity_focus') {
      occurredAt = new Date(occurredMs).toISOString();
      const activityId = sanitizeText(metadata.activity_id) ?? sanitizeText(metadata.action_id);
      if (activityId) metadata.activity_id = activityId;
    } else if (rawType === 'delete_session') {
      occurredAt = new Date(occurredMs).toISOString();
      const deletion = this.normalizeSessionDeleteMetadata(metadata);
      if (deletion.reason) {
        status = 'ignored';
        ignoreReason = deletion.reason;
      }
      Object.assign(metadata, deletion.metadata);
    } else {
      occurredAt = new Date(occurredMs).toISOString();
    }

    this.insertEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      type,
      occurred_at_utc: occurredAt,
      received_at_utc: receivedAt,
      local_timer_id: sanitizeText(rawEvent?.local_timer_id),
      base_server_revision: toNullableInteger(rawEvent?.base_server_revision),
      status,
      ignore_reason: ignoreReason,
      payload_version: EVENT_PAYLOAD_VERSION,
      metadata_json: JSON.stringify(metadata)
    });

    return {
      event_id: eventId,
      ignored: ignoreReason ? { event_id: eventId, reason: ignoreReason } : null
    };
  }
,

  insertIgnoredEvent({ eventId, deviceId, clientSequence, receivedAt, reason, rawEvent }) {
    this.insertEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      type: 'invalid',
      occurred_at_utc: receivedAt,
      received_at_utc: receivedAt,
      local_timer_id: sanitizeText(rawEvent?.local_timer_id),
      base_server_revision: toNullableInteger(rawEvent?.base_server_revision),
      status: 'ignored',
      ignore_reason: reason,
      payload_version: EVENT_PAYLOAD_VERSION,
      metadata_json: JSON.stringify({ raw_event: rawEvent })
    });
  }
,

  upsertDevice(device, nowIso, { lastSyncAtUtc = null, lastServerClockOffsetMs = null } = {}) {
    this.db
      .prepare(
        `
          INSERT INTO timer_devices (
            device_id, platform, display_name, created_at_utc, last_seen_at_utc,
            last_sync_at_utc, last_server_clock_offset_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id) DO UPDATE SET
            platform = excluded.platform,
            display_name = COALESCE(excluded.display_name, timer_devices.display_name),
            last_seen_at_utc = excluded.last_seen_at_utc,
            last_sync_at_utc = COALESCE(excluded.last_sync_at_utc, timer_devices.last_sync_at_utc),
            last_server_clock_offset_ms = COALESCE(
              excluded.last_server_clock_offset_ms,
              timer_devices.last_server_clock_offset_ms
            )
        `
      )
      .run(
        device.device_id,
        device.platform,
        device.display_name ?? null,
        nowIso,
        nowIso,
        lastSyncAtUtc,
        lastServerClockOffsetMs
      );
  }
,

  insertEvent(event) {
    this.db
      .prepare(
        `
          INSERT INTO timer_events (
            event_id, device_id, client_sequence, server_sequence, type,
            occurred_at_utc, received_at_utc, local_timer_id, base_server_revision,
            status, ignore_reason, payload_version, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO NOTHING
        `
      )
      .run(
        event.event_id,
        event.device_id,
        event.client_sequence,
        this.nextServerSequence(),
        event.type,
        event.occurred_at_utc,
        event.received_at_utc,
        event.local_timer_id ?? null,
        event.base_server_revision ?? null,
        event.status,
        event.ignore_reason ?? null,
        event.payload_version,
        event.metadata_json ?? null
      );
  }
,

  nextServerSequence() {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(server_sequence), 0) + 1 AS next FROM timer_events')
      .get();
    return row.next;
  }
,

  nextDeviceSequence(deviceId) {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(client_sequence), 0) + 1 AS next FROM timer_events WHERE device_id = ?'
      )
      .get(deviceId);
    return row.next;
  }
,

  recomputeCanonicalSessions(nowIso) {
    const events = this.db
      .prepare(
        `
          SELECT * FROM timer_events
          WHERE status = 'accepted'
          ORDER BY occurred_at_utc ASC, server_sequence ASC, device_id ASC, event_id ASC
        `
      )
      .all();
    const sessions = buildCanonicalSessions(events);

    this.db.prepare('DELETE FROM focus_session_sources').run();
    this.db.prepare('DELETE FROM focus_session_intervals').run();
    this.db.prepare('DELETE FROM focus_sessions').run();

    const insertSession = this.db.prepare(`
      INSERT INTO focus_sessions (
        id, created_at_utc, updated_at_utc, deleted_at_utc, deleted_event_id,
        start_origin, started_by_activity_id
      )
      VALUES (?, ?, ?, NULL, NULL, ?, ?)
    `);
    const insertInterval = this.db.prepare(`
      INSERT INTO focus_session_intervals (
        id, focus_session_id, activity_id, started_at_utc, ended_at_utc,
        duration_seconds, created_at_utc, updated_at_utc, created_event_id,
        ended_event_id, created_by_device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = this.db.prepare(`
      INSERT OR IGNORE INTO focus_session_sources (session_id, event_id, device_id, role)
      VALUES (?, ?, ?, ?)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.started_at_utc,
        session.ended_at_utc ?? nowIso,
        session.start_origin ?? 'focus',
        session.started_by_activity_id ?? null
      );
      for (const interval of session.intervals) {
        insertInterval.run(
          interval.id,
          session.id,
          interval.activity_id,
          interval.started_at_utc,
          interval.ended_at_utc,
          interval.duration_seconds,
          interval.started_at_utc,
          interval.ended_at_utc ?? nowIso,
          interval.created_event_id,
          interval.ended_event_id,
          interval.created_by_device_id
        );
      }
      for (const source of session.sourceEvents) {
        insertSource.run(session.id, source.event_id, source.device_id, source.role);
      }
    }

    for (const event of events
      .filter((item) => item.type === 'edit_session' || item.type === 'edit_focus_interval' || item.type === 'delete_session')
      .sort(compareEvents)) {
      if (event.type === 'edit_session') {
        this.applyFocusSessionEdit(event);
      } else if (event.type === 'edit_focus_interval') {
        this.applyFocusIntervalEdit(event);
      } else {
        this.applyFocusSessionDelete(event);
      }
    }
  }
,

  normalizeSessionEditMetadata(metadata, receivedAt) {
    const focusSessionId = sanitizeText(metadata.focus_session_id) ?? sanitizeText(metadata.session_id);
    const startedMs = Date.parse(metadata.started_at_utc);
    const endedMs = Date.parse(metadata.ended_at_utc);
    const normalized = { focus_session_id: focusSessionId ?? null };

    if (!focusSessionId) return { reason: 'focus_session_id_required', metadata: normalized };

    const session = this.getSession(focusSessionId);
    if (!session) return { reason: 'focus_session_not_found', metadata: normalized };
    if (session.deleted_at_utc) return { reason: 'focus_session_deleted', metadata: normalized };
    if (!session.ended_at_utc) return { reason: 'active_session_not_editable', metadata: normalized };
    if (session.intervals.length !== 1) {
      return { reason: 'focus_session_has_multiple_intervals', metadata: normalized };
    }

    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
      return { reason: 'invalid_session_timestamp', metadata: normalized };
    }
    if (endedMs <= startedMs) {
      return { reason: 'invalid_session_range', metadata: normalized };
    }
    if (Math.max(startedMs, endedMs) - Date.parse(receivedAt) > FUTURE_EVENT_TOLERANCE_MS) {
      return { reason: 'future_timestamp', metadata: normalized };
    }
    if (this.hasFocusIntervalOverlap(session.intervals[0].id, focusSessionId, startedMs, endedMs)) {
      return { reason: 'focus_session_overlap', metadata: normalized };
    }

    return {
      reason: null,
      metadata: {
        focus_session_id: focusSessionId,
        focus_interval_id: session.intervals[0].id,
        started_at_utc: new Date(startedMs).toISOString(),
        ended_at_utc: new Date(endedMs).toISOString(),
        duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000))
      }
    };
  }
,

  normalizeIntervalEditMetadata(metadata, receivedAt) {
    const intervalId = sanitizeText(metadata.focus_interval_id) ?? sanitizeText(metadata.interval_id);
    const startedMs = Date.parse(metadata.started_at_utc);
    const endedMs = Date.parse(metadata.ended_at_utc);
    const normalized = { focus_interval_id: intervalId ?? null };

    if (!intervalId) return { reason: 'focus_interval_id_required', metadata: normalized };

    const interval = this.getFocusInterval(intervalId);
    if (!interval) return { reason: 'focus_interval_not_found', metadata: normalized };
    const session = this.getSession(interval.focus_session_id);
    if (!session) return { reason: 'focus_session_not_found', metadata: normalized };
    if (session.deleted_at_utc) return { reason: 'focus_session_deleted', metadata: normalized };
    if (!interval.ended_at_utc) return { reason: 'active_interval_not_editable', metadata: normalized };

    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) {
      return { reason: 'invalid_interval_timestamp', metadata: normalized };
    }
    if (endedMs <= startedMs) {
      return { reason: 'invalid_interval_range', metadata: normalized };
    }
    if (Math.max(startedMs, endedMs) - Date.parse(receivedAt) > FUTURE_EVENT_TOLERANCE_MS) {
      return { reason: 'future_timestamp', metadata: normalized };
    }
    if (this.hasFocusIntervalOverlap(intervalId, interval.focus_session_id, startedMs, endedMs)) {
      return { reason: 'focus_interval_overlap', metadata: normalized };
    }

    return {
      reason: null,
      metadata: {
        focus_interval_id: intervalId,
        focus_session_id: interval.focus_session_id,
        started_at_utc: new Date(startedMs).toISOString(),
        ended_at_utc: new Date(endedMs).toISOString(),
        duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000))
      }
    };
  }
,

  normalizeSessionDeleteMetadata(metadata) {
    const focusSessionId = sanitizeText(metadata.focus_session_id) ?? sanitizeText(metadata.session_id);
    const normalized = { focus_session_id: focusSessionId ?? null };

    if (!focusSessionId) return { reason: 'focus_session_id_required', metadata: normalized };

    const session = this.getSession(focusSessionId);
    if (!session) return { reason: 'focus_session_not_found', metadata: normalized };
    if (!session.ended_at_utc) return { reason: 'active_session_not_editable', metadata: normalized };

    return { reason: null, metadata: { focus_session_id: focusSessionId } };
  }
,

  getFocusInterval(intervalId) {
    return this.db
      .prepare(`
        SELECT i.*, s.deleted_at_utc
        FROM focus_session_intervals i
        JOIN focus_sessions s ON s.id = i.focus_session_id
        WHERE i.id = ?
      `)
      .get(intervalId) ?? null;
  }
,

  hasFocusIntervalOverlap(intervalId, focusSessionId, startedMs, endedMs) {
    const row = this.db
      .prepare(
        `
          SELECT i.id
          FROM focus_sessions s
          JOIN focus_session_intervals i ON i.focus_session_id = s.id
          WHERE i.id != ?
            AND s.deleted_at_utc IS NULL
            AND i.started_at_utc < ?
            AND COALESCE(i.ended_at_utc, '9999-12-31T23:59:59.999Z') > ?
          LIMIT 1
        `
      )
      .get(intervalId, new Date(endedMs).toISOString(), new Date(startedMs).toISOString());
    return Boolean(row);
  }
,

  applyFocusSessionEdit(event) {
    const metadata = parseJsonObject(event.metadata_json);
    const focusSessionId = sanitizeText(metadata.focus_session_id) ?? sanitizeText(metadata.session_id);
    const startedMs = Date.parse(metadata.started_at_utc);
    const endedMs = Date.parse(metadata.ended_at_utc);
    if (!focusSessionId || !Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
      return;
    }

    const session = this.getSession(focusSessionId);
    if (!session || !session.ended_at_utc || session.intervals.length !== 1) return;
    if (
      session.deleted_at_utc ||
      this.hasFocusIntervalOverlap(session.intervals[0].id, focusSessionId, startedMs, endedMs)
    ) {
      return;
    }

    this.updateFocusInterval(session.intervals[0].id, event, startedMs, endedMs);
  }
,

  applyFocusIntervalEdit(event) {
    const metadata = parseJsonObject(event.metadata_json);
    const intervalId = sanitizeText(metadata.focus_interval_id) ?? sanitizeText(metadata.interval_id);
    const focusSessionId = sanitizeText(metadata.focus_session_id) ?? sanitizeText(metadata.session_id);
    const startedMs = Date.parse(metadata.started_at_utc);
    const endedMs = Date.parse(metadata.ended_at_utc);
    if (!intervalId || !focusSessionId || !Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
      return;
    }

    const interval = this.getFocusInterval(intervalId);
    if (!interval || interval.focus_session_id !== focusSessionId || interval.ended_at_utc == null) return;
    if (interval.deleted_at_utc || this.hasFocusIntervalOverlap(intervalId, focusSessionId, startedMs, endedMs)) return;

    this.updateFocusInterval(intervalId, event, startedMs, endedMs);
  }
,

  updateFocusInterval(intervalId, event, startedMs, endedMs) {
    this.db
      .prepare(
        `
          UPDATE focus_session_intervals
          SET started_at_utc = ?, ended_at_utc = ?, duration_seconds = ?,
            updated_at_utc = ?, ended_event_id = ?
          WHERE id = ?
        `
      )
      .run(
        new Date(startedMs).toISOString(),
        new Date(endedMs).toISOString(),
        Math.max(0, Math.floor((endedMs - startedMs) / 1000)),
        event.received_at_utc,
        event.event_id,
        intervalId
      );
    const interval = this.getFocusInterval(intervalId);
    if (!interval) return;
    this.db
      .prepare('UPDATE focus_sessions SET updated_at_utc = ? WHERE id = ?')
      .run(event.received_at_utc, interval.focus_session_id);
  }
,

  applyFocusSessionDelete(event) {
    const metadata = parseJsonObject(event.metadata_json);
    const focusSessionId = sanitizeText(metadata.focus_session_id) ?? sanitizeText(metadata.session_id);
    if (!focusSessionId) return;

    const session = this.getSession(focusSessionId);
    if (!session || !session.ended_at_utc || session.deleted_at_utc) return;

    this.db
      .prepare(
        `
          UPDATE focus_sessions
          SET deleted_at_utc = ?, deleted_event_id = ?, updated_at_utc = ?
          WHERE id = ? AND deleted_at_utc IS NULL
        `
      )
      .run(event.occurred_at_utc, event.event_id, event.received_at_utc, focusSessionId);
  }

};
