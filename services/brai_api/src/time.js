export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_TIME_ZONE = 'Europe/Moscow';
export const DAILY_GOAL_SECONDS = 12 * 60 * 60;
export const CHALLENGE_START_DATE = '2026-06-12';
export const CHALLENGE_DAYS = 28;
export const CHALLENGE_TARGET_SECONDS = DAILY_GOAL_SECONDS * CHALLENGE_DAYS;

export function nowIso() {
  return new Date().toISOString();
}

export function localDateFromUtcMs(utcMs, timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(utcMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localHourFromUtcMs(utcMs, timeZone = DEFAULT_TIME_ZONE) {
  return Number(zonedParts(utcMs, timeZone).hour);
}

export function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function moscowDateStartUtcMs(dateString) {
  return localDateStartUtcMs(dateString, DEFAULT_TIME_ZONE);
}

export function localDateStartUtcMs(dateString, timeZone = DEFAULT_TIME_ZONE) {
  const [year, month, day] = dateString.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = localAsUtc - timeZoneOffsetMs(localAsUtc, timeZone);
  candidate = localAsUtc - timeZoneOffsetMs(candidate, timeZone);
  return candidate;
}

export function challengeDates() {
  return Array.from({ length: CHALLENGE_DAYS }, (_, index) =>
    addDays(CHALLENGE_START_DATE, index)
  );
}

export function challengeEndDate() {
  return addDays(CHALLENGE_START_DATE, CHALLENGE_DAYS - 1);
}

export function challengeEndExclusiveUtcMs(timeZone = DEFAULT_TIME_ZONE) {
  return localDateStartUtcMs(addDays(CHALLENGE_START_DATE, CHALLENGE_DAYS), timeZone);
}

export function splitSessionByMoscowDay(startedAtUtc, endedAtUtc, timeZone = DEFAULT_TIME_ZONE) {
  const startMs = Date.parse(startedAtUtc);
  const endMs = Date.parse(endedAtUtc);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }

  const chunks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const date = localDateFromUtcMs(cursor, timeZone);
    const nextBoundary = localDateStartUtcMs(addDays(date, 1), timeZone);
    const chunkEnd = Math.min(endMs, nextBoundary);
    const seconds = Math.max(0, Math.floor((chunkEnd - cursor) / 1000));
    if (seconds > 0) {
      chunks.push({ date, seconds });
    }
    cursor = chunkEnd;
  }
  return chunks;
}

export function remainingChallengeDays(currentUtcMs = Date.now(), timeZone = DEFAULT_TIME_ZONE) {
  const currentDate = localDateFromUtcMs(currentUtcMs, timeZone);
  const endDate = challengeEndDate();
  if (currentDate < CHALLENGE_START_DATE) return CHALLENGE_DAYS;
  if (currentDate > endDate) return 0;

  const currentStart = localDateStartUtcMs(currentDate, timeZone);
  const endStart = localDateStartUtcMs(endDate, timeZone);
  return Math.floor((endStart - currentStart) / (24 * 60 * 60 * 1000)) + 1;
}

export function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return { hours, minutes, seconds: secs };
}

function zonedParts(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function timeZoneOffsetMs(utcMs, timeZone) {
  const parts = zonedParts(utcMs, timeZone);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}
