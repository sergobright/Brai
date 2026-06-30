import { clientDb, ensureClientMeta, getMeta, randomId, setMeta } from "./db";
import type {
  GoalData,
  HistoryData,
  PendingTimerEvent,
  TimerSession,
  TimerEventType,
  TimerState,
} from "@/shared/types/timer";

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Adds a timer mutation to the durable local outbox.
 */
export async function enqueueTimerEvent(params: {
  type: TimerEventType;
  baseServerRevision: number;
  metadata?: Record<string, unknown>;
}): Promise<PendingTimerEvent> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.outbox_events, async () => {
    const meta = await ensureClientMeta();
    const sequence = meta.nextClientSequence;
    const now = new Date().toISOString();
    const event: PendingTimerEvent = {
      eventId: `${meta.deviceId}:${sequence}:${randomId()}`,
      deviceId: meta.deviceId,
      clientSequence: sequence,
      type: params.type,
      occurredAtUtc: now,
      localTimerId: `${meta.deviceId}:timer:${sequence}`,
      baseServerRevision: params.baseServerRevision,
      payloadVersion: 1,
      metadata: params.metadata,
      status: "pending",
      attemptCount: 0,
      lastError: null,
      enqueuedAtUtc: now,
      lastSyncAttemptAtUtc: null,
    };
    await db.outbox_events.add(event);
    await setMeta("nextClientSequence", sequence + 1);
    return event;
  });
}

export async function enqueueFocusSessionEdit(params: {
  sessionId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "edit_session",
    baseServerRevision: params.baseServerRevision,
    metadata: {
      focus_session_id: params.sessionId,
      started_at_utc: params.startedAtUtc,
      ended_at_utc: params.endedAtUtc,
    },
  });
}

export async function enqueueFocusSessionDelete(params: {
  sessionId: string;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "delete_session",
    baseServerRevision: params.baseServerRevision,
    metadata: {
      focus_session_id: params.sessionId,
    },
  });
}

export async function enqueueStartActionFocus(params: {
  activityId: string;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "start_activity_focus",
    baseServerRevision: params.baseServerRevision,
    metadata: { activity_id: params.activityId },
  });
}

export async function enqueueSwitchActionFocus(params: {
  activityId: string;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "switch_activity_focus",
    baseServerRevision: params.baseServerRevision,
    metadata: { activity_id: params.activityId },
  });
}

export async function enqueueStopActionFocus(params: {
  activityId?: string | null;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "stop_activity_focus",
    baseServerRevision: params.baseServerRevision,
    metadata: params.activityId ? { activity_id: params.activityId } : undefined,
  });
}

export async function enqueueFocusIntervalEdit(params: {
  intervalId: string;
  sessionId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  baseServerRevision: number;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "edit_focus_interval",
    baseServerRevision: params.baseServerRevision,
    metadata: {
      focus_interval_id: params.intervalId,
      focus_session_id: params.sessionId,
      started_at_utc: params.startedAtUtc,
      ended_at_utc: params.endedAtUtc,
    },
  });
}

export async function pendingEvents(): Promise<PendingTimerEvent[]> {
  return clientDb().outbox_events.orderBy("clientSequence").toArray();
}

export async function markAttempt(events: PendingTimerEvent[]): Promise<void> {
  const now = new Date().toISOString();
  await clientDb().transaction("rw", clientDb().outbox_events, async () => {
    await Promise.all(
      events.map((event) =>
        clientDb().outbox_events.update(event.eventId, {
          status: "syncing",
          attemptCount: event.attemptCount + 1,
          lastSyncAttemptAtUtc: now,
          lastError: null,
        }),
      ),
    );
  });
}

export async function markFailure(events: PendingTimerEvent[], message: string): Promise<void> {
  await clientDb().transaction("rw", clientDb().outbox_events, async () => {
    await Promise.all(
      events.map((event) =>
        clientDb().outbox_events.update(event.eventId, {
          status: "failed",
          lastError: message,
        }),
      ),
    );
  });
}

export async function acknowledgeEvents(ids: string[]): Promise<void> {
  await clientDb().outbox_events.bulkDelete(ids);
}

export async function saveIgnoredEvents(
  ignored: Array<{ event_id: string; reason: string }>,
): Promise<void> {
  if (ignored.length === 0) return;
  const now = new Date().toISOString();
  await clientDb().ignored_events.bulkPut(
    ignored.map((event) => ({
      eventId: event.event_id,
      reason: event.reason,
      acknowledgedAtUtc: now,
    })),
  );
}

/**
 * Stores the latest canonical timer snapshot and active interval details.
 */
export async function saveCanonicalState(state: TimerState): Promise<boolean> {
  const currentRevision = await lastServerRevision();
  if (state.server_revision < currentRevision) return false;

  await clientDb().canonical_state.put({
    key: "current",
    serverRevision: state.server_revision,
    serverTimeUtc: state.server_time_utc,
    activeSessionJson: state.active_session,
    elapsedSeconds: state.elapsed_seconds,
    activeIntervalJson: state.active_interval ?? state.active_session?.active_interval ?? null,
    activeIntervalElapsedSeconds: state.active_interval_elapsed_seconds ?? 0,
    activeActivityId: state.active_activity_id ?? null,
    activeSessionStartOrigin: state.active_session_start_origin ?? state.active_session?.start_origin ?? null,
    activeSessionStartedByActivityId: state.active_session_started_by_activity_id ?? state.active_session?.started_by_activity_id ?? null,
    updatedAtUtc: new Date().toISOString(),
  });
  await setMeta("lastServerRevision", state.server_revision);
  await setMeta("lastSuccessfulSyncAtUtc", new Date().toISOString());
  return true;
}

export async function loadCanonicalState(): Promise<TimerState | null> {
  const row = await clientDb().canonical_state.get("current");
  if (!row) return null;
  return {
    server_time_utc: row.serverTimeUtc,
    server_revision: row.serverRevision,
    timezone: "Europe/Moscow",
    active_session: row.activeSessionJson,
    elapsed_seconds: row.elapsedSeconds,
    active_interval: row.activeIntervalJson ?? row.activeSessionJson?.active_interval ?? null,
    active_interval_elapsed_seconds: row.activeIntervalElapsedSeconds ?? 0,
    active_activity_id: row.activeActivityId ?? row.activeSessionJson?.active_activity_id ?? null,
    active_session_start_origin: row.activeSessionStartOrigin ?? row.activeSessionJson?.start_origin ?? null,
    active_session_started_by_activity_id: row.activeSessionStartedByActivityId ?? row.activeSessionJson?.started_by_activity_id ?? null,
  };
}

export async function saveHistoryCache(history: HistoryData): Promise<void> {
  await clientDb().sessions_cache.clear();
  if (history.sessions.length > 0) {
    await clientDb().sessions_cache.bulkPut(history.sessions);
  }
}

export async function loadHistoryCache(): Promise<HistoryData> {
  const sessions = await clientDb().sessions_cache.orderBy("started_at_utc").reverse().toArray();
  return {
    sessions,
    groups: groupSessionsByDate(sessions),
  };
}

export async function saveGoalCache(goal: GoalData, serverRevision = 0): Promise<void> {
  await clientDb().goal_cache.put({
    key: "challenge",
    payloadJson: goal,
    serverRevision,
    updatedAtUtc: new Date().toISOString(),
  });
}

export async function loadGoalCache(): Promise<GoalData | null> {
  return (await clientDb().goal_cache.get("challenge"))?.payloadJson ?? null;
}

export async function lastServerRevision(): Promise<number> {
  return (await getMeta<number>("lastServerRevision")) ?? 0;
}

function groupSessionsByDate(sessions: HistoryData["sessions"]): HistoryData["groups"] {
  const groups: HistoryData["groups"] = {};
  for (const session of sessions) {
    for (const chunk of sessionDayChunks(session)) {
      const date = chunk.started_date_msk ?? chunk.started_at_utc.slice(0, 10);
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
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [session];
  }

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
