import { beforeEach, describe, expect, it } from "vitest";
import { initialOnboardingState, isValidOnboardingName, loadOnboardingState, ONBOARDING_STORAGE_KEY, saveOnboardingState, stepProgress } from "@/features/onboarding/onboardingModel";

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

  it("migrates the removed features screen to floating buttons", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      ...initialOnboardingState,
      history: ["setup-start", "features"],
      step: "features",
    }));

    expect(loadOnboardingState()).toMatchObject({
      history: ["setup-start", "floating-buttons"],
      step: "floating-buttons",
    });
  });

  it("migrates legacy floating button demo steps", () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      ...initialOnboardingState,
      history: ["floating-buttons", "demo-dictation", "demo-save-screen", "demo-chat-reply"],
      step: "demo-agent-command",
    }));

    expect(loadOnboardingState()).toMatchObject({
      history: ["floating-buttons", "demo-main-dictation", "demo-screenshot-inbox", "demo-context-reply"],
      step: "demo-screenshot-voice",
    });
  });

  it("accepts letters from any alphabet, numbers and spaces in names", () => {
    expect(isValidOnboardingName("Я1")).toBe(true);
    expect(isValidOnboardingName("李 明")).toBe(true);
    expect(isValidOnboardingName("Él")).toBe(true);
    expect(isValidOnboardingName("A")).toBe(false);
    expect(isValidOnboardingName("A!")).toBe(false);
    expect(isValidOnboardingName("  ")).toBe(false);
  });

  it("returns monotonic progress for later steps", () => {
    expect(stepProgress("notifications")).toBeGreaterThan(stepProgress("start"));
    expect(stepProgress("overlay")).toBeGreaterThan(stepProgress("microphone"));
    expect(stepProgress("notifications")).toBeGreaterThan(stepProgress("accessibility-enable"));
    expect(stepProgress("voice-ready")).toBeGreaterThan(stepProgress("notifications"));
  });
});
