import { describe, expect, it } from "vitest";
import { compareBrightVersions, engineSectionView } from "@/features/app/sections/engine/engineModel";

describe("engineSectionView", () => {
  it("does not treat stale Android OTA checking status as active work", () => {
    const view = engineSectionView({
      appBuild: "0.0.10.1",
      appVersionState: null,
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.10.1",
        lastCheckStatus: "checking",
        checkInProgress: false,
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.isChecking).toBe(false);
    expect(view.updateStatus.label).toBe("актуально");
  });

  it("detects newer ledger versions", () => {
    expect(compareBrightVersions("0.11.52.1", "0.11.51.1")).toBeGreaterThan(0);
    expect(compareBrightVersions("0.11.52.1", "0.11.52.1.42")).toBe(0);
    expect(compareBrightVersions("0.10.52.1", "0.11.1.1")).toBeLessThan(0);
  });

  it("does not invent the latest version from the installed web build", () => {
    const view = engineSectionView({
      appBuild: "0.0.1.1",
      appVersionState: null,
      otaRefreshing: false,
      otaState: null,
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.latestVersion).toBeNull();
    expect(view.nativeApk).toBeNull();
    expect(view.hasUpdate).toBe(false);
  });
});
