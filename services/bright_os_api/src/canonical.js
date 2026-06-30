import crypto from 'node:crypto';

const ACTION_EVENT_TYPES = new Set([
  'start_activity_focus',
  'switch_activity_focus',
  'stop_activity_focus'
]);

export function buildCanonicalSessions(events) {
  const accepted = events.filter(
    (event) =>
      event.status === 'accepted' &&
      (event.type === 'start' ||
        event.type === 'stop' ||
        ACTION_EVENT_TYPES.has(event.type)) &&
      Number.isFinite(Date.parse(event.occurred_at_utc))
  );
  const baseSessions = buildBaseSessions(accepted);
  const replayEvents = accepted
    .filter((event) => ACTION_EVENT_TYPES.has(event.type) || event.type === 'stop')
    .sort(compareEvents);

  for (const event of replayEvents) {
    if (ACTION_EVENT_TYPES.has(event.type)) {
      applyActionFocusEvent(baseSessions, event);
    } else {
      applyStandaloneStopEvent(baseSessions, event);
    }
  }

  return baseSessions
    .map(normalizeSession)
    .filter((session) => session && session.intervals.length > 0)
    .sort((a, b) => Date.parse(a.started_at_utc) - Date.parse(b.started_at_utc));
}

export function normalizeDeviceTimeline(events) {
  const sorted = events.slice().sort(compareEvents);
  const intervals = [];
  let activeStart = null;

  for (const event of sorted) {
    if (event.type === 'start') {
      if (!activeStart) activeStart = event;
      continue;
    }

    if (event.type !== 'stop' || !activeStart) continue;

    const startedMs = Date.parse(activeStart.occurred_at_utc);
    const endedMs = Date.parse(event.occurred_at_utc);
    if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
      continue;
    }

    intervals.push({
      startedMs,
      endedMs,
      sourceEvents: [sourceEvent(activeStart, 'start'), sourceEvent(event, 'stop')]
    });
    activeStart = null;
  }

  if (activeStart) {
    intervals.push({
      startedMs: Date.parse(activeStart.occurred_at_utc),
      endedMs: null,
      sourceEvents: [sourceEvent(activeStart, 'start')]
    });
  }

  return intervals.filter((interval) => Number.isFinite(interval.startedMs));
}

export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval.endedMs === null || interval.endedMs >= interval.startedMs)
    .slice()
    .sort((a, b) => a.startedMs - b.startedMs || intervalEndMs(a) - intervalEndMs(b));
  const merged = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(cloneInterval(interval));
      continue;
    }

    const lastEnd = intervalEndMs(last);
    if (interval.startedMs <= lastEnd) {
      if (last.endedMs === null || interval.endedMs === null) {
        last.endedMs = null;
      } else {
        last.endedMs = Math.max(last.endedMs, interval.endedMs);
      }
      last.sourceEvents = mergeSources(last.sourceEvents, interval.sourceEvents);
      continue;
    }

    merged.push(cloneInterval(interval));
  }

  return merged;
}

export function compareEvents(a, b) {
  return (
    Date.parse(a.occurred_at_utc) - Date.parse(b.occurred_at_utc) ||
    Number(a.server_sequence ?? 0) - Number(b.server_sequence ?? 0) ||
    String(a.device_id ?? '').localeCompare(String(b.device_id ?? '')) ||
    String(a.event_id ?? '').localeCompare(String(b.event_id ?? ''))
  );
}

function buildBaseSessions(events) {
  const globalStops = events
    .filter(isGlobalStopEvent)
    .slice()
    .sort(compareEvents);
  const deviceEvents = new Map();

  for (const event of events) {
    if (event.type !== 'start' && event.type !== 'stop') continue;
    if (isGlobalStopEvent(event)) continue;
    const items = deviceEvents.get(event.device_id) ?? [];
    items.push(event);
    deviceEvents.set(event.device_id, items);
  }

  const intervals = [];
  for (const [deviceId, eventsForDevice] of deviceEvents) {
    const replayEvents = [
      ...eventsForDevice,
      ...globalStops.map((event) => ({
        ...event,
        device_id: deviceId,
        source_device_id: event.device_id
      }))
    ];
    intervals.push(...normalizeDeviceTimeline(replayEvents));
  }

  return mergeIntervals(intervals).map(baseIntervalToSession);
}

function applyActionFocusEvent(sessions, event) {
  const metadata = parseMetadata(event.metadata_json);
  const activityId = textValue(metadata.activity_id) ?? textValue(metadata.action_id);
  const occurredMs = Date.parse(event.occurred_at_utc);
  if (!Number.isFinite(occurredMs)) return;

  if (event.type === 'start_activity_focus') {
    if (!activityId) return;
    let session = findSessionAt(sessions, occurredMs);
    if (!session) {
      session = createActionStartedSession(event, activityId, occurredMs);
      sessions.push(session);
      return;
    }
    openActivityInterval(session, event, activityId, occurredMs, 'start_activity_focus');
    return;
  }

  if (event.type === 'switch_activity_focus') {
    if (!activityId) return;
    const session = findSessionAt(sessions, occurredMs);
    if (!session) return;
    openActivityInterval(session, event, activityId, occurredMs, 'switch_activity_focus');
    return;
  }

  if (event.type === 'stop_activity_focus') {
    const session = findSessionAt(sessions, occurredMs);
    if (!session) return;
    stopActivityInterval(session, event, occurredMs, metadata.preserve_focus_session === true);
  }
}

function applyStandaloneStopEvent(sessions, event) {
  const occurredMs = Date.parse(event.occurred_at_utc);
  if (!Number.isFinite(occurredMs)) return;
  const session = sessions
    .filter((item) => item.start_origin === 'activity' && item.endedMs === null && item.startedMs <= occurredMs)
    .sort((a, b) => b.startedMs - a.startedMs)[0] ?? null;
  if (!session) return;
  closeIntervalAt(session, occurredMs, event.event_id);
  session.endedMs = occurredMs;
  session.sourceEvents = mergeSources(session.sourceEvents, [sourceEvent(event, 'stop')]);
  session.intervals = session.intervals.filter((interval) => interval.startedMs < occurredMs);
}

function baseIntervalToSession(interval) {
  const startedAt = new Date(interval.startedMs).toISOString();
  const endedAt = interval.endedMs === null ? null : new Date(interval.endedMs).toISOString();
  const id = stableSessionId(startedAt, endedAt, interval.sourceEvents);
  return {
    id,
    start_origin: 'focus',
    started_by_activity_id: null,
    startedMs: interval.startedMs,
    endedMs: interval.endedMs,
    sourceEvents: interval.sourceEvents.slice(),
    intervals: [
      {
        id: `${id}:interval:0`,
        activity_id: null,
        startedMs: interval.startedMs,
        endedMs: interval.endedMs,
        createdEventId: interval.sourceEvents.find((source) => source.role === 'start')?.event_id ?? null,
        endedEventId: interval.sourceEvents.find((source) => source.role === 'stop')?.event_id ?? null,
        createdByDeviceId: interval.sourceEvents.find((source) => source.role === 'start')?.device_id ?? null
      }
    ]
  };
}

function createActionStartedSession(event, activityId, startedMs) {
  const source = sourceEvent(event, 'start_activity_focus');
  const startedAt = new Date(startedMs).toISOString();
  const id = stableSessionId(startedAt, null, [source]);
  return {
    id,
    start_origin: 'activity',
    started_by_activity_id: activityId,
    startedMs,
    endedMs: null,
    sourceEvents: [source],
    intervals: [
      {
        id: `${id}:interval:0`,
        activity_id: activityId,
        startedMs,
        endedMs: null,
        createdEventId: event.event_id,
        endedEventId: null,
        createdByDeviceId: event.device_id
      }
    ]
  };
}

function findSessionAt(sessions, occurredMs) {
  return sessions
    .filter((session) => session.startedMs <= occurredMs && intervalEndMs(session) >= occurredMs)
    .sort((a, b) => b.startedMs - a.startedMs)[0] ?? null;
}

function openActivityInterval(session, event, activityId, occurredMs, role) {
  const source = sourceEvent(event, role);
  const tailEndMs = closeIntervalAt(session, occurredMs, event.event_id);
  session.sourceEvents = mergeSources(session.sourceEvents, [source]);
  session.intervals.push({
    id: `${session.id}:interval:${session.intervals.length}`,
    activity_id: activityId,
    startedMs: occurredMs,
    endedMs: tailEndMs,
    createdEventId: event.event_id,
    endedEventId: null,
    createdByDeviceId: event.device_id
  });
}

function stopActivityInterval(session, event, occurredMs, preserveFocusSession = false) {
  const active = intervalAt(session, occurredMs);
  if (!active || !active.activity_id) return;
  const previousEndMs = active.endedMs;
  active.endedMs = occurredMs;
  active.endedEventId = event.event_id;
  session.sourceEvents = mergeSources(session.sourceEvents, [sourceEvent(event, 'stop_activity_focus')]);

  if (session.start_origin === 'activity' && !preserveFocusSession) {
    session.endedMs = occurredMs;
    session.intervals = session.intervals.filter((interval) => interval.startedMs < occurredMs);
    return;
  }

  if (previousEndMs === null || previousEndMs > occurredMs) {
    session.intervals.push({
      id: `${session.id}:interval:${session.intervals.length}`,
      activity_id: null,
      startedMs: occurredMs,
      endedMs: previousEndMs,
      createdEventId: event.event_id,
      endedEventId: null,
      createdByDeviceId: event.device_id
    });
  }
}

function closeIntervalAt(session, occurredMs, endedEventId) {
  const active = intervalAt(session, occurredMs);
  if (!active) return null;
  const previousEndMs = active.endedMs;
  active.endedMs = occurredMs;
  active.endedEventId = endedEventId;
  return previousEndMs;
}

function intervalAt(session, occurredMs) {
  return session.intervals
    .filter((interval) => interval.startedMs <= occurredMs && intervalEndMs(interval) >= occurredMs)
    .sort((a, b) => b.startedMs - a.startedMs)[0] ?? null;
}

function normalizeSession(session) {
  const intervals = session.intervals
    .filter((interval) => interval.endedMs === null || interval.endedMs > interval.startedMs)
    .sort((a, b) => a.startedMs - b.startedMs)
    .map((interval, index) => {
      const endedAt = interval.endedMs === null ? null : new Date(interval.endedMs).toISOString();
      return {
        id: `${session.id}:interval:${index}`,
        focus_session_id: session.id,
        activity_id: interval.activity_id,
        started_at_utc: new Date(interval.startedMs).toISOString(),
        ended_at_utc: endedAt,
        duration_seconds:
          interval.endedMs === null
            ? null
            : Math.max(0, Math.floor((interval.endedMs - interval.startedMs) / 1000)),
        created_event_id: interval.createdEventId,
        ended_event_id: interval.endedEventId,
        created_by_device_id: interval.createdByDeviceId
      };
    });
  if (intervals.length === 0) return null;
  const startedMs = Math.min(...intervals.map((interval) => Date.parse(interval.started_at_utc)));
  const active = intervals.some((interval) => interval.ended_at_utc === null);
  const endedMs = active
    ? null
    : Math.max(...intervals.map((interval) => Date.parse(interval.ended_at_utc)));

  return {
    id: session.id,
    start_origin: session.start_origin,
    started_by_activity_id: session.started_by_activity_id,
    started_at_utc: new Date(startedMs).toISOString(),
    ended_at_utc: endedMs === null ? null : new Date(endedMs).toISOString(),
    duration_seconds: active
      ? null
      : intervals.reduce((sum, interval) => sum + (interval.duration_seconds ?? 0), 0),
    sourceEvents: session.sourceEvents,
    intervals
  };
}

function intervalEndMs(interval) {
  return interval.endedMs === null ? Number.POSITIVE_INFINITY : interval.endedMs;
}

function cloneInterval(interval) {
  return {
    startedMs: interval.startedMs,
    endedMs: interval.endedMs,
    sourceEvents: interval.sourceEvents.slice()
  };
}

function sourceEvent(event, role) {
  return {
    event_id: event.event_id,
    device_id: event.source_device_id ?? event.device_id,
    role
  };
}

function mergeSources(left, right) {
  const seen = new Set();
  const sources = [];
  for (const source of [...left, ...right]) {
    const key = `${source.event_id}:${source.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  return sources;
}

function stableSessionId(startedAt, endedAt, sourceEvents) {
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        startedAt,
        endedAt,
        sourceEvents: sourceEvents.map((source) => source.event_id).sort()
      })
    )
    .digest('hex')
    .slice(0, 20);
  return `canonical-${hash}`;
}

function isGlobalStopEvent(event) {
  const metadata = parseMetadata(event.metadata_json);
  return event.type === 'stop' && metadata.global_stop === true;
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
