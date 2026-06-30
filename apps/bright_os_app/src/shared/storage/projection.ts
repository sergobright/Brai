import type { FocusSessionInterval, HistoryData, PendingTimerEvent, TimerSession, TimerState } from "@/shared/types/timer";
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
      const interval = pendingInterval(event, event.localTimerId, null);
      projected = {
        ...projected,
        active_session: {
          id: event.localTimerId,
          started_at_utc: event.occurredAtUtc,
          ended_at_utc: null,
          duration_seconds: null,
          intervals: [interval],
          active_interval: interval,
          active_activity_id: null,
          start_origin: "focus",
          pending: true,
        },
        active_interval: interval,
        active_interval_elapsed_seconds: Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(event.occurredAtUtc)) / 1000),
        ),
        active_activity_id: null,
        active_session_start_origin: "focus",
        active_session_started_by_activity_id: null,
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
        active_interval: null,
        active_interval_elapsed_seconds: 0,
        active_activity_id: null,
        active_session_start_origin: null,
        active_session_started_by_activity_id: null,
        elapsed_seconds: 0,
      };
    }

    if (event.type === "start_activity_focus" || event.type === "switch_activity_focus") {
      const activityId = stringValue(event.metadata?.activity_id) ?? stringValue(event.metadata?.action_id);
      if (!activityId) continue;
      const sessionId = projected.active_session?.id ?? event.localTimerId;
      const interval = pendingInterval(event, sessionId, activityId);
      const startedAtUtc = projected.active_session?.started_at_utc ?? event.occurredAtUtc;
      const startOrigin = projected.active_session?.start_origin ?? "activity";
      const intervals = [
        ...closeOpenIntervals(projected.active_session?.intervals ?? [], event.occurredAtUtc),
        interval,
      ];
      projected = {
        ...projected,
        active_session: {
          ...(projected.active_session ?? {
            id: sessionId,
            started_at_utc: startedAtUtc,
            ended_at_utc: null,
            duration_seconds: null,
          }),
          intervals,
          active_interval: interval,
          active_activity_id: activityId,
          start_origin: startOrigin,
          started_by_activity_id: startOrigin === "activity" ? activityId : projected.active_session?.started_by_activity_id,
          pending: true,
        },
        active_interval: interval,
        active_interval_elapsed_seconds: Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(event.occurredAtUtc)) / 1000),
        ),
        active_activity_id: activityId,
        active_session_start_origin: startOrigin,
        active_session_started_by_activity_id: startOrigin === "activity" ? activityId : (projected.active_session?.started_by_activity_id ?? null),
        elapsed_seconds: Math.max(
          0,
          Math.floor((now.getTime() - Date.parse(startedAtUtc)) / 1000),
        ),
      };
    }

    if (event.type === "stop_activity_focus" && projected.active_session?.active_interval?.activity_id) {
      const closedIntervals = closeOpenIntervals(projected.active_session.intervals ?? [], event.occurredAtUtc);
      if (projected.active_session.start_origin === "activity") {
        projected = {
          ...projected,
          active_session: null,
          active_interval: null,
          active_interval_elapsed_seconds: 0,
          active_activity_id: null,
          active_session_start_origin: null,
          active_session_started_by_activity_id: null,
          elapsed_seconds: 0,
        };
      } else {
        const interval = pendingInterval(event, projected.active_session.id, null);
        const intervals = [...closedIntervals, interval];
        projected = {
          ...projected,
          active_session: {
            ...projected.active_session,
            active_interval: interval,
            active_activity_id: null,
            intervals,
            pending: true,
          },
          active_interval: interval,
          active_interval_elapsed_seconds: Math.max(
            0,
            Math.floor((now.getTime() - Date.parse(event.occurredAtUtc)) / 1000),
          ),
          active_activity_id: null,
        };
      }
    }
  }

  return projected;
}

/**
 * Applies pending focus-session edits over cached canonical history.
 */
export function projectHistoryData(history: HistoryData, pending: PendingTimerEvent[]): HistoryData {
  const sessions = new Map<string, TimerSession>(history.sessions.map((session) => [session.id, { ...session, pending: false }]));

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
    const session = sessions.get(sessionId)!;
    if ((session.intervals?.length ?? 1) !== 1) continue;

    sessions.set(sessionId, withEditedSessionRange(session, startedMs, endedMs));
  }

  for (const event of [...pending].sort((a, b) => a.clientSequence - b.clientSequence)) {
    if (event.type !== "edit_focus_interval") continue;
    const intervalId = stringValue(event.metadata?.focus_interval_id) ?? stringValue(event.metadata?.interval_id);
    const sessionId = stringValue(event.metadata?.focus_session_id) ?? stringValue(event.metadata?.session_id);
    const startedMs = Date.parse(stringValue(event.metadata?.started_at_utc) ?? "");
    const endedMs = Date.parse(stringValue(event.metadata?.ended_at_utc) ?? "");
    if (!intervalId || !sessionId || !sessions.has(sessionId) || !Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs <= startedMs) {
      continue;
    }
    sessions.set(sessionId, withEditedInterval(sessions.get(sessionId)!, intervalId, startedMs, endedMs));
  }

  const projectedSessions = [...sessions.values()].sort((left, right) => (
    Date.parse(right.started_at_utc) - Date.parse(left.started_at_utc)
  ));
  return {
    sessions: projectedSessions,
    groups: groupSessionsByDate(projectedSessions),
  };
}

function pendingInterval(event: PendingTimerEvent, sessionId: string, activityId: string | null): FocusSessionInterval {
  return {
    id: `${event.localTimerId}:interval:${event.clientSequence}`,
    focus_session_id: sessionId,
    activity_id: activityId,
    activity_title: null,
    started_at_utc: event.occurredAtUtc,
    ended_at_utc: null,
    duration_seconds: null,
    pending: true,
  };
}

function closeOpenIntervals(intervals: FocusSessionInterval[], endedAtUtc: string): FocusSessionInterval[] {
  const endedMs = Date.parse(endedAtUtc);
  if (!Number.isFinite(endedMs)) return intervals;
  return intervals.flatMap((interval) => {
    if (interval.ended_at_utc) return [interval];
    const startedMs = Date.parse(interval.started_at_utc);
    if (!Number.isFinite(startedMs) || endedMs <= startedMs) return [];
    return [
      {
        ...interval,
        ended_at_utc: endedAtUtc,
        duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000)),
        ended_date_msk: localDateFromUtcMs(endedMs),
        ended_hour_msk: localHourFromUtcMs(endedMs),
        pending: true,
      },
    ];
  });
}

function withEditedSessionRange(session: TimerSession, startedMs: number, endedMs: number): TimerSession {
  const intervals = session.intervals?.length
    ? [editedInterval(session.intervals[0], startedMs, endedMs)]
    : undefined;
  return sessionFromIntervals({
    ...session,
    intervals,
    started_at_utc: new Date(startedMs).toISOString(),
    ended_at_utc: new Date(endedMs).toISOString(),
    duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000)),
    pending: true,
  });
}

function withEditedInterval(session: TimerSession, intervalId: string, startedMs: number, endedMs: number): TimerSession {
  if (!session.intervals?.some((interval) => interval.id === intervalId)) return session;
  return sessionFromIntervals({
    ...session,
    intervals: session.intervals.map((interval) =>
      interval.id === intervalId ? editedInterval(interval, startedMs, endedMs) : interval,
    ),
    pending: true,
  });
}

function editedInterval(interval: FocusSessionInterval, startedMs: number, endedMs: number): FocusSessionInterval {
  return {
    ...interval,
    started_at_utc: new Date(startedMs).toISOString(),
    ended_at_utc: new Date(endedMs).toISOString(),
    duration_seconds: Math.max(0, Math.floor((endedMs - startedMs) / 1000)),
    started_date_msk: localDateFromUtcMs(startedMs),
    started_hour_msk: localHourFromUtcMs(startedMs),
    ended_date_msk: localDateFromUtcMs(endedMs),
    ended_hour_msk: localHourFromUtcMs(endedMs),
    pending: true,
  };
}

function sessionFromIntervals(session: TimerSession): TimerSession {
  const intervals = (session.intervals ?? []).slice().sort((left, right) => Date.parse(left.started_at_utc) - Date.parse(right.started_at_utc));
  if (intervals.length === 0) return session;
  const startedMs = Math.min(...intervals.map((interval) => Date.parse(interval.started_at_utc)));
  const active = intervals.some((interval) => !interval.ended_at_utc);
  const endedMs = active ? null : Math.max(...intervals.map((interval) => Date.parse(interval.ended_at_utc ?? "")));
  const activityIntervals = intervals.filter((interval) => interval.activity_id);
  const primaryActivity = activityIntervals
    .slice()
    .sort((left, right) => (right.duration_seconds ?? 0) - (left.duration_seconds ?? 0))[0];
  return {
    ...session,
    intervals,
    activity_interval_count: activityIntervals.length,
    primary_activity_id: primaryActivity?.activity_id ?? null,
    primary_activity_title: primaryActivity?.activity_title ?? null,
    started_at_utc: new Date(startedMs).toISOString(),
    ended_at_utc: endedMs == null ? null : new Date(endedMs).toISOString(),
    duration_seconds: active ? null : intervals.reduce((sum, interval) => sum + (interval.duration_seconds ?? 0), 0),
    started_date_msk: localDateFromUtcMs(startedMs),
    started_hour_msk: localHourFromUtcMs(startedMs),
    ended_date_msk: endedMs == null ? null : localDateFromUtcMs(endedMs),
    ended_hour_msk: endedMs == null ? null : localHourFromUtcMs(endedMs),
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
