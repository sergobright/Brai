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
});
