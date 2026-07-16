import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_TIME_ZONE, formatDisplayDateTime, formatDuration, formatGoalDuration, formatHumanDuration, formatPercent, setDisplayTimeZone } from "@/shared/time/format";

afterEach(() => setDisplayTimeZone(DEFAULT_DISPLAY_TIME_ZONE));

describe("time formatting", () => {
  it("formats timer digits", () => {
    expect(formatDuration(3723)).toBe("01:02:03");
  });

  it("formats human durations in Russian units", () => {
    expect(formatHumanDuration(43200)).toBe("12 ч");
    expect(formatHumanDuration(5400)).toBe("1 ч 30 мин");
  });

  it("formats goal durations compactly", () => {
    expect(formatGoalDuration(0)).toBe("0м");
    expect(formatGoalDuration(1800)).toBe("30м");
    expect(formatGoalDuration(3600)).toBe("1ч");
    expect(formatGoalDuration(3900)).toBe("1ч 5м");
  });

  it("formats precise small percentages", () => {
    expect(formatPercent(0.42)).toBe("0,4%");
    expect(formatPercent(124.3)).toBe("124%");
  });

  it("formats absolute timestamps in the configured display timezone", () => {
    setDisplayTimeZone("UTC");
    expect(formatDisplayDateTime("2026-06-13T19:35:12.000Z")).toBe("2026-06-13 19:35");
    setDisplayTimeZone("Europe/Moscow");
    expect(formatDisplayDateTime("2026-06-13T19:35:12.000Z")).toBe("2026-06-13 22:35");
    setDisplayTimeZone("America/New_York");
    expect(formatDisplayDateTime("2026-06-13T19:35:12.000Z")).toBe("2026-06-13 15:35");
  });
});
