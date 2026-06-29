import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openEngineFromProfile, openSettingsFromProfile, otaPlugin, setupBrightOsAppTest, stubAndroidCapacitor, testVersionState } from "./app-test-support";
import { BrightOsApp } from "@/features/app/BrightOsApp";

describe("BrightOsApp settings", () => {
  setupBrightOsAppTest();

  it("keeps Settings separate from update state", async () => {
    render(<BrightOsApp />);

    await openSettingsFromProfile();

    expect(screen.queryByRole("heading", { name: "Синхронизация" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Включить темную тему" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Акценты" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /открыть выбор цвета/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Обновление" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Архив" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Сессия" })).not.toBeInTheDocument();
    expect(screen.queryByText("APK")).not.toBeInTheDocument();
  });

  it("opens Engine from the profile menu", async () => {
    render(<BrightOsApp />);

    await openEngineFromProfile();

    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Engine v0.0.10.1" })).toBeInTheDocument();
    expect(screen.getByText("Журнал версий")).toBeInTheDocument();
  });

  it("keeps Engine available in the mobile profile drawer outside Actions", async () => {
    render(<BrightOsApp initialSection="inbox" />);

    await openEngineFromProfile();

    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();
  });

  it("marks Engine when a newer ledger version is available", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.11.1")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });

    render(<BrightOsApp />);

    const engineButton = await screen.findByRole("button", { name: "Engine v0.0.11.1" });
    expect(engineButton.querySelector(".lucide-download")).toBeInTheDocument();
  });

  it("shows when an Android OTA update is ready for restart", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10.1",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      candidateBundleVersion: "0.0.11.1",
      lastCheckStatus: "candidate_ready_for_next_start",
    });

    render(<BrightOsApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText("Обновление скачано. Закрой и открой приложение.")).toBeInTheDocument());
    expect(screen.getByText("0.0.11.1")).toBeInTheDocument();
    expect(screen.getByText("0.0.10.1 (1)")).toBeInTheDocument();
  });

  it.each([
    ["Software caused connection abort", "Обновление не установилось. Связь оборвалась во время скачивания. Проверь интернет и попробуй еще раз."],
    [
      "/data/user/0/world.brightos.bright_os_client/cache/bright-ota-downloads/0.0.11.1.zip: open failed: ENOENT (No such file or directory)",
      "Обновление не установилось. Скачанный файл обновления пропал из памяти телефона. Запусти проверку еще раз.",
    ],
  ])("shows a readable Android OTA error for %s", async (lastUpdateError, message) => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10.1",
      lastCheckStatus: "check_failed",
      lastUpdateError,
    });

    render(<BrightOsApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.queryByText(/Software caused connection abort|ENOENT|\/data\/user/)).not.toBeInTheDocument();
  });

  it("blocks Dev and Preview when the installed APK is incompatible", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10.1.42",
      fallbackBundleVersion: "0.0.10.1.0",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1-a",
      nativeVersionCode: 1,
      nativeEnvironment: "preview-a",
      nativePreviewSlot: "A",
      nativeOtaChannel: "a.test.brightos.world/mobile-update",
      lastCheckStatus: "incompatible",
    });

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Установленный APK не подходит для этой версии" })).toBeInTheDocument());
    expect(screen.getByText("Нужен новый APK")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть APK-релизы" })).toHaveAttribute("href", "https://a.test.brightos.world/releases/");
    expect(screen.queryByRole("heading", { name: "Действия" })).not.toBeInTheDocument();
  });

  it("keeps production incompatible OTA non-blocking", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10.1",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      nativeEnvironment: "prod",
      lastCheckStatus: "incompatible",
    });

    render(<BrightOsApp />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Установленный APK не подходит для этой версии" })).not.toBeInTheDocument();
  });

  it("starts an Android OTA check from Engine", async () => {
    stubAndroidCapacitor();

    render(<BrightOsApp />);
    await openEngineFromProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновление" }));

    await waitFor(() => expect(otaPlugin.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Обновление скачано. Закрой и открой приложение.")).toBeInTheDocument();
    expect(screen.getByText("0.0.11.1")).toBeInTheDocument();
  });

  it("returns from Settings through the Android back bridge", async () => {
    render(<BrightOsApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(window.BrightOsAndroidBack).toBeTypeOf("function"));
    expect(window.BrightOsAndroidBack?.()).toBe(true);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });
});
