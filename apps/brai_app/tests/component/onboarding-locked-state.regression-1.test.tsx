import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setupBraiAppTest } from "./app-test-support";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { loadOnboardingState, ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

// Regression: ISSUE-015 — экран выхода был locked только в памяти и пропадал при промежуточном connecting.
// Found by /qa on 2026-07-13
// Report: exhaustive Brai CMD follow-up QA
describe("locked onboarding persistence", () => {
  setupBraiAppTest();

  it("persists the locked step when a completed user becomes unauthorized", async () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: true,
      history: [],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "login-check",
      voiceMode: "cloud",
    }));

    render(<OnboardingFlow
      authMode="email"
      authRequired
      busy={false}
      onDone={vi.fn()}
      onEmailLogin={vi.fn(async () => undefined)}
      onOpenEngine={vi.fn()}
      onOpenNativeCmdSettings={vi.fn(async () => true)}
      onRequestOtp={vi.fn(async () => ({ ok: true, message: "ok" }))}
      onStartupScreenChange={vi.fn()}
      onVerifyOtp={vi.fn(async () => undefined)}
      startupIntroComplete
    />);

    expect(await screen.findByText("Нужен вход")).toBeInTheDocument();
    await waitFor(() => expect(loadOnboardingState().step).toBe("locked"));
  });
});
