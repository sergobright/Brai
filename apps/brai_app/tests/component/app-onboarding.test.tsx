import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { androidCapabilitiesPlugin, cmdPlugin, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import RootLayout from "@/app/layout";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

function runAppInitScript() {
  const markup = renderToStaticMarkup(<RootLayout><main /></RootLayout>);
  const appInitScript = /<script>([\s\S]*?)<\/script>/.exec(markup)?.[1] ?? "";
  new Function(appInitScript)();
}

describe("BraiApp onboarding", () => {
  setupBraiAppTest();
  afterEach(() => vi.useRealTimers());

  it("shows the commissioning start screen before the normal shell on a fresh install", async () => {
    vi.useFakeTimers();
    stubAndroidCapacitor();
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    window.localStorage.setItem("brai_theme_mode", "light");
    document.documentElement.dataset.theme = "light";

    runAppInitScript();

    expect(document.documentElement.dataset.theme).toBe("dark");

    render(<BraiApp />);

    const logo = screen.getByRole("img", { name: "Brai" });
    expect(document.querySelector("[data-startup-splash]")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-startup-logo]")).toHaveLength(1);
    expect(document.querySelector("[data-startup-logo]")).toHaveStyle({ animation: "brai-startup-logo-fade 1000ms linear both" });
    const startButtonContainer = screen.getByRole("button", { name: "Приступить" }).parentElement;
    expect(startButtonContainer).toHaveStyle({ opacity: "0" });

    act(() => vi.advanceTimersByTime(2999));
    expect(startButtonContainer).toHaveStyle({ opacity: "0" });

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name: "Приступить" })).toBeInTheDocument();
    expect(startButtonContainer).toHaveStyle({
      animation: "brai-onboarding-start-button 300ms ease-out both",
    });
    expect(document.querySelector("[data-startup-logo]")).toBe(logo.closest("[data-startup-logo]"));
    vi.useRealTimers();
    expect(screen.queryByText("ВВОД В ЭКСПЛУАТАЦИЮ")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
  });

  it("shows the normal shell instead of onboarding on fresh browser web", async () => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    window.localStorage.setItem("brai_theme_mode", "light");
    document.documentElement.dataset.theme = "dark";

    runAppInitScript();

    expect(document.documentElement.dataset.theme).toBe("light");

    render(<BraiApp />);

    expect(await screen.findByRole("heading", { name: "Действия" })).toBeInTheDocument();
    expect(document.querySelector("[data-app-shell]")).toBeInTheDocument();
    expect(document.querySelector("[data-onboarding-flow]")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Приступить" })).not.toBeInTheDocument();
  });

  it("renders the first welcome cards without carousel arrow buttons", async () => {
    vi.useFakeTimers();
    stubAndroidCapacitor();
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    const { container } = render(<BraiApp />);

    act(() => vi.advanceTimersByTime(3000));
    const startButton = screen.getByRole("button", { name: "Приступить" });
    vi.useRealTimers();
    fireEvent.click(startButton);
    expect(screen.getByText("Brai рядом с вашим экраном")).toBeInTheDocument();
    expect(screen.getByText("Голос превращается в действие")).toBeInTheDocument();
    expect(screen.getByText("Идеи не теряются")).toBeInTheDocument();
    expect(screen.getByText("Пора настроить основу")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="carousel-content"]')).toHaveClass("h-full");
    expect(container.querySelector('[data-slot="carousel-content"] > div')).toHaveClass("-ml-4", "h-full", "w-full", "touch-pan-y");
    expect(screen.getByText("Карточка 1 из 4").closest('[data-slot="carousel-item"]')).toHaveClass("h-full", "pl-4");
    expect(screen.getByText("Карточка 1 из 4").closest('[data-slot="card"]')).toHaveClass("h-full", "w-full", "overflow-hidden");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать" })).not.toBeInTheDocument();
  });

  it("shows the start button on the fourth welcome card", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["start"],
      name: "",
      path: null,
      profileVersion: null,
      step: "welcome-4",
      voiceMode: null,
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    expect(screen.getByText("Как запускаем Brai?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Начать с начала/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Есть профиль/ })).toBeInTheDocument();
  });

  it("keeps the logo splash above a synchronously restored onboarding step", () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["voice-intro"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "voice-choice",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(document.querySelector("[data-startup-splash] img[alt='Brai']")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-startup-logo]")).toHaveLength(1);
    expect(screen.getByText("Как распознавать голос?")).toBeInTheDocument();
  });

  it("keeps unauthenticated users inside the limited access screen", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: [],
      name: "Test",
      path: "new",
      profileVersion: null,
      step: "locked",
      voiceMode: "provider",
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Нужен вход")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Настройки Brai CMD" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
  });

  it("offers cloud and local voice recognition for a new setup", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: [],
      name: "Test",
      path: "new",
      profileVersion: "self-hosted",
      step: "voice-choice",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Как распознавать голос?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Облачный модуль/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Локальная модель/ })).toBeInTheDocument();
  });

  it("uses a select for provider choice and mutes provider testing until the key is entered", async () => {
    stubAndroidCapacitor();
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

    expect(await screen.findByRole("combobox", { name: "Поставщик" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Проверить" })).toBeDisabled();
  });

  it("offers app settings after microphone permission is denied", async () => {
    stubAndroidCapacitor();
    androidCapabilitiesPlugin.requestMicrophone.mockResolvedValueOnce({ microphoneGranted: false });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["accessibility-enable"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "microphone",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Разрешить микрофон" }));
    expect(await screen.findByRole("button", { name: "Открыть настройки приложения" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ошибка" })).toBeDisabled();
  });

  it("offers app settings after notification permission is denied", async () => {
    stubAndroidCapacitor();
    androidCapabilitiesPlugin.requestNotifications.mockResolvedValueOnce({ notificationsGranted: false });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["microphone"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "notifications",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Разрешить уведомления" }));
    expect(await screen.findByRole("button", { name: "Открыть настройки приложения" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ошибка" })).toBeDisabled();
  });

  it("keeps the context floating button disabled until the final voice screen", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["accessibility-enable"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "microphone",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Микрофон")).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: false });
  });

  it("keeps the context floating button hidden until the cabinet opens", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["training-storage"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "voice-ready",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Голосовое управление настроено")).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("keeps dictation enabled and context hidden after skipping voice training", async () => {
    stubAndroidCapacitor();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["notifications"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "training-start",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Пропустить" }));
    expect(await screen.findByText("Нужен вход")).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(cmdPlugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Test" }));
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true });
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("opens the cabinet and enables context after skipping when already signed in", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["notifications"],
      name: "Test",
      path: "existing",
      profileVersion: "cloud",
      step: "training-start",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Пропустить" }));
    expect(await screen.findByRole("heading", { name: "Действия" })).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it("temporarily enables only the training overlay after native access is ready", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["notifications"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "training-start",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Обучение" }));

    await waitFor(() => expect(cmdPlugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Test" }));
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByRole("textbox", { name: "Результат голосового ввода" })).toBeInTheDocument();
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("does not leave cloud login after a failed password request", async () => {
    stubAndroidCapacitor();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["profile-version"],
      name: "Test",
      path: "existing",
      profileVersion: "cloud",
      step: "cloud-password",
      voiceMode: null,
    }));

    render(<BraiApp />);

    fireEvent.change(await screen.findByLabelText("Пароль"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByText("Пароль не подошел. Проверьте его и попробуйте снова.")).toBeInTheDocument();
    expect(screen.getByText("Вход в облачный профиль")).toBeInTheDocument();
    expect(screen.queryByText("Начинаем настройку")).not.toBeInTheDocument();
  });

  it("keeps a completed onboarding locked when cabinet login fails", async () => {
    stubAndroidCapacitor();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: true,
      history: ["login-check"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "locked",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }, { timeout: 5_000 }));
    fireEvent.change(await screen.findByLabelText("Пароль"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true });
    expect(screen.getByLabelText("Пароль")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("enables context only after the final login opens the cabinet", async () => {
    stubAndroidCapacitor();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({ authenticated: true, user: { id: "test-user", name: "Test" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: true,
      history: ["login-check"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "locked",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }, { timeout: 5_000 }));
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
    fireEvent.change(await screen.findByLabelText("Пароль"), { target: { value: "correct" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByRole("heading", { name: "Действия" })).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
  });

  it("does not run a fake check on the cloud privacy screen", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["voice-choice"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "cloud-privacy",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Приватность облака")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Проверить" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(await screen.findByText("Поверх других приложений")).toBeInTheDocument();
  });

  it("checks overlay permission before continuing", async () => {
    stubAndroidCapacitor();
    androidCapabilitiesPlugin.getState
      .mockResolvedValueOnce({ overlayGranted: false })
      .mockImplementationOnce(() => new Promise((resolve) => window.setTimeout(() => resolve({ overlayGranted: false }), 20)))
      .mockImplementationOnce(() => new Promise((resolve) => window.setTimeout(() => resolve({ overlayGranted: true }), 20)));
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["cloud-privacy"],
      name: "Test",
      path: "new",
      profileVersion: "cloud",
      step: "overlay",
      voiceMode: "cloud",
    }));

    render(<BraiApp />);

    const checkButton = await screen.findByRole("button", { name: "Проверить" });
    expect(checkButton).toBeEnabled();
    expect(screen.queryByText("Готово")).not.toBeInTheDocument();
    fireEvent.click(checkButton);
    expect(screen.getByRole("button", { name: "Проверка" })).toBeDisabled();
    expect(await screen.findByText("Разрешение поверх экрана еще не включено.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ошибка" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Проверить" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(await screen.findByRole("button", { name: "Продолжить" })).toBeInTheDocument();
  });

  it("delays manual accessibility confirmation after opening settings", async () => {
    vi.useFakeTimers();
    try {
      stubAndroidCapacitor();
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
        complete: false,
        history: ["accessibility-why"],
        name: "Test",
        path: "new",
        profileVersion: "cloud",
        step: "accessibility-blocked",
        voiceMode: "cloud",
      }));

      render(<BraiApp />);
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      const confirmButton = screen.getByRole("button", { name: "Да, доступ заблокирован" });
      expect(confirmButton).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
      expect(confirmButton).toBeDisabled();
      act(() => vi.advanceTimersByTime(2999));
      expect(confirmButton).toBeDisabled();
      act(() => vi.advanceTimersByTime(1));
      expect(confirmButton).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not pass voice training from manually typed text", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["training-start"],
      name: "Test",
      path: "new",
      profileVersion: "self-hosted",
      step: "training-dictate",
      voiceMode: "local",
    }));

    render(<BraiApp />);

    const input = await screen.findByRole("textbox", { name: "Результат голосового ввода" });
    fireEvent.change(input, { target: { value: "ручной текст" } });
    expect(screen.getByRole("button", { name: "Да, вставилось" })).toBeDisabled();
  });
});
