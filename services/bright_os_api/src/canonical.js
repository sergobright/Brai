import crypto from 'node:crypto';

export function buildCanonicalSessions(events) {
  const accepted = events.filter(
    (event) =>
      event.status === 'accepted' &&
      (event.type === 'start' || event.type === 'stop') &&
      Number.isFinite(Date.parse(event.occurred_at_utc))
  );
  const globalStops = accepted
    .filter(isGlobalStopEvent)
    .slice()
    .sort(compareEvents);
  const deviceEvents = new Map();

  for (const event of accepted) {
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

  return mergeIntervals(intervals).map(intervalToSession);
}

export function normalizeDeviceTimeline(events) {
  const sorted = events.slice().sort(compareEvents);
  const intervals = [];
  let activeStart = null;

  for (const event of sorted) {
    if (event.type === 'start') {
      if (!activeStart) {
        activeStart = event;
      }
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

function compareEvents(a, b) {
  return (
    Date.parse(a.occurred_at_utc) - Date.parse(b.occurred_at_utc) ||
    Number(a.client_sequence ?? 0) - Number(b.client_sequence ?? 0) ||
    Date.parse(a.received_at_utc) - Date.parse(b.received_at_utc) ||
    Number(a.server_sequence ?? 0) - Number(b.server_sequence ?? 0)
  );
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

function intervalToSession(interval) {
  const startedAt = new Date(interval.startedMs).toISOString();
  const endedAt = interval.endedMs === null ? null : new Date(interval.endedMs).toISOString();
  const id = stableSessionId(startedAt, endedAt, interval.sourceEvents);
  return {
    id,
    started_at_utc: startedAt,
    ended_at_utc: endedAt,
    duration_seconds:
      interval.endedMs === null
        ? null
        : Math.max(0, Math.floor((interval.endedMs - interval.startedMs) / 1000)),
    sourceEvents: interval.sourceEvents
  };
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
