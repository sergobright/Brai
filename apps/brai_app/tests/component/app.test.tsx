import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { cmdPlugin, openProfileMenuItem, setupBraiAppTest, stubAndroidCapacitor, testVersionState } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { AuthPanel } from "@/features/app/chrome/AppChrome";
import { FocusSection } from "@/features/app/sections/focus/FocusSection";
import { BraiApi } from "@/shared/api/braiApi";
import { setMeta } from "@/shared/storage/db";
import { pendingEvents, saveGoalCache, saveHistoryCache } from "@/shared/storage/syncStore";
import { emptyGoal, emptyHistory } from "@/shared/types/timer";
import { shouldSnapSlidingNumber } from "@/shared/ui/sliding-number";

const drawsCanvasSpy = vi.hoisted(() => vi.fn());

vi.mock("@/features/app/sections/draws/DrawsCanvas", () => ({
  DrawsCanvas: (props: Record<string, unknown>) => {
    const [initialData] = useState(props.initialData as { elements?: unknown[] });
    drawsCanvasSpy(props);
    return <div data-element-count={initialData.elements?.length ?? 0} data-testid="draws-canvas" />;
  },
}));

describe("BraiApp shell", () => {
  setupBraiAppTest();

  it("renders the actions-first shell", async () => {
    render(<BraiApp />);
    expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Действия").length).toBeGreaterThan(0);
    ["Действия", "Входящие", "Фокус"].forEach((title) => {
      expect(screen.getAllByRole("button", { name: title }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: "Цели фокусировки" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Настройки" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть меню" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть левое меню" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Информация о действиях" })).toBeInTheDocument());
    expect(screen.getAllByLabelText("Информация о действиях").length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "Добавить" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть правое меню" })).toBeInTheDocument();
  });

  it("enables dictation and context after the signed-in cabinet opens", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    await waitFor(() => expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false }));
    expect(cmdPlugin.setQueuePausedMode).toHaveBeenCalledWith({ enabled: false });
    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledWith({ token: "authenticated-device-token", displayName: "Test" }));
    expect(cmdPlugin.ensureAccess).not.toHaveBeenCalled();
  });

  it("does not tie cabinet overlays to the legacy native access-name request", async () => {
    stubAndroidCapacitor();
    cmdPlugin.ensureAccess.mockResolvedValue({ accessGranted: false });

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false });
    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledWith({ token: "authenticated-device-token", displayName: "Test" }));
    expect(cmdPlugin.ensureAccess).not.toHaveBeenCalled();
  });

  it("does not rotate a healthy device token on ordinary network recovery", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(1));
    expect(deviceTokenRequestCount()).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(deviceTokenRequestCount()).toBe(1);
    expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(1);
  });

  it("replaces the device token when native transport rejects its credential", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(1));
    const refreshListener = cmdPlugin.addListener.mock.calls.find(([eventName]) => eventName === "credentialRefreshRequired")?.[1];
    expect(refreshListener).toEqual(expect.any(Function));

    act(() => refreshListener());

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(2));
    expect(deviceTokenRequestCount()).toBe(2);
  });

  it("keeps full mode active and retries a failed device-token bootstrap", async () => {
    stubAndroidCapacitor();
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    let tokenAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith("/v1/brai-cmd/device-token") && tokenAttempts++ === 0) {
        throw new Error("offline");
      }
      if (!defaultFetch) throw new Error("missing_default_fetch");
      return await defaultFetch(input, init);
    });

    render(<BraiApp />);

    await waitFor(() => expect(deviceTokenRequestCount()).toBe(1));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenCalledWith({ enabled: true });
    expect(cmdPlugin.setVoiceOnlyMode).toHaveBeenCalledWith({ enabled: false });
    expect(cmdPlugin.setAccessKey).not.toHaveBeenCalled();

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(1), { timeout: 2_500 });
    expect(deviceTokenRequestCount()).toBe(2);
    expect(cmdPlugin.retryQueue).toHaveBeenCalled();
  });

  it("retries an unfinished bootstrap immediately when the network returns", async () => {
    stubAndroidCapacitor();
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    let offline = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith("/v1/brai-cmd/device-token") && offline) throw new Error("offline");
      if (!defaultFetch) throw new Error("missing_default_fetch");
      return await defaultFetch(input, init);
    });

    render(<BraiApp />);

    await waitFor(() => expect(deviceTokenRequestCount()).toBe(1));
    offline = false;
    act(() => window.dispatchEvent(new Event("online")));

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledTimes(1));
    expect(deviceTokenRequestCount()).toBe(2);
  });

  it("returns to signed-out native mode when device-token bootstrap reports an expired app session", async () => {
    stubAndroidCapacitor();
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith("/v1/brai-cmd/device-token")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (!defaultFetch) throw new Error("missing_default_fetch");
      return await defaultFetch(input, init);
    });

    render(<BraiApp />);

    await waitFor(() => expect(deviceTokenRequestCount()).toBe(1));
    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenLastCalledWith({ token: "", displayName: "" }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("clears the technical credential and overlays after logout", async () => {
    stubAndroidCapacitor();
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith("/auth/logout")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (!defaultFetch) throw new Error("missing_default_fetch");
      return await defaultFetch(input, init);
    });

    render(<BraiApp />);

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenCalledWith({ token: "authenticated-device-token", displayName: "Test" }));
    await openProfileMenuItem("Выход");

    await waitFor(() => expect(cmdPlugin.setAccessKey).toHaveBeenLastCalledWith({ token: "", displayName: "" }));
    expect(cmdPlugin.setOverlayEnabled).toHaveBeenLastCalledWith({ enabled: false });
    expect(cmdPlugin.setQueuePausedMode).toHaveBeenCalledWith({ enabled: false });
  });

  it("requests an OTP code from the shared auth form", async () => {
    const auth = authPanelProps();
    auth.onRequestOtp.mockRejectedValue(new Error("invalid_email"));
    render(<AuthPanel {...auth} />);

    const email = screen.getByRole("textbox", { name: "Email" });
    expect(screen.queryByLabelText("Код из письма")).not.toBeInTheDocument();
    fireEvent.change(email, { target: { value: "primary@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Получить код" }));

    await waitFor(() => expect(auth.onRequestOtp).toHaveBeenCalledWith("primary@example.com"));
    expect(await screen.findByText("Не удалось отправить код")).toBeInTheDocument();
    expect(auth.onVerifyOtp).not.toHaveBeenCalled();
  });

  it("uses explicit email-only login on Preview Android", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = {
      environment: "preview-a",
      androidApiBase: "https://a.test.brai.one/api",
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false, user: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    const email = await screen.findByRole("textbox", { name: "Email" });
    fireEvent.change(email, { target: { value: "random@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://a.test.brai.one/api/auth/test-email-login",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "https://a.test.brai.one/api/auth/otp/send",
      expect.anything(),
    );
    expect(await screen.findByText("Email не подошёл")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Получить код" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Пароль")).not.toBeInTheDocument();
  });

  it("keeps Android on the OTP flow", async () => {
    stubAndroidCapacitor();
    window.__BRAI_RUNTIME_CONFIG__ = {
      environment: "prod",
      androidApiBase: "https://api.brai.one",
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false, user: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });

    render(<BraiApp />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Получить код" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Войти" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Пароль")).not.toBeInTheDocument();
  });

  it("uses the OTP flow on Web", async () => {
    render(<AuthPanel {...authPanelProps()} />);

    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Получить код" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Войти" })).not.toBeInTheDocument();
  });

  it("redirects anonymous web users to the standalone auth page without rendering the cabinet shell", async () => {
    await setMeta("currentUserId", null);
    let resolveSession!: (session: { authenticated: false; user: null }) => void;
    const sessionResult = new Promise<{ authenticated: false; user: null }>((resolve) => {
      resolveSession = resolve;
    });
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockReturnValue(sessionResult);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/auth/session")) {
        return new Response(JSON.stringify({ authenticated: false, user: null }), {
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
    }));

    render(<BraiApp />);
    await waitFor(() => expect(sessionSpy).toHaveBeenCalled());
    await act(async () => {
      resolveSession({ authenticated: false, user: null });
      await sessionResult;
    });
    await waitFor(() => expect(window.location.pathname).toBe("/auth"));
    expect(document.querySelector("[data-auth-redirect]")).toBeInTheDocument();
    expect(document.querySelector("[data-app-shell]")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Действия" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Email" })).not.toBeInTheDocument();
  });

  it("shows the production OTP countdown and enables resend after one minute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T10:00:00.000Z"));
    try {
      const auth = authPanelProps();
      render(<AuthPanel {...auth} />);

      fireEvent.change(screen.getByRole("textbox", { name: "Email" }), { target: { value: "primary@example.com" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Получить код" }));
        await Promise.resolve();
      });

      expect(auth.onRequestOtp).toHaveBeenCalledWith("primary@example.com");
      const otpInput = screen.getByTestId("auth-otp-input");
      expect(document.activeElement).toBe(otpInput);
      expect(screen.getByText("Код действителен 5:00")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Отправить повторно через 1:00" })).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(59_000);
      });
      expect(screen.getByRole("button", { name: "Отправить повторно через 0:01" })).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      const resend = screen.getByRole("button", { name: "Отправить повторно" });
      expect(resend).toBeEnabled();
      fireEvent.change(otpInput, { target: { value: "123456" } });
      await act(async () => {
        fireEvent.click(resend);
        await Promise.resolve();
      });

      expect(auth.onRequestOtp).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("auth-otp-input")).toHaveValue("");
      expect(screen.getByText("Код действителен 4:00")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps collapsed desktop rail action icons clickable", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    document.cookie = "sidebar_state=false; path=/";

    render(<BraiApp />);

    await waitFor(() => expect(document.querySelector('[data-slot="sidebar"][data-state="collapsed"]')).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Engine/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/engine");

    fireEvent.pointerDown(screen.getByRole("button", { name: "Открыть меню профиля" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Настройки" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Открыть меню профиля" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Архив" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Архив" })).toBeInTheDocument());
  });

  it("opens the mobile Inbox info sheet", async () => {
    render(<BraiApp initialSection="inbox" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    const infoButton = await screen.findByRole("button", { name: "Информация о входящих" });
    fireEvent.click(infoButton);

    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
    expect(infoButton).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the mobile dock overflow over an existing mobile sheet", async () => {
    render(<BraiApp />);

    const infoButton = await screen.findByRole("button", { name: "Информация о действиях" });
    fireEvent.click(infoButton);
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Открыть правое меню" }));

    expect(document.querySelector(".mobile-dock-overflow-sheet")).toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-backdrop")).toHaveClass("z-[110]");
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draws" })).toBeInTheDocument();
  });

  it("keeps the left dock overflow available and hides the mobile FAB while the right overflow is open", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть правое меню" }));

    const leftOverflowButton = screen.getByRole("button", { name: "Открыть левое меню" });
    expect(leftOverflowButton).not.toHaveClass("max-[860px]:invisible", "max-[860px]:opacity-0");
    expect(screen.queryByRole("button", { name: "Добавить действие" })).not.toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-sheet")).toHaveAttribute("aria-label", "Правое меню");

    fireEvent.click(leftOverflowButton);

    await waitFor(() => expect(document.querySelector(".mobile-dock-overflow-sheet")).toHaveAttribute("aria-label", "Левое меню"));
    expect(within(document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement).getByRole("button", { name: "Настройки" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Добавить действие" })).not.toBeInTheDocument();
  });

  it("hides app chrome while Draws is fullscreen", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    stubDrawsFetch();

    render(<BraiApp initialSection="draws" />);

    const fullScreenButton = await screen.findByRole("button", { name: "На весь экран" });
    expect(document.querySelector(".desktop-rail")).toBeInTheDocument();
    expect(document.querySelector(".main-dock")).toBeInTheDocument();

    fireEvent.click(fullScreenButton);

    await waitFor(() => expect(document.querySelector(".desktop-rail")).not.toBeInTheDocument());
    expect(document.querySelector(".main-dock")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Открыть левое меню" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выйти из полноэкранного режима" })).toBeInTheDocument();
  });

  it("starts Draws rename only from the main title text", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    stubDrawsFetch();

    render(<BraiApp initialSection="draws" />);

    const titleButton = await screen.findByRole("button", { name: "Название рисунка: Рисунок" });
    const fileCard = screen.getAllByRole("button", { name: /Рисунок/ }).find((button) => button.textContent?.includes("11.07"));

    expect(fileCard).toBeInstanceOf(HTMLElement);
    fireEvent.click(fileCard as HTMLElement);
    expect(screen.queryByRole("textbox", { name: "Название рисунка: Рисунок" })).not.toBeInTheDocument();

    fireEvent.click(titleButton.parentElement as HTMLElement);
    expect(screen.queryByRole("textbox", { name: "Название рисунка: Рисунок" })).not.toBeInTheDocument();

    fireEvent.click(titleButton);
    const editor = screen.getByRole("textbox", { name: "Название рисунка: Рисунок" });
    expect(editor).toBeVisible();
    expect(editor).toHaveTextContent("Рисунок");
  });

  it("strips Excalidraw collaborators from loaded Draws app state", async () => {
    drawsCanvasSpy.mockClear();
    stubDrawsFetch({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [],
      appState: { collaborators: {}, viewBackgroundColor: "#ffffff" },
      files: {},
    });

    render(<BraiApp initialSection="draws" />);

    await waitFor(() => expect(drawsCanvasSpy).toHaveBeenCalled());
    const initialData = drawsCanvasSpy.mock.calls.at(-1)?.[0].initialData as Record<string, unknown>;
    expect(initialData.appState).toEqual({ viewBackgroundColor: "#ffffff" });
  });

  it("mounts Draws canvas with persisted elements after resolving the saved file name", async () => {
    stubDrawsFetch({
      type: "excalidraw",
      version: 2,
      source: "test",
      elements: [{ id: "saved-ellipse", type: "ellipse" }],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });

    render(<BraiApp initialSection="draws" />);

    await waitFor(() => expect(screen.getByTestId("draws-canvas")).toHaveAttribute("data-element-count", "1"));
  });

  it("keeps contextual actions before the rightmost sync status", async () => {
    render(<BraiApp />);

    for (const title of ["Действия", "Фокус"]) {
      fireEvent.click(screen.getAllByRole("button", { name: title }).at(-1) as HTMLElement);
      await waitFor(() => expect(screen.getByRole("heading", { name: title })).toBeInTheDocument());
      const topbar = document.querySelector(".section-page-current .topbar");
      const topbarActions = topbar?.querySelector(".topbar-actions");

      expect(topbar).toBeInstanceOf(HTMLElement);
      expect(topbar?.querySelector(".eyebrow")).not.toBeInTheDocument();
      expect(topbar?.querySelector(".status-pill")).toBeInTheDocument();
      expect(topbar?.querySelector(".status-pill svg")).toBeInTheDocument();
      expect(topbarActions?.lastElementChild).toHaveClass("status-pill");
      expect(topbar?.querySelector(".status-pill-label")).not.toBeInTheDocument();
      expect(topbar?.querySelector("button.status-pill")).not.toBeInTheDocument();
      expect(topbar?.querySelector('[aria-label="Обновить"]')).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Цели фокусировки" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "История фокуса" })).toHaveAttribute("aria-pressed", "false");
    expect(document.querySelector(".section-page-current .timer-face .status-pill")).not.toBeInTheDocument();
  });

  it("shows the scroll hint only before the timer starts", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(document.querySelector(".timer-scroll-hint svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Запустить" })).toHaveClass("rounded-full", "bg-primary", "text-primary-foreground", "whitespace-nowrap");
    const timerPane = document.querySelector(".section-page-current .focus-timer-pane[data-slot='scroll-area']");
    expect(timerPane).toBeInTheDocument();
    expect(timerPane?.querySelector("[data-slot='scroll-area-viewport']")).toBeInTheDocument();
    expect(timerPane?.querySelector("[data-slot='scroll-area-scrollbar']")).not.toBeInTheDocument();
    expect(document.querySelector(".timer-border-trail")).not.toBeInTheDocument();
    expect(document.querySelector(".focus-background")).toHaveClass("bg-background");
    expect(document.querySelector(".main-view > .focus-background")).toBeInTheDocument();
    expect(document.querySelector(".timer-galaxy-background")).toHaveClass("invert", "dark:invert-0", "opacity-100");
    expect(document.querySelector(".timer-evil-eye-background")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Фон Galaxy" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Фон Evil Eye" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "Фон Evil Eye" }));
    expect(window.localStorage.getItem("brai_focus_background")).toBe("evil-eye");
    expect(screen.getByRole("button", { name: "Фон Galaxy" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Фон Evil Eye" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".timer-galaxy-background")).toHaveClass("opacity-0", "delay-0");
    await waitFor(() => expect(document.querySelector(".timer-evil-eye-background")).toHaveClass("opacity-100", "delay-[1500ms]"));

    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Завершить/ })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Завершить/ })).toHaveClass("rounded-full", "bg-destructive", "text-destructive-foreground", "whitespace-nowrap");
    expect(screen.getByText(/^Started \d{2}:\d{2}$/)).toHaveClass("text-muted-foreground/55");
    expect(document.querySelector(".timer-screen")).toHaveClass("is-active");
    await waitFor(() => expect(document.querySelector(".timer-scroll-hint")).not.toBeInTheDocument());
    expect(document.querySelector(".timer-border-trail")).toBeInTheDocument();
    expect(document.querySelector(".timer-evil-eye-background")).toHaveClass("invert", "dark:invert-0", "opacity-100");
  });

  it("keeps Focus timer controls local-first while network requests hang", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));

    render(<BraiApp initialSection="focus" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Запустить" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Завершить/ })).not.toBeDisabled());
    expect(await pendingEvents()).toHaveLength(1);
  });

  it("uses SlidingNumber for timer digits", async () => {
    render(<BraiApp initialSection="focus" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    const digits = document.querySelector(".section-page-current .timer-digits");

    expect(digits).toHaveAttribute("aria-label", "00:00:00");
    expect(digits?.querySelector('[data-slot="timer-hours"] .relative')).toBeInTheDocument();
    expect(digits?.querySelector('[data-slot="timer-minutes"] .relative')).toBeInTheDocument();
    expect(digits?.querySelector('[data-slot="timer-seconds"] .relative')).toBeInTheDocument();
  });

  it("shows zero elapsed time when the timer is inactive", () => {
    render(
      <FocusSection
        state={{
          server_time_utc: "2026-06-22T12:13:42.000Z",
          server_revision: 8,
          timezone: "Europe/Moscow",
          active_session: null,
          elapsed_seconds: 81,
        }}
        active={false}
        busy={false}
        contextPanel="none"
        goal={emptyGoal()}
        history={emptyHistory()}
        todayKey="2026-06-22"
        background="galaxy"
        onStart={() => undefined}
        onStop={() => undefined}
        onBackground={() => undefined}
      />,
    );

    expect(document.querySelector(".timer-digits")).toHaveAttribute("aria-label", "00:00:00");
    expect(screen.getByRole("button", { name: "Запустить" })).toBeInTheDocument();
  });

  it("remounts timer digits when a remote stop leaves stale elapsed time", () => {
    const props = {
      active: true,
      busy: false,
      contextPanel: "none" as const,
      goal: emptyGoal(),
      history: emptyHistory(),
      todayKey: "2026-06-22",
      background: "galaxy" as const,
      onStart: () => undefined,
      onStop: () => undefined,
      onBackground: () => undefined,
    };
    const view = render(
      <FocusSection
        {...props}
        state={{
          server_time_utc: "2026-06-22T12:13:42.000Z",
          server_revision: 8,
          timezone: "Europe/Moscow",
          active_session: {
            id: "remote-active",
            started_at_utc: "2026-06-22T08:25:25.000Z",
            ended_at_utc: null,
            duration_seconds: null,
          },
          elapsed_seconds: 13697,
        }}
      />,
    );
    const runningDigits = document.querySelector(".timer-digits");

    expect(runningDigits).toHaveAttribute("aria-label", "03:48:17");

    view.rerender(
      <FocusSection
        {...props}
        active={false}
        state={{
          server_time_utc: "2026-06-22T12:13:43.000Z",
          server_revision: 9,
          timezone: "Europe/Moscow",
          active_session: null,
          elapsed_seconds: 13697,
        }}
      />,
    );

    const idleDigits = document.querySelector(".timer-digits");
    expect(idleDigits).not.toBe(runningDigits);
    expect(idleDigits).toHaveAttribute("aria-label", "00:00:00");
    expect(screen.getByRole("button", { name: "Запустить" })).toBeInTheDocument();
  });

  it("snaps timer digits only after skipped seconds", () => {
    expect(shouldSnapSlidingNumber(10, 11)).toBe(false);
    expect(shouldSnapSlidingNumber(10, 12)).toBe(true);
    expect(shouldSnapSlidingNumber(12, 0)).toBe(true);
    expect(shouldSnapSlidingNumber(undefined, 12)).toBe(false);
  });

  it("uses /focus as the canonical Focus route", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/focus");

    fireEvent.click(screen.getAllByRole("button", { name: "Действия" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/");
  });

  it("opens mutually exclusive mobile Focus context sheets", async () => {
    render(<BraiApp initialSection="focus" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Цели фокусировки" }));
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Цели фокусировки" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "Закрыть историю" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));
    expect(document.querySelector(".focus-history-backdrop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Цели фокусировки" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "История фокуса" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));
    expect(document.querySelector(".mobile-context-sheet")).not.toBeInTheDocument();
  });

  it("persists the desktop Focus context panel preference", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    const first = render(<BraiApp initialSection="focus" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(document.querySelector(".focus-context-pane")).not.toBeInTheDocument();
    expect(document.querySelector(".timer-face-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Цели фокусировки" }));
    await waitFor(() => expect(document.querySelector(".focus-context-pane")).toHaveTextContent("Цели фокусировки"));
    const focusSection = document.querySelector(".focus-section");
    const timerPane = document.querySelector(".focus-timer-pane[data-slot='scroll-area']");
    const contextPane = document.querySelector(".focus-context-pane");
    const contextScrollArea = document.querySelector(".focus-context-pane [data-slot='scroll-area']");
    expect(focusSection).not.toHaveClass("min-[861px]:-mr-7");
    expect(contextPane).not.toHaveClass("min-[861px]:-mr-7");
    expect(timerPane).toBeInTheDocument();
    expect(timerPane?.querySelector("[data-slot='scroll-area-scrollbar']")).not.toBeInTheDocument();
    expect(timerPane?.querySelector("[data-slot='scroll-area-viewport']")).toBeInTheDocument();
    expect(timerPane).not.toHaveClass("pr-3");
    expect(contextScrollArea).toBeInTheDocument();
    expect(contextScrollArea).not.toHaveClass("pr-3");
    expect(contextScrollArea).toHaveClass(
      "[--scroll-area-thumb-size:10px]",
      "[--scroll-area-gap:calc(var(--scroll-area-thumb-size)/2)]",
      "[&>[data-slot=scroll-area-viewport]]:pr-[var(--scroll-area-content-gutter)]",
    );
    expect(contextScrollArea).not.toHaveClass("[&>[data-slot=scroll-area-scrollbar]]:right-1", "[&>[data-slot=scroll-area-viewport]>div]:pr-5");
    expect(contextScrollArea?.querySelector("[data-slot='scroll-area-scrollbar']")).toHaveClass(
      "w-[var(--scroll-area-thumb-size)]",
      "opacity-0",
      "pointer-events-none",
    );
    expect(contextScrollArea?.querySelector("[data-slot='scroll-area-scrollbar']")).toHaveStyle({ right: "var(--scroll-area-gap)" });
    expect(contextScrollArea?.querySelector("[data-slot='scroll-area-scrollbar']")).toHaveAttribute("data-scrollbar-state", "hidden");
    expect(window.localStorage.getItem("brai_focus_context_panel")).toBe("goal");
    first.unmount();

    render(<BraiApp initialSection="focus" />);
    await waitFor(() => expect(document.querySelector(".focus-context-pane")).toHaveTextContent("Цели фокусировки"));
    expect(screen.getByRole("button", { name: "Цели фокусировки" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders date-only collapsible history day headers with goal progress", async () => {
    const session = {
      id: "session-2026-06-19",
      started_at_utc: "2026-06-18T21:00:00.000Z",
      ended_at_utc: "2026-06-19T09:00:00.000Z",
      duration_seconds: 43_200,
    };
    const goal = emptyGoal();
    goal.days = goal.days.map((day) =>
      day.date === "2026-06-19"
        ? { ...day, achieved: true, completed_hours: 12, completed_seconds: 43_200, percentage: 100 }
        : day,
    );
    await saveHistoryCache({
      sessions: [session],
      groups: {},
    });
    await saveGoalCache(goal);

    render(<BraiApp initialSection="focus" />);

    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    const trigger = await screen.findByRole("button", { name: "пятница, 19 июня" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByText("День")).not.toBeInTheDocument();
    expect(screen.getByText("В фокусе")).toBeInTheDocument();
    expect(screen.getByText("12ч")).toBeInTheDocument();
    expect(screen.queryByText("new")).not.toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Цель достигнута")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();

    fireEvent.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("refreshes Focus history after a remote timer stop live update", async () => {
    const sockets = stubWebSockets();
    const session = {
      id: "remote-session",
      started_at_utc: "2026-06-22T05:00:00.000Z",
      ended_at_utc: "2026-06-22T06:00:00.000Z",
      duration_seconds: 3600,
      started_date_msk: "2026-06-22",
      started_hour_msk: 8,
      ended_date_msk: "2026-06-22",
      ended_hour_msk: 9,
    };
    let historyRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            timezone: "Europe/Moscow",
            active_session: {
              id: "active-session",
              started_at_utc: "2026-06-22T05:00:00.000Z",
              ended_at_utc: null,
              duration_seconds: null,
            },
            elapsed_seconds: 1800,
          });
        }
        if (url.includes("/v1/sessions")) {
          historyRequests += 1;
          return jsonResponse(
            historyRequests === 1
              ? emptyHistory()
              : {
                  sessions: [session],
                  groups: {
                    "2026-06-22": { total_seconds: 3600, sessions: [session] },
                  },
                },
          );
        }
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            activities: [],
            archived_activities: [],
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp initialSection="focus" />);
    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    await waitFor(() => expect(screen.getByText("Сессий пока нет")).toBeInTheDocument());
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));

    await act(async () => {
      sockets[0].sendMessage({
        type: "timer_synced",
        state: {
          server_time_utc: "2026-06-22T06:00:00.000Z",
          server_revision: 2,
          timezone: "Europe/Moscow",
          active_session: null,
          elapsed_seconds: 0,
        },
      });
    });

    await waitFor(() => expect(screen.getByText("1ч")).toBeInTheDocument());
    expect(historyRequests).toBeGreaterThan(1);
  });

  it("refreshes Focus history when a remote stop is followed by a new start", async () => {
    const sockets = stubWebSockets();
    const session = {
      id: "remote-completed-before-active",
      started_at_utc: "2026-06-22T05:00:00.000Z",
      ended_at_utc: "2026-06-22T06:00:00.000Z",
      duration_seconds: 3600,
      started_date_msk: "2026-06-22",
      started_hour_msk: 8,
      ended_date_msk: "2026-06-22",
      ended_hour_msk: 9,
    };
    let historyRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            timezone: "Europe/Moscow",
            active_session: {
              id: "active-session",
              started_at_utc: "2026-06-22T05:00:00.000Z",
              ended_at_utc: null,
              duration_seconds: null,
            },
            elapsed_seconds: 1800,
          });
        }
        if (url.includes("/v1/sessions")) {
          historyRequests += 1;
          return jsonResponse(
            historyRequests === 1
              ? emptyHistory()
              : {
                  sessions: [session],
                  groups: {
                    "2026-06-22": { total_seconds: 3600, sessions: [session] },
                  },
                },
          );
        }
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            activities: [],
            archived_activities: [],
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp initialSection="focus" />);
    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    await waitFor(() => expect(screen.getByText("Сессий пока нет")).toBeInTheDocument());
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));

    await act(async () => {
      sockets[0].sendMessage({
        type: "timer_synced",
        state: {
          server_time_utc: "2026-06-22T06:01:00.000Z",
          server_revision: 3,
          timezone: "Europe/Moscow",
          active_session: {
            id: "next-active-session",
            started_at_utc: "2026-06-22T06:00:30.000Z",
            ended_at_utc: null,
            duration_seconds: null,
          },
          elapsed_seconds: 30,
        },
      });
    });

    await waitFor(() => expect(screen.getByText("1ч")).toBeInTheDocument());
    expect(historyRequests).toBeGreaterThan(1);
  });

  it("refreshes Focus history from polling when live updates are missed", async () => {
    const intervals = captureIntervals();
    const session = {
      id: "poll-session",
      started_at_utc: "2026-06-22T05:00:00.000Z",
      ended_at_utc: "2026-06-22T06:00:00.000Z",
      duration_seconds: 3600,
      started_date_msk: "2026-06-22",
      started_hour_msk: 8,
      ended_date_msk: "2026-06-22",
      ended_hour_msk: 9,
    };
    let stateRequests = 0;
    let historyRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          stateRequests += 1;
          return jsonResponse({
            server_time_utc: stateRequests === 1 ? "2026-06-22T05:30:00.000Z" : "2026-06-22T06:00:00.000Z",
            server_revision: stateRequests === 1 ? 1 : 2,
            timezone: "Europe/Moscow",
            active_session:
              stateRequests === 1
                ? {
                    id: "poll-active-session",
                    started_at_utc: "2026-06-22T05:00:00.000Z",
                    ended_at_utc: null,
                    duration_seconds: null,
                  }
                : null,
            elapsed_seconds: stateRequests === 1 ? 1800 : 0,
          });
        }
        if (url.includes("/v1/sessions")) {
          historyRequests += 1;
          return jsonResponse(
            historyRequests === 1
              ? emptyHistory()
              : {
                  sessions: [session],
                  groups: {
                    "2026-06-22": { total_seconds: 3600, sessions: [session] },
                  },
                },
          );
        }
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            activities: [],
            archived_activities: [],
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp initialSection="focus" />);
    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    await waitFor(() => expect(screen.getByText("Сессий пока нет")).toBeInTheDocument());

    await intervals.run(5000);

    await waitFor(() => expect(screen.getByText("1ч")).toBeInTheDocument());
    expect(stateRequests).toBeGreaterThan(1);
    intervals.restore();
  });

  it("refreshes Focus immediately when the browser tab returns", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    const session = {
      id: "focus-return-session",
      started_at_utc: "2026-06-22T05:00:00.000Z",
      ended_at_utc: "2026-06-22T06:00:00.000Z",
      duration_seconds: 3600,
      started_date_msk: "2026-06-22",
      started_hour_msk: 8,
      ended_date_msk: "2026-06-22",
      ended_hour_msk: 9,
    };
    let stateRequests = 0;
    let historyRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          stateRequests += 1;
          return jsonResponse({
            server_time_utc: stateRequests === 1 ? "2026-06-22T05:30:00.000Z" : "2026-06-22T06:00:00.000Z",
            server_revision: stateRequests === 1 ? 1 : 2,
            timezone: "Europe/Moscow",
            active_session:
              stateRequests === 1
                ? {
                    id: "focus-return-active-session",
                    started_at_utc: "2026-06-22T05:00:00.000Z",
                    ended_at_utc: null,
                    duration_seconds: null,
                  }
                : null,
            elapsed_seconds: stateRequests === 1 ? 1800 : 0,
          });
        }
        if (url.includes("/v1/sessions")) {
          historyRequests += 1;
          return jsonResponse(
            historyRequests === 1
              ? emptyHistory()
              : {
                  sessions: [session],
                  groups: {
                    "2026-06-22": { total_seconds: 3600, sessions: [session] },
                  },
                },
          );
        }
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T05:30:00.000Z",
            server_revision: 1,
            activities: [],
            archived_activities: [],
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp initialSection="focus" />);
    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    await waitFor(() => expect(stateRequests).toBeGreaterThan(0));
    const stateRequestsBeforeFocus = stateRequests;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(stateRequests).toBeGreaterThan(stateRequestsBeforeFocus));
    await waitFor(() => expect(document.querySelector(".timer-digits")).toHaveAttribute("aria-label", "00:00:00"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Завершить/ })).not.toBeInTheDocument());
  });

  it("applies live activity updates to active Actions and Archive", async () => {
    const sockets = stubWebSockets();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T06:00:00.000Z",
            server_revision: 1,
            timezone: "Europe/Moscow",
            active_session: null,
            elapsed_seconds: 0,
          });
        }
        if (url.includes("/v1/sessions")) return jsonResponse(emptyHistory());
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T06:00:00.000Z",
            server_revision: 1,
            activities: [],
            archived_activities: [],
          });
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp />);
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));

    await act(async () => {
      sockets[0].sendMessage({
        type: "activities_synced",
        activities_state: {
          server_time_utc: "2026-06-22T06:01:00.000Z",
          server_revision: 2,
          activities: [
            {
              id: "live-action",
              title: "Live действие",
              description_md: "",
              status: "New",
              created_at_utc: "2026-06-22T06:01:00.000Z",
              updated_at_utc: "2026-06-22T06:01:00.000Z",
              completed_at_utc: null,
              sort_order: null,
              deleted_at_utc: null,
              restored_at_utc: null,
            },
          ],
          archived_activities: [
            {
              id: "live-archived-action",
              title: "Live архив",
              description_md: "",
              status: "New",
              created_at_utc: "2026-06-22T05:00:00.000Z",
              updated_at_utc: "2026-06-22T05:30:00.000Z",
              completed_at_utc: null,
              sort_order: null,
              deleted_at_utc: "2026-06-22T05:30:00.000Z",
              restored_at_utc: null,
            },
          ],
        },
      });
    });

    await waitFor(() => expect(screen.getByText("Live действие")).toBeInTheDocument());
    await openProfileMenuItem("Архив");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Архив" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("Live архив")).toBeInTheDocument());
  });

  it("refreshes Actions and Archive from polling when live updates are missed", async () => {
    const intervals = captureIntervals();
    let actionsRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.includes("/auth/session")) return authSessionResponse();
        if (url.includes("/v1/inbox")) return emptyInboxResponse();
        if (url.includes("/v1/timer/state")) {
          return jsonResponse({
            server_time_utc: "2026-06-22T06:00:00.000Z",
            server_revision: 1,
            timezone: "Europe/Moscow",
            active_session: null,
            elapsed_seconds: 0,
          });
        }
        if (url.includes("/v1/sessions")) return jsonResponse(emptyHistory());
        if (url.includes("/v1/goals/challenge")) return jsonResponse(emptyGoal());
        if (url.includes("/v1/activities")) {
          actionsRequests += 1;
          return jsonResponse(
            actionsRequests === 1
              ? {
                  server_time_utc: "2026-06-22T06:00:00.000Z",
                  server_revision: 1,
                  activities: [],
                  archived_activities: [],
                }
              : {
                  server_time_utc: "2026-06-22T06:01:00.000Z",
                  server_revision: 2,
                  activities: [
                    {
                      id: "poll-action",
                      title: "Polling действие",
                      description_md: "",
                      status: "New",
                      created_at_utc: "2026-06-22T06:01:00.000Z",
                      updated_at_utc: "2026-06-22T06:01:00.000Z",
                      completed_at_utc: null,
                      sort_order: null,
                      deleted_at_utc: null,
                      restored_at_utc: null,
                    },
                  ],
                  archived_activities: [
                    {
                      id: "poll-archived-action",
                      title: "Polling архив",
                      description_md: "",
                      status: "New",
                      created_at_utc: "2026-06-22T05:00:00.000Z",
                      updated_at_utc: "2026-06-22T05:30:00.000Z",
                      completed_at_utc: null,
                      sort_order: null,
                      deleted_at_utc: "2026-06-22T05:30:00.000Z",
                      restored_at_utc: null,
                    },
                  ],
                },
          );
        }
        return jsonResponse({ error: "not_found" }, 404);
      }),
    );

    render(<BraiApp />);
    await waitFor(() => expect(screen.getByText("Новых действий нет")).toBeInTheDocument());

    await intervals.run(5000);

    await waitFor(() => expect(screen.getByText("Polling действие")).toBeInTheDocument());
    await openProfileMenuItem("Архив");
    await waitFor(() => expect(screen.getByText("Polling архив")).toBeInTheDocument());
    expect(actionsRequests).toBeGreaterThan(1);
    intervals.restore();
  });

  it("marks the native Android shell for safe-area spacing", async () => {
    stubAndroidCapacitor();

    render(<BraiApp />);

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-platform", "android"));
  });

  it("keeps the desktop rail compact and static", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    render(<BraiApp />);
    const shell = document.querySelector(".app-shell");
    const rail = document.querySelector(".desktop-rail");
    const topbar = document.querySelector(".section-page-current .topbar");

    expect(shell).toBeInstanceOf(HTMLElement);
    expect(rail).toBeInstanceOf(HTMLElement);
    expect(topbar?.querySelector("[data-screen-icon]")).toBeInTheDocument();
    expect(topbar?.querySelector('[aria-label="Свернуть меню"]')).not.toBeInTheDocument();
    expect(shell).not.toHaveClass("is-rail-expanded");
    expect(rail).not.toHaveClass("expanded");
    expect(document.documentElement).toHaveAttribute("data-sidebar-state", "collapsed");
    expect(rail).not.toContainElement(screen.queryByRole("button", { name: "Свернуть меню" }));
    expect(rail).not.toContainElement(screen.queryByRole("button", { name: "Развернуть меню" }));
    expect(rail).not.toHaveTextContent("Меню страницы");
    expect(rail).not.toHaveTextContent("Platform");
    expect(rail).not.toHaveTextContent("Time");
    expect(rail).not.toHaveTextContent("Фокус");
    expect(rail.querySelector(".desktop-rail-status .status-pill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Engine/ }).closest('[data-sidebar="footer"]')).toBeInTheDocument();
    expect(rail).toContainElement(screen.getByRole("button", { name: /Engine/ }));
    expect(rail).toContainElement(screen.getByRole("button", { name: "Открыть меню профиля" }));
    expect(rail).not.toContainElement(screen.queryByRole("button", { name: "Настройки" }));
    expect(rail).not.toContainElement(screen.queryByRole("button", { name: "Архив" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(rail).not.toHaveTextContent("Меню страницы");
    expect(rail).toContainElement(within(rail as HTMLElement).getByRole("button", { name: "Открыть меню профиля" }));
  });

  it("keeps the desktop rail collapsed regardless of the old sidebar cookie", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    document.cookie = "sidebar_state=true; path=/";
    render(<BraiApp />);

    await waitFor(() => {
      expect(document.querySelector(".app-shell")).not.toHaveClass("is-rail-expanded");
      expect(document.querySelector(".desktop-rail")).not.toHaveClass("expanded");
      expect(document.documentElement).toHaveAttribute("data-sidebar-state", "collapsed");
    });
  });

  it("keeps the burger drawer empty and opens mobile overflow navigation from primary screens", async () => {
    render(<BraiApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    expect(document.querySelector(".mobile-menu-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-menu-backdrop > div")).toHaveClass("bg-foreground/15", "dark:bg-background/80");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Workspace");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Настройки");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Архив");

    fireEvent.click(document.querySelector(".mobile-menu-backdrop") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".mobile-menu-backdrop")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Открыть левое меню" }));
    expect(document.querySelector(".mobile-dock-overflow-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Workspace");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Меню страницы");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Действия");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Platform");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Time");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Фокус");
    const sheet = document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement;
    expect(within(sheet).getByRole("button", { name: "Настройки" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Архив" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Профиль" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Brai CMD" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Выход" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Открыть меню профиля" })).not.toBeInTheDocument();

    fireEvent.click(document.querySelector(".mobile-dock-overflow-backdrop") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".mobile-dock-overflow-backdrop")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Открыть левое меню" }));
    expect(document.querySelector(".mobile-dock-overflow-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Меню страницы");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Фокус");
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Действия");
    expect(within(document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement).getByRole("button", { name: "Настройки" })).toBeInTheDocument();
    expect(within(document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement).getByRole("button", { name: /Engine/ })).toBeInTheDocument();

    fireEvent.click(within(document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement).getByRole("button", { name: "Настройки" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument());
    await waitFor(() => expect(document.querySelector(".mobile-dock-overflow-backdrop")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Открыть левое меню" }));
    expect(document.querySelector(".mobile-dock-overflow-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-dock-overflow-sheet")).not.toHaveTextContent("Workspace");
    expect(within(document.querySelector(".mobile-dock-overflow-sheet") as HTMLElement).getByRole("button", { name: "Архив" })).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authSessionResponse(): Response {
  return jsonResponse({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
}

function emptyInboxResponse(): Response {
  return jsonResponse({ server_time_utc: "2026-06-22T06:00:00.000Z", server_revision: 1, inbox: [] });
}

function stubDrawsFetch(scene: Record<string, unknown> = {
  type: "excalidraw",
  version: 2,
  source: "test",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.endsWith("/auth/session")) return authSessionResponse();
    if (url.endsWith("/v1/version")) return jsonResponse(testVersionState("0.0.10"));
    if (url.endsWith("/v1/draws")) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      return jsonResponse({ draws: [{
        name: "Рисунок.excalidraw",
        title: "Рисунок",
        updated_at_utc: "2026-07-11T12:00:00.000Z",
        size_bytes: 0,
      }] });
    }
    if (url.includes(encodeURIComponent("Новый рисунок.excalidraw"))) return jsonResponse({ error: "not_found" }, 404);
    if (url.includes("/v1/draws/")) {
      return jsonResponse({
        name: "Рисунок.excalidraw",
        title: "Рисунок",
        updated_at_utc: "2026-07-11T12:00:00.000Z",
        size_bytes: 0,
        scene,
      });
    }
    return Promise.reject(new Error("offline"));
  }));
}

function stubWebSockets(): Array<{ sendMessage: (payload: unknown) => void }> {
  const sockets: Array<{ sendMessage: (payload: unknown) => void }> = [];
  class FakeWebSocket {
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor() {
      sockets.push(this);
    }

    close() {}

    sendMessage(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function deviceTokenRequestCount(): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/brai-cmd/device-token")).length;
}

function authPanelProps() {
  return {
    busy: false,
    onEmailLogin: vi.fn(async () => undefined),
    onRequestOtp: vi.fn(async () => ({
      success: true,
      expires_in_seconds: 300,
      resend_after_seconds: 60,
      resend_strategy: "reuse" as const,
    })),
    onVerifyOtp: vi.fn(async () => undefined),
  };
}

function captureIntervals() {
  const intervals: Array<{ callback: () => void; timeout: number }> = [];
  const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((callback, timeout) => {
    if (typeof callback === "function") {
      intervals.push({ callback, timeout: Number(timeout) });
    }
    return intervals.length;
  });
  const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

  return {
    async run(timeout: number) {
      await act(async () => {
        for (const interval of intervals.filter((item) => item.timeout === timeout)) {
          interval.callback();
        }
        await Promise.resolve();
      });
    },
    restore() {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    },
  };
}
