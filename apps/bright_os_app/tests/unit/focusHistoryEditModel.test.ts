import { describe, expect, it } from "vitest";
import {
  applyFocusInput,
  createFocusEditDraft,
  hasFocusOverlap,
  normalizedInputValue,
} from "@/features/app/sections/focus/focusHistoryEditModel";
import type { TimerSession } from "@/shared/types/timer";

describe("focus history edit model", () => {
  const session: TimerSession = {
    id: "session-1",
    started_at_utc: "2026-06-14T10:00:00.000Z",
    ended_at_utc: "2026-06-14T11:00:00.000Z",
    duration_seconds: 3600,
  };

  it("normalizes time input and shifts dependent times", () => {
    const draft = createFocusEditDraft(session)!;
    const movedStart = applyFocusInput(draft, "start", "14:15")!;
    expect(new Date(movedStart.startMs).toISOString()).toBe("2026-06-14T11:15:00.000Z");
    expect(new Date(movedStart.endMs).toISOString()).toBe("2026-06-14T12:15:00.000Z");

    const changedDuration = applyFocusInput(draft, "duration", "1:30")!;
    expect(normalizedInputValue("duration", "1:30")).toBe("01:30");
    expect(new Date(changedDuration.endMs).toISOString()).toBe("2026-06-14T11:30:00.000Z");
  });

  it("detects overlaps while allowing touching boundaries", () => {
    const draft = createFocusEditDraft(session)!;
    const neighbor: TimerSession = {
      id: "session-2",
      started_at_utc: "2026-06-14T11:00:00.000Z",
      ended_at_utc: "2026-06-14T12:00:00.000Z",
      duration_seconds: 3600,
    };

    expect(hasFocusOverlap(draft, [neighbor])).toBe(false);
    expect(hasFocusOverlap(applyFocusInput(draft, "duration", "1:05")!, [neighbor])).toBe(true);
  });
});
