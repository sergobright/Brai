import { describe, expect, it } from "vitest";
import { sectionAfterMobileSwipe } from "@/features/app/navigation/useSectionSwipeNavigation";

describe("mobile section swipe order", () => {
  it("stops at Factory and keeps Draws outside swipe navigation", () => {
    expect(sectionAfterMobileSwipe("brai", -100)).toBe("actions");
    expect(sectionAfterMobileSwipe("actions", 100)).toBe("brai");
    expect(sectionAfterMobileSwipe("factory", -100)).toBe("factory");
    expect(sectionAfterMobileSwipe("draws", 100)).toBe("draws");
  });
});
