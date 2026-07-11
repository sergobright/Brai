import { registerPlugin } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";

export type BraiAndroidCapabilitiesState = {
  overlayDeclared?: boolean;
  overlayGranted?: boolean;
  microphoneDeclared?: boolean;
  microphoneForegroundServiceDeclared?: boolean;
  microphoneGranted?: boolean;
  notificationsDeclared?: boolean;
  notificationsGranted?: boolean;
  mediaProjectionDeclared?: boolean;
  mediaProjectionServiceDeclared?: boolean;
  mediaProjectionServiceTypeDeclared?: boolean;
  microphoneServiceTypeDeclared?: boolean;
  accessibilityServiceDeclared?: boolean;
  accessibilityServiceEnabled?: boolean;
};

type BraiAndroidCapabilitiesPlugin = {
  getState(): Promise<BraiAndroidCapabilitiesState>;
  requestMicrophone(): Promise<BraiAndroidCapabilitiesState>;
  requestNotifications(): Promise<BraiAndroidCapabilitiesState>;
  openAppSettings(): Promise<BraiAndroidCapabilitiesState>;
  openOverlaySettings(): Promise<BraiAndroidCapabilitiesState>;
  openAccessibilitySettings(): Promise<BraiAndroidCapabilitiesState>;
};

const BraiAndroidCapabilities = registerPlugin<BraiAndroidCapabilitiesPlugin>("BraiAndroidCapabilities");

export async function getAndroidCapabilities(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.getState();
  } catch {
    return null;
  }
}

export async function requestAndroidMicrophone(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.requestMicrophone();
  } catch {
    return null;
  }
}

export async function requestAndroidNotifications(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.requestNotifications();
  } catch {
    return null;
  }
}

export async function openAndroidAppSettings(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.openAppSettings();
  } catch {
    return null;
  }
}

export async function openAndroidOverlaySettings(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.openOverlaySettings();
  } catch {
    return null;
  }
}

export async function openAndroidAccessibilitySettings(): Promise<BraiAndroidCapabilitiesState | null> {
  if (!isNativeAndroid()) return null;
  try {
    return await BraiAndroidCapabilities.openAccessibilitySettings();
  } catch {
    return null;
  }
}

function isNativeAndroid(): boolean {
  return isNativeShell() && platformName() === "android";
}
