import { beforeEach, describe, expect, it } from "vitest";
import { clientDb, getMeta } from "@/shared/storage/db";
import {
  enqueueTimerEvent,
  enqueueFocusIntervalEdit,
  enqueueFocusSessionDelete,
  enqueueFocusSessionEdit,
  enqueueStartActionFocus,
  loadCanonicalState,
  loadHistoryCache,
  pendingEvents,
  saveCanonicalState,
  saveHistoryCache,
} from "@/shared/storage/syncStore";
import type { TimerState } from "@/shared/types/timer";

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
