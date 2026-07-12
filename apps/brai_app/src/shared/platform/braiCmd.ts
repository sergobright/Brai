import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

type BraiCmdPlugin = {
  getState(): Promise<BraiCmdState>;
  vibratePress(): Promise<BraiCmdState>;
  openSettings(): Promise<unknown>;
  preparePreliminaryProfile(options: { displayName: string }): Promise<BraiCmdPreliminaryProfile>;
  ensureAccess(options: { displayName: string }): Promise<BraiCmdState>;
  setAccessKey(options: { token: string; displayName: string }): Promise<BraiCmdState>;
  setOverlayEnabled(options: { enabled: boolean }): Promise<BraiCmdState>;
  setVoiceOnlyMode(options: { enabled: boolean }): Promise<BraiCmdState>;
  setQueuePausedMode(options: { enabled: boolean }): Promise<BraiCmdState>;
  retryQueue(): Promise<BraiCmdState>;
  addListener(eventName: "onboardingEvent", listenerFunc: (event: BraiCmdOnboardingEvent) => void): Promise<PluginListenerHandle>;
};

const BraiCmd = registerPlugin<BraiCmdPlugin>("BraiCmd");

export type BraiCmdState = {
  native?: boolean;
  accessGranted?: boolean;
  voiceOnlyMode?: boolean;
  queuePausedMode?: boolean;
  overlayEnabled?: boolean;
};

export type BraiCmdPreliminaryProfile = BraiCmdState & {
  preliminaryStatus?: "ready" | "duplicate";
  preliminaryUserId?: string;
  preliminaryClaimToken?: string;
  duplicateDevice?: boolean;
  deviceFingerprint?: string;
};

export type BraiCmdOnboardingEvent = {
  type?: "voiceTextInserted" | "queueSaved";
  text?: string;
};

export async function getBraiCmdState(): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.getState();
  } catch {
    return null;
  }
}

/** Opens the Brai Cmd native settings screen when the app runs inside Android. */
export async function openBraiCmdSettings(): Promise<boolean> {
  if (!isNativeAndroid()) return false;
  try {
    await BraiCmd.openSettings();
    return true;
  } catch {
    return false;
  }
}

export async function ensureBraiCmdAccess(displayName: string): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.ensureAccess({ displayName });
  } catch {
    return null;
  }
}

export async function prepareBraiCmdPreliminaryProfile(displayName: string): Promise<BraiCmdPreliminaryProfile | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.preparePreliminaryProfile({ displayName });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "preliminary_unknown";
    console.warn("Brai CMD preliminary profile failed", { code });
    return null;
  }
}

export async function setBraiCmdAccessKey(token: string, displayName: string): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setAccessKey({ token, displayName });
  } catch {
    return null;
  }
}

export async function setBraiCmdVoiceOnlyMode(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setVoiceOnlyMode({ enabled });
  } catch {
    return null;
  }
}

export async function setBraiCmdOverlayEnabled(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setOverlayEnabled({ enabled });
  } catch {
    return null;
  }
}

export async function vibrateBraiCmdPress(): Promise<void> {
  if (isNativeAndroid()) {
    try {
      await BraiCmd.vibratePress();
      return;
    } catch {
      // Fall through to the browser vibration API when the native bridge is unavailable.
    }
  }
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(16);
}

export async function setBraiCmdQueuePausedMode(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setQueuePausedMode({ enabled });
  } catch {
    return null;
  }
}

export async function retryBraiCmdQueue(): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.retryQueue();
  } catch {
    return null;
  }
}

export async function listenBraiCmdOnboardingEvents(
  onEvent: (event: BraiCmdOnboardingEvent) => void,
): Promise<PluginListenerHandle | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.addListener("onboardingEvent", onEvent);
  } catch {
    return null;
  }
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}
