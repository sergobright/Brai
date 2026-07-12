import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  addListener: vi.fn(),
  ensureAccess: vi.fn(),
  getState: vi.fn(),
  openSettings: vi.fn(),
  preparePreliminaryProfile: vi.fn(),
  retryQueue: vi.fn(),
  setAccessKey: vi.fn(),
  setOverlayEnabled: vi.fn(),
  setQueuePausedMode: vi.fn(),
  setVoiceOnlyMode: vi.fn(),
  vibratePress: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

describe("Brai CMD bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.addListener.mockReset();
    plugin.ensureAccess.mockReset();
    plugin.getState.mockReset();
    plugin.openSettings.mockReset();
    plugin.preparePreliminaryProfile.mockReset();
    plugin.retryQueue.mockReset();
    plugin.setAccessKey.mockReset();
    plugin.setOverlayEnabled.mockReset();
    plugin.setQueuePausedMode.mockReset();
    plugin.setVoiceOnlyMode.mockReset();
    plugin.vibratePress.mockReset();
    vi.unstubAllGlobals();
  });

  it("does nothing outside Android native shell", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { ensureBraiCmdAccess, getBraiCmdState, listenBraiCmdOnboardingEvents, prepareBraiCmdPreliminaryProfile, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode, vibrateBraiCmdPress } = await import("@/shared/platform/braiCmd");

    await expect(getBraiCmdState()).resolves.toBeNull();
    await expect(ensureBraiCmdAccess("Test")).resolves.toBeNull();
    await expect(prepareBraiCmdPreliminaryProfile("Test")).resolves.toBeNull();
    await expect(listenBraiCmdOnboardingEvents(vi.fn())).resolves.toBeNull();
    await expect(setBraiCmdAccessKey("token", "Test")).resolves.toBeNull();
    await expect(setBraiCmdOverlayEnabled(true)).resolves.toBeNull();
    await expect(setBraiCmdVoiceOnlyMode(true)).resolves.toBeNull();
    await expect(setBraiCmdQueuePausedMode(true)).resolves.toBeNull();
    await expect(retryBraiCmdQueue()).resolves.toBeNull();
    await expect(vibrateBraiCmdPress()).resolves.toBeUndefined();
    expect(plugin.getState).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
    expect(plugin.preparePreliminaryProfile).not.toHaveBeenCalled();
    expect(plugin.setVoiceOnlyMode).not.toHaveBeenCalled();
    expect(plugin.vibratePress).not.toHaveBeenCalled();
  });

  it("reads access state from Android native bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.getState.mockResolvedValue({ accessGranted: true, voiceOnlyMode: false });
    const { getBraiCmdState } = await import("@/shared/platform/braiCmd");

    await expect(getBraiCmdState()).resolves.toMatchObject({
      accessGranted: true,
      voiceOnlyMode: false,
    });
  });

  it("toggles voice-only training mode through Android native bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.setVoiceOnlyMode.mockResolvedValue({ voiceOnlyMode: true });
    const { setBraiCmdVoiceOnlyMode } = await import("@/shared/platform/braiCmd");

    await expect(setBraiCmdVoiceOnlyMode(true)).resolves.toMatchObject({ voiceOnlyMode: true });
    expect(plugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true });
  });

  it("uses Android native haptics for onboarding button presses", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.vibratePress.mockResolvedValue({});
    const { vibrateBraiCmdPress } = await import("@/shared/platform/braiCmd");

    await expect(vibrateBraiCmdPress()).resolves.toBeUndefined();
    expect(plugin.vibratePress).toHaveBeenCalledWith();
  });

  it("prepares access and queue controls through Android native bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.ensureAccess.mockResolvedValue({ accessGranted: true });
    plugin.preparePreliminaryProfile.mockResolvedValue({ preliminaryStatus: "ready", preliminaryUserId: "prelim-1" });
    plugin.setAccessKey.mockResolvedValue({ accessGranted: true });
    plugin.setOverlayEnabled.mockResolvedValue({ overlayEnabled: true });
    plugin.setQueuePausedMode.mockResolvedValue({ queuePausedMode: true });
    plugin.retryQueue.mockResolvedValue({ queuePausedMode: false });
    const { ensureBraiCmdAccess, prepareBraiCmdPreliminaryProfile, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode } = await import("@/shared/platform/braiCmd");

    await expect(ensureBraiCmdAccess("Fixture User")).resolves.toMatchObject({ accessGranted: true });
    await expect(prepareBraiCmdPreliminaryProfile("Fixture User")).resolves.toMatchObject({ preliminaryUserId: "prelim-1" });
    await expect(setBraiCmdAccessKey("fixture-access-key", "Fixture User")).resolves.toMatchObject({ accessGranted: true });
    await expect(setBraiCmdOverlayEnabled(true)).resolves.toMatchObject({ overlayEnabled: true });
    await expect(setBraiCmdQueuePausedMode(true)).resolves.toMatchObject({ queuePausedMode: true });
    await expect(retryBraiCmdQueue()).resolves.toMatchObject({ queuePausedMode: false });
    expect(plugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Fixture User" });
    expect(plugin.preparePreliminaryProfile).toHaveBeenCalledWith({ displayName: "Fixture User" });
    expect(plugin.setAccessKey).toHaveBeenCalledWith({ token: "fixture-access-key", displayName: "Fixture User" });
    expect(plugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(plugin.setQueuePausedMode).toHaveBeenCalledWith({ enabled: true });
    expect(plugin.retryQueue).toHaveBeenCalledWith();
  });

  it("listens to onboarding events on Android native bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const remove = vi.fn();
    plugin.addListener.mockResolvedValue({ remove });
    const listener = vi.fn();
    const { listenBraiCmdOnboardingEvents } = await import("@/shared/platform/braiCmd");

    await expect(listenBraiCmdOnboardingEvents(listener)).resolves.toEqual({ remove });
    expect(plugin.addListener).toHaveBeenCalledWith("onboardingEvent", listener);
  });
});
