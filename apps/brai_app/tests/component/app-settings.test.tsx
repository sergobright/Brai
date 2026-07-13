import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { braiCmdSettingsSnapshot, cmdPlugin, openEngineFromProfile, openProfileMenu, openProfileMenuItem, openSettingsFromProfile, otaPlugin, setupBraiAppTest, stubAndroidCapacitor, testVersionState } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";
import { getMeta } from "@/shared/storage/db";

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
    expect(screen.getByRole("heading", { name: "Текущая версия unknown" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скачать обновление" })).toBeInTheDocument();
  });

  it("keeps Engine available in the mobile profile drawer outside Actions", async () => {
    render(<BraiApp initialSection="inbox" />);

    await openEngineFromProfile();

    expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument();
  });

  it("opens the Brai CMD web description outside Android", async () => {
    render(<BraiApp />);

    await openProfileMenuItem("Brai CMD");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Brai CMD" })).toBeInTheDocument());
    expect(await screen.findByText("Настройки Brai CMD доступны в Android-приложении Brai.")).toBeInTheDocument();
    expect(cmdPlugin.openSettings).not.toHaveBeenCalled();
  });

  it("opens the Brai CMD WebView settings inside Android", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai CMD");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Brai CMD" })).toBeInTheDocument());
    expect(screen.getAllByRole("heading", { name: "Brai CMD" })).toHaveLength(1);
    expect(await screen.findByText("Главная кнопка диктовки")).toBeInTheDocument();
    expect(screen.getByText("Разрешения")).toBeInTheDocument();
    expect(screen.getByText("Подключение к Brai")).toBeInTheDocument();
    expect(cmdPlugin.getSettings).toHaveBeenCalledTimes(1);
    expect(cmdPlugin.openSettings).not.toHaveBeenCalled();
  });

  it("toggles only the main dictation setting", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    await screen.findByText("Главная кнопка диктовки");
    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledWith({ token: "authenticated-device-token", displayName: "Test" }));

    cmdPlugin.setOverlayEnabled.mockClear();
    fireEvent.click(screen.getByRole("switch", { name: "Главная кнопка включена" }));

    await waitFor(() => expect(cmdPlugin.updateSettings).toHaveBeenCalledWith({ patch: { mainDictationEnabled: false } }));
    expect(cmdPlugin.setOverlayEnabled).not.toHaveBeenCalled();
  });

  it("asks installations affected by the old onboarding to reconnect once", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: true,
      step: "login-check",
      history: [],
      path: "new",
      profileVersion: "cloud",
      voiceMode: "provider",
      name: "Пользователь",
    }));
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    expect(await screen.findByText("Подключите поставщика заново")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(screen.queryByText("Подключите поставщика заново")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("brai_cmd_provider_reconnect_notice_dismissed")).toBe("true");
  });

  it("shows connection test results as visible status alerts", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    fireEvent.click(await screen.findByRole("button", { name: "Проверить подключение к Brai" }));

    expect(await screen.findByText("ok")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("text-emerald-700");

    cmdPlugin.testConnection.mockResolvedValueOnce({ ok: false, message: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Проверить подключение к Brai" }));

    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass("text-destructive");
  });

  it("shows models only after provider verification and requires a selection", async () => {
    stubAndroidCapacitor();
    const connectedSnapshot = braiCmdSettingsSnapshot();
    connectedSnapshot.settings.providerProfiles = [{ providerId: "openai", configured: true }];
    cmdPlugin.getSettings.mockResolvedValueOnce(connectedSnapshot);
    render(<BraiApp />);

    await openProfileMenuItem("Brai Cmd");
    const speechCard = (await screen.findByText("Распознавание речи")).closest("[data-slot=card]");
    fireEvent.click(within(speechCard as HTMLElement).getByRole("button", { name: "Настроить" }));
    fireEvent.click(screen.getByText("Свой API-ключ"));
    expect(screen.queryByLabelText("Модель")).not.toBeInTheDocument();
    const probeButton = screen.getByRole("button", { name: "Проверить подключение" });
    await waitFor(() => expect(probeButton).toBeEnabled());
    fireEvent.click(probeButton);
    await waitFor(() => expect(cmdPlugin.probeProvider).toHaveBeenCalledWith({ provider: {
      providerId: "openai",
      apiKey: "",
      baseUrl: "",
      capability: "speech",
    } }));
    expect(await screen.findByText("Выберите модель")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("combobox")).toHaveLength(2));
    const modelSelect = screen.getAllByRole("combobox")[1];
    expect(screen.getByRole("button", { name: "Подключить" })).toBeDisabled();
    fireEvent.click(modelSelect);
    fireEvent.click(await screen.findByRole("option", { name: "test-model" }));
    fireEvent.click(screen.getByRole("button", { name: "Подключить" }));

    await waitFor(() => expect(cmdPlugin.connectProvider).toHaveBeenCalledWith({ provider: {
      providerId: "openai",
      apiKey: "",
      model: "test-model",
      baseUrl: "",
      capability: "speech",
    } }));
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

  it("uses the shadcn-space mobile menu with Brai CMD and Engine", async () => {
    render(<BraiApp />);

    const drawer = await openProfileMenu();

    expect(drawer).not.toHaveTextContent("Больше");
    for (const name of ["Профиль", "Архив", "Brai CMD", "Engine", "Настройки", "Выход"]) {
      expect(within(drawer).getByRole("button", { name })).toHaveClass("p-2", "text-sm");
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
      const engineButton = screen.getByRole("button", { name: "Engine, доступно обновление" });
      expect(engineButton.querySelector(".lucide-download")).toBeInTheDocument();
    });
  });

  it("adds the mobile aggregate dot below the three dots without changing button geometry", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.11")), { status: 200, headers: { "content-type": "application/json" } });
      }
      return Promise.reject(new Error("offline"));
    });

    render(<BraiApp />);

    const overflow = await screen.findByRole("button", { name: "Открыть левое меню" });
    await waitFor(() => expect(overflow.querySelector(".bg-amber-400")).toBeInTheDocument());
    expect(overflow).toHaveClass("h-11", "w-11", "max-[860px]:grid");
    expect(overflow.querySelector(".bg-amber-400")?.parentElement).toHaveClass("bottom-0.5", "left-1/2", "-translate-x-1/2", "absolute");
    expect(overflow.querySelector(".lucide-ellipsis")).toHaveClass("h-5", "w-5");

    const drawer = await openProfileMenu();
    const engine = within(drawer).getByRole("button", { name: "Engine" });
    expect(engine.querySelector(".lucide-download")).toBeInTheDocument();
    expect(engine.querySelector(".bg-amber-400")?.parentElement).toHaveClass("bottom-0.5", "right-0.5");
  });

  it("shows when an Android update is ready for restart", async () => {
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

    await waitFor(() => expect(screen.getAllByText(/Обновление 0\.0\.11 скачано/).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "Скачано" })).toBeDisabled();
  });

  it("shows Android update download progress", async () => {
    stubAndroidCapacitor();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.10",
      downloadProgressPercent: 66,
      downloadProgressVersion: "0.0.11",
      activeOperation: "web_download",
      lastCheckStatus: "downloading",
    });

    render(<BraiApp />);
    await openEngineFromProfile();

    await waitFor(() => expect(screen.getByText("Скачивается обновление 0.0.11")).toBeInTheDocument());
    expect(screen.getByText("66%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "66");
  });

  it.each([
    ["Software caused connection abort", "Обновление не установилось. Связь оборвалась во время скачивания. Проверь интернет и попробуй еще раз."],
    [
      "/data/user/0/world.brightos.brai/cache/brai-ota-downloads/0.0.11.zip: open failed: ENOENT (No such file or directory)",
      "Обновление не установилось. Скачанный файл обновления пропал из памяти телефона. Запусти проверку еще раз.",
    ],
  ])("shows a readable Android update error for %s", async (lastUpdateError, message) => {
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

    expect(screen.getByText(/Доступна новая версия приложения\. Для обновления нужен APK v2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скачать APK" })).toBeInTheDocument();
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

    expect(screen.getByText(/Доступна новая версия приложения\. Для обновления нужен APK v2/)).toBeInTheDocument();
  });

  it("discovers before explicitly downloading an Android update", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);
    await openEngineFromProfile();
    fireEvent.click(await screen.findByRole("button", { name: "Проверить обновления" }));

    await waitFor(() => expect(otaPlugin.checkForUpdates).toHaveBeenCalledTimes(1));
    expect(otaPlugin.downloadUpdate).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Скачать обновление" }));
    await waitFor(() => expect(otaPlugin.downloadUpdate).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/Обновление 0\.0\.11 скачано/)).length).toBeGreaterThan(0);
  });

  it("restores preliminary profile and voice-only mode after Android logout", async () => {
    stubAndroidCapacitor();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/auth/logout")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.10")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: true,
      history: [],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "login-check",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    await screen.findByRole("heading", { name: "Действия" });
    await openProfileMenuItem("Выход");

    expect(await screen.findByText("Нужен вход")).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.preparePreliminaryProfile).toHaveBeenCalledWith({ displayName: "Test" }));
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true });
    expect(cmdPlugin.setQueuePausedMode).toHaveBeenCalledWith({ enabled: false });
    await waitFor(async () => expect(await getMeta("currentUserId")).toBe("preliminary:prelim-test-user"));
    expect(JSON.parse(window.localStorage.getItem(ONBOARDING_STORAGE_KEY) ?? "{}")).toMatchObject({
      preliminaryUserId: "prelim-test-user",
      preliminaryClaimToken: "prelim-claim-token",
    });

    fireEvent.click(screen.getByRole("button", { name: "Настройки Brai CMD" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Brai CMD" })).toBeInTheDocument());
    expect(document.querySelector("[data-standalone-section]")).toBeInTheDocument();
    expect(document.querySelector("[data-app-shell]")).not.toBeInTheDocument();
    expect(await screen.findByText("Главная кнопка диктовки")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(await screen.findByText("Нужен вход")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument());
    expect(document.querySelector("[data-standalone-section]")).toBeInTheDocument();
    expect(document.querySelector("[data-app-shell]")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить обновления" })).toBeInTheDocument();
  });

  it("returns from Settings through the Android back bridge", async () => {
    render(<BraiApp />);
    await openSettingsFromProfile();

    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });
});
