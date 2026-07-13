import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { braiCmdSettingsSnapshot, cmdPlugin, openProfileMenuItem, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

// Regression: ISSUE-006 — ответ проверки старой модели применялся после выбора новой.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Brai CMD model check races", () => {
  setupBraiAppTest();

  it("does not connect a settings model that the user changed during its check", async () => {
    stubAndroidCapacitor();
    cmdPlugin.probeProvider.mockResolvedValueOnce({ ok: true, message: "Выберите модель", models: ["model-a", "model-b"] });
    const connect = deferred<{ ok: boolean; message: string; state: ReturnType<typeof braiCmdSettingsSnapshot> }>();
    cmdPlugin.connectProvider.mockReturnValueOnce(connect.promise);
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    const speechCard = (await screen.findByText("Распознавание речи")).closest("[data-slot=card]") as HTMLElement;
    fireEvent.click(speechCard.querySelector("button")!);
    fireEvent.click(screen.getByText("Свой API-ключ"));
    fireEvent.change(screen.getByLabelText("API ключ"), { target: { value: "valid-test-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить подключение" }));
    const model = await screen.findByRole("combobox", { name: "Модель" });
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "model-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "model-b" }));
    const connectedTitlesBefore = screen.queryAllByText("Подключено").length;

    const oldState = braiCmdSettingsSnapshot();
    oldState.settings.transcriptionMode = "key";
    oldState.settings.transcriptionModel = "model-a";
    await act(async () => connect.resolve({ ok: true, message: "Подключено", state: oldState }));

    expect(screen.queryAllByText("Подключено")).toHaveLength(connectedTitlesBefore);
    expect(screen.getByRole("button", { name: "Подключить" })).toBeEnabled();
  });

  it("does not advance onboarding after the selected model changes during its check", async () => {
    stubAndroidCapacitor();
    cmdPlugin.probeProvider.mockResolvedValueOnce({ ok: true, message: "Выберите модель", models: ["model-a", "model-b"] });
    const connect = deferred<{ ok: boolean; message: string }>();
    cmdPlugin.connectProvider.mockReturnValueOnce(connect.promise);
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
    const model = await screen.findByRole("combobox", { name: "Модель распознавания" });
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "model-a" }));
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    fireEvent.click(model);
    fireEvent.click(await screen.findByRole("option", { name: "model-b" }));
    await act(async () => connect.resolve({ ok: true, message: "Подключено" }));

    expect(screen.queryByText("Микрофон")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить" })).toBeEnabled();
  });
});
