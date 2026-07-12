import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { braiCmdSettingsSnapshot, cmdPlugin, openEngineFromProfile, openProfileMenu, openProfileMenuItem, openSettingsFromProfile, otaPlugin, setupBraiAppTest, stubAndroidCapacitor, testVersionState } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";

describe("BraiApp settings", () => {
  setupBraiAppTest();

  it("keeps Settings separate from update state", async () => {
    render(<BraiApp />);

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
    render(<BraiApp />);

    await openEngineFromProfile();

    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Текущая OTA-версия unknown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить обновления" })).toBeInTheDocument();
  });

  it("keeps Engine available in the mobile profile drawer outside Actions", async () => {
    render(<BraiApp initialSection="inbox" />);

    await openEngineFromProfile();

    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();
  });

  it("opens the Brai Cmd section outside Android", async () => {
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Brai CMD" })).toBeInTheDocument());
    expect(screen.getByText("Настройки Brai CMD доступны в Android-приложении Brai.")).toBeInTheDocument();
    expect(cmdPlugin.openSettings).not.toHaveBeenCalled();
  });

  it("opens the Brai Cmd WebView settings inside Android", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Brai CMD" })).toBeInTheDocument());
    expect(screen.getAllByRole("heading", { name: "Brai CMD" })).toHaveLength(1);
    expect(screen.getByText("Главная кнопка диктовки")).toBeInTheDocument();
    expect(screen.getByText("Разрешения")).toBeInTheDocument();
    expect(screen.getByText("Проверка связи")).toBeInTheDocument();
    expect(cmdPlugin.getSettings).toHaveBeenCalledTimes(1);
    expect(cmdPlugin.openSettings).not.toHaveBeenCalled();
  });

  it("toggles the main dictation button through the native overlay flag", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    await screen.findByText("Главная кнопка диктовки");

    cmdPlugin.setOverlayEnabled.mockClear();
    cmdPlugin.setOverlayEnabled.mockResolvedValueOnce({ overlayEnabled: false });
    fireEvent.click(screen.getByRole("switch", { name: "Переключатель активен" }));

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: false }));
  });

  it("shows connection test results as visible status alerts", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    fireEvent.click(await screen.findByRole("button", { name: "Тест" }));

    expect(await screen.findByText("Всё работает")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("text-emerald-700");

    cmdPlugin.testConnection.mockResolvedValueOnce({ ok: false, message: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Тест" }));

    expect(await screen.findByText("Подключение не работает")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("text-destructive");
  });

  it("uses a radio group and numeric text input for audio retention", async () => {
    stubAndroidCapacitor();
    const processedSnapshot = braiCmdSettingsSnapshot();
    processedSnapshot.settings.processedAudioRetentionEnabled = true;
    processedSnapshot.settings.processedAudioRetentionLimit = 25;
    cmdPlugin.updateSettings.mockResolvedValueOnce(processedSnapshot);
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    fireEvent.click(await screen.findByRole("button", { name: "Аудиозаписи" }));

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Хранить больше аудиозаписей"));

    const input = await screen.findByLabelText("Сколько аудиозаписей хранить?");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "numeric");

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.blur(input);

    await waitFor(() => expect(cmdPlugin.updateSettings).toHaveBeenCalledWith({ patch: { processedAudioRetentionLimit: 1 } }));
  });

  it("uses larger rows in the mobile menu that contains Brai Cmd", async () => {
    render(<BraiApp />);

    const drawer = await openProfileMenu();

    for (const name of ["Настройки", "Архив", "Выйти", "Brai Cmd", "Engine"]) {
      expect(within(drawer).getByRole("button", { name })).toHaveClass("h-12", "text-base");
    }
  });

  it("marks Engine when a newer ledger version is available", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.11")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });

    render(<BraiApp />);

    await waitFor(() => {
      const engineButton = screen.getByRole("button", { name: "Engine" });
      expect(engineButton.querySelector(".lucide-download")).toBeInTheDocument();
    });
  });

  it("shows when an Android OTA update is ready for restart", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      candidateBundleVersion: "0.0.11",
      lastCheckStatus: "candidate_ready_for_next_start",
    });

    render(<BraiApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText("OTA-версия 0.0.11 загружена")).toBeInTheDocument());
    expect(screen.getAllByText("Закройте приложение, чтобы новая версия применилась.").length).toBeGreaterThan(0);
  });

  it("shows Android OTA download progress", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      downloadProgressPercent: 66,
      downloadProgressVersion: "0.0.11",
      checkInProgress: true,
      lastCheckStatus: "downloading",
    });

    render(<BraiApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText("Загрузка OTA-версии 0.0.11")).toBeInTheDocument());
    expect(screen.getByText("66%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "66");
  });

  it.each([
    ["Software caused connection abort", "Обновление не установилось. Связь оборвалась во время скачивания. Проверь интернет и попробуй еще раз."],
    [
      "/data/user/0/world.brightos.brai/cache/brai-ota-downloads/0.0.11.zip: open failed: ENOENT (No such file or directory)",
      "Обновление не установилось. Скачанный файл обновления пропал из памяти телефона. Запусти проверку еще раз.",
    ],
  ])("shows a readable Android OTA error for %s", async (lastUpdateError, message) => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      lastCheckStatus: "check_failed",
      lastUpdateError,
    });

    render(<BraiApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText(message)).toBeInTheDocument());
    expect(screen.queryByText(/Software caused connection abort|ENOENT|\/data\/user/)).not.toBeInTheDocument();
  });

  it("keeps the app usable when the installed APK cannot apply the next OTA", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      fallbackBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      targetApkVersion: "2",
      nativeEnvironment: "preview-a",
      nativePreviewSlot: "A",
      nativeOtaChannel: "a.test.brai.one/mobile-update",
      lastCheckStatus: "apk_required",
    });

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Установленный APK не подходит для этой версии" })).not.toBeInTheDocument();

    await openEngineFromProfile();

    expect(screen.getByText("Нужен новый APK")).toBeInTheDocument();
    expect(screen.getByText(/Требуется APK v2/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Открыть APK-релизы" })).toHaveAttribute("href", "https://a.test.brai.one/releases/");
  });

  it("shows production APK requirements only inside Engine", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      nativeApkVersion: "1",
      nativeVersionName: "1",
      targetApkVersion: "2",
      nativeEnvironment: "prod",
      lastCheckStatus: "apk_required",
    });

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());

    await openEngineFromProfile();

    expect(screen.getByText("Нужен новый APK")).toBeInTheDocument();
    expect(screen.getByText(/Требуется APK v2/)).toBeInTheDocument();
  });

  it("starts an Android OTA check from Engine", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);
    await openEngineFromProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(otaPlugin.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("OTA-версия 0.0.11 загружена")).toBeInTheDocument();
  });

  it("returns from Settings through the Android back bridge", async () => {
    render(<BraiApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });
});
