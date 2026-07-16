import { describe, expect, it } from "vitest";
import type { VersionHistoryItem, VersionHistoryTypeId } from "@/shared/api/braiApi";
import { installedProductVersion, versionHistoryStatus, versionTypeTitle } from "@/features/app/sections/engine/versionHistoryModel";

describe("version history model", () => {
  it("uses an exact Product commit match and only then the explicit Preview baseline", () => {
    const items = [historyItem(148, "build", "accepted")];
    expect(installedProductVersion(items, "accepted", 147)).toBe(148);
    expect(installedProductVersion(items, "preview-head", 147)).toBe(147);
    expect(installedProductVersion(items, "preview-head", null)).toBeNull();
  });

  it("maps installed, available, irrelevant, and unknown states per platform", () => {
    const product148 = historyItem(148, "build");
    const product149 = historyItem(149, "build");
    const apk11 = historyItem(11, "apk");
    const macos1 = historyItem(1, "macos");

    expect(versionHistoryStatus(product148, { build: 148 }, "web")).toBe("installed");
    expect(versionHistoryStatus(product149, { build: 148 }, "web")).toBe("available");
    expect(versionHistoryStatus(apk11, { apk: 10 }, "web")).toBe("irrelevant");
    expect(versionHistoryStatus(apk11, { apk: 10 }, "android")).toBe("available");
    expect(versionHistoryStatus(apk11, { apk: 11 }, "android")).toBe("installed");
    expect(versionHistoryStatus(macos1, {}, "android")).toBe("irrelevant");
    expect(versionHistoryStatus(product148, {}, "web")).toBe("unknown");
  });

  it("uses canonical badge labels", () => {
    const legacyTypes = [{ id: "build", title: "Сборка" }, { id: "apk", title: "APK" }];
    expect(versionTypeTitle("build", legacyTypes)).toBe("Product");
    expect(versionTypeTitle("apk", legacyTypes)).toBe("Android APK");
    expect(versionTypeTitle("macos", legacyTypes)).toBe("macOS");
    expect(versionTypeTitle("ios", legacyTypes)).toBe("iOS");
  });
});

function historyItem(version: number, type: VersionHistoryTypeId, targetCommit = "target"): VersionHistoryItem {
  return {
    id: version,
    type,
    version,
    short_changes: `Работа ${version}`,
    detailed_changes: `Подробности ${version}`,
    reason: `Причина ${version}`,
    released_at_utc: "2026-07-15T00:00:00.000Z",
    created_at_utc: "2026-07-15T00:00:00.000Z",
    work: null,
    details: [],
    pull_requests: [],
    refs: [{ source_branch: null, source_commit: null, target_branch: "main", target_commit: targetCommit, created_at_utc: "2026-07-15T00:00:00.000Z" }],
  };
}
