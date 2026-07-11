import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { androidCapabilitiesPlugin, cmdPlugin, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import RootLayout from "@/app/layout";
import { BraiApp } from "@/features/app/BraiApp";
import { ONBOARDING_STORAGE_KEY } from "@/features/onboarding/onboardingModel";
import { emptyActivitiesState } from "@/shared/types/activities";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyGoal, emptyHistory, emptyTimerState } from "@/shared/types/timer";

const SNAPSHOT_NOW = new Date("2026-07-01T10:00:00.000Z");

function runAppInitScript() {
  const markup = renderToStaticMarkup(<RootLayout><main /></RootLayout>);
  const appInitScript = /<script>([\s\S]*?)<\/script>/.exec(markup)?.[1] ?? "";
  new Function(appInitScript)();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyAppSnapshotResponse(url: string): Response | null {
  if (url.endsWith("/v1/timer/state")) return jsonResponse({ ...emptyTimerState(SNAPSHOT_NOW), server_revision: 1 });
  if (url.endsWith("/v1/sessions")) return jsonResponse(emptyHistory());
  if (url.endsWith("/v1/goals/challenge")) return jsonResponse(emptyGoal());
  if (url.endsWith("/v1/activities")) {
    const state = emptyActivitiesState(SNAPSHOT_NOW);
    return jsonResponse({
      server_time_utc: state.server_time_utc,
      server_revision: 1,
      activities: state.actions,
      archived_activities: state.archived_actions,
    });
  }
  if (url.endsWith("/v1/inbox")) return jsonResponse({ ...emptyInboxState(SNAPSHOT_NOW), server_revision: 1 });
  return null;
}

async function submitEmailLogin(email: string) {
  const input = await screen.findByLabelText("Email");
  fireEvent.change(input, { target: { value: email } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

function expectNoPasswordPrompt() {
  expect(screen.queryByLabelText("Пароль")).not.toBeInTheDocument();
  expect(screen.queryByText(/пароль/i)).not.toBeInTheDocument();
  expect(document.querySelector('input[type="password"]')).not.toBeInTheDocument();
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
    expect(screen.getByText("А что, если исполнитель желаний существует?")).toBeInTheDocument();
    expect(screen.getByText("Тебе достаточно сказать, чего ты хочешь")).toBeInTheDocument();
    expect(screen.getByText("У него только одна цель")).toBeInTheDocument();
    expect(screen.getByText("Он не просто советует")).toBeInTheDocument();
    expect(screen.getByText("Вся твоя жизнь — в одном разуме")).toBeInTheDocument();
    expect(screen.getByText("Твой исполнитель желаний уже здесь")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="card"] img')).toHaveLength(6);
    expect(container.querySelector('[data-slot="carousel-content"]')).toHaveClass("h-full");
    expect(container.querySelector('[data-slot="carousel-content"] > div')).toHaveClass("!ml-0", "h-full", "w-full", "touch-pan-y", "gap-4");
    expect(screen.getByText("А что, если исполнитель желаний существует?").closest('[data-slot="carousel-item"]')).toHaveClass("h-full", "!pl-0");
    expect(screen.getByText("А что, если исполнитель желаний существует?").closest('[data-slot="card"]')).toHaveClass("h-full", "w-full", "overflow-hidden");
    expect(screen.queryByText(/Карточка \d из 6/)).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Начать" })).not.toBeInTheDocument();
  });

  it("shows the start button on the sixth welcome card", async () => {
    vi.useFakeTimers();
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["start"],
      name: "",
      path: null,
      profileVersion: null,
      step: "welcome-6",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(screen.queryByRole("button", { name: "Начать" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.queryByRole("button", { name: "Начать" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    expect(screen.getByText("Как запускаем Brai?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /С чистого листа/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Есть профиль/ })).toBeInTheDocument();
  });

  it("keeps self-hosted profiles unavailable and marks them as in development", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["path"],
      name: "",
      path: "existing",
      profileVersion: null,
      step: "profile-version",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(await screen.findByRole("button", { name: /Облачная версия/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Self-hosted версия/ })).toBeDisabled();
    expect(screen.getByText("В разработке")).toBeInTheDocument();
  });

  it("autofocuses the name and enables continuation only for a valid value", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["path"],
      name: "",
      path: "new",
      profileVersion: "self-hosted",
      step: "name",
      voiceMode: null,
    }));

    render(<BraiApp />);

    const input = await screen.findByRole("textbox", { name: "Имя" });
    const continueButton = screen.getByRole("button", { name: "Продолжить" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("placeholder", "Только буквы и пробел");
    expect(continueButton).toBeDisabled();
    fireEvent.change(input, { target: { value: "А!" } });
    expect(continueButton).toBeDisabled();
    fireEvent.change(input, { target: { value: "А1" } });
    expect(continueButton).toBeEnabled();
  });

  it("moves from the Brai CMD introduction to floating buttons", async () => {
    stubAndroidCapacitor();
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify({
      complete: false,
      history: ["name"],
      name: "Брай",
      path: "new",
      profileVersion: "self-hosted",
      step: "setup-start",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Brai CMD")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(await screen.findByText("Плавающие кнопки")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ознакомиться" })).toBeInTheDocument();
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
    expect(screen.getByText("Как распознавать голос")).toBeInTheDocument();
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

    expect(await screen.findByText("Как распознавать голос")).toBeInTheDocument();
    const choices = screen.getAllByRole("button").filter((button) => /API ключ|Локальная модель|Облако Brai/.test(button.textContent ?? ""));
    expect(choices.map((button) => button.textContent)).toEqual([
      expect.stringContaining("API ключ"),
      expect.stringContaining("Локальная модель"),
      expect.stringContaining("Облако Brai"),
    ]);
    expect(screen.getByText("Самое простое")).toBeInTheDocument();
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

  it("does not leave cloud login after a failed email request", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a" };
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
      step: "cloud-login",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Вход в облачный профиль")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expectNoPasswordPrompt();
    await submitEmailLogin("wrong@example.test");

    expect(await screen.findByText("Email не подошёл.")).toBeInTheDocument();
    expect(screen.getByText("Вход в облачный профиль")).toBeInTheDocument();
    expectNoPasswordPrompt();
    expect(screen.queryByText("Начинаем настройку")).not.toBeInTheDocument();
  });

  it("keeps cloud onboarding production on OTP without a password prompt", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "prod" };
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
      step: "cloud-login",
      voiceMode: null,
    }));

    render(<BraiApp />);

    expect(await screen.findByText("Вход в облачный профиль")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Получить код" })).toBeInTheDocument();
    expectNoPasswordPrompt();
  });

  it("keeps a completed onboarding locked when cabinet login fails", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a" };
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
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expectNoPasswordPrompt();
    await submitEmailLogin("wrong@example.test");

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: true });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Добавить" })).not.toBeInTheDocument();
    expect(cmdPlugin.setVoiceOnlyMode).not.toHaveBeenCalledWith({ enabled: false });
  }, 10_000);

  it("enables context only after the final login opens the cabinet", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a" };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/auth/test-email-login")) {
        return new Response(JSON.stringify({ authenticated: true, user: { id: "test-user", email: "test@example.test", name: "Test" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const snapshot = emptyAppSnapshotResponse(url);
      if (snapshot) return snapshot;
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
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expectNoPasswordPrompt();
    await submitEmailLogin("test@example.test");

    expect(await screen.findByRole("heading", { name: "Действия" })).toBeInTheDocument();
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
  }, 10_000);

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

    expect(await screen.findByText("Мы ничего не храним")).toBeInTheDocument();
    expect(screen.getByText(/после успешной доставки расшифровки/)).toBeInTheDocument();
    expect(screen.getByText(/Для полной приватности используйте локальные модели/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Проверить" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Согласен" }));
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
