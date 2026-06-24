import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  getState: vi.fn(),
  checkForUpdates: vi.fn(),
  markReady: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

describe("Android OTA readiness bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.getState.mockReset();
    plugin.checkForUpdates.mockReset();
    plugin.markReady.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing in the browser", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { notifyAndroidOtaReady } = await import("@/shared/platform/ota");

    await notifyAndroidOtaReady();

    expect(plugin.getState).not.toHaveBeenCalled();
    expect(plugin.markReady).not.toHaveBeenCalled();
  });

  it("marks the active Android bundle ready once", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.getState.mockResolvedValue({ activeBundleVersion: "0.0.2.1" });
    plugin.markReady.mockResolvedValue({ activeBundleVersion: "0.0.2.1" });
    const { notifyAndroidOtaReady } = await import("@/shared/platform/ota");

    await notifyAndroidOtaReady();
    await notifyAndroidOtaReady();

    expect(plugin.getState).toHaveBeenCalledTimes(1);
    expect(plugin.markReady).toHaveBeenCalledWith({ bundleVersion: "0.0.2.1" });
  });

  it("keeps startup alive when the native bridge is unavailable", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.getState.mockRejectedValue(new Error("missing plugin"));
    const { notifyAndroidOtaReady } = await import("@/shared/platform/ota");

    await expect(notifyAndroidOtaReady()).resolves.toBeUndefined();
  });

  it("asks the Android bridge to check for updates", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.checkForUpdates.mockResolvedValue({
      activeBundleVersion: "0.0.2.1",
      lastCheckStatus: "checking",
    });
    const { checkAndroidOtaUpdates } = await import("@/shared/platform/ota");

    await expect(checkAndroidOtaUpdates()).resolves.toMatchObject({ lastCheckStatus: "checking" });
    expect(plugin.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
