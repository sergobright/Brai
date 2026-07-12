import {
  ACTIVITY_EVENT_PAYLOAD_VERSION,
  ACTIVITY_EVENT_TYPES,
  ACTIVITY_STATUSES,
  ACTIVITY_TYPES,
  EVENT_PAYLOAD_VERSION,
  FUTURE_EVENT_TOLERANCE_MS,
  LEGACY_DEVICE_ID,
  formatActivity,
  normalizeActionPayload,
  normalizeMarkdownSource,
  normalizeOrderedIds,
  parseJsonObject,
  sanitizeText
} from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const activityEventMethods = {
  listActivities() {
    const scope = scopeSql('a');
    return this.db
      .prepare(
        `
          SELECT a.*,
            w.status AS workflow_status,
            w.current_step AS workflow_step,
            w.attempt_count AS workflow_attempt_count,
            w.last_error AS workflow_last_error,
            w.workflow_id AS temporal_workflow_id,
            w.run_id AS temporal_run_id
          FROM activities a
          LEFT JOIN workflow_executions w ON w.id = a.workflow_execution_id
          WHERE a.activity_type_id IN ('action', 'operation')
            AND a.deleted_at_utc IS NULL
            ${scope.clause}
          ORDER BY
            CASE a.status WHEN 'New' THEN 0 ELSE 1 END ASC,
            CASE a.status WHEN 'New' THEN CASE WHEN a.sort_order IS NULL THEN 0 ELSE 1 END END ASC,
            CASE WHEN a.status = 'New' AND a.sort_order IS NULL THEN COALESCE(a.restored_at_utc, a.created_at_utc) END DESC,
            CASE a.status WHEN 'New' THEN a.sort_order END ASC,
            CASE a.status WHEN 'Done' THEN a.completed_at_utc END DESC,
            a.updated_at_utc DESC,
            a.id ASC
        `
      )
      .all(...scope.params)
      .map(formatActivity);
  }
,

  listArchivedActivities() {
    const scope = scopeSql('a');
    return this.db
      .prepare(
        `
          SELECT a.*,
            w.status AS workflow_status,
            w.current_step AS workflow_step,
            w.attempt_count AS workflow_attempt_count,
            w.last_error AS workflow_last_error,
            w.workflow_id AS temporal_workflow_id,
            w.run_id AS temporal_run_id
          FROM activities a
          LEFT JOIN workflow_executions w ON w.id = a.workflow_execution_id
          WHERE a.activity_type_id IN ('action', 'operation')
            AND a.deleted_at_utc IS NOT NULL
            ${scope.clause}
          ORDER BY a.deleted_at_utc DESC, a.updated_at_utc DESC, a.id ASC
        `
      )
      .all(...scope.params)
      .map(formatActivity);
  }
,

  getActivityItem(activityId) {
    const id = sanitizeText(activityId);
    if (!id) return null;
    const scope = scopeSql('a');
    return formatActivity(this.db
      .prepare(`
        SELECT a.*,
          w.status AS workflow_status,
          w.current_step AS workflow_step,
          w.attempt_count AS workflow_attempt_count,
          w.last_error AS workflow_last_error,
          w.workflow_id AS temporal_workflow_id,
          w.run_id AS temporal_run_id
        FROM activities a
        LEFT JOIN workflow_executions w ON w.id = a.workflow_execution_id
        WHERE a.id = ? ${scope.clause}
      `)
      .get(id, ...scope.params));
  }
,

  getActivityServerRevision() {
    return this.getEventDomainRevision('activity');
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
        const result = this.ingestActivityEvent(deviceId, rawEvent, receivedAt);
        if (result.event_id) acknowledged.push(result.event_id);
        if (result.ignored) ignored.push(result.ignored);
        if (result.accepted_event) acceptedEvents.push(result.accepted_event);
      }

      this.projectAcceptedActivityEvents(acceptedEvents, receivedAt);
      this.stopDeletedActiveActivityFocus(acceptedEvents, receivedAt);
    });
    run();

    const serverRevision = this.getActivityServerRevision();
    this.recordLog({
      dt: receivedAt,
      source: 'sync',
      operation: 'activity.events_sync',
      status: 'done',
      eventDomain: 'activity',
      deviceId,
      message: 'Activity events sync',
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

  stopDeletedActiveActivityFocus(acceptedEvents, receivedAt) {
    for (const event of acceptedEvents) {
      if (event.change_type !== 'delete') continue;
      const activeInterval = this.getActiveInterval?.();
      if (!activeInterval || activeInterval.activity_id !== event.activity_id) continue;
      this.upsertDevice(
        {
          device_id: LEGACY_DEVICE_ID,
          platform: 'server',
          display_name: 'Activity deletion focus bridge'
        },
        receivedAt
      );
      this.insertEvent({
        event_id: `activity:${event.event_id}:stop-focus`,
        device_id: LEGACY_DEVICE_ID,
        client_sequence: this.nextDeviceSequence(LEGACY_DEVICE_ID),
        type: 'stop_activity_focus',
        occurred_at_utc: event.occurred_at_utc,
        received_at_utc: receivedAt,
        local_timer_id: activeInterval.focus_session_id,
        base_server_revision: this.getServerRevision(),
        status: 'accepted',
        ignore_reason: null,
        payload_version: EVENT_PAYLOAD_VERSION,
        metadata_json: JSON.stringify({
          activity_id: event.activity_id,
          activity_delete_event_id: event.event_id,
          preserve_focus_session: true
        })
      });
      this.recomputeCanonicalSessions(receivedAt);
    }
  }
,

  ingestActivityEvent(deviceId, rawEvent, receivedAt) {
    const eventId = sanitizeText(rawEvent?.event_id);
    if (!eventId) return { event_id: null };

    const existing = this.existingEvent('activity', eventId) ?? this.existingIgnoredEvent('activity', eventId);
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
      this.insertIgnoredActivityEvent({
        eventId,
        deviceId,
        clientSequence: this.nextInvalidActivityClientSequence(deviceId),
        receivedAt,
        reason: 'invalid_client_sequence',
        rawEvent
      });
      return { event_id: eventId, ignored: { event_id: eventId, reason: 'invalid_client_sequence' } };
    }

    const existingSequence = this.existingDeviceSequence('activity', deviceId, clientSequence);
    if (existingSequence) {
      return {
        event_id: eventId,
        ignored: { event_id: eventId, reason: 'duplicate_client_sequence' }
      };
    }

    const rawType = sanitizeText(rawEvent?.change_type) ?? sanitizeText(rawEvent?.type);
    const activityId = sanitizeText(rawEvent?.activity_id) ?? sanitizeText(rawEvent?.action_id);
    const occurredMs = Date.parse(rawEvent?.occurred_at_utc);
    const payload = normalizeActionPayload(rawEvent?.payload);
    let changeType = rawType;
    let status = 'accepted';
    let ignoreReason = null;
    let occurredAt = rawEvent?.occurred_at_utc;

    if (!ACTIVITY_EVENT_TYPES.has(rawType)) {
      changeType = 'invalid';
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
    } else if (rawType === 'create' && payload.activity_type_id !== undefined && !ACTIVITY_TYPES.has(payload.activity_type_id)) {
      status = 'ignored';
      ignoreReason = 'invalid_activity_type';
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
      if (payload.activity_type_id !== undefined) {
        payload.activity_type_id = ACTIVITY_TYPES.has(payload.activity_type_id) ? payload.activity_type_id : 'action';
      }
      if (typeof payload.author === 'string') payload.author = sanitizeText(payload.author) ?? '';
      if (typeof payload.reason === 'string') payload.reason = normalizeMarkdownSource(payload.reason);
      if (Array.isArray(payload.ordered_ids)) {
        payload.ordered_ids = normalizeOrderedIds(payload.ordered_ids);
      }
    }

    const serverSequence = this.insertActivityEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      activity_id: activityId,
      change_type: changeType,
      occurred_at_utc: occurredAt,
      received_at_utc: receivedAt,
      payload_json: JSON.stringify(payload),
      status,
      ignore_reason: ignoreReason,
      payload_version: ACTIVITY_EVENT_PAYLOAD_VERSION
    });

    return {
      event_id: eventId,
      ignored: ignoreReason ? { event_id: eventId, reason: ignoreReason } : null,
      accepted_event:
        status === 'accepted' && serverSequence
          ? {
              event_id: eventId,
              activity_id: activityId,
              change_type: changeType,
              occurred_at_utc: occurredAt,
              server_sequence: serverSequence,
              payload_json: JSON.stringify(payload)
            }
          : null
    };
  }
,

  insertIgnoredActivityEvent({ eventId, deviceId, clientSequence, receivedAt, reason, rawEvent }) {
    this.insertActivityEvent({
      event_id: eventId,
      device_id: deviceId,
      client_sequence: clientSequence,
      activity_id: sanitizeText(rawEvent?.activity_id) ?? sanitizeText(rawEvent?.action_id),
      change_type: 'invalid',
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
    if (event.status === 'ignored') {
      this.recordSyncIgnoredEvent({
        domain: 'activity',
        eventId: event.event_id,
        deviceId: event.device_id,
        clientSequence: event.client_sequence,
        receivedAt: event.received_at_utc,
        reason: event.ignore_reason ?? 'ignored',
        rawEvent: parseJsonObject(event.payload_json).raw_event ?? event
      });
    }
    const linked = event.activity_id ? this.getActivityItem(event.activity_id) : null;
    return this.insertEventRecord({
      eventId: event.event_id,
      eventDomain: 'activity',
      eventType: event.change_type,
      eventAction: `activity.${event.change_type}`,
      title: `Activity ${event.change_type}`,
      itemsId: event.change_type === 'reorder' || !linked?.item_roles_id ? null : event.activity_id,
      itemRolesId: event.change_type === 'reorder' ? null : linked?.item_roles_id ?? null,
      subjectType: event.change_type === 'reorder' ? 'activity_list' : 'activity',
      subjectId: event.change_type === 'reorder' ? null : event.activity_id,
      actorType: 'user',
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

  nextActivityServerSequence() {
    return this.nextPostgresCounter('events.domain_sequence.activity');
  }
,

  nextInvalidActivityClientSequence(deviceId) {
    return -this.nextPostgresCounter(`events.invalid_client_sequence.${deviceId}`);
  }
,

  projectAcceptedActivityEvents(events, nowIso) {
    if (events.length === 0) return;

    const activityIds = new Set();
    const insertedReorderIds = new Set();

    for (const event of events) {
      if (event.change_type === 'reorder') {
        insertedReorderIds.add(event.event_id);
      } else if (event.activity_id) {
        activityIds.add(event.activity_id);
      }
    }

    const latestReorder = insertedReorderIds.size > 0 ? this.latestActivityReorderEvent() : null;
    if (latestReorder && insertedReorderIds.has(latestReorder.event_id)) {
      for (const id of this.applyLatestActivityReorder(latestReorder)) {
        activityIds.add(id);
      }
    }

    for (const activityId of activityIds) {
      this.projectActivity(activityId, nowIso);
    }
  }
,

  projectActivity(activityId, nowIso) {
    const scope = scopeSql();
    const events = this.db
      .prepare(
        `
          SELECT id, event_id, subject_id AS activity_id, event_type AS change_type,
            occurred_at_utc, received_at_utc, domain_sequence AS server_sequence, payload_json, user_id
          FROM events
          WHERE event_domain = 'activity'
            AND status = 'accepted'
            AND subject_id = ?
            AND event_type != 'reorder'
            ${scope.clause}
          ORDER BY occurred_at_utc ASC, domain_sequence ASC
        `
      )
      .all(activityId, ...scope.params);

    let activity = null;
    let sortResetEvent = null;
    let lastOwnEvent = null;

    for (const event of events) {
      const payload = parseJsonObject(event.payload_json);

      if (event.change_type === 'create') {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        if (!activity) sortResetEvent = event;
        activity = {
          id: activityId,
          activity_type_id: normalizeActivityType(payload.activity_type_id, activity?.activity_type_id ?? 'action'),
          title,
          description_md: normalizeMarkdownSource(payload.description_md ?? activity?.description_md ?? ''),
          author: typeof payload.author === 'string' ? sanitizeText(payload.author) ?? '' : activity?.author ?? '',
          reason: typeof payload.reason === 'string' ? normalizeMarkdownSource(payload.reason) : activity?.reason ?? '',
          status: activity?.status ?? 'New',
          created_at_utc: activity?.created_at_utc ?? event.occurred_at_utc,
          updated_at_utc: event.occurred_at_utc,
          completed_at_utc: activity?.completed_at_utc ?? null,
          sort_order: activity?.sort_order ?? null,
          deleted_at_utc: null,
          restored_at_utc: activity?.restored_at_utc ?? null,
          normalized: activity?.normalized === true,
          initial_event_id: activity?.initial_event_id ?? event.id,
          last_event_id: event.event_id
        };
        lastOwnEvent = event;
      } else if (event.change_type === 'update_title' && activity) {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        activity.title = title;
        activity.updated_at_utc = event.occurred_at_utc;
        activity.last_event_id = event.event_id;
        lastOwnEvent = event;
      } else if (event.change_type === 'update_description' && activity) {
        activity.description_md = normalizeMarkdownSource(payload.description_md ?? '');
        activity.updated_at_utc = event.occurred_at_utc;
        activity.last_event_id = event.event_id;
        lastOwnEvent = event;
      } else if (event.change_type === 'normalized' && activity) {
        const title = sanitizeText(payload.title);
        if (title) activity.title = title;
        if (typeof payload.description_md === 'string') {
          activity.description_md = normalizeMarkdownSource(payload.description_md);
        }
        if (typeof payload.reason === 'string') {
          activity.reason = normalizeMarkdownSource(payload.reason);
        }
        activity.normalized = true;
        activity.updated_at_utc = event.occurred_at_utc;
        activity.last_event_id = event.event_id;
        lastOwnEvent = event;
      } else if (event.change_type === 'set_status' && activity && ACTIVITY_STATUSES.has(payload.status)) {
        activity.status = payload.status;
        activity.updated_at_utc = event.occurred_at_utc;
        activity.completed_at_utc = payload.status === 'Done' ? event.occurred_at_utc : null;
        activity.sort_order = null;
        activity.last_event_id = event.event_id;
        sortResetEvent = event;
        lastOwnEvent = event;
      } else if (event.change_type === 'delete' && activity) {
        activity.deleted_at_utc = event.occurred_at_utc;
        activity.updated_at_utc = event.occurred_at_utc;
        activity.sort_order = null;
        activity.last_event_id = event.event_id;
        sortResetEvent = event;
        lastOwnEvent = event;
      } else if (event.change_type === 'restore' && activity) {
        activity.deleted_at_utc = null;
        activity.restored_at_utc = event.occurred_at_utc;
        activity.status = 'New';
        activity.completed_at_utc = null;
        activity.sort_order = null;
        activity.updated_at_utc = event.occurred_at_utc;
        activity.last_event_id = event.event_id;
        sortResetEvent = event;
        lastOwnEvent = event;
      }
    }

    if (!activity) {
      this.db
        .prepare(`DELETE FROM activities WHERE id = ? AND activity_type_id IN ('action', 'operation')${scope.clause}`)
        .run(activityId, ...scope.params);
      return;
    }

    if (activity.status === 'New' && !activity.deleted_at_utc && sortResetEvent) {
      const reorder = this.latestActivityReorderAfter(sortResetEvent);
      if (reorder) {
        const orderedIds = normalizeOrderedIds(parseJsonObject(reorder.payload_json).ordered_ids);
        const sortOrder = orderedIds.indexOf(activityId);
        activity.sort_order = sortOrder === -1 ? null : sortOrder;
        if (sortOrder !== -1 && isEventAfter(reorder, lastOwnEvent)) {
          activity.updated_at_utc = reorder.occurred_at_utc;
          activity.last_event_id = reorder.event_id;
        }
      }
    }

    this.db
      .prepare(
        `
          INSERT INTO activities (
            id, title, description_md, status, created_at_utc, updated_at_utc, completed_at_utc,
            sort_order, deleted_at_utc, restored_at_utc, last_event_id, activity_type_id, author, reason,
            initial_event_id, user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            activity_type_id = excluded.activity_type_id,
            title = excluded.title,
            description_md = excluded.description_md,
            author = excluded.author,
            reason = excluded.reason,
            status = excluded.status,
            created_at_utc = excluded.created_at_utc,
            updated_at_utc = excluded.updated_at_utc,
            completed_at_utc = excluded.completed_at_utc,
            sort_order = excluded.sort_order,
            deleted_at_utc = excluded.deleted_at_utc,
            restored_at_utc = excluded.restored_at_utc,
            last_event_id = excluded.last_event_id,
            initial_event_id = COALESCE(activities.initial_event_id, excluded.initial_event_id)
          WHERE activities.user_id IS NOT DISTINCT FROM excluded.user_id
            OR activities.user_id IS NULL
            OR excluded.user_id IS NULL
        `
      )
      .run(
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
        activity.last_event_id ?? null,
        normalizeActivityType(activity.activity_type_id),
        activity.author ?? '',
        activity.reason ?? '',
        activity.initial_event_id ?? null,
        scopedUserId()
      );
    const stored = this.getActivityItem(activity.id);
    if (stored?.item_roles_id) {
      this.ensureActivityRoleLink(stored);
    } else if (stored) {
      this.ensureActivityWorkflowExecution({ activityId: activity.id, nowIso });
    }
  }
,

  latestActivityReorderEvent() {
    const scope = scopeSql();
    return this.db
      .prepare(
        `
          SELECT id, event_id, subject_id AS activity_id, event_type AS change_type,
            occurred_at_utc, received_at_utc, domain_sequence AS server_sequence, payload_json, user_id
          FROM events
          WHERE event_domain = 'activity' AND event_type = 'reorder' AND status = 'accepted'
            ${scope.clause}
          ORDER BY occurred_at_utc DESC, domain_sequence DESC
          LIMIT 1
        `
      )
      .get(...scope.params);
  }
,

  latestActivityReorderAfter(event) {
    const scope = scopeSql();
    return this.db
      .prepare(
        `
          SELECT id, event_id, subject_id AS activity_id, event_type AS change_type,
            occurred_at_utc, received_at_utc, domain_sequence AS server_sequence, payload_json, user_id
          FROM events
          WHERE event_domain = 'activity'
            AND status = 'accepted'
            AND event_type = 'reorder'
            AND (
              occurred_at_utc > ?
              OR (occurred_at_utc = ? AND domain_sequence > ?)
            )
            ${scope.clause}
          ORDER BY occurred_at_utc DESC, domain_sequence DESC
          LIMIT 1
        `
      )
      .get(event.occurred_at_utc, event.occurred_at_utc, event.server_sequence, ...scope.params);
  }
,

  applyLatestActivityReorder(reorderEvent) {
    const orderedIds = normalizeOrderedIds(parseJsonObject(reorderEvent.payload_json).ordered_ids);
    const scope = scopeSql();
    const idFilter = orderedIds.length
      ? `AND id NOT IN (${orderedIds.map(() => '?').join(', ')})`
      : '';
    this.db
      .prepare(
        `
          UPDATE activities
          SET sort_order = NULL
          WHERE deleted_at_utc IS NULL
            AND status = 'New'
            AND sort_order IS NOT NULL
            ${idFilter}
            ${scope.clause}
        `
      )
      .run(...orderedIds, ...scope.params);
    return orderedIds;
  }
,

  recomputeActivities(nowIso) {
    const scope = scopeSql();
    const events = this.db
      .prepare(
        `
          SELECT id, event_id, subject_id AS activity_id, event_type AS change_type,
            occurred_at_utc, received_at_utc, domain_sequence AS server_sequence, payload_json, user_id
          FROM events
          WHERE event_domain = 'activity'
            AND status = 'accepted'
            ${scope.clause}
          ORDER BY occurred_at_utc ASC, domain_sequence ASC
        `
      )
      .all(...scope.params);
    const activities = new Map();

    for (const event of events) {
      const activityId = sanitizeText(event.activity_id);
      if (!activityId) continue;
      const payload = parseJsonObject(event.payload_json);
      const existing = activities.get(activityId);

      if (event.change_type === 'create') {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        activities.set(activityId, {
          id: activityId,
          activity_type_id: normalizeActivityType(payload.activity_type_id, existing?.activity_type_id ?? 'action'),
          title,
          description_md: normalizeMarkdownSource(payload.description_md ?? existing?.description_md ?? ''),
          author: typeof payload.author === 'string' ? sanitizeText(payload.author) ?? '' : existing?.author ?? '',
          reason: typeof payload.reason === 'string' ? normalizeMarkdownSource(payload.reason) : existing?.reason ?? '',
          status: existing?.status ?? 'New',
          created_at_utc: existing?.created_at_utc ?? event.occurred_at_utc,
          updated_at_utc: event.occurred_at_utc,
          completed_at_utc: existing?.completed_at_utc ?? null,
          sort_order: existing?.sort_order ?? null,
          deleted_at_utc: null,
          restored_at_utc: existing?.restored_at_utc ?? null,
          normalized: existing?.normalized === true,
          initial_event_id: existing?.initial_event_id ?? event.id,
          last_event_id: event.event_id
        });
      } else if (event.change_type === 'update_title' && existing) {
        const title = sanitizeText(payload.title);
        if (!title) continue;
        existing.title = title;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      } else if (event.change_type === 'update_description' && existing) {
        existing.description_md = normalizeMarkdownSource(payload.description_md ?? '');
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      } else if (event.change_type === 'normalized' && existing) {
        const title = sanitizeText(payload.title);
        if (title) existing.title = title;
        if (typeof payload.description_md === 'string') {
          existing.description_md = normalizeMarkdownSource(payload.description_md);
        }
        if (typeof payload.reason === 'string') {
          existing.reason = normalizeMarkdownSource(payload.reason);
        }
        existing.normalized = true;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.last_event_id = event.event_id;
      } else if (event.change_type === 'set_status' && existing && ACTIVITY_STATUSES.has(payload.status)) {
        existing.status = payload.status;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.completed_at_utc = payload.status === 'Done' ? event.occurred_at_utc : null;
        existing.sort_order = null;
        existing.last_event_id = event.event_id;
      } else if (event.change_type === 'reorder') {
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
      } else if (event.change_type === 'delete') {
        if (!existing) continue;
        existing.deleted_at_utc = event.occurred_at_utc;
        existing.updated_at_utc = event.occurred_at_utc;
        existing.sort_order = null;
        existing.last_event_id = event.event_id;
      } else if (event.change_type === 'restore') {
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

    this.db
      .prepare(`DELETE FROM activities WHERE activity_type_id IN ('action', 'operation')${scope.clause}`)
      .run(...scope.params);
    const insertActivity = this.db.prepare(`
      INSERT INTO activities (
        id, title, description_md, status, created_at_utc, updated_at_utc, completed_at_utc,
        sort_order, deleted_at_utc, restored_at_utc, last_event_id, activity_type_id, author, reason,
        initial_event_id, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        activity.last_event_id ?? null,
        normalizeActivityType(activity.activity_type_id),
        activity.author ?? '',
        activity.reason ?? '',
        activity.initial_event_id ?? null,
        scopedUserId()
      );
      const stored = this.getActivityItem(activity.id);
      if (stored && activity.normalized) {
        this.ensureActivityRoleLink(stored);
      } else if (stored) {
        this.ensureActivityWorkflowExecution({ activityId: activity.id, nowIso });
      }
    }
  }

};

function isEventAfter(left, right) {
  if (!right) return true;
  return (
    left.occurred_at_utc > right.occurred_at_utc ||
    (left.occurred_at_utc === right.occurred_at_utc && left.server_sequence > right.server_sequence)
  );
}

function normalizeActivityType(value, fallback = 'action') {
  const type = sanitizeText(value);
  return ACTIVITY_TYPES.has(type) ? type : fallback;
}
