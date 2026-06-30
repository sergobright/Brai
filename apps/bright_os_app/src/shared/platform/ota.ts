import { registerPlugin } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

export type BrightOtaState = {
  activeBundleVersion: string;
  fallbackBundleVersion?: string;
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
  failedBundleVersions?: string;
  checkInProgress?: boolean;
  downloadProgressVersion?: string | null;
  downloadProgressBytes?: number;
  downloadProgressTotalBytes?: number;
  downloadProgressPercent?: number | null;
};

type BrightOtaPlugin = {
  getState(): Promise<BrightOtaState>;
  checkForUpdates?(): Promise<BrightOtaState & { started?: boolean }>;
  markReady(options: { bundleVersion: string }): Promise<BrightOtaState & { promoted?: boolean }>;
};

const BrightOta = registerPlugin<BrightOtaPlugin>("BrightOta");
let readinessSent = false;

export async function notifyAndroidOtaReady(): Promise<void> {
  if (readinessSent || !isNativeShell() || platformName() !== "android") return;
  readinessSent = true;

  try {
    const state = await BrightOta.getState();
    await BrightOta.markReady({ bundleVersion: state.activeBundleVersion });
  } catch {
    // Old APKs and browser-like shells must keep booting even without the OTA bridge.
  }
}

export async function getAndroidOtaState(): Promise<BrightOtaState | null> {
  if (!isNativeShell() || platformName() !== "android") return null;
  try {
    return await BrightOta.getState();
  } catch {
    return null;
  }
}

export async function checkAndroidOtaUpdates(): Promise<BrightOtaState | null> {
  if (!isNativeShell() || platformName() !== "android") return null;
  try {
    return BrightOta.checkForUpdates ? await BrightOta.checkForUpdates() : await BrightOta.getState();
  } catch {
    return null;
  }
}
