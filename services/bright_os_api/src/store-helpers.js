import {
  addDays,
  localDateFromUtcMs,
  localHourFromUtcMs,
  moscowDateStartUtcMs
} from './time.js';

export const FUTURE_EVENT_TOLERANCE_MS = 5 * 60 * 1000;
export const LEGACY_DEVICE_ID = 'legacy-server';
export const EVENT_PAYLOAD_VERSION = 1;
export const ACTIVITY_EVENT_PAYLOAD_VERSION = 1;
export const ACTIVITY_EVENT_TYPES = new Set([
  'create',
  'update_title',
  'update_description',
  'set_status',
  'reorder',
  'delete',
  'restore'
]);
export const ACTIVITY_STATUSES = new Set(['New', 'Done']);

export function formatSession(session) {
  if (!session) return null;
  const startedMs = Date.parse(session.started_at_utc);
  const endedMs = session.ended_at_utc ? Date.parse(session.ended_at_utc) : null;
  return {
    id: session.id,
    started_at_utc: session.started_at_utc,
    ended_at_utc: session.ended_at_utc,
    duration_seconds: session.duration_seconds,
    started_date_msk: localDateFromUtcMs(startedMs),
    started_hour_msk: localHourFromUtcMs(startedMs),
    ended_date_msk: endedMs ? localDateFromUtcMs(endedMs) : null,
    ended_hour_msk: endedMs ? localHourFromUtcMs(endedMs) : null
  };
}

export function formatActivity(activity) {
  if (!activity) return null;
  return {
    id: activity.id,
    title: activity.title,
    description_md: activity.description_md ?? '',
    status: activity.status,
    created_at_utc: activity.created_at_utc,
    updated_at_utc: activity.updated_at_utc,
    completed_at_utc: activity.completed_at_utc,
    sort_order: Number.isInteger(activity.sort_order) ? activity.sort_order : null,
    deleted_at_utc: activity.deleted_at_utc ?? null,
    restored_at_utc: activity.restored_at_utc ?? null
  };
}

export function groupSessionsByDateHour(sessions, { from, to } = {}) {
  const dates = {};
  for (const session of sessions) {
    for (const chunk of sessionDayChunks(session)) {
      const date = chunk.started_date_msk;
      if ((from && date < from) || (to && date > to)) continue;
      const hour = String(chunk.started_hour_msk).padStart(2, '0');
      dates[date] ??= { total_seconds: 0, hours: {} };
      dates[date].total_seconds += chunk.duration_seconds ?? 0;
      dates[date].hours[hour] ??= { total_seconds: 0, sessions: [] };
      dates[date].hours[hour].total_seconds += chunk.duration_seconds ?? 0;
      dates[date].hours[hour].sessions.push(chunk);
    }
  }
  return dates;
}

function sessionDayChunks(session) {
  const startMs = Date.parse(session.started_at_utc);
  const endMs = Date.parse(session.ended_at_utc);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [session];
  }

  const chunks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const date = localDateFromUtcMs(cursor);
    const chunkEndMs = Math.min(endMs, moscowDateStartUtcMs(addDays(date, 1)));
    const durationSeconds = Math.floor((chunkEndMs - cursor) / 1000);
    if (durationSeconds > 0) {
      const startedAtUtc = new Date(cursor).toISOString();
      const endedAtUtc = new Date(chunkEndMs).toISOString();
      const isWholeSession =
        startedAtUtc === session.started_at_utc && endedAtUtc === session.ended_at_utc;
      chunks.push({
        ...session,
        id: isWholeSession ? session.id : `${session.id}:${date}`,
        started_at_utc: startedAtUtc,
        ended_at_utc: endedAtUtc,
        duration_seconds: durationSeconds,
        started_date_msk: date,
        started_hour_msk: localHourFromUtcMs(cursor),
        ended_date_msk: localDateFromUtcMs(chunkEndMs),
        ended_hour_msk: localHourFromUtcMs(chunkEndMs)
      });
    }
    cursor = chunkEndMs;
  }
  return chunks;
}

export function sanitizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeMarkdownSource(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

export function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

export function normalizeActionPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

export function normalizeOrderedIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    const id = sanitizeText(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function toNullableInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

