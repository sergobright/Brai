export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAILY_GOAL_SECONDS = 12 * 60 * 60;
export const CHALLENGE_START_DATE = '2026-06-12';
export const CHALLENGE_DAYS = 28;
export const CHALLENGE_TARGET_SECONDS = DAILY_GOAL_SECONDS * CHALLENGE_DAYS;

export function nowIso() {
  return new Date().toISOString();
}

export function localDateFromUtcMs(utcMs) {
  return new Date(utcMs + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

export function localHourFromUtcMs(utcMs) {
  return Number(new Date(utcMs + MOSCOW_OFFSET_MS).toISOString().slice(11, 13));
}

export function addDays(dateString, days) {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function moscowDateStartUtcMs(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return Date.UTC(year, month - 1, day, 0, 0, 0) - MOSCOW_OFFSET_MS;
}

export function challengeDates() {
  return Array.from({ length: CHALLENGE_DAYS }, (_, index) =>
    addDays(CHALLENGE_START_DATE, index)
  );
}

export function challengeEndDate() {
  return addDays(CHALLENGE_START_DATE, CHALLENGE_DAYS - 1);
}

export function challengeEndExclusiveUtcMs() {
  return moscowDateStartUtcMs(addDays(CHALLENGE_START_DATE, CHALLENGE_DAYS));
}

export function splitSessionByMoscowDay(startedAtUtc, endedAtUtc) {
  const startMs = Date.parse(startedAtUtc);
  const endMs = Date.parse(endedAtUtc);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }

  const chunks = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const date = localDateFromUtcMs(cursor);
    const nextBoundary = moscowDateStartUtcMs(addDays(date, 1));
    const chunkEnd = Math.min(endMs, nextBoundary);
    const seconds = Math.max(0, Math.floor((chunkEnd - cursor) / 1000));
    if (seconds > 0) {
      chunks.push({ date, seconds });
    }
    cursor = chunkEnd;
  }
  return chunks;
}

export function remainingChallengeDays(currentUtcMs = Date.now()) {
  const currentDate = localDateFromUtcMs(currentUtcMs);
  const endDate = challengeEndDate();
  if (currentDate < CHALLENGE_START_DATE) return CHALLENGE_DAYS;
  if (currentDate > endDate) return 0;

  const currentStart = moscowDateStartUtcMs(currentDate);
  const endStart = moscowDateStartUtcMs(endDate);
  return Math.floor((endStart - currentStart) / (24 * 60 * 60 * 1000)) + 1;
}

export function formatSeconds(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return { hours, minutes, seconds: secs };
}
