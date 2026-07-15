import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cmdPlugin, openProfileMenuItem, selectBraiCmdGroup, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

// Regression: ISSUE-004 — поздний ответ проверки одного поставщика подтверждал уже выбранного другого.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Brai CMD stale provider checks", () => {
  setupBraiAppTest();

  it("ignores a settings probe after the user changes provider", async () => {
    stubAndroidCapacitor();
    const probe = deferred<{ ok: boolean; message: string; models: string[] }>();
    cmdPlugin.probeProvider.mockReturnValueOnce(probe.promise);
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    await selectBraiCmdGroup("Распознавание");
    const speechCard = (await screen.findByText("Распознавание речи")).closest("[data-slot=card]") as HTMLElement;
    fireEvent.click(speechCard.querySelector("button")!);
    fireEvent.click(screen.getByText("Свой API-ключ"));
    fireEvent.change(screen.getByLabelText("API ключ"), { target: { value: "valid-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить подключение" }));

    fireEvent.click(screen.getByRole("combobox", { name: "Поставщик" }));
    fireEvent.click(await screen.findByRole("option", { name: "Groq" }));
    await act(async () => probe.resolve({ ok: true, message: "OpenAI готов", models: ["gpt-4o-transcribe"] }));

    expect(screen.queryByText("Выберите модель")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Модель")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить подключение" })).toBeEnabled();
  });

  it("ignores an onboarding probe after the user changes provider", async () => {
    stubAndroidCapacitor();
    const probe = deferred<{ ok: boolean; message: string; models: string[] }>();
    cmdPlugin.probeProvider.mockReturnValueOnce(probe.promise);
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
    fireEvent.click(screen.getByRole("combobox", { name: "Поставщик" }));
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));
    await act(async () => probe.resolve({ ok: true, message: "Groq готов", models: ["whisper-large-v3"] }));

    expect(screen.queryByRole("combobox", { name: "Модель распознавания" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить" })).toBeEnabled();
  });
});
