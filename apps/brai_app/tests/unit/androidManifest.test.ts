import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Android manifest", () => {
  it("disables platform backup for private app state", () => {
    const manifest = readFileSync(resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml"), "utf8");

    expect(manifest).toContain('android:allowBackup="false"');
  });
});
