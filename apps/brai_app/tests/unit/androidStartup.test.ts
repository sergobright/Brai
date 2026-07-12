import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Android startup", () => {
  it("does not restore onboarding-only mode on every app launch", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "android/app/src/main/java/world/brightos/brai/MainActivity.java"),
      "utf8",
    );

    expect(source).toContain("setOnboardingVoiceOnly(false)");
    expect(source).not.toContain("setOnboardingVoiceOnly(true)");
  });
});
