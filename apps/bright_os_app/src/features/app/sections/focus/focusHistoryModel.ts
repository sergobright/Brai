import { moscowTime, sessionDuration } from "@/shared/time/format";
import type { TimerSession } from "@/shared/types/timer";
import { canonicalSessionId } from "./focusHistoryEditModel";

export type FocusHistoryRow = {
  id: string;
  sessionId: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  duration: string;
  startedAtUtc: string;
  endedAtUtc: string | null;
  pending: boolean;
};

export function focusHistoryRows(sessions: TimerSession[]): FocusHistoryRow[] {
  return sessions.map((session) => ({
    arrivalTime: moscowTime(session.ended_at_utc),
    departureTime: moscowTime(session.started_at_utc),
    destination: "В фокусе",
    duration: formatCompactSessionDuration(sessionDuration(session)),
    endedAtUtc: session.ended_at_utc,
    id: session.id,
    sessionId: canonicalSessionId(session),
    pending: session.pending === true,
    startedAtUtc: session.started_at_utc,
  }));
}

function formatCompactSessionDuration(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours <= 0) return `${minutes}м`;
  if (minutes <= 0) return `${hours}ч`;
  return `${hours}ч ${minutes}м`;
}
