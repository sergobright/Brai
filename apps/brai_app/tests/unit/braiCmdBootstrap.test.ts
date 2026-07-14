import { describe, expect, it } from "vitest";
import { braiCmdBootstrapRetryDelay } from "@/features/app/braiCmdBootstrap.model";

describe("Brai CMD authenticated bootstrap", () => {
  it("uses the 1, 2, 5, 15, 30 second retry ladder and stays capped", () => {
    expect(Array.from({ length: 7 }, (_, attempt) => braiCmdBootstrapRetryDelay(attempt))).toEqual([
      1_000,
      2_000,
      5_000,
      15_000,
      30_000,
      30_000,
      30_000,
    ]);
  });
});
