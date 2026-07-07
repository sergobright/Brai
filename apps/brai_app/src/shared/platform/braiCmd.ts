import { registerPlugin } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

type BraiCmdPlugin = {
  getState(): Promise<BraiCmdState>;
  openSettings(): Promise<unknown>;
  setVoiceOnlyMode(options: { enabled: boolean }): Promise<BraiCmdState>;
};

const BraiCmd = registerPlugin<BraiCmdPlugin>("BraiCmd");

export type BraiCmdState = {
  native?: boolean;
  accessGranted?: boolean;
  voiceOnlyMode?: boolean;
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

export async function setBraiCmdVoiceOnlyMode(enabled: boolean): Promise<BraiCmdState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiCmd.setVoiceOnlyMode({ enabled });
  } catch {
    return null;
  }
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}
