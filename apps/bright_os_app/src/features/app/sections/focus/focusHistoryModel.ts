import { moscowTime, sessionDuration } from "@/shared/time/format";
import type { FocusSessionInterval, TimerSession } from "@/shared/types/timer";
import { canonicalSessionId } from "./focusHistoryEditModel";

export type FocusHistoryRow = {
  id: string;
  sessionId: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  intervals: FocusSessionInterval[];
  actionIntervalCount: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  pending: boolean;
};

export function focusHistoryRows(sessions: TimerSession[]): FocusHistoryRow[] {
  return sessions.map((session) => {
    const intervals = contiguousSessionIntervals(session);
    const actionIntervals = intervals.filter((interval) => interval.activity_id);
    return {
      arrivalTime: moscowTime(session.ended_at_utc),
      departureTime: moscowTime(session.started_at_utc),
      destination: historyTitle(session, actionIntervals),
      duration: formatCompactSessionDuration(sessionDuration(session)),
      endedAtUtc: session.ended_at_utc,
      id: session.id,
      intervals,
      actionIntervalCount: actionIntervals.length,
      sessionId: canonicalSessionId(session),
      pending: session.pending === true,
      startedAtUtc: session.started_at_utc,
    };
  });
}

function contiguousSessionIntervals(session: TimerSession): FocusSessionInterval[] {
  const intervals = (session.intervals ?? [])
    .slice()
    .sort((left, right) => Date.parse(left.started_at_utc) - Date.parse(right.started_at_utc));
  if (intervals.length < 2) return intervals;

  const sessionStartMs = Date.parse(session.started_at_utc);
  const sessionEndMs = Date.parse(session.ended_at_utc ?? "");
  let cursorMs = Number.isFinite(sessionStartMs) ? sessionStartMs : Date.parse(intervals[0]?.started_at_utc ?? "");
  const packed: FocusSessionInterval[] = [];

  for (const interval of intervals) {
    const originalStartMs = Date.parse(interval.started_at_utc);
    const originalEndMs = Date.parse(interval.ended_at_utc ?? "");
    if (!Number.isFinite(originalStartMs) || !Number.isFinite(originalEndMs) || originalEndMs <= originalStartMs || !Number.isFinite(cursorMs)) {
      packed.push(interval);
      cursorMs = originalEndMs;
      continue;
    }

    let startMs = originalStartMs;
    let endMs = originalEndMs;
    if (startMs > cursorMs) {
      const previous = packed[packed.length - 1];
      if (previous?.activity_id == null && previous.ended_at_utc) {
        packed[packed.length - 1] = intervalWithRange(previous, Date.parse(previous.started_at_utc), startMs);
      } else if (interval.activity_id == null) {
        startMs = cursorMs;
      } else {
        endMs = cursorMs + (endMs - startMs);
        startMs = cursorMs;
      }
    } else if (startMs < cursorMs) {
      endMs = cursorMs + (endMs - startMs);
      startMs = cursorMs;
    }

    packed.push(intervalWithRange(interval, startMs, endMs));
    cursorMs = endMs;
  }

  if (Number.isFinite(sessionEndMs) && Number.isFinite(cursorMs) && sessionEndMs > cursorMs && packed.length > 0) {
    const last = packed[packed.length - 1];
    packed[packed.length - 1] = intervalWithRange(last, Date.parse(last.started_at_utc), sessionEndMs);
  }

  return packed;
}

function intervalWithRange(interval: FocusSessionInterval, startMs: number, endMs: number): FocusSessionInterval {
  const startedAtUtc = new Date(startMs).toISOString();
  const endedAtUtc = new Date(endMs).toISOString();
  if (interval.started_at_utc === startedAtUtc && interval.ended_at_utc === endedAtUtc) return interval;
  return {
    ...interval,
    started_at_utc: startedAtUtc,
    ended_at_utc: endedAtUtc,
    duration_seconds: Math.max(0, Math.floor((endMs - startMs) / 1000)),
  };
}

function historyTitle(session: TimerSession, actionIntervals: FocusSessionInterval[]) {
  if (actionIntervals.length === 0) return "В фокусе";
  return longestActionTitle(actionIntervals) ?? session.primary_activity_title ?? "Действие";
}

function longestActionTitle(intervals: FocusSessionInterval[]) {
  return intervals
    .slice()
    .sort((left, right) => {
      const titleDelta = (right.activity_title?.length ?? 0) - (left.activity_title?.length ?? 0);
      if (titleDelta !== 0) return titleDelta;
      return (right.duration_seconds ?? 0) - (left.duration_seconds ?? 0);
    })[0]?.activity_title ?? null;
}

function formatCompactSessionDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours <= 0) return `${minutes}м`;
  if (minutes <= 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}
