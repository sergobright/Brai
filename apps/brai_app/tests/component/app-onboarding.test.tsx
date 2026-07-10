import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { androidCapabilitiesPlugin, cmdPlugin, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";

describe("BraiApp onboarding", () => {
  setupBraiAppTest();

  it("shows the commissioning start screen before the normal shell on a fresh install", async () => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    render(<BraiApp />);

    expect(await screen.findByRole("button", { name: "Приступить" })).toBeInTheDocument();
    expect(screen.queryByText("ВВОД В ЭКСПЛУАТАЦИЮ")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
  });

  it("renders the first welcome cards without carousel arrow buttons", async () => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);

    const { container } = render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Приступить" }));
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

  it("shows the logo splash before restoring an unfinished onboarding step", async () => {
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

    expect(screen.getByAltText("Brai")).toBeInTheDocument();
    expect(screen.queryByText("Как распознавать голос?")).not.toBeInTheDocument();
    expect(await screen.findByText("Как распознавать голос?")).toBeInTheDocument();
  });

  it("keeps unauthenticated users inside the limited access screen", async () => {
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
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("keeps the context floating button hidden after skipping voice training", async () => {
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
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: false }));
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
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

    fireEvent.click(await screen.findByRole("button", { name: "Обучение" }));

    await waitFor(() => expect(cmdPlugin.ensureAccess).toHaveBeenCalledWith({ displayName: "Test" }));
    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(await screen.findByRole("textbox", { name: "Результат голосового ввода" })).toBeInTheDocument();
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  });

  it("does not leave cloud login after a failed password request", async () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(await screen.findByLabelText("Пароль"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: false }));
    expect(screen.getByLabelText("Пароль")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
    expect(cmdPlugin.setOverlayEnabled).not.toHaveBeenCalledWith({ enabled: true });
  });

  it("does not run a fake check on the cloud privacy screen", async () => {
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
