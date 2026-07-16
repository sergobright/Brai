import type { VersionHistoryItem, VersionHistoryType, VersionHistoryTypeId } from "@/shared/api/braiApi";

export type VersionHistoryPlatform = "web" | "android";
export type VersionHistoryStatus = "installed" | "available" | "irrelevant" | "unknown";
export type InstalledVersions = Partial<Record<VersionHistoryTypeId, number | null>>;

const TYPE_TITLES: Record<VersionHistoryTypeId, string> = {
  build: "Product",
  apk: "Android APK",
  macos: "macOS",
  ios: "iOS",
};

/** Resolves the installed Product ledger version without guessing from the latest API row. */
export function installedProductVersion(
  items: VersionHistoryItem[],
  currentCommit: string | undefined,
  explicitVersion: number | null | undefined,
): number | null {
  const commit = currentCommit?.trim().toLowerCase();
  const matched = commit
    ? items.reduce<number | null>((current, item) => {
        if (item.type !== "build" || !item.refs.some((ref) => ref.target_commit?.toLowerCase() === commit)) return current;
        return current == null ? item.version : Math.max(current, item.version);
      }, null)
    : null;
  return matched ?? explicitVersion ?? null;
}

/** Maps a release to its platform-aware installed, available, irrelevant, or unknown state. */
export function versionHistoryStatus(
  item: VersionHistoryItem,
  installedVersions: InstalledVersions,
  platform: VersionHistoryPlatform,
): VersionHistoryStatus {
  const applicable = item.type === "build" || (platform === "android" && item.type === "apk");
  if (!applicable) return "irrelevant";
  const installedVersion = installedVersions[item.type];
  if (installedVersion == null) return "unknown";
  return item.version <= installedVersion ? "installed" : "available";
}

/** Returns the canonical user-facing label for a version ledger type. */
export function versionTypeTitle(typeId: VersionHistoryTypeId, types: VersionHistoryType[]): string {
  return TYPE_TITLES[typeId] ?? types.find((type) => type.id === typeId)?.title ?? typeId.toUpperCase();
}
