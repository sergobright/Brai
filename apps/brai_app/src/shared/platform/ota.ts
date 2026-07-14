import { registerPlugin } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

export type BraiOtaState = {
  activeBundleVersion: string;
  fallbackBundleVersion?: string;
  nativeApkVersion?: string;
  nativeVersionName?: string;
  nativeBuild?: string;
  nativeVersionCode?: number;
  nativeEnvironment?: string;
  nativePreviewSlot?: string | null;
  nativeApkReleaseKey?: string | null;
  nativeApkBuildKind?: string | null;
  nativeApkPreviewIteration?: number | string | null;
  nativeOtaChannel?: string;
  nativeAppLabel?: string;
  previousStableBundleVersion?: string | null;
  stableBundleVersion?: string | null;
  candidateBundleVersion?: string | null;
  availableBundleVersion?: string | null;
  updateAvailable?: boolean;
  lastCheckStatus?: string;
  lastUpdateError?: string | null;
  targetApkVersion?: string | null;
  targetApkReleaseKey?: string | null;
  targetApkBuildKind?: string | null;
  targetApkPreviewIteration?: string | number | null;
  targetApkVersionCode?: string | number | null;
  targetApkReleaseUrl?: string | null;
  failedBundleVersions?: string;
  checkInProgress?: boolean;
  activeOperation?: "checking" | "web_download" | "apk_download" | null;
  apkDownloadStatus?: "idle" | "downloading" | "downloaded" | "failed";
  apkDownloadError?: string | null;
  apkDownloadBytes?: number;
  apkDownloadTotalBytes?: number;
  apkDownloadPercent?: number | null;
  apkInstallReady?: boolean;
  apkInstallPermissionRequired?: boolean;
  downloadProgressVersion?: string | null;
  downloadProgressBytes?: number;
  downloadProgressTotalBytes?: number;
  downloadProgressPercent?: number | null;
};

type BraiOtaPlugin = {
  getState(): Promise<BraiOtaState>;
  checkForUpdates?(): Promise<BraiOtaState & { started?: boolean }>;
  downloadUpdate?(): Promise<BraiOtaState & { started?: boolean }>;
  downloadApk?(): Promise<BraiOtaState & { started?: boolean }>;
  installApk?(): Promise<BraiOtaState & { opened?: boolean }>;
  markReady(options: { bundleVersion: string }): Promise<BraiOtaState & { promoted?: boolean }>;
};

const BraiOta = registerPlugin<BraiOtaPlugin>("BraiOta");
let readinessSent = false;

export async function notifyAndroidOtaReady(): Promise<void> {
  if (readinessSent || !isNativeShell() || platformName() !== "android") return;
  readinessSent = true;

  try {
    const state = await BraiOta.getState();
    await BraiOta.markReady({ bundleVersion: state.activeBundleVersion });
  } catch {
    // Old APKs and browser-like shells must keep booting even without the OTA bridge.
  }
}

export async function getAndroidOtaState(): Promise<BraiOtaState | null> {
  if (!isNativeShell() || platformName() !== "android") return null;
  try {
    return await BraiOta.getState();
  } catch {
    return null;
  }
}

export async function checkAndroidOtaUpdates(): Promise<BraiOtaState | null> {
  if (!isNativeShell() || platformName() !== "android") return null;
  try {
    return BraiOta.checkForUpdates ? await BraiOta.checkForUpdates() : await BraiOta.getState();
  } catch {
    return null;
  }
}

export async function downloadAndroidOtaUpdate(): Promise<BraiOtaState | null> {
  if (!isNativeShell() || platformName() !== "android" || !BraiOta.downloadUpdate) return null;
  try {
    return await BraiOta.downloadUpdate();
  } catch {
    return null;
  }
}

export async function downloadAndroidApk(): Promise<BraiOtaState | null> {
  if (!isNativeShell() || platformName() !== "android" || !BraiOta.downloadApk) return null;
  try {
    return await BraiOta.downloadApk();
  } catch {
    return null;
  }
}

export async function installAndroidApk(): Promise<BraiOtaState | null> {
  if (!isNativeShell() || platformName() !== "android" || !BraiOta.installApk) return null;
  try {
    return await BraiOta.installApk();
  } catch {
    return null;
  }
}
