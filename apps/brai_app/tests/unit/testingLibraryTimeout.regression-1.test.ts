import { getConfig } from "@testing-library/dom";
import { describe, expect, it } from "vitest";

// Regression: ISSUE-016 — CI host load pushed valid async UI updates past Testing Library's 1s default.
// Found by /qa on 2026-07-13
describe("Testing Library async budget", () => {
  it("keeps the bounded CI-safe timeout", () => {
    expect(getConfig().asyncUtilTimeout).toBe(5_000);
  });
});
