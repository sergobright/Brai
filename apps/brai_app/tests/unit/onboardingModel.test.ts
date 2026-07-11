import { beforeEach, describe, expect, it } from "vitest";
import { initialOnboardingState, loadOnboardingState, ONBOARDING_STORAGE_KEY, saveOnboardingState, stepProgress } from "@/features/onboarding/onboardingModel";

describe("onboarding model", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores and restores commissioning progress", () => {
    saveOnboardingState({
      ...initialOnboardingState,
      step: "voice-choice",
      history: ["start", "welcome-1"],
      path: "new",
      name: "Пользователь",
    });

    expect(loadOnboardingState()).toMatchObject({
      complete: false,
      step: "voice-choice",
      history: ["start", "welcome-1"],
      path: "new",
      name: "Пользователь",
    });
  });

  it("falls back to the first step for broken local data", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "{broken");

    expect(loadOnboardingState()).toEqual(initialOnboardingState);
  });

  it("migrates legacy cloud password onboarding state to cloud login", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["profile-version", "cloud-password"],
      name: "Test",
      path: "existing",
      profileVersion: "cloud",
      step: "cloud-password",
      voiceMode: null,
    }));

    expect(loadOnboardingState()).toMatchObject({
      history: ["profile-version", "cloud-login"],
      step: "cloud-login",
    });
  });

  it("returns monotonic progress for later steps", () => {
    expect(stepProgress("notifications")).toBeGreaterThan(stepProgress("start"));
    expect(stepProgress("voice-ready")).toBeGreaterThan(stepProgress("notifications"));
  });
});
