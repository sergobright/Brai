import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  addListener: vi.fn(),
  beginAccountCredentialMode: vi.fn(),
  ensureAccess: vi.fn(),
  getState: vi.fn(),
  invalidateProviderCredentials: vi.fn(),
  openSettings: vi.fn(),
  preparePreliminaryProfile: vi.fn(),
  retryPendingAccountRevocation: vi.fn(),
  retryQueue: vi.fn(),
  setAccessKey: vi.fn(),
  setAuthenticatedMode: vi.fn(),
  syncProviderCredentials: vi.fn(),
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
    plugin.beginAccountCredentialMode.mockReset();
    plugin.ensureAccess.mockReset();
    plugin.getState.mockReset();
    plugin.invalidateProviderCredentials.mockReset();
    plugin.openSettings.mockReset();
    plugin.preparePreliminaryProfile.mockReset();
    plugin.retryPendingAccountRevocation.mockReset();
    plugin.retryQueue.mockReset();
    plugin.setAccessKey.mockReset();
    plugin.setAuthenticatedMode.mockReset();
    plugin.syncProviderCredentials.mockReset();
    plugin.setOverlayEnabled.mockReset();
    plugin.setQueuePausedMode.mockReset();
    plugin.setVoiceOnlyMode.mockReset();
    plugin.vibratePress.mockReset();
    vi.unstubAllGlobals();
  });

  it("does nothing outside Android native shell", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { beginBraiCmdAccountCredentialMode, ensureBraiCmdAccess, getBraiCmdState, invalidateBraiCmdProviderCredentials, listenBraiCmdCredentialRefreshRequired, listenBraiCmdOnboardingEvents, prepareBraiCmdPreliminaryProfile, retryBraiCmdPendingAccountRevocation, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode, vibrateBraiCmdPress } = await import("@/shared/platform/braiCmd");

    await expect(getBraiCmdState()).resolves.toBeNull();
    await expect(ensureBraiCmdAccess("Test")).resolves.toBeNull();
    await expect(prepareBraiCmdPreliminaryProfile("Test")).resolves.toBeNull();
    await expect(listenBraiCmdOnboardingEvents(vi.fn())).resolves.toBeNull();
    await expect(listenBraiCmdCredentialRefreshRequired(vi.fn())).resolves.toBeNull();
    await expect(beginBraiCmdAccountCredentialMode("user-1")).resolves.toBeNull();
    await expect(setBraiCmdAccessKey("token", "Test", "user-1")).resolves.toBeNull();
    await expect(invalidateBraiCmdProviderCredentials()).resolves.toBe(false);
    await expect(retryBraiCmdPendingAccountRevocation()).resolves.toBe(false);
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

  it("applies authenticated native mode through the account-owned atomic bridge", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.setAuthenticatedMode.mockResolvedValue({
      overlayEnabled: true,
      voiceOnlyMode: false,
      queuePausedMode: false,
    });
    const { setBraiCmdAuthenticatedMode } = await import("@/shared/platform/braiCmd");

    await expect(setBraiCmdAuthenticatedMode("user-1", true)).resolves.toMatchObject({
      overlayEnabled: true,
      voiceOnlyMode: false,
      queuePausedMode: false,
    });
    expect(plugin.setAuthenticatedMode).toHaveBeenCalledWith({ userId: "user-1", enabled: true });
    expect(plugin.setOverlayEnabled).not.toHaveBeenCalled();
    expect(plugin.setQueuePausedMode).not.toHaveBeenCalled();
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
    plugin.getState.mockResolvedValue({ accessGranted: false, accountCredentialsActive: false });
    plugin.beginAccountCredentialMode.mockResolvedValue({ accountCredentialsActive: true, queuePausedMode: true });
    plugin.preparePreliminaryProfile.mockResolvedValue({ preliminaryStatus: "ready", preliminaryUserId: "prelim-1" });
    plugin.setAccessKey.mockResolvedValue({ accessGranted: true });
    plugin.setOverlayEnabled.mockResolvedValue({ overlayEnabled: true });
    plugin.setQueuePausedMode.mockResolvedValue({ queuePausedMode: true });
    plugin.retryQueue.mockResolvedValue({ queuePausedMode: false });
    plugin.retryPendingAccountRevocation.mockResolvedValue({ ok: true });
    plugin.invalidateProviderCredentials.mockResolvedValue({ ok: true });
    plugin.preparePreliminaryProfile.mockResolvedValue({ preliminaryStatus: "ready", preliminaryUserId: "prelim-1", preliminaryClaimToken: "claim-1" });
    const { beginBraiCmdAccountCredentialMode, ensureBraiCmdAccess, invalidateBraiCmdProviderCredentials, prepareBraiCmdPreliminaryProfile, retryBraiCmdPendingAccountRevocation, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode } = await import("@/shared/platform/braiCmd");

    await expect(beginBraiCmdAccountCredentialMode("user-1")).resolves.toMatchObject({ accountCredentialsActive: true });
    await expect(ensureBraiCmdAccess("Fixture User")).resolves.toMatchObject({ accessGranted: true });
    await expect(prepareBraiCmdPreliminaryProfile("Fixture User")).resolves.toMatchObject({ preliminaryUserId: "prelim-1" });
    await expect(setBraiCmdAccessKey("fixture-access-key", "Fixture User", "user-1")).resolves.toMatchObject({ accessGranted: true });
    await expect(invalidateBraiCmdProviderCredentials()).resolves.toBe(true);
    await expect(setBraiCmdOverlayEnabled(true)).resolves.toMatchObject({ overlayEnabled: true });
    await expect(setBraiCmdQueuePausedMode(true)).resolves.toMatchObject({ queuePausedMode: true });
    await expect(retryBraiCmdQueue()).resolves.toMatchObject({ queuePausedMode: false });
    await expect(retryBraiCmdPendingAccountRevocation()).resolves.toBe(true);
    expect(plugin.beginAccountCredentialMode).toHaveBeenCalledWith({ userId: "user-1" });
    expect(plugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Fixture User" });
    expect(plugin.preparePreliminaryProfile).toHaveBeenCalledWith({ displayName: "Fixture User" });
    expect(plugin.setAccessKey).toHaveBeenCalledWith({ token: "fixture-access-key", displayName: "Fixture User", userId: "user-1" });
    expect(plugin.invalidateProviderCredentials).toHaveBeenCalledWith();
    expect(plugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(plugin.setQueuePausedMode).toHaveBeenCalledWith({ enabled: true });
    expect(plugin.retryQueue).toHaveBeenCalledWith();
    expect(plugin.retryPendingAccountRevocation).toHaveBeenCalledWith();
  });

  it("requests native device access even after account mode starts", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.ensureAccess.mockResolvedValue({ accountCredentialsActive: true, accessGranted: true });
    const { ensureBraiCmdAccess } = await import("@/shared/platform/braiCmd");

    await expect(ensureBraiCmdAccess("Fixture User")).resolves.toMatchObject({ accessGranted: true });
    expect(plugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Fixture User" });
  });

  it("logs only the safe preliminary failure category", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    plugin.preparePreliminaryProfile.mockRejectedValue(Object.assign(new Error("private network detail"), { code: "preliminary_timeout" }));
    const { prepareBraiCmdPreliminaryProfile } = await import("@/shared/platform/braiCmd");

    await expect(prepareBraiCmdPreliminaryProfile("Fixture User")).resolves.toBeNull();
    expect(warning).toHaveBeenCalledWith("Brai CMD preliminary profile failed", { code: "preliminary_timeout" });
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

  it("listens for internal credential refresh requests", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const remove = vi.fn();
    plugin.addListener.mockResolvedValue({ remove });
    const listener = vi.fn();
    const { listenBraiCmdCredentialRefreshRequired } = await import("@/shared/platform/braiCmd");

    await expect(listenBraiCmdCredentialRefreshRequired(listener)).resolves.toEqual({ remove });
    expect(plugin.addListener).toHaveBeenCalledWith("credentialRefreshRequired", listener);
  });
});
