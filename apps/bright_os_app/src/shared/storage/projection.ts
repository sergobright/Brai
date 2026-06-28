import type { HistoryData, PendingTimerEvent, TimerSession, TimerState } from "@/shared/types/timer";
import { emptyTimerState } from "@/shared/types/timer";
import { MOSCOW_OFFSET_MS, tickTimerState } from "@/shared/time/format";

/**
 * Applies pending timer events over the canonical timer state for immediate UI.
 */
export function projectTimerState(
  canonical: TimerState | null,
  pending: PendingTimerEvent[],
  now = new Date(),
): TimerState {
  let projected = tickTimerState(canonical ?? emptyTimerState(now), now);
  const sorted = [...pending].sort((a, b) => a.clientSequence - b.clientSequence);

  for (const event of sorted) {
    if (event.type === "start" && !projected.active_session) {
      projected = {
        ...projected,
        active_session: {
          id: event.localTimerId,
          started_at_utc: event.occurredAtUtc,
          ended_at_utc: null,
          duration_seconds: null,
          pending: true,
        },
        elapsed_seconds: Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(event.occurredAtUtc)) / 1000),
        ),
      };
    }

    if (event.type === "stop" && projected.active_session) {
      projected = {
        ...projected,
        active_session: null,
        elapsed_seconds: 0,
      };
    }
  }

  return projected;
}

/**
 * Applies pending focus-session edits over cached canonical history.
 */
export function projectHistoryData(history: HistoryData, pending: PendingTimerEvent[]): HistoryData {
  const sessions = new Map(history.sessions.map((session) => [session.id, { ...session, pending: false }]));

  for (const event of [...pending].sort((a, b) => a.clientSequence - b.clientSequence)) {
    const sessionId = stringValue(event.metadata?.focus_session_id) ?? stringValue(event.metadata?.session_id);
    if (event.type === "delete_session") {
      if (sessionId) sessions.delete(sessionId);
      continue;
    }

    if (event.type !== "edit_session") continue;
    const startedMs = Date.parse(stringValue(event.metadata?.started_at_utc) ?? "");
    const endedMs = Date.parse(stringValue(event.metadata?.ended_at_utc) ?? "");
    if (!sessionId || !sessions.has(sessionId) || !Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
      continue;
    }

    sessions.set(sessionId, {
      ...sessions.get(sessionId)!,
      started_at_utc: new Date(startedMs).toISOString(),
      ended_at_utc: new Date(endedMs).toISOString(),
      duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000)),
      started_date_msk: localDateFromUtcMs(startedMs),
      started_hour_msk: localHourFromUtcMs(startedMs),
      ended_date_msk: localDateFromUtcMs(endedMs),
      ended_hour_msk: localHourFromUtcMs(endedMs),
      pending: true,
    });
  }

  const projectedSessions = [...sessions.values()].sort((left, right) => (
    Date.parse(right.started_at_utc) - Date.parse(left.started_at_utc)
  ));
  return {
    sessions: projectedSessions,
    groups: groupSessionsByDate(projectedSessions),
  };
}

function groupSessionsByDate(sessions: TimerSession[]): HistoryData["groups"] {
  const groups: HistoryData["groups"] = {};
  for (const session of sessions) {
    for (const chunk of sessionDayChunks(session)) {
      const date = chunk.started_date_msk ?? localDateFromUtcMs(Date.parse(chunk.started_at_utc));
      groups[date] ??= { total_seconds: 0, sessions: [] };
      groups[date].total_seconds += chunk.duration_seconds ?? 0;
      groups[date].sessions?.push(chunk);
    }
  }
  return groups;
}

function sessionDayChunks(session: TimerSession): TimerSession[] {
  const startMs = Date.parse(session.started_at_utc);
  const endMs = Date.parse(session.ended_at_utc ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [session];

  const chunks: TimerSession[] = [];
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
        source_session_id: session.id,
        started_at_utc: startedAtUtc,
        ended_at_utc: endedAtUtc,
        duration_seconds: durationSeconds,
        started_date_msk: date,
        started_hour_msk: localHourFromUtcMs(cursor),
        ended_date_msk: localDateFromUtcMs(chunkEndMs),
        ended_hour_msk: localHourFromUtcMs(chunkEndMs),
      });
    }
    cursor = chunkEndMs;
  }
  return chunks;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function localDateFromUtcMs(utcMs: number): string {
  return new Date(utcMs + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
}

function localHourFromUtcMs(utcMs: number): number {
  return Number(new Date(utcMs + MOSCOW_OFFSET_MS).toISOString().slice(11, 13));
}

function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function moscowDateStartUtcMs(dateString: string): number {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 0, 0, 0) - MOSCOW_OFFSET_MS;
}
