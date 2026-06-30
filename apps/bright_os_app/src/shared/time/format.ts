import type { TimerSession, TimerState } from "@/shared/types/timer";

export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

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
  const shifted = new Date(ms + MOSCOW_OFFSET_MS).toISOString();
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`;
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
