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

  it("does not let a stale ledger version hide the installed web build", () => {
    const view = engineSectionView({
      appBuild: "0.11.52.1",
      appVersionState: {
        server_time_utc: "2026-06-29T12:00:00.000Z",
        version: "0.0.1.1",
        parts: { canon: 0, release: 0, build: 1, apk: 1 },
        latest: { canon: null, release: null, build: null, apk: null },
        apk_release: null,
      },
      otaRefreshing: false,
      otaState: null,
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.latestVersion).toBe("0.11.52.1");
    expect(view.nativeApk).toBeNull();
    expect(view.hasUpdate).toBe(false);
  });

  it("normalizes Android OTA download progress", () => {
    const view = engineSectionView({
      appBuild: "0.0.10.1",
      appVersionState: null,
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.10.1",
        checkInProgress: true,
        downloadProgressBytes: 2,
        downloadProgressTotalBytes: 3,
        downloadProgressVersion: "0.0.11.1",
        lastCheckStatus: "downloading",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.androidUpdateStage).toBe("downloading");
    expect(view.downloadProgressPercent).toBe(67);
    expect(view.downloadProgressVersion).toBe("0.0.11.1");
  });

  it("flags stale Android APK even when the web bundle is current", () => {
    const view = engineSectionView({
      appBuild: "0.0.41.3",
      appVersionState: {
        server_time_utc: "2026-06-30T20:26:24.000Z",
        version: "0.0.41.3",
        parts: { canon: 0, release: 0, build: 41, apk: 3 },
        latest: { canon: null, release: null, build: null, apk: null },
        apk_release: {
          file: "bright-os-0.0.41.3-capacitor.apk",
          version: "0.0.41.3",
          version_code: 47,
          published_at: "2026-06-30T20:23:42Z",
        },
      },
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.41.3",
        nativeVersionCode: 42,
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.hasUpdate).toBe(true);
    expect(view.apkUpdateAvailable).toBe(true);
    expect(view.updateStatus.label).toBe("нужен APK");
  });
});
