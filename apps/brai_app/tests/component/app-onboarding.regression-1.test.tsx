import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cmdPlugin, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

// Regression: ISSUE-003 — пустой список моделей оставлял онбординг без поля ручного ввода.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
describe("Brai CMD onboarding provider regressions", () => {
  setupBraiAppTest();

  it("accepts a manual speech model after a successful empty-list probe", async () => {
    stubAndroidCapacitor();
    cmdPlugin.probeProvider.mockResolvedValueOnce({
      ok: true,
      message: "Введите модель вручную",
      models: [],
      manualModel: true,
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["voice-choice"],
      name: "Test",
      path: "new",
      profileVersion: "self-hosted",
      step: "provider-key",
      voiceMode: "provider",
    }));
    render(<BraiApp />);

    fireEvent.change(await screen.findByLabelText("Ключ поставщика"), { target: { value: "valid-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));

    const manualModel = await screen.findByRole("textbox", { name: "Модель распознавания" });
    fireEvent.change(manualModel, { target: { value: "whisper-large-v3-turbo" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));

    await waitFor(() => expect(cmdPlugin.connectProvider).toHaveBeenCalledWith({ provider: {
      providerId: "groq",
      apiKey: "valid-test-key",
      model: "whisper-large-v3-turbo",
      capability: "speech",
    } }));
  });
});
