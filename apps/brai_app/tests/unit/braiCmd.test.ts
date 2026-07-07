import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  getState: vi.fn(),
  openSettings: vi.fn(),
  setVoiceOnlyMode: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

describe("Brai CMD bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.getState.mockReset();
    plugin.openSettings.mockReset();
    plugin.setVoiceOnlyMode.mockReset();
    vi.unstubAllGlobals();
  });

  it("does nothing outside Android native shell", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { getBraiCmdState, setBraiCmdVoiceOnlyMode } = await import("@/shared/platform/braiCmd");

    await expect(getBraiCmdState()).resolves.toBeNull();
    await expect(setBraiCmdVoiceOnlyMode(true)).resolves.toBeNull();
    expect(plugin.getState).not.toHaveBeenCalled();
    expect(plugin.setVoiceOnlyMode).not.toHaveBeenCalled();
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
});
