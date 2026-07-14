import {
  assertClientUserInCurrentTransaction,
  clientDb,
  ensureClientMeta,
  randomId,
  setMeta,
} from "./db";
import { addDays, getDisplayTimeZone, localDateFromUtcMs, localDateStartUtcMs, localHourFromUtcMs } from "@/shared/time/format";
import type {
  GoalData,
  HistoryData,
  PendingTimerEvent,
  TimerSession,
  TimerEventType,
  TimerState,
} from "@/shared/types/timer";

/**
 * Adds a timer mutation to the durable local outbox.
 */
export async function enqueueTimerEvent(params: {
  type: TimerEventType;
  baseServerRevision: number;
  metadata?: Record<string, unknown>;
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.outbox_events, async () => {
    if (params.expectedUserId !== undefined) {
      await assertClientUserInCurrentTransaction(params.expectedUserId);
    }
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
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "edit_session",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
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
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "delete_session",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
    metadata: {
      focus_session_id: params.sessionId,
    },
  });
}

export async function enqueueStartActionFocus(params: {
  activityId: string;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "start_activity_focus",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
    metadata: { activity_id: params.activityId },
  });
}

export async function enqueueSwitchActionFocus(params: {
  activityId: string;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "switch_activity_focus",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
    metadata: { activity_id: params.activityId },
  });
}

export async function enqueueStopActionFocus(params: {
  activityId?: string | null;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "stop_activity_focus",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
    metadata: params.activityId ? { activity_id: params.activityId } : undefined,
  });
}

/** Adds a completed Focus interval edit to the timer outbox. */
export async function enqueueFocusIntervalEdit(params: {
  intervalId: string;
  sessionId: string;
  startedAtUtc: string;
  endedAtUtc: string;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingTimerEvent> {
  return enqueueTimerEvent({
    type: "edit_focus_interval",
    baseServerRevision: params.baseServerRevision,
    expectedUserId: params.expectedUserId,
    metadata: {
      focus_interval_id: params.intervalId,
      focus_session_id: params.sessionId,
      started_at_utc: params.startedAtUtc,
      ended_at_utc: params.endedAtUtc,
    },
  });
}

export async function pendingEvents(expectedUserId?: string): Promise<PendingTimerEvent[]> {
  const db = clientDb();
  return db.transaction("r", db.meta, db.outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return db.outbox_events.orderBy("clientSequence").toArray();
  });
}

export async function markAttempt(events: PendingTimerEvent[], expectedUserId?: string): Promise<void> {
  const db = clientDb();
  const now = new Date().toISOString();
  await db.transaction("rw", db.meta, db.outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.outbox_events.update(event.eventId, {
          status: "syncing",
          attemptCount: event.attemptCount + 1,
          lastSyncAttemptAtUtc: now,
          lastError: null,
        }),
      ),
    );
  });
}

export async function markFailure(
  events: PendingTimerEvent[],
  message: string,
  expectedUserId?: string,
): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.outbox_events.update(event.eventId, {
          status: "failed",
          lastError: message,
        }),
      ),
    );
  });
}

export async function acknowledgeEvents(ids: string[], expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await db.outbox_events.bulkDelete(ids);
  });
}

export async function saveIgnoredEvents(
  ignored: Array<{ event_id: string; reason: string }>,
  expectedUserId?: string,
): Promise<void> {
  if (ignored.length === 0) return;
  const db = clientDb();
  const now = new Date().toISOString();
  await db.transaction("rw", db.meta, db.ignored_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await db.ignored_events.bulkPut(
      ignored.map((event) => ({
        eventId: event.event_id,
        reason: event.reason,
        acknowledgedAtUtc: now,
      })),
    );
  });
}

/**
 * Stores the latest canonical timer snapshot and active interval details.
 */
export async function saveCanonicalState(state: TimerState, expectedUserId?: string): Promise<boolean> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.canonical_state, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return saveCanonicalSnapshotInCurrentTransaction(state);
  });
}

async function saveCanonicalSnapshotInCurrentTransaction(state: TimerState): Promise<boolean> {
  const db = clientDb();
  const currentRevision = Number((await db.meta.get("lastServerRevision"))?.value ?? 0);
  if (state.server_revision < currentRevision) return false;

  await db.canonical_state.put({
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
  await db.meta.bulkPut([
    { key: "lastServerRevision", value: state.server_revision },
    { key: "lastSuccessfulSyncAtUtc", value: new Date().toISOString() },
  ]);
  return true;
}

/** Atomically applies a timer sync response and its terminal outbox outcomes. */
export async function acknowledgeTimerSyncEvents(params: {
  acknowledgedEventIds: string[];
  ignoredEvents: Array<{ event_id: string; reason: string }>;
  state: TimerState;
  expectedUserId?: string;
}): Promise<boolean> {
  const db = clientDb();
  const ignored = new Map(params.ignoredEvents.map((event) => [event.event_id, event.reason]));
  const acknowledged = [...new Set([...params.acknowledgedEventIds, ...ignored.keys()])];
  return db.transaction(
    "rw",
    [db.meta, db.outbox_events, db.ignored_events, db.canonical_state],
    async () => {
      if (params.expectedUserId !== undefined) {
        await assertClientUserInCurrentTransaction(params.expectedUserId);
      }
      if (ignored.size > 0) {
        const acknowledgedAtUtc = new Date().toISOString();
        await db.ignored_events.bulkPut(
          [...ignored].map(([eventId, reason]) => ({ eventId, reason, acknowledgedAtUtc })),
        );
      }
      const accepted = await saveCanonicalSnapshotInCurrentTransaction(params.state);
      await db.outbox_events.bulkDelete(acknowledged);
      return accepted;
    },
  );
}

/** Loads the canonical timer snapshot for the optional expected owner. */
export async function loadCanonicalState(expectedUserId?: string): Promise<TimerState | null> {
  const db = clientDb();
  const row = await db.transaction("r", db.meta, db.canonical_state, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return db.canonical_state.get("current");
  });
  if (!row) return null;
  return {
    server_time_utc: row.serverTimeUtc,
    server_revision: row.serverRevision,
    timezone: getDisplayTimeZone(),
    active_session: row.activeSessionJson,
    elapsed_seconds: row.elapsedSeconds,
    active_interval: row.activeIntervalJson ?? row.activeSessionJson?.active_interval ?? null,
    active_interval_elapsed_seconds: row.activeIntervalElapsedSeconds ?? 0,
    active_activity_id: row.activeActivityId ?? row.activeSessionJson?.active_activity_id ?? null,
    active_session_start_origin: row.activeSessionStartOrigin ?? row.activeSessionJson?.start_origin ?? null,
    active_session_started_by_activity_id: row.activeSessionStartedByActivityId ?? row.activeSessionJson?.started_by_activity_id ?? null,
  };
}

export async function saveHistoryCache(history: HistoryData, expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.sessions_cache, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await saveHistorySnapshotInCurrentTransaction(history);
  });
}

async function saveHistorySnapshotInCurrentTransaction(history: HistoryData): Promise<void> {
  const db = clientDb();
  await db.sessions_cache.clear();
  if (history.sessions.length > 0) await db.sessions_cache.bulkPut(history.sessions);
}

export async function loadHistoryCache(expectedUserId?: string): Promise<HistoryData> {
  const db = clientDb();
  const sessions = await db.transaction("r", db.meta, db.sessions_cache, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return db.sessions_cache.orderBy("started_at_utc").reverse().toArray();
  });
  return {
    sessions,
    groups: groupSessionsByDate(sessions),
  };
}

export async function saveGoalCache(
  goal: GoalData,
  serverRevision = 0,
  expectedUserId?: string,
): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.goal_cache, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await saveGoalSnapshotInCurrentTransaction(goal, serverRevision);
  });
}

async function saveGoalSnapshotInCurrentTransaction(goal: GoalData, serverRevision: number): Promise<void> {
  await clientDb().goal_cache.put({
    key: "challenge",
    payloadJson: goal,
    serverRevision,
    updatedAtUtc: new Date().toISOString(),
  });
}

/** Stores matching History and Focus Goal responses in one owner-checked transaction. */
export async function saveHistoryAndGoalCache(params: {
  history: HistoryData;
  goal: GoalData;
  serverRevision?: number;
  expectedUserId?: string;
}): Promise<boolean> {
  const db = clientDb();
  const serverRevision = params.serverRevision ?? 0;
  return db.transaction("rw", [db.meta, db.sessions_cache, db.goal_cache], async () => {
    if (params.expectedUserId !== undefined) {
      await assertClientUserInCurrentTransaction(params.expectedUserId);
    }
    const currentRevision = (await db.goal_cache.get("challenge"))?.serverRevision ?? 0;
    if (serverRevision < currentRevision) return false;
    await saveHistorySnapshotInCurrentTransaction(params.history);
    await saveGoalSnapshotInCurrentTransaction(params.goal, serverRevision);
    return true;
  });
}

export async function loadGoalCache(expectedUserId?: string): Promise<GoalData | null> {
  const db = clientDb();
  return db.transaction("r", db.meta, db.goal_cache, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return (await db.goal_cache.get("challenge"))?.payloadJson ?? null;
  });
}

export async function lastServerRevision(expectedUserId?: string): Promise<number> {
  const db = clientDb();
  return db.transaction("r", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Number((await db.meta.get("lastServerRevision"))?.value ?? 0);
  });
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
    const chunkEndMs = Math.min(endMs, localDateStartUtcMs(addDays(date, 1)));
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
