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
    const intervals = session.intervals ?? [];
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

function historyTitle(session: TimerSession, actionIntervals: FocusSessionInterval[]) {
  if (actionIntervals.length === 0) return "В фокусе";
  const title = session.primary_activity_title ?? longestActionInterval(actionIntervals)?.activity_title ?? "Действие";
  if (actionIntervals.length === 1) return title;
  return `${title} +${actionIntervals.length - 1}`;
}

function longestActionInterval(intervals: FocusSessionInterval[]) {
  return intervals
    .slice()
    .sort((left, right) => (right.duration_seconds ?? 0) - (left.duration_seconds ?? 0))[0] ?? null;
}

function formatCompactSessionDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours <= 0) return `${minutes}м`;
  if (minutes <= 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}
