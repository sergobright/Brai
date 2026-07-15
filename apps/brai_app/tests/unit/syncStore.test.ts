import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientUserScopeChangedError, clientDb, getMeta, setMeta } from "@/shared/storage/db";
import {
  acknowledgeTimerSyncEvents,
  enqueueTimerEvent,
  enqueueFocusIntervalEdit,
  enqueueFocusSessionDelete,
  enqueueFocusSessionEdit,
  enqueueStartActionFocus,
  loadCanonicalState,
  loadGoalCache,
  loadHistoryCache,
  pendingEvents,
  saveCanonicalState,
  saveHistoryAndGoalCache,
  saveHistoryCache,
} from "@/shared/storage/syncStore";
import { emptyGoal, type HistoryData, type TimerState } from "@/shared/types/timer";

describe("sync store guards", () => {
  beforeEach(async () => {
    const db = clientDb();
    await Promise.all(db.tables.map((table) => table.clear()));
  });

  it("does not overwrite canonical state with an older server revision", async () => {
    expect(await saveCanonicalState(state(5))).toBe(true);
    expect(await saveCanonicalState(state(4))).toBe(false);

    expect((await loadCanonicalState())?.server_revision).toBe(5);
    expect(await getMeta<number>("lastServerRevision")).toBe(5);
  });

  it("preserves event metadata in the pending queue", async () => {
    await enqueueTimerEvent({
      type: "stop",
      baseServerRevision: 7,
      metadata: { global_stop: true },
    });

    expect((await pendingEvents())[0].metadata).toEqual({ global_stop: true });
  });

  it("queues completed focus session edits as timer events", async () => {
    await enqueueFocusSessionEdit({
      sessionId: "session-1",
      startedAtUtc: "2026-06-14T10:15:00.000Z",
      endedAtUtc: "2026-06-14T11:45:00.000Z",
      baseServerRevision: 7,
    });

    const [event] = await pendingEvents();
    expect(event.type).toBe("edit_session");
    expect(event.metadata).toMatchObject({
      focus_session_id: "session-1",
      started_at_utc: "2026-06-14T10:15:00.000Z",
      ended_at_utc: "2026-06-14T11:45:00.000Z",
    });
  });

  it("queues completed focus session deletes as timer events", async () => {
    await enqueueFocusSessionDelete({
      sessionId: "session-1",
      baseServerRevision: 7,
    });

    const [event] = await pendingEvents();
    expect(event.type).toBe("delete_session");
    expect(event.metadata).toMatchObject({
      focus_session_id: "session-1",
    });
  });

  it("queues action focus and interval edit timer events", async () => {
    await enqueueStartActionFocus({
      activityId: "action-1",
      baseServerRevision: 7,
    });
    await enqueueFocusIntervalEdit({
      intervalId: "interval-1",
      sessionId: "session-1",
      startedAtUtc: "2026-06-14T10:15:00.000Z",
      endedAtUtc: "2026-06-14T10:45:00.000Z",
      baseServerRevision: 7,
    });

    const events = await pendingEvents();
    expect(events.map((item) => item.type)).toEqual(["start_activity_focus", "edit_focus_interval"]);
    expect(events[0].metadata).toMatchObject({ activity_id: "action-1" });
    expect(events[1].metadata).toMatchObject({
      focus_interval_id: "interval-1",
      focus_session_id: "session-1",
    });
  });

  it("splits cached history across Moscow midnight", async () => {
    await saveHistoryCache({
      sessions: [
        {
          id: "session-1",
          started_at_utc: "2026-06-12T20:30:00.000Z",
          ended_at_utc: "2026-06-12T21:30:00.000Z",
          duration_seconds: 3600,
          started_date_msk: "2026-06-12",
          started_hour_msk: 23,
          ended_date_msk: "2026-06-13",
          ended_hour_msk: 0,
        },
      ],
      groups: {},
    });

    const history = await loadHistoryCache();

    expect(history.sessions).toHaveLength(1);
    expect(history.groups["2026-06-12"].total_seconds).toBe(1800);
    expect(history.groups["2026-06-13"].total_seconds).toBe(1800);
    expect(history.groups["2026-06-12"].sessions?.[0]).toMatchObject({
      id: "session-1:2026-06-12",
      started_at_utc: "2026-06-12T20:30:00.000Z",
      ended_at_utc: "2026-06-12T21:00:00.000Z",
      duration_seconds: 1800,
    });
    expect(history.groups["2026-06-13"].sessions?.[0]).toMatchObject({
      id: "session-1:2026-06-13",
      started_at_utc: "2026-06-12T21:00:00.000Z",
      ended_at_utc: "2026-06-12T21:30:00.000Z",
      duration_seconds: 1800,
    });
  });

  it("rejects old-owner timer enqueue and response apply without touching user B data", async () => {
    await setMeta("currentUserId", "user-a");
    const expectedUserId = "user-a";
    await setMeta("currentUserId", "user-b");
    await saveCanonicalState(state(5), "user-b");
    const userBEvent = await enqueueTimerEvent({
      type: "start",
      baseServerRevision: 5,
      expectedUserId: "user-b",
    });
    const nextClientSequence = await getMeta<number>("nextClientSequence");

    await expect(enqueueTimerEvent({
      type: "stop",
      baseServerRevision: 5,
      expectedUserId,
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(acknowledgeTimerSyncEvents({
      acknowledgedEventIds: [userBEvent.eventId],
      ignoredEvents: [{ event_id: userBEvent.eventId, reason: "old_owner" }],
      state: state(9),
      expectedUserId,
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await pendingEvents("user-b")).toEqual([userBEvent]);
    expect((await loadCanonicalState("user-b"))?.server_revision).toBe(5);
    expect(await clientDb().ignored_events.toArray()).toEqual([]);
    expect(await getMeta<number>("nextClientSequence")).toBe(nextClientSequence);
  });

  it("rolls back timer acknowledgement, ignored audit, and canonical snapshot together", async () => {
    await setMeta("currentUserId", "user-b");
    const event = await enqueueTimerEvent({
      type: "start",
      baseServerRevision: 0,
      expectedUserId: "user-b",
    });
    const failure = vi.spyOn(clientDb().outbox_events, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected_ack_failure"));

    await expect(acknowledgeTimerSyncEvents({
      acknowledgedEventIds: [],
      ignoredEvents: [{ event_id: event.eventId, reason: "ignored" }],
      state: state(5),
      expectedUserId: "user-b",
    })).rejects.toThrow("injected_ack_failure");
    failure.mockRestore();

    expect(await pendingEvents("user-b")).toEqual([event]);
    expect(await loadCanonicalState("user-b")).toBeNull();
    expect(await clientDb().ignored_events.get(event.eventId)).toBeUndefined();
  });

  it("rejects an old-owner History and Goal pair without replacing user B cache", async () => {
    await setMeta("currentUserId", "user-a");
    const expectedUserId = "user-a";
    await setMeta("currentUserId", "user-b");
    const userBGoal = { ...emptyGoal(), completed_seconds: 5 };
    await saveHistoryAndGoalCache({
      history: history("user-b-session"),
      goal: userBGoal,
      serverRevision: 5,
      expectedUserId: "user-b",
    });

    await expect(saveHistoryAndGoalCache({
      history: history("user-a-session"),
      goal: { ...emptyGoal(), completed_seconds: 9 },
      serverRevision: 9,
      expectedUserId,
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect((await loadHistoryCache("user-b")).sessions.map((session) => session.id)).toEqual([
      "user-b-session",
    ]);
    expect(await loadGoalCache("user-b")).toEqual(userBGoal);
  });
});

function state(serverRevision: number): TimerState {
  return {
    server_time_utc: `2026-06-14T12:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    timezone: "Europe/Moscow",
    active_session: null,
    elapsed_seconds: 0,
  };
}

function history(sessionId: string): HistoryData {
  return {
    sessions: [{
      id: sessionId,
      started_at_utc: "2026-06-14T10:00:00.000Z",
      ended_at_utc: "2026-06-14T11:00:00.000Z",
      duration_seconds: 3600,
    }],
    groups: {},
  };
}
