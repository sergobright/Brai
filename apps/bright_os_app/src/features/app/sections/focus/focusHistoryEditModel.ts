import { MOSCOW_OFFSET_MS } from "@/shared/time/format";
import type { FocusSessionInterval, TimerSession } from "@/shared/types/timer";

export type FocusEditField = "start" | "duration" | "end";

export type FocusEditDraft = {
  sessionId: string;
  intervalId?: string;
  originalStartMs: number;
  originalEndMs: number;
  startMs: number;
  endMs: number;
};

const STEP_MS = 5 * 60 * 1000;

export function canonicalSessionId(session: TimerSession): string {
  return session.source_session_id ?? session.id.replace(/:\d{4}-\d{2}-\d{2}$/, "");
}

export function createFocusEditDraft(session: TimerSession): FocusEditDraft | null {
  const interval = session.intervals?.length === 1 ? session.intervals[0] : null;
  const startMs = Date.parse(session.started_at_utc);
  const endMs = Date.parse(session.ended_at_utc ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    sessionId: canonicalSessionId(session),
    intervalId: interval?.id,
    originalStartMs: startMs,
    originalEndMs: endMs,
    startMs,
    endMs,
  };
}

export function createFocusIntervalEditDraft(interval: FocusSessionInterval): FocusEditDraft | null {
  const startMs = Date.parse(interval.started_at_utc);
  const endMs = Date.parse(interval.ended_at_utc ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return {
    sessionId: interval.focus_session_id,
    intervalId: interval.id,
    originalStartMs: startMs,
    originalEndMs: endMs,
    startMs,
    endMs,
  };
}

export function draftChanged(draft: FocusEditDraft): boolean {
  return draft.startMs !== draft.originalStartMs || draft.endMs !== draft.originalEndMs;
}

export function draftUtcRange(draft: FocusEditDraft): { startedAtUtc: string; endedAtUtc: string } {
  return {
    startedAtUtc: new Date(draft.startMs).toISOString(),
    endedAtUtc: new Date(draft.endMs).toISOString(),
  };
}

export function formatTimeInput(utcMs: number): string {
  const shifted = new Date(utcMs + MOSCOW_OFFSET_MS).toISOString();
  return shifted.slice(11, 16);
}

export function formatDurationInput(startMs: number, endMs: number): string {
  const minutes = Math.max(0, Math.floor((endMs - startMs) / 60000));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function normalizedInputValue(field: FocusEditField, value: string): string | null {
  const minutes = parseInputMinutes(field, value);
  if (minutes == null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function applyFocusStep(draft: FocusEditDraft, field: FocusEditField, direction: -1 | 1): FocusEditDraft | null {
  if (field === "start") return validDraft({ ...draft, startMs: draft.startMs + direction * STEP_MS, endMs: draft.endMs + direction * STEP_MS });
  if (field === "end") return validDraft({ ...draft, endMs: draft.endMs + direction * STEP_MS });
  const nextEndMs = Math.max(draft.startMs + STEP_MS, draft.endMs + direction * STEP_MS);
  return validDraft({ ...draft, endMs: nextEndMs });
}

export function applyFocusInput(draft: FocusEditDraft, field: FocusEditField, value: string): FocusEditDraft | null {
  const minutes = parseInputMinutes(field, value);
  if (minutes == null) return null;
  if (field === "start") {
    const nextStartMs = setMoscowClock(draft.startMs, minutes);
    const delta = nextStartMs - draft.startMs;
    return validDraft({ ...draft, startMs: nextStartMs, endMs: draft.endMs + delta });
  }
  if (field === "end") return validDraft({ ...draft, endMs: setMoscowClock(draft.endMs, minutes) });
  return validDraft({ ...draft, endMs: draft.startMs + minutes * 60000 });
}

export function hasFocusOverlap(draft: FocusEditDraft, sessions: TimerSession[], ignoredIntervalIds: string[] = []): boolean {
  const ignoredIntervals = new Set(ignoredIntervalIds);
  if (draft.intervalId) ignoredIntervals.add(draft.intervalId);
  return sessions.some((session) => {
    if (draft.intervalId && session.intervals?.some((interval) => interval.id === draft.intervalId)) {
      return session.intervals.some((interval) => {
        if (ignoredIntervals.has(interval.id)) return false;
        const startMs = Date.parse(interval.started_at_utc);
        const endMs = interval.ended_at_utc ? Date.parse(interval.ended_at_utc) : Number.POSITIVE_INFINITY;
        return Number.isFinite(startMs) && startMs < draft.endMs && endMs > draft.startMs;
      });
    }
    if (canonicalSessionId(session) === draft.sessionId) return false;
    const startMs = Date.parse(session.started_at_utc);
    const endMs = session.ended_at_utc ? Date.parse(session.ended_at_utc) : Number.POSITIVE_INFINITY;
    return Number.isFinite(startMs) && startMs < draft.endMs && endMs > draft.startMs;
  });
}

function parseInputMinutes(field: FocusEditField, value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes > 59) return null;
  if (field !== "duration" && hours > 23) return null;
  const total = hours * 60 + minutes;
  return field === "duration" && total <= 0 ? null : total;
}

function setMoscowClock(utcMs: number, minutesOfDay: number): number {
  const shifted = new Date(utcMs + MOSCOW_OFFSET_MS);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    Math.floor(minutesOfDay / 60),
    minutesOfDay % 60,
  ) - MOSCOW_OFFSET_MS;
}

function validDraft(draft: FocusEditDraft): FocusEditDraft | null {
  return draft.endMs > draft.startMs ? draft : null;
}
