import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression: ISSUE-016 — valid full user flows exceeded Vitest's 5s default on a loaded runner.
// Found by /qa on 2026-07-13
describe("Vitest execution budget", () => {
  it("keeps a bounded timeout for complete user flows", () => {
    const config = readFileSync(resolve(process.cwd(), "vitest.config.mts"), "utf8");
    expect(config).toMatch(/testTimeout:\s*15_000/);
  });
});
