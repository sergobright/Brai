import { describe, expect, it } from "vitest";
import { projectHistoryData, projectTimerState } from "@/shared/storage/projection";
import { emptyTimerState, type HistoryData, type PendingTimerEvent, type TimerEventType } from "@/shared/types/timer";

function event(sequence: number, type: TimerEventType, occurredAtUtc: string, metadata?: Record<string, unknown>): PendingTimerEvent {
  return {
    eventId: `event-${sequence}`,
    deviceId: "device",
    clientSequence: sequence,
    type,
    occurredAtUtc,
    localTimerId: "local-timer",
    baseServerRevision: 0,
    payloadVersion: 1,
    metadata,
    status: "pending",
    attemptCount: 0,
    enqueuedAtUtc: occurredAtUtc,
  };
}

describe("pending projection", () => {
  it("projects offline start as running", () => {
    const state = projectTimerState(
      emptyTimerState(new Date("2026-06-14T10:00:00.000Z")),
      [event(1, "start", "2026-06-14T10:00:00.000Z")],
      new Date("2026-06-14T10:02:00.000Z"),
    );
    expect(state.active_session?.pending).toBe(true);
    expect(state.elapsed_seconds).toBe(120);
  });

  it("projects start and stop as idle pending history", () => {
    const state = projectTimerState(
      emptyTimerState(new Date("2026-06-14T10:00:00.000Z")),
      [
        event(1, "start", "2026-06-14T10:00:00.000Z"),
        event(2, "stop", "2026-06-14T10:05:00.000Z"),
      ],
      new Date("2026-06-14T10:06:00.000Z"),
    );
    expect(state.active_session).toBeNull();
    expect(state.elapsed_seconds).toBe(0);
  });

  it("projects activity focus as the active interval before sync", () => {
    const state = projectTimerState(
      emptyTimerState(new Date("2026-06-14T10:00:00.000Z")),
      [
        event(1, "start", "2026-06-14T10:00:00.000Z"),
        event(2, "start_activity_focus", "2026-06-14T10:10:00.000Z", {
          activity_id: "action-1",
        }),
      ],
      new Date("2026-06-14T10:25:00.000Z"),
    );

    expect(state.active_session?.start_origin).toBe("focus");
    expect(state.active_activity_id).toBe("action-1");
    expect(state.active_interval?.activity_id).toBe("action-1");
    expect(state.active_interval_elapsed_seconds).toBe(900);
    expect(state.active_session?.intervals).toMatchObject([
      {
        activity_id: null,
        started_at_utc: "2026-06-14T10:00:00.000Z",
        ended_at_utc: "2026-06-14T10:10:00.000Z",
        duration_seconds: 600,
      },
      {
        activity_id: "action-1",
        started_at_utc: "2026-06-14T10:10:00.000Z",
        ended_at_utc: null,
      },
    ]);
  });

  it("projects switching and stopping activity focus as split intervals", () => {
    const state = projectTimerState(
      emptyTimerState(new Date("2026-06-14T10:00:00.000Z")),
      [
        event(1, "start", "2026-06-14T10:00:00.000Z"),
        event(2, "start_activity_focus", "2026-06-14T10:10:00.000Z", {
          activity_id: "action-1",
        }),
        event(3, "switch_activity_focus", "2026-06-14T10:20:00.000Z", {
          activity_id: "action-2",
        }),
        event(4, "stop_activity_focus", "2026-06-14T10:35:00.000Z", {
          activity_id: "action-2",
        }),
      ],
      new Date("2026-06-14T10:50:00.000Z"),
    );

    expect(state.active_activity_id).toBeNull();
    expect(state.active_interval?.activity_id).toBeNull();
    expect(state.active_interval_elapsed_seconds).toBe(900);
    expect(state.active_session?.intervals?.map((interval) => [
      interval.activity_id,
      interval.started_at_utc,
      interval.ended_at_utc,
      interval.duration_seconds,
    ])).toEqual([
      [null, "2026-06-14T10:00:00.000Z", "2026-06-14T10:10:00.000Z", 600],
      ["action-1", "2026-06-14T10:10:00.000Z", "2026-06-14T10:20:00.000Z", 600],
      ["action-2", "2026-06-14T10:20:00.000Z", "2026-06-14T10:35:00.000Z", 900],
      [null, "2026-06-14T10:35:00.000Z", null, null],
    ]);
  });

  it("projects activity-started stop as an idle timer", () => {
    const state = projectTimerState(
      emptyTimerState(new Date("2026-06-14T10:00:00.000Z")),
      [
        event(1, "start_activity_focus", "2026-06-14T10:00:00.000Z", {
          activity_id: "action-1",
        }),
        event(2, "stop_activity_focus", "2026-06-14T10:25:00.000Z", {
          activity_id: "action-1",
        }),
      ],
      new Date("2026-06-14T10:30:00.000Z"),
    );

    expect(state.active_session).toBeNull();
    expect(state.active_interval).toBeNull();
  });

  it("projects offline completed session edits over cached history", () => {
    const history: HistoryData = {
      sessions: [
        {
          id: "session-1",
          started_at_utc: "2026-06-14T10:00:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 3600,
        },
      ],
      groups: {},
    };

    const projected = projectHistoryData(history, [
      event(1, "edit_session", "2026-06-14T12:00:00.000Z", {
        focus_session_id: "session-1",
        started_at_utc: "2026-06-14T10:15:00.000Z",
        ended_at_utc: "2026-06-14T11:45:00.000Z",
      }),
    ]);

    expect(projected.sessions[0]).toMatchObject({
      id: "session-1",
      started_at_utc: "2026-06-14T10:15:00.000Z",
      ended_at_utc: "2026-06-14T11:45:00.000Z",
      duration_seconds: 5400,
      pending: true,
    });
    expect(projected.groups["2026-06-14"].total_seconds).toBe(5400);
  });

  it("projects offline completed session deletes over cached history", () => {
    const history: HistoryData = {
      sessions: [
        {
          id: "session-1",
          started_at_utc: "2026-06-14T10:00:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 3600,
        },
      ],
      groups: {},
    };

    const projected = projectHistoryData(history, [
      event(1, "delete_session", "2026-06-14T12:00:00.000Z", {
        focus_session_id: "session-1",
      }),
    ]);

    expect(projected.sessions).toHaveLength(0);
    expect(projected.groups).toEqual({});
  });

  it("projects offline interval edits over cached history", () => {
    const history: HistoryData = {
      sessions: [
        {
          id: "session-1",
          started_at_utc: "2026-06-14T10:00:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 3600,
          intervals: [
            {
              id: "interval-1",
              focus_session_id: "session-1",
              activity_id: "action-1",
              activity_title: "Письмо",
              started_at_utc: "2026-06-14T10:00:00.000Z",
              ended_at_utc: "2026-06-14T10:30:00.000Z",
              duration_seconds: 1800,
            },
            {
              id: "interval-2",
              focus_session_id: "session-1",
              activity_id: null,
              activity_title: null,
              started_at_utc: "2026-06-14T10:30:00.000Z",
              ended_at_utc: "2026-06-14T11:00:00.000Z",
              duration_seconds: 1800,
            },
          ],
        },
      ],
      groups: {},
    };

    const projected = projectHistoryData(history, [
      event(1, "edit_focus_interval", "2026-06-14T12:00:00.000Z", {
        focus_session_id: "session-1",
        focus_interval_id: "interval-1",
        started_at_utc: "2026-06-14T10:05:00.000Z",
        ended_at_utc: "2026-06-14T10:20:00.000Z",
      }),
    ]);

    expect(projected.sessions[0].duration_seconds).toBe(2700);
    expect(projected.sessions[0].intervals?.[0]).toMatchObject({
      id: "interval-1",
      started_at_utc: "2026-06-14T10:05:00.000Z",
      ended_at_utc: "2026-06-14T10:20:00.000Z",
      duration_seconds: 900,
      pending: true,
    });
  });

  it("does not project compatible session edits over multi-interval history", () => {
    const history: HistoryData = {
      sessions: [
        {
          id: "session-1",
          started_at_utc: "2026-06-14T10:00:00.000Z",
          ended_at_utc: "2026-06-14T11:00:00.000Z",
          duration_seconds: 3600,
          intervals: [
            {
              id: "interval-1",
              focus_session_id: "session-1",
              activity_id: "action-1",
              activity_title: "Письмо",
              started_at_utc: "2026-06-14T10:00:00.000Z",
              ended_at_utc: "2026-06-14T10:30:00.000Z",
              duration_seconds: 1800,
            },
            {
              id: "interval-2",
              focus_session_id: "session-1",
              activity_id: null,
              activity_title: null,
              started_at_utc: "2026-06-14T10:30:00.000Z",
              ended_at_utc: "2026-06-14T11:00:00.000Z",
              duration_seconds: 1800,
            },
          ],
        },
      ],
      groups: {},
    };

    const projected = projectHistoryData(history, [
      event(1, "edit_session", "2026-06-14T12:00:00.000Z", {
        focus_session_id: "session-1",
        started_at_utc: "2026-06-14T10:05:00.000Z",
        ended_at_utc: "2026-06-14T10:20:00.000Z",
      }),
    ]);

    expect(projected.sessions[0]).toMatchObject({
      started_at_utc: "2026-06-14T10:00:00.000Z",
      ended_at_utc: "2026-06-14T11:00:00.000Z",
      duration_seconds: 3600,
      pending: false,
    });
    expect(projected.sessions[0].intervals?.[0].pending).toBeUndefined();
  });
});
