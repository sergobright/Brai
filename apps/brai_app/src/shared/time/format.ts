import type { TimerSession, TimerState } from "@/shared/types/timer";

export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_DISPLAY_TIME_ZONE = "Europe/Moscow";

let displayTimeZone = DEFAULT_DISPLAY_TIME_ZONE;

export function getDisplayTimeZone(): string {
  return displayTimeZone;
}

export function setDisplayTimeZone(timeZone: string): void {
  displayTimeZone = normalizeTimeZone(timeZone);
}

export function normalizeTimeZone(timeZone: string | null | undefined): string {
  const value = timeZone === "UTC+0" || timeZone === "UTC+00:00" || timeZone === "Etc/UTC" ? "UTC" : String(timeZone ?? "").trim();
  if (!value) return DEFAULT_DISPLAY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    return DEFAULT_DISPLAY_TIME_ZONE;
  }
}

/**
 * Advances active timer and interval elapsed counters against the current clock.
 */
export function tickTimerState(state: TimerState, now = new Date()): TimerState {
  if (!state.active_session) {
    return { ...state, server_time_utc: now.toISOString(), elapsed_seconds: 0, active_interval_elapsed_seconds: 0 };
  }

  const startedMs = Date.parse(state.active_session.started_at_utc);
  const activeInterval = state.active_interval ?? state.active_session.active_interval ?? null;
  const activeIntervalStartedMs = Date.parse(activeInterval?.started_at_utc ?? "");
  const elapsed = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((now.getTime() - startedMs) / 1000))
    : state.elapsed_seconds;
  const activeIntervalElapsed = Number.isFinite(activeIntervalStartedMs)
    ? Math.max(0, Math.floor((now.getTime() - activeIntervalStartedMs) / 1000))
    : (state.active_interval_elapsed_seconds ?? 0);

  return {
    ...state,
    server_time_utc: now.toISOString(),
    elapsed_seconds: elapsed,
    active_interval: activeInterval,
    active_interval_elapsed_seconds: activeIntervalElapsed,
    active_activity_id: activeInterval?.activity_id ?? state.active_activity_id ?? null,
  };
}

export function formatDuration(seconds: number | null | undefined): string {
  const safe = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map((item) => String(item).padStart(2, "0")).join(":");
}

export function formatHourMinute(seconds: number | null | undefined): string {
  const safe = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function formatHumanDuration(seconds: number | null | undefined): string {
  const safe = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours === 0 && minutes === 0) return "0 мин";
  if (hours === 0) return `${minutes} мин`;
  if (minutes === 0) return `${hours} ч`;
  return `${hours} ч ${minutes} мин`;
}

export function formatGoalDuration(seconds: number | null | undefined): string {
  const safe = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours === 0 && minutes === 0) return "0м";
  if (hours === 0) return `${minutes}м`;
  if (minutes === 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}

export function formatPercent(value: number | null | undefined): string {
  const safe = Number.isFinite(value ?? NaN) ? Number(value) : 0;
  if (safe === 0) return "0%";
  if (safe < 1) return `${safe.toFixed(1).replace(".", ",")}%`;
  if (safe < 100) return `${safe.toFixed(1).replace(".", ",")}%`;
  return `${safe.toFixed(0)}%`;
}

export function moscowDateTime(utcIso: string | null | undefined): string {
  if (!utcIso) return "";
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms)) return "";
  const parts = zonedParts(ms);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function moscowTime(utcIso: string | null | undefined): string {
  return moscowDateTime(utcIso).slice(11);
}

export function formatRussianDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

export function sessionDuration(session: TimerSession): number {
  if (session.duration_seconds != null) return session.duration_seconds;
  if (!session.ended_at_utc) return 0;
  return Math.max(
    0,
    Math.floor(
      (Date.parse(session.ended_at_utc) - Date.parse(session.started_at_utc)) / 1000,
    ),
  );
}

export function localDateFromUtcMs(utcMs: number, timeZone = displayTimeZone): string {
  const parts = zonedParts(utcMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localHourFromUtcMs(utcMs: number, timeZone = displayTimeZone): number {
  return Number(zonedParts(utcMs, timeZone).hour);
}

export function localDateStartUtcMs(dateString: string, timeZone = displayTimeZone): number {
  const [year, month, day] = dateString.split("-").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day);
  let candidate = localAsUtc - timeZoneOffsetMs(localAsUtc, timeZone);
  candidate = localAsUtc - timeZoneOffsetMs(candidate, timeZone);
  return candidate;
}

export function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function formatLocalTimeInput(utcMs: number, timeZone = displayTimeZone): string {
  const parts = zonedParts(utcMs, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function setLocalClock(utcMs: number, minutesOfDay: number, timeZone = displayTimeZone): number {
  const parts = zonedParts(utcMs, timeZone);
  return localDateStartUtcMs(`${parts.year}-${parts.month}-${parts.day}`, timeZone) + minutesOfDay * 60_000;
}

function zonedParts(utcMs: number, timeZone = displayTimeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return {
    year: parts.year ?? "1970",
    month: parts.month ?? "01",
    day: parts.day ?? "01",
    hour: parts.hour ?? "00",
    minute: parts.minute ?? "00",
    second: parts.second ?? "00",
  };
}

function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zonedParts(utcMs, timeZone);
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  ) - Math.floor(utcMs / 1000) * 1000;
}
