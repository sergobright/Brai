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
  nativeOtaChannel?: string;
  nativeAppLabel?: string;
  previousStableBundleVersion?: string | null;
  stableBundleVersion?: string | null;
  candidateBundleVersion?: string | null;
  lastCheckStatus?: string;
  lastUpdateError?: string | null;
  targetApkVersion?: string | null;
  targetApkReleaseUrl?: string | null;
  failedBundleVersions?: string;
  checkInProgress?: boolean;
  downloadProgressVersion?: string | null;
  downloadProgressBytes?: number;
  downloadProgressTotalBytes?: number;
  downloadProgressPercent?: number | null;
};

type BraiOtaPlugin = {
  getState(): Promise<BraiOtaState>;
  checkForUpdates?(): Promise<BraiOtaState & { started?: boolean }>;
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
