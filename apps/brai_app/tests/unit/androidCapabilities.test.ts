import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  getState: vi.fn(),
  requestMicrophone: vi.fn(),
  requestNotifications: vi.fn(),
  openOverlaySettings: vi.fn(),
  openAccessibilitySettings: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

describe("Android capabilities bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.getState.mockReset();
    plugin.requestMicrophone.mockReset();
    plugin.requestNotifications.mockReset();
    plugin.openOverlaySettings.mockReset();
    plugin.openAccessibilitySettings.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing outside Android native shell", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { getAndroidCapabilities } = await import("@/shared/platform/androidCapabilities");

    await expect(getAndroidCapabilities()).resolves.toBeNull();
    expect(plugin.getState).not.toHaveBeenCalled();
  });

  it("reads Android native capability state", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.getState.mockResolvedValue({
      overlayDeclared: true,
      microphoneGranted: true,
      notificationsGranted: true,
      mediaProjectionServiceTypeDeclared: true,
    });
    const { getAndroidCapabilities } = await import("@/shared/platform/androidCapabilities");

    await expect(getAndroidCapabilities()).resolves.toMatchObject({
      overlayDeclared: true,
      microphoneGranted: true,
      notificationsGranted: true,
      mediaProjectionServiceTypeDeclared: true,
    });
  });

  it("requests Android notification permission through the native bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.requestNotifications.mockResolvedValue({
      notificationsDeclared: true,
      notificationsGranted: true,
    });
    const { requestAndroidNotifications } = await import("@/shared/platform/androidCapabilities");

    await expect(requestAndroidNotifications()).resolves.toMatchObject({
      notificationsDeclared: true,
      notificationsGranted: true,
    });
    expect(plugin.requestNotifications).toHaveBeenCalledTimes(1);
  });

  it("keeps callers alive when old APKs do not have the plugin", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.requestMicrophone.mockRejectedValue(new Error("missing plugin"));
    const { requestAndroidMicrophone } = await import("@/shared/platform/androidCapabilities");

    await expect(requestAndroidMicrophone()).resolves.toBeNull();
  });
});
