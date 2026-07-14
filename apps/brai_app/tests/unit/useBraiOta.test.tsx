import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBraiOta } from "@/features/app/hooks/useBraiOta";

const ota = vi.hoisted(() => ({
  checkAndroidOtaUpdates: vi.fn(),
  getAndroidOtaState: vi.fn(),
  notifyAndroidOtaReady: vi.fn(),
}));

vi.mock("@/shared/platform/ota", () => ota);
vi.mock("@/shared/platform/platform", () => ({ platformName: () => "android" }));

describe("useBraiOta", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ota.checkAndroidOtaUpdates.mockReset();
    ota.getAndroidOtaState.mockReset();
    ota.notifyAndroidOtaReady.mockReset();
    ota.notifyAndroidOtaReady.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every 250 ms only while a check is active and applies its terminal state", async () => {
    const checking = {
      activeBundleVersion: "0.0.134",
      checkInProgress: true,
      lastCheckStatus: "checking",
      updateAvailable: true,
    };
    const current = {
      activeBundleVersion: "0.0.134",
      checkInProgress: false,
      lastCheckStatus: "up_to_date",
      updateAvailable: false,
    };
    ota.getAndroidOtaState
      .mockResolvedValueOnce(checking)
      .mockResolvedValueOnce(checking)
      .mockResolvedValueOnce(current)
      .mockResolvedValue(current);

    const { result } = renderHook(() => useBraiOta());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.otaState).toEqual(checking);
    expect(ota.getAndroidOtaState).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(ota.getAndroidOtaState).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.otaState).toEqual(current);
    expect(ota.getAndroidOtaState).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(ota.getAndroidOtaState).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(ota.getAndroidOtaState).toHaveBeenCalledTimes(5);
  });
});
