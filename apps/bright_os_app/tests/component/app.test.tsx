import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { openProfileMenuItem, setupBrightOsAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BrightOsApp } from "@/features/app/BrightOsApp";
import { FocusSection } from "@/features/app/sections/focus/FocusSection";
import { pendingEvents, saveGoalCache, saveHistoryCache } from "@/shared/storage/syncStore";
import { emptyGoal, emptyHistory } from "@/shared/types/timer";
import { shouldSnapSlidingNumber } from "@/shared/ui/sliding-number";

describe("BrightOsApp shell", () => {
  setupBrightOsAppTest();

  it("renders the actions-first shell", () => {
    render(<BrightOsApp />);
    expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Действия").length).toBeGreaterThan(0);
    ["Действия", "Фокус"].forEach((title) => {
      expect(screen.getAllByRole("button", { name: title }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("button", { name: "Цели фокусировки" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Настройки" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть меню" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Информация о действиях" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Добавить" })).toBeInTheDocument();
  });

  it("keeps contextual actions before the rightmost sync status", async () => {
    render(<BrightOsApp />);

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
    render(<BrightOsApp />);

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
    expect(window.localStorage.getItem("bright_os_focus_background")).toBe("evil-eye");
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

    render(<BrightOsApp initialSection="focus" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Запустить" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Завершить/ })).not.toBeDisabled());
    expect(await pendingEvents()).toHaveLength(1);
  });

  it("uses SlidingNumber for timer digits", async () => {
    render(<BrightOsApp initialSection="focus" />);

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

  it("snaps timer digits only after skipped seconds", () => {
    expect(shouldSnapSlidingNumber(10, 11)).toBe(false);
    expect(shouldSnapSlidingNumber(10, 12)).toBe(true);
    expect(shouldSnapSlidingNumber(12, 0)).toBe(true);
    expect(shouldSnapSlidingNumber(undefined, 12)).toBe(false);
  });

  it("uses /focus as the canonical Focus route", async () => {
    render(<BrightOsApp />);

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/focus");

    fireEvent.click(screen.getAllByRole("button", { name: "Действия" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
    expect(window.location.pathname).toBe("/");
  });

  it("opens mutually exclusive mobile Focus context sheets", async () => {
    render(<BrightOsApp initialSection="focus" />);

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
    const first = render(<BrightOsApp initialSection="focus" />);

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
    expect(window.localStorage.getItem("bright_os_focus_context_panel")).toBe("goal");
    first.unmount();

    render(<BrightOsApp initialSection="focus" />);
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

    render(<BrightOsApp initialSection="focus" />);

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

    render(<BrightOsApp initialSection="focus" />);
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

    render(<BrightOsApp initialSection="focus" />);
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

    render(<BrightOsApp initialSection="focus" />);
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

    render(<BrightOsApp initialSection="focus" />);
    fireEvent.click(await screen.findByRole("button", { name: "История фокуса" }));
    await waitFor(() => expect(stateRequests).toBeGreaterThan(0));
    const stateRequestsBeforeFocus = stateRequests;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(stateRequests).toBeGreaterThan(stateRequestsBeforeFocus));
    await waitFor(() => expect(screen.getByRole("button", { name: "Запустить" })).toBeInTheDocument());
    expect(document.querySelector(".timer-digits")).toHaveAttribute("aria-label", "00:00:00");
  });

  it("applies live activity updates to active Actions and Archive", async () => {
    const sockets = stubWebSockets();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = requestUrl(input);
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

    render(<BrightOsApp />);
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

    render(<BrightOsApp />);
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

    render(<BrightOsApp />);

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-platform", "android"));
  });

  it("expands and collapses the desktop rail as a layout state", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    render(<BrightOsApp />);
    const shell = document.querySelector(".app-shell");
    const rail = document.querySelector(".desktop-rail");
    const topbar = document.querySelector(".section-page-current .topbar");

    expect(shell).toBeInstanceOf(HTMLElement);
    expect(rail).toBeInstanceOf(HTMLElement);
    expect(topbar?.querySelector("[data-screen-icon]")).toBeInTheDocument();
    expect(topbar?.querySelector('[aria-label="Свернуть меню"]')).not.toBeInTheDocument();
    expect(shell).toHaveClass("is-rail-expanded");
    expect(rail).toHaveClass("expanded");
    expect(document.documentElement).toHaveAttribute("data-sidebar-state", "expanded");
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(rail).toContainElement(screen.getByRole("button", { name: "Свернуть меню" }));
    expect(rail).toHaveTextContent("Меню страницы");
    expect(rail).toHaveTextContent("Действия");
    expect(rail).not.toHaveTextContent("Platform");
    expect(rail).not.toHaveTextContent("Time");
    expect(rail).not.toHaveTextContent("Фокус");

    fireEvent.click(screen.getByRole("button", { name: "Свернуть меню" }));
    expect(shell).not.toHaveClass("is-rail-expanded");
    expect(rail).not.toHaveClass("expanded");
    expect(document.documentElement).toHaveAttribute("data-sidebar-state", "collapsed");
    expect(document.cookie).toContain("sidebar_state=false");
    expect(topbar?.querySelector("[data-screen-icon]")).toBeInTheDocument();
    expect(topbar?.querySelector('[aria-label="Развернуть меню"]')).not.toBeInTheDocument();
    expect(rail).toContainElement(screen.getByRole("button", { name: "Развернуть меню" }));
    expect(rail).not.toHaveTextContent("Platform");
    expect(rail).not.toHaveTextContent("Time");
    expect(rail).not.toHaveTextContent("Действия");
    expect(rail).not.toHaveTextContent("Фокус");

    fireEvent.click(screen.getByRole("button", { name: "Развернуть меню" }));
    expect(shell).toHaveClass("is-rail-expanded");
    expect(rail).toHaveClass("expanded");
    expect(document.documentElement).toHaveAttribute("data-sidebar-state", "expanded");
    expect(document.cookie).toContain("sidebar_state=true");

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    expect(rail).toHaveTextContent("Меню страницы");
    expect(rail).toHaveTextContent("Фокус");
    expect(rail).not.toHaveTextContent("Действия");
  });

  it("restores the collapsed desktop rail after reload", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    document.cookie = "sidebar_state=false; path=/";
    render(<BrightOsApp />);

    await waitFor(() => {
      expect(document.querySelector(".app-shell")).not.toHaveClass("is-rail-expanded");
      expect(document.querySelector(".desktop-rail")).not.toHaveClass("expanded");
      expect(document.documentElement).toHaveAttribute("data-sidebar-state", "collapsed");
    });
  });

  it("opens the mobile profile drawer with navigation from primary screens and closes it by backdrop", async () => {
    render(<BrightOsApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    expect(document.querySelector(".mobile-menu-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-menu-backdrop > div")).toHaveClass("bg-foreground/15", "dark:bg-background/80");
    expect(document.querySelector(".mobile-profile-drawer")).toHaveTextContent("Workspace");
    expect(document.querySelector(".mobile-profile-drawer")).toHaveTextContent("Меню страницы");
    expect(document.querySelector(".mobile-profile-drawer")).toHaveTextContent("Действия");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Platform");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Time");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Фокус");
    expect(screen.getAllByRole("button", { name: "Открыть меню профиля" }).length).toBeGreaterThan(0);

    fireEvent.click(document.querySelector(".mobile-menu-backdrop") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".mobile-menu-backdrop")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Фокус" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    expect(document.querySelector(".mobile-menu-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".mobile-profile-drawer")).toHaveTextContent("Меню страницы");
    expect(document.querySelector(".mobile-profile-drawer")).toHaveTextContent("Фокус");
    expect(document.querySelector(".mobile-profile-drawer")).not.toHaveTextContent("Действия");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
