import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openSettingsFromProfile, otaPlugin, setupBrightOsAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BrightOsApp } from "@/features/app/BrightOsApp";

describe("BrightOsApp settings", () => {
  setupBrightOsAppTest();

  it("keeps Settings focused on update state instead of duplicate sync", async () => {
    render(<BrightOsApp />);

    await openSettingsFromProfile();

    expect(screen.queryByRole("heading", { name: "Синхронизация" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить темную тему" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Акценты" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /открыть выбор цвета/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Обновление" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Архив" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Сессия" })).not.toBeInTheDocument();
    expect(screen.getByText("APK")).toBeInTheDocument();
    expect(screen.getByText("0.0.2.1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
  });

  it("shows when an Android OTA update is ready for restart", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.2.1",
      nativeVersionName: "0.0.2.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      candidateBundleVersion: "0.0.3.1",
      lastCheckStatus: "candidate_ready_for_next_start",
    });

    render(<BrightOsApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(screen.getByText("Обновление скачано. Закрой и открой приложение.")).toBeInTheDocument());
    expect(screen.getByText("0.0.3.1")).toBeInTheDocument();
    expect(screen.getByText("0.0.2.1 (1)")).toBeInTheDocument();
  });

  it.each([
    ["Software caused connection abort", "Обновление не установилось. Связь оборвалась во время скачивания. Проверь интернет и попробуй еще раз."],
    [
      "/data/user/0/world.brightos.bright_os_client/cache/bright-ota-downloads/0.0.3.1.zip: open failed: ENOENT (No such file or directory)",
      "Обновление не установилось. Скачанный файл обновления пропал из памяти телефона. Запусти проверку еще раз.",
    ],
  ])("shows a readable Android OTA error for %s", async (lastUpdateError, message) => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.2.1",
      lastCheckStatus: "check_failed",
      lastUpdateError,
    });

    render(<BrightOsApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.queryByText(/Software caused connection abort|ENOENT|\/data\/user/)).not.toBeInTheDocument();
  });

  it("starts an Android OTA check from Settings", async () => {
    stubAndroidCapacitor();

    render(<BrightOsApp />);
    await openSettingsFromProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновление" }));

    await waitFor(() => expect(otaPlugin.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Обновление скачано. Закрой и открой приложение.")).toBeInTheDocument();
    expect(screen.getByText("0.0.3.1")).toBeInTheDocument();
  });

  it("returns from Settings through the Android back bridge", async () => {
    render(<BrightOsApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(window.BrightOsAndroidBack).toBeTypeOf("function"));
    expect(window.BrightOsAndroidBack?.()).toBe(true);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });
});
