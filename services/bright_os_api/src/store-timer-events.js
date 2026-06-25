import { randomUUID } from 'node:crypto';
import { buildCanonicalSessions } from './canonical.js';
import {
  EVENT_PAYLOAD_VERSION,
  FUTURE_EVENT_TOLERANCE_MS,
  LEGACY_DEVICE_ID,
  normalizeMetadata,
  sanitizeText,
  toNullableInteger
} from './store-helpers.js';

export const timerEventMethods = {
  seedLegacyEvents() {
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
    return this.db
      .prepare('SELECT * FROM timer_sessions WHERE ended_at_utc IS NULL LIMIT 1')
      .get();
  }
,

  getSession(id) {
    return this.db.prepare('SELECT * FROM timer_sessions WHERE id = ?').get(id);
  }
,

  getLatestCompletedSession() {
    return this.db
      .prepare(
        `
          SELECT * FROM timer_sessions
          WHERE ended_at_utc IS NOT NULL
          ORDER BY ended_at_utc DESC, started_at_utc DESC
          LIMIT 1
        `
      )
      .get();
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

    if (rawType !== 'start' && rawType !== 'stop') {
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
          ORDER BY occurred_at_utc ASC, client_sequence ASC, received_at_utc ASC, server_sequence ASC
        `
      )
      .all();
    const sessions = buildCanonicalSessions(events);

    this.db.prepare('DELETE FROM timer_session_sources').run();
    this.db.prepare('DELETE FROM timer_sessions').run();

    const insertSession = this.db.prepare(`
      INSERT INTO timer_sessions (
        id, started_at_utc, ended_at_utc, duration_seconds, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertSource = this.db.prepare(`
      INSERT OR IGNORE INTO timer_session_sources (session_id, event_id, device_id, role)
      VALUES (?, ?, ?, ?)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.started_at_utc,
        session.ended_at_utc,
        session.duration_seconds,
        session.started_at_utc,
        session.ended_at_utc ?? nowIso
      );
      for (const source of session.sourceEvents) {
        insertSource.run(session.id, source.event_id, source.device_id, source.role);
      }
    }
  }

};
