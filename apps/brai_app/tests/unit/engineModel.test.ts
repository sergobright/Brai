import { describe, expect, it } from "vitest";
import { compareBraiVersions, engineSectionView } from "@/features/app/sections/engine/engineModel";

describe("engineSectionView", () => {
  it("does not treat stale Android OTA checking status as active work", () => {
    const view = engineSectionView({
      appBuild: "0.0.10",
      appVersionState: null,
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.10",
        lastCheckStatus: "checking",
        checkInProgress: false,
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.isChecking).toBe(false);
    expect(view.updateStatus.label).toBe("актуально");
    expect(view.updateAction).toBe("check");
  });

  it("detects newer ledger versions", () => {
    expect(compareBraiVersions("0.11.52", "0.11.51")).toBeGreaterThan(0);
    expect(compareBraiVersions("0.11.52", "0.11.52.42")).toBe(0);
    expect(compareBraiVersions("0.10.52", "0.11.1")).toBeLessThan(0);
  });

  it("does not let a stale ledger version hide the installed web build", () => {
    const view = engineSectionView({
      appBuild: "0.11.52",
      appVersionState: {
        server_time_utc: "2026-06-29T12:00:00.000Z",
        version: "0.0.1",
        ota_version: "0.0.1",
        parts: { canon: 0, release: 0, build: 1, apk: 1 },
        latest: { canon: null, release: null, build: null, apk: null },
        target_apk: null,
        apk_release: null,
      },
      otaRefreshing: false,
      otaState: null,
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.latestVersion).toBe("0.11.52");
    expect(view.hasUpdate).toBe(false);
  });

  it("normalizes Android OTA download progress", () => {
    const view = engineSectionView({
      appBuild: "0.0.10",
      appVersionState: null,
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.10",
        checkInProgress: true,
        downloadProgressBytes: 2,
        downloadProgressTotalBytes: 3,
        downloadProgressVersion: "0.0.11",
        lastCheckStatus: "downloading",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.androidUpdateStage).toBe("downloading");
    expect(view.downloadProgressPercent).toBe(67);
    expect(view.downloadProgressVersion).toBe("0.0.11");
  });

  it("flags APK target gate even when the OTA bundle is current", () => {
    const view = engineSectionView({
      appBuild: "0.0.41",
      appVersionState: {
        server_time_utc: "2026-06-30T20:26:24.000Z",
        version: "0.0.41",
        ota_version: "0.0.41",
        parts: { canon: 0, release: 0, build: 41, apk: 1 },
        latest: { canon: null, release: null, build: null, apk: null },
        target_apk: {
          file: "brai-v2.apk",
          version: 2,
          version_code: 2,
          release_url: "/releases/",
          published_at: "2026-06-30T20:23:42Z",
        },
        apk_release: {
          file: "brai-v2.apk",
          version: 2,
          version_code: 2,
          release_url: "/releases/",
          published_at: "2026-06-30T20:23:42Z",
        },
      },
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.41",
        nativeApkVersion: "1",
        targetApkVersion: "2",
        lastCheckStatus: "apk_required",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.hasUpdate).toBe(true);
    expect(view.apkUpdateAvailable).toBe(true);
    expect(view.installedApkVersion).toBe(1);
    expect(view.updateStatus.label).toBe("нужен APK");
  });

  it("flags APK-only releases from the version API", () => {
    const view = engineSectionView({
      appBuild: "0.0.41",
      appVersionState: {
        server_time_utc: "2026-06-30T20:26:24.000Z",
        version: "0.0.41",
        ota_version: "0.0.41",
        parts: { canon: 0, release: 0, build: 41, apk: 2 },
        latest: { canon: null, release: null, build: null, apk: null },
        target_apk: {
          file: "brai-v2.apk",
          version: 2,
          version_code: 2,
          release_key: "production",
          apk_build_kind: "stable",
          preview_iteration: null,
          release_url: "/releases/",
          published_at: "2026-06-30T20:23:42Z",
        },
        apk_release: null,
      },
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.41",
        nativeApkVersion: "1",
        nativeApkReleaseKey: "production",
        nativeApkBuildKind: "stable",
        targetApkReleaseUrl: "https://app.brai.one/releases/",
        lastCheckStatus: "up_to_date",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.hasUpdate).toBe(true);
    expect(view.apkUpdateAvailable).toBe(true);
    expect(view.requiredApkLabel).toBe("v2");
    expect(view.apkReleaseUrl).toBe("/releases/download/production");
    expect(view.updateAction).toBe("download-apk");
  });

  it("keeps legacy stable APK state compatible without native release key metadata", () => {
    const view = engineSectionView({
      appBuild: "0.0.41",
      appVersionState: {
        server_time_utc: "2026-06-30T20:26:24.000Z",
        version: "0.0.41",
        ota_version: "0.0.41",
        parts: { canon: 0, release: 0, build: 41, apk: 1 },
        latest: { canon: null, release: null, build: null, apk: null },
        target_apk: {
          file: "brai-v1.apk",
          version: 1,
          version_code: 1,
          release_key: "production",
          apk_build_kind: "stable",
          preview_iteration: null,
          release_url: "/releases/",
          published_at: "2026-06-30T20:23:42Z",
        },
        apk_release: null,
      },
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.41",
        nativeApkVersion: "1",
        lastCheckStatus: "up_to_date",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.hasUpdate).toBe(false);
    expect(view.apkUpdateAvailable).toBe(false);
  });

  it("flags stale preview APK iterations", () => {
    const view = engineSectionView({
      appBuild: "0.0.41",
      appVersionState: null,
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.41",
        nativeApkVersion: "2",
        nativeApkReleaseKey: "a",
        nativeApkBuildKind: "preview",
        nativeApkPreviewIteration: 5,
        targetApkVersion: "2",
        targetApkReleaseKey: "a",
        targetApkBuildKind: "preview",
        targetApkPreviewIteration: "6",
        lastCheckStatus: "up_to_date",
      },
      versionError: false,
      versionRefreshing: false,
    });

    expect(view.apkUpdateAvailable).toBe(true);
    expect(view.requiredApkLabel).toBe("v2-preview6");
  });

  it("maps discovery, web download, and APK download to separate actions", () => {
    const base = {
      appBuild: "0.0.10",
      appVersionState: null,
      otaRefreshing: false,
      versionError: false,
      versionRefreshing: false,
    };
    expect(engineSectionView({
      ...base,
      otaState: { activeBundleVersion: "0.0.10", availableBundleVersion: "0.0.11", updateAvailable: true, lastCheckStatus: "update_available" },
    }).updateAction).toBe("download-web");
    expect(engineSectionView({
      ...base,
      otaState: { activeBundleVersion: "0.0.10", availableBundleVersion: "0.0.11", activeOperation: "web_download", lastCheckStatus: "downloading" },
    }).updateAction).toBe("downloading-web");
    expect(engineSectionView({
      ...base,
      otaState: { activeBundleVersion: "0.0.10", nativeApkVersion: "1", targetApkVersion: "2", lastCheckStatus: "apk_required", apkDownloadStatus: "downloading" },
    }).updateAction).toBe("downloading-apk");
    expect(engineSectionView({
      ...base,
      otaState: { activeBundleVersion: "0.0.10", nativeApkVersion: "1", targetApkVersion: "2", lastCheckStatus: "apk_required", apkDownloadStatus: "downloaded" },
    }).updateAction).toBe("install-apk");
  });

  it("shows real APK progress and install permission state", () => {
    const base = {
      appBuild: "0.0.10",
      appVersionState: null,
      otaRefreshing: false,
      versionError: false,
      versionRefreshing: false,
    };
    const downloading = engineSectionView({
      ...base,
      otaState: {
        activeBundleVersion: "0.0.10",
        nativeApkVersion: "1",
        targetApkVersion: "2",
        lastCheckStatus: "apk_required",
        apkDownloadStatus: "downloading",
        apkDownloadBytes: 25,
        apkDownloadTotalBytes: 100,
      },
    });
    expect(downloading.updateAction).toBe("downloading-apk");
    expect(downloading.downloadProgressPercent).toBe(25);

    const ready = engineSectionView({
      ...base,
      otaState: {
        activeBundleVersion: "0.0.10",
        nativeApkVersion: "1",
        targetApkVersion: "2",
        lastCheckStatus: "apk_required",
        apkDownloadStatus: "downloaded",
        apkInstallPermissionRequired: true,
      },
    });
    expect(ready.updateAction).toBe("install-apk");
    expect(ready.apkInstallPermissionRequired).toBe(true);
  });

  it("keeps user-facing Engine text free from the technical update acronym", () => {
    const view = engineSectionView({
      appBuild: "0.0.10",
      appVersionState: null,
      otaRefreshing: false,
      otaState: { activeBundleVersion: "0.0.10", availableBundleVersion: "0.0.11", lastCheckStatus: "update_available" },
      versionError: false,
      versionRefreshing: false,
    });
    expect(view.updateStatus.body).not.toContain("OTA");
  });
});
