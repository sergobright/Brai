import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { actionsWidgetPlugin, audioPlay, cachedActivitiesState, openProfileMenuItem, setupBraiAppTest, stubAndroidCapacitor } from "./app-test-support";
import { BraiApp } from "@/features/app/BraiApp";
import { useBraiAppState } from "@/features/app/hooks/useBraiAppState";
import { ActionRow } from "@/features/app/sections/actions/ActionRow";
import { ActionsSection } from "@/features/app/sections/actions/ActionsSection";
import { TITLE_MAX_LENGTH } from "@/shared/activities/text";
import { BraiApi } from "@/shared/api/braiApi";
import { pendingActivityEvents, saveActivitiesState } from "@/shared/storage/activityStore";
import { clientDb, getMeta } from "@/shared/storage/db";
import { pendingEvents, saveCanonicalState } from "@/shared/storage/syncStore";
import { emptyActivitiesState } from "@/shared/types/activities";

describe("BraiApp actions", () => {
  setupBraiAppTest();

  it("hydrates cached actions when the session check is offline after a cold restart", async () => {
    await saveActivitiesState(cachedActivitiesState("action-offline-restart", "Офлайн после перезапуска"));
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("offline"));

    render(<BraiApp />);

    expect(await screen.findByRole("textbox", { name: "Название действия: Офлайн после перезапуска" })).toBeInTheDocument();
    expect(screen.queryByText("Загрузка действий")).not.toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Добавить" });
    fireEvent.change(input, { target: { value: "Новая офлайн-цель" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(async () => expect(await pendingActivityEvents()).toHaveLength(1));
  });

  it("preserves the current scope, screen, and cached actions when auth returns 503", async () => {
    await saveActivitiesState(cachedActivitiesState("action-auth-outage", "Действие во время сбоя auth"));
    window.history.replaceState(null, "", "/");
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({ error: "auth_backend_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected_request");
    });

    render(<BraiApp />);

    expect(await screen.findByRole("textbox", { name: "Название действия: Действие во время сбоя auth" })).toBeInTheDocument();
    expect(await getMeta<string>("currentUserId")).toBe("test-user");
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("button", { name: "Войти" })).not.toBeInTheDocument();
  });

  it("rejects ownerless local mutations until a delayed session binds the user", async () => {
    let resolveSession!: (value: { authenticated: true; user: { id: string; email: string; name: string } }) => void;
    const sessionResult = new Promise<{ authenticated: true; user: { id: string; email: string; name: string } }>((resolve) => {
      resolveSession = resolve;
    });
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockReturnValue(sessionResult);
    const { result } = renderHook(() => useBraiAppState("actions"));
    await waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());

    expect(result.current.localMutationReady).toBe(false);
    await expect(result.current.onCreateGoal("Слишком рано")).rejects.toThrow("local_user_scope_not_ready");
    expect(await pendingActivityEvents()).toEqual([]);

    await act(async () => {
      resolveSession({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
      await sessionResult;
    });
    await waitFor(() => expect(result.current.localMutationReady).toBe(true));

    await act(async () => result.current.onCreateGoal("После привязки"));
    expect(await pendingActivityEvents()).toHaveLength(1);
  });

  it("keeps the domain shell inert while the local owner scope is unresolved", async () => {
    let resolveSession!: (value: { authenticated: true; user: { id: string; email: string; name: string } }) => void;
    const sessionResult = new Promise<{ authenticated: true; user: { id: string; email: string; name: string } }>((resolve) => {
      resolveSession = resolve;
    });
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockReturnValue(sessionResult);

    render(<BraiApp />);
    await waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());
    const shell = document.querySelector("[data-app-shell]");
    expect(shell).toHaveAttribute("inert");
    expect(shell).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      resolveSession({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
      await sessionResult;
    });
    await waitFor(() => expect(shell).not.toHaveAttribute("inert"));
  });

  it("clears the cached user scope before syncing after a different user reconnects", async () => {
    await saveActivitiesState(cachedActivitiesState("action-old-user", "Действие прошлого пользователя"));
    let online = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/auth/session")) {
        return new Response(JSON.stringify({
          authenticated: true,
          user: { id: "other-user", email: "other@example.test", name: "Other" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("offline");
    });

    render(<BraiApp />);
    expect(await screen.findByRole("textbox", { name: "Название действия: Действие прошлого пользователя" })).toBeInTheDocument();

    online = true;
    window.dispatchEvent(new Event("online"));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название действия: Действие прошлого пользователя" })).not.toBeInTheDocument());
    expect(await getMeta<string>("currentUserId")).toBe("other-user");
  });

  it("keeps domain refresh behind one in-flight startup session check", async () => {
    let resolveSession!: (value: { authenticated: true; user: { id: string; email: string; name: string } }) => void;
    const sessionResult = new Promise<{ authenticated: true; user: { id: string; email: string; name: string } }>((resolve) => {
      resolveSession = resolve;
    });
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockReturnValue(sessionResult);
    const stateSpy = vi.spyOn(BraiApi.prototype, "state").mockRejectedValue(new Error("offline"));

    render(<BraiApp />);
    await waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("pageshow"));
      await Promise.resolve();
    });
    expect(sessionSpy).toHaveBeenCalledOnce();
    expect(stateSpy).not.toHaveBeenCalled();

    await act(async () => {
      resolveSession({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
      await sessionResult;
    });
    await waitFor(() => expect(stateSpy).toHaveBeenCalled());
  });

  it("aborts a direct settings mutation when revalidation switches user scope", async () => {
    let online = false;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
    vi.spyOn(BraiApi.prototype, "session").mockResolvedValue({
      authenticated: true,
      user: { id: "other-user", email: "other@example.test", name: "Other" },
    });
    const updateSettings = vi.spyOn(BraiApi.prototype, "updateSettings");
    const { result } = renderHook(() => useBraiAppState("actions"));
    await waitFor(() => expect(result.current.localSnapshotReady).toBe(true));

    online = true;
    let mutationError: unknown;
    await act(async () => {
      try {
        await result.current.onUpdateAppSettings({ display_timezone: "UTC" });
      } catch (error) {
        mutationError = error;
      }
    });

    expect(mutationError).toMatchObject({ message: "session_revalidation_required" });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(await getMeta<string>("currentUserId")).toBe("other-user");
  });

  it("does not let a late startup session undo an explicit logout", async () => {
    let resolveSession!: (value: { authenticated: true; user: { id: string; email: string; name: string } }) => void;
    const sessionResult = new Promise<{ authenticated: true; user: { id: string; email: string; name: string } }>((resolve) => {
      resolveSession = resolve;
    });
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockReturnValue(sessionResult);
    const logoutSpy = vi.spyOn(BraiApi.prototype, "logout").mockResolvedValue();
    const stateSpy = vi.spyOn(BraiApi.prototype, "state").mockRejectedValue(new Error("unexpected_domain_refresh"));
    const { result } = renderHook(() => useBraiAppState("actions"));
    await waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());

    await act(async () => result.current.onLogout());
    expect(logoutSpy).toHaveBeenCalledOnce();
    expect(await getMeta<string>("currentUserId")).toBeNull();

    await act(async () => {
      resolveSession({ authenticated: true, user: { id: "test-user", email: "test@example.com", name: "Test" } });
      await sessionResult;
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.displaySyncStatus).toBe("auth_required"));
    expect(result.current.authUser).toBeNull();
    expect(await getMeta<string>("currentUserId")).toBeNull();
    expect(stateSpy).not.toHaveBeenCalled();
  });

  it("keeps a truly fresh client mutation-locked when its startup session fails offline", async () => {
    await clientDb().meta.delete("currentUserId");
    expect(await clientDb().meta.get("currentUserId")).toBeUndefined();
    let online = true;
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
    const sessionSpy = vi.spyOn(BraiApi.prototype, "session").mockImplementation(async () => {
      online = false;
      throw new Error("offline");
    });
    const { result } = renderHook(() => useBraiAppState("actions"));

    await waitFor(() => expect(sessionSpy).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.displaySyncStatus).toBe("offline"));
    expect(result.current.localSnapshotReady).toBe(false);
    expect(result.current.localMutationReady).toBe(false);
    await expect(result.current.onCreateGoal("Без владельца")).rejects.toThrow("local_user_scope_not_ready");
    expect(await pendingActivityEvents()).toEqual([]);
  });

  it("adds an action and moves it to the completed group", async () => {
    render(<BraiApp />);
    await screen.findByText("Новых действий нет");
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: " Фокус " } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Выполнено 0/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Фокус" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Выполнено 1/ })).toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Фокус" })).toBeChecked();
    expect(audioPlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Фокус" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Фокус" })).not.toBeChecked());
    expect(audioPlay).toHaveBeenCalledTimes(1);
  });

  it("publishes Android widget snapshots for local create and status changes", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await waitFor(() => expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalled());
    actionsWidgetPlugin.saveSnapshot.mockClear();

    const input = screen.getByRole("textbox", { name: "Добавить" });
    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "New", title: "Фокус" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });

    actionsWidgetPlugin.saveSnapshot.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Фокус" }));

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "Done", title: "Фокус" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });

    actionsWidgetPlugin.saveSnapshot.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: "Фокус" }));

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "New", title: "Фокус" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });
  });

  it("does not let a slow old Android widget publish block the latest app snapshot", async () => {
    stubAndroidCapacitor();
    actionsWidgetPlugin.saveSnapshot
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue({});
    render(<BraiApp />);

    await waitFor(() => expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledTimes(1));

    const input = screen.getByRole("textbox", { name: "Добавить" });
    fireEvent.change(input, { target: { value: "Сразу" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "New", title: "Сразу" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });
  });

  it("publishes Android widget snapshots for mobile create before one second", async () => {
    stubAndroidCapacitor();
    render(<BraiApp />);

    await waitFor(() => expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalled());
    actionsWidgetPlugin.saveSnapshot.mockClear();

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const title = await screen.findByRole("textbox", { name: "Добавить действие" });
    fireEvent.change(title, { target: { value: "Мобильный виджет" } });
    fireEvent.click(screen.getByRole("button", { name: "Добавить действие" }));

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "New", title: "Мобильный виджет" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });
  });

  it("retries Android widget snapshot publishing when the app returns to foreground", async () => {
    stubAndroidCapacitor();
    await saveActivitiesState(cachedActivitiesState("action-widget-foreground", "Виджет"));
    actionsWidgetPlugin.saveSnapshot
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValue({});

    render(<BraiApp />);

    await waitFor(
      () => expect(screen.getByRole("checkbox", { name: "Виджет" })).toBeInTheDocument(),
      { timeout: 10_000 },
    );
    await waitFor(() => expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalled());
    actionsWidgetPlugin.saveSnapshot.mockClear();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: expect.arrayContaining([
          expect.objectContaining({ status: "New", title: "Виджет" }),
        ]),
        viewId: "all",
      }));
    }, { interval: 25, timeout: 900 });
  }, 15_000);

  it("applies Android widget status changes to the app in under one second", async () => {
    stubAndroidCapacitor();
    await saveActivitiesState(cachedActivitiesState("action-widget", "Виджет"));
    let changes: Array<{ id: string; actionId: string; status: "New" | "Done"; baseServerRevision: number; occurredAtUtc: string }> = [];
    actionsWidgetPlugin.pendingStatusChanges.mockImplementation(async () => ({ changes }));
    actionsWidgetPlugin.acknowledgeStatusChanges.mockImplementation(async ({ ids }: { ids: string[] }) => {
      changes = changes.filter((change) => !ids.includes(change.id));
      return {};
    });

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Виджет" })).not.toBeChecked());
    actionsWidgetPlugin.acknowledgeStatusChanges.mockClear();
    changes = [{
      id: "widget-change-1",
      actionId: "action-widget",
      status: "Done",
      baseServerRevision: 8,
      occurredAtUtc: "2026-07-04T12:00:00.000Z",
    }];

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Виджет" })).toBeChecked(), {
      interval: 25,
      timeout: 900,
    });
    expect(actionsWidgetPlugin.acknowledgeStatusChanges).toHaveBeenCalledWith({ ids: ["widget-change-1"] });
    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "action-widget",
          attemptCount: 1,
          lastError: "offline",
          payload: { status: "Done" },
          status: "failed",
          type: "set_status",
        }),
      ]));
    });
  });

  it("applies Android widget unchecked status to the app in under one second", async () => {
    stubAndroidCapacitor();
    await saveActivitiesState({
      ...cachedActivitiesState("action-widget-done", "Виджет"),
      actions: [{
        ...cachedActivitiesState("action-widget-done", "Виджет").actions[0],
        status: "Done",
        completed_at_utc: "2026-06-16T10:01:00.000Z",
      }],
    });
    let changes: Array<{ id: string; actionId: string; status: "New" | "Done"; baseServerRevision: number; occurredAtUtc: string }> = [];
    actionsWidgetPlugin.pendingStatusChanges.mockImplementation(async () => ({ changes }));
    actionsWidgetPlugin.acknowledgeStatusChanges.mockImplementation(async ({ ids }: { ids: string[] }) => {
      changes = changes.filter((change) => !ids.includes(change.id));
      return {};
    });

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Виджет" })).toBeChecked());
    actionsWidgetPlugin.acknowledgeStatusChanges.mockClear();
    changes = [{
      id: "widget-change-new",
      actionId: "action-widget-done",
      status: "New",
      baseServerRevision: 8,
      occurredAtUtc: "2026-07-04T12:00:00.000Z",
    }];

    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Виджет" })).not.toBeChecked(), {
      interval: 25,
      timeout: 900,
    });
    expect(actionsWidgetPlugin.acknowledgeStatusChanges).toHaveBeenCalledWith({ ids: ["widget-change-new"] });
    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          actionId: "action-widget-done",
          attemptCount: 1,
          lastError: "offline",
          payload: { status: "New" },
          status: "failed",
          type: "set_status",
        }),
      ]));
    });
  });

  it("publishes Android widget snapshots for deletes before one second", async () => {
    stubAndroidCapacitor();
    await saveActivitiesState(cachedActivitiesState("action-delete-widget", "Фокус"));
    render(<BraiApp />);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    actionsWidgetPlugin.saveSnapshot.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Фокус", hidden: true }));

    await waitFor(() => {
      expect(actionsWidgetPlugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        actions: [],
        viewId: "all",
      }));
    }, { timeout: 900 });
  });

  it("creates a mobile action with a description from the composer", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/activities/sync")) throw new Error("offline");
      if (!defaultFetch) throw new Error("missing_default_fetch");
      return await defaultFetch(input, init);
    });
    render(<BraiApp />);
    await screen.findByText("Новых действий нет");

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const title = screen.getByRole("textbox", { name: "Добавить действие" }) as HTMLTextAreaElement;
    await waitFor(() => expect(title).toHaveFocus());
    expect(title).toHaveAttribute("placeholder", "Что бы вы хотели сделать?");
    expect(title).toHaveAttribute("enterkeyhint", "enter");
    expect(document.querySelector(".mobile-create-grabber")).toHaveClass("h-1", "w-11");
    expect(document.querySelector(".mobile-create-text")).toHaveClass("overflow-y-auto");
    expect(title).toHaveClass("overflow-hidden", "text-lg/7", "font-semibold", "text-foreground");

    const description = screen.getByRole("textbox", { name: "Описание действия" }) as HTMLTextAreaElement;
    expect(description).toHaveClass("min-h-10", "overflow-hidden", "text-sm/5", "text-muted-foreground/75");
    expect(description).toHaveAttribute("placeholder", "");
    fireEvent.focus(description);
    expect(description).toHaveAttribute("placeholder", "Описание");
    expect(document.querySelectorAll(".mobile-create-tool-icon svg")).toHaveLength(6);
    const dateButton = screen.getByRole("button", { name: "Дата" });
    expect(dateButton).toHaveClass("mobile-create-tool-icon");
    dateButton.focus();
    expect(dateButton).toHaveFocus();
    fireEvent.click(dateButton);
    expect(screen.getByRole("textbox", { name: "Добавить действие" })).toBeInTheDocument();

    fireEvent.change(title, { target: { value: " Большой план " } });
    fireEvent.change(description, { target: { value: "Описание\nстрока 2" } });
    fireEvent.click(document.querySelector(".actions-mobile-overlay") as HTMLElement);
    await waitFor(() => expect(document.querySelector(".actions-mobile-overlay")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Продолжить черновик действия" })).toBeInTheDocument();

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const restoredTitle = screen.getByRole("textbox", { name: "Добавить действие" }) as HTMLTextAreaElement;
    const restoredDescription = screen.getByRole("textbox", { name: "Описание действия" }) as HTMLTextAreaElement;
    expect(restoredTitle).toHaveValue(" Большой план ");
    expect(restoredDescription).toHaveValue("Описание\nстрока 2");
    fireEvent.click(screen.getByRole("button", { name: "Добавить действие" }));

    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "create",
            payload: { title: "Большой план", description_md: "Описание\nстрока 2" },
          }),
        ]),
      );
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Продолжить черновик действия" })).not.toBeInTheDocument());
  });

  it("closes mobile action creation after local save and ignores duplicate submit taps", async () => {
    let resolveCreate: () => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<void>((resolve) => {
      resolveCreate = resolve;
    }));

    function Harness() {
      const [draft, setDraft] = useState({ title: "", descriptionMd: "" });
      return (
        <ActionsSection
          state={emptyActivitiesState(new Date("2026-07-04T12:00:00.000Z"))}
          localSnapshotReady
          autoFocusAddInput={false}
          activeActivityId={null}
          activeActivityElapsedSeconds={0}
          dockOverflowOpen={false}
          mobileCreateDraft={draft}
          onAutosaveDetails={vi.fn()}
          onCreate={onCreate}
          onDelete={vi.fn()}
          onMobileCreateDraftChange={setDraft}
          onMobileOverlayChange={vi.fn()}
          onReorder={vi.fn()}
          onSetStatus={vi.fn()}
          onStartActionFocus={vi.fn()}
          onStopActionFocus={vi.fn()}
          onUpdateTitle={vi.fn()}
        />
      );
    }

    render(<Harness />);

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const overlay = document.querySelector(".actions-mobile-overlay") as HTMLElement;
    fireEvent.change(within(overlay).getByRole("textbox", { name: "Добавить действие" }), { target: { value: "Один" } });
    const submit = within(overlay).getByRole("button", { name: "Добавить действие" });

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(onCreate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector(".actions-mobile-overlay")).not.toBeInTheDocument());

    await act(async () => resolveCreate());
    expect(document.querySelector(".actions-mobile-overlay")).not.toBeInTheDocument();
  });

  it("closes the mobile create composer by pulling down and keeps the draft", async () => {
    render(<BraiApp />);

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const editor = document.querySelector(".actions-mobile-editor") as HTMLElement;
    expect(editor).toBeInstanceOf(HTMLElement);
    fireEvent.change(screen.getByRole("textbox", { name: "Добавить действие" }), { target: { value: "Свайп-черновик" } });

    Object.defineProperty(editor, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 500, height: 400, left: 0, right: 360, top: 100, width: 360, x: 0, y: 100 }),
    });
    fireEvent.touchStart(editor, { changedTouches: [{ identifier: 1, clientX: 180, clientY: 120 }] });
    fireEvent.touchMove(editor, { changedTouches: [{ identifier: 1, clientX: 180, clientY: 260 }] });
    fireEvent.touchEnd(editor, { changedTouches: [{ identifier: 1, clientX: 180, clientY: 260 }] });

    await waitFor(() => expect(document.querySelector(".actions-mobile-overlay")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Продолжить черновик действия" }));
    expect(screen.getByRole("textbox", { name: "Добавить действие" })).toHaveValue("Свайп-черновик");
  });

  it("keeps separate mobile create drafts while switching Actions and Inbox", async () => {
    render(<BraiApp />);

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const actionOverlay = () => document.querySelector(".actions-mobile-overlay") as HTMLElement;
    const closeComposer = async () => {
      fireEvent.click(actionOverlay());
      await waitFor(() => expect(document.querySelector(".actions-mobile-overlay")).not.toBeInTheDocument());
    };

    const actionTitle = within(actionOverlay()).getByRole("textbox", { name: "Добавить действие" });
    fireEvent.change(actionTitle, { target: { value: "Черновик действия" } });
    await closeComposer();
    expect(document.querySelector(".actions-fab")).toHaveAttribute("aria-label", "Продолжить черновик действия");

    fireEvent.click(screen.getAllByRole("button", { name: "Входящие" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    expect(document.querySelector(".actions-fab")).toHaveAttribute("aria-label", "Добавить входящее");

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const inboxTitle = within(actionOverlay()).getByRole("textbox", { name: "Добавить входящее" });
    fireEvent.change(inboxTitle, { target: { value: "Черновик входящего" } });
    await closeComposer();
    expect(document.querySelector(".actions-fab")).toHaveAttribute("aria-label", "Продолжить черновик входящего");

    fireEvent.click(screen.getAllByRole("button", { name: "Действия" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Продолжить черновик действия" }));
    expect(within(actionOverlay()).getByRole("textbox", { name: "Добавить действие" })).toHaveValue("Черновик действия");
    await closeComposer();

    fireEvent.click(screen.getAllByRole("button", { name: "Входящие" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Продолжить черновик входящего" }));
    expect(within(actionOverlay()).getByRole("textbox", { name: "Добавить входящее" })).toHaveValue("Черновик входящего");
  });

  it("restores a mobile create draft after the app remounts", async () => {
    const { unmount } = render(<BraiApp />);

    fireEvent.click(document.querySelector(".actions-fab") as HTMLElement);
    const overlay = () => document.querySelector(".actions-mobile-overlay") as HTMLElement;
    fireEvent.change(within(overlay()).getByRole("textbox", { name: "Добавить действие" }), {
      target: { value: "Черновик после закрытия" },
    });
    fireEvent.change(within(overlay()).getByRole("textbox", { name: "Описание действия" }), {
      target: { value: "Описание тоже осталось" },
    });

    unmount();
    render(<BraiApp />);

    fireEvent.click(screen.getByRole("button", { name: "Продолжить черновик действия" }));
    expect(within(overlay()).getByRole("textbox", { name: "Добавить действие" })).toHaveValue("Черновик после закрытия");
    expect(within(overlay()).getByRole("textbox", { name: "Описание действия" })).toHaveValue("Описание тоже осталось");
  });

  it("does not complete an action when its title is clicked", async () => {
    render(<BraiApp />);
    await screen.findByText("Новых действий нет");
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    const title = await screen.findByRole("textbox", { name: "Название действия: Фокус" });
    fireEvent.click(title);

    expect(screen.getByRole("checkbox", { name: "Фокус" })).not.toBeChecked();
    expect(screen.queryByRole("button", { name: /Выполнено 1/ })).not.toBeInTheDocument();
  });

  it("deletes an action from the list", async () => {
    render(<BraiApp />);
    await screen.findByText("Новых действий нет");
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Фокус", hidden: true }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название действия: Фокус" })).not.toBeInTheDocument());
  });

  it("opens Archive from the profile menu and restores a deleted action", async () => {
    render(<BraiApp />);
    await screen.findByText("Новых действий нет");
    const input = screen.getByRole("textbox", { name: "Добавить" });

    fireEvent.change(input, { target: { value: "Фокус" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Удалить: Фокус", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название действия: Фокус" })).not.toBeInTheDocument());

    await openProfileMenuItem("Архив");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Архив" })).toBeInTheDocument());
    const archiveList = screen.getByRole("region", { name: "Архив: Activities" });
    expect(within(archiveList).getByText("Фокус")).toBeInTheDocument();
    expect(archiveList.querySelector(".action-focus-button")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Восстановить: Фокус" }));
    await waitFor(() => expect(within(archiveList).queryByText("Фокус")).not.toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Действия" }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument());
  }, 15_000);

  it("shows the cached Actions snapshot before the network refresh finishes", async () => {
    await saveActivitiesState({
      server_time_utc: "2026-06-16T12:00:00.000Z",
      server_revision: 3,
      actions: [
        {
          id: "action-cached",
          title: "Кэшированное действие",
          description_md: "",
          status: "New",
          created_at_utc: "2026-06-16T10:00:00.000Z",
          updated_at_utc: "2026-06-16T10:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
      ],
      archived_actions: [],
    });

    render(<BraiApp />);

    expect(screen.queryByText("Новых действий нет")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Кэшированное действие")).toBeInTheDocument());
  });

  it("opens the desktop activity detail panel and flushes description on close", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-detail", "Детальное действие"));

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByText("Детальное действие")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Детальное действие" }));
    expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument();
    const detailPanel = screen.getByLabelText("Редактирование действия");
    expect(detailPanel).toHaveClass("px-0");
    const detailTitle = screen.getByRole("textbox", { name: "Название действия" });
    const detailTabs = detailPanel.querySelector(".actions-detail-tabs") as HTMLElement;
    expect(detailTabs.compareDocumentPosition(detailTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(detailTitle.closest(".actions-detail-title-block")).toHaveClass("mt-6");
    expect(detailTitle).not.toHaveClass("truncate");
    expect(detailPanel).toHaveClass("overflow-hidden");
    const limitedTitle = "А".repeat(TITLE_MAX_LENGTH);
    fireEvent.change(detailTitle, { target: { value: `${limitedTitle}лишнее` } });
    await waitFor(() => expect(detailTitle).toHaveValue(limitedTitle));
    expect(detailPanel.querySelector(".actions-detail-title-counter")).toHaveTextContent("0");
    expect(detailPanel.querySelector(".actions-detail-title-counter")).toHaveClass("text-destructive");
    const detailScroll = detailPanel.querySelector(".actions-detail-description-scroll");
    expect(detailScroll).toBeInTheDocument();
    expect(detailScroll?.parentElement).toBe(detailPanel);
    expect(screen.getByRole("tab", { name: "Инфо" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Связи" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "История" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Детали" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "БД" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    expect(await screen.findByText("Для этого действия AI workflow ещё не запускался.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Детали" }));
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Инфо" }));
    const splitSlider = screen.getByRole("slider", { name: "Изменить ширину панелей" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(splitSlider, { key: "End" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(splitSlider, { key: "Home" });
    expect(splitSlider).toHaveAttribute("aria-valuenow", "30");
    const storageKeys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? "");
    expect(storageKeys.join(" ")).not.toMatch(/split|ratio|pane/i);

    const descriptionEditor = screen.getByRole("textbox", { name: "Описание действия" });
    expect(descriptionEditor.closest("[data-slot='scroll-area']")).toBeInTheDocument();
    expect(descriptionEditor).toHaveClass("overflow-hidden", "before:float-right", "before:w-12");
    descriptionEditor.textContent = "# Большое описание\n\n## Цель\n\n**важно**";
    fireEvent.input(descriptionEditor);
    const readModeButton = screen.getByRole("button", { name: "Читать описание" });
    expect(detailPanel.querySelector(".actions-detail-header .actions-detail-preview-toggle")).not.toBeInTheDocument();
    expect(detailPanel.querySelector(".actions-detail-description-scroll .actions-detail-preview-toggle")).toBeInTheDocument();
    expect(readModeButton).toHaveClass("absolute");
    expect(readModeButton).not.toHaveClass("float-right");
    expect(readModeButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(readModeButton);
    await waitFor(() => expect(screen.getByRole("button", { name: "Редактировать описание" })).toHaveAttribute("aria-pressed", "true"));
    expect(window.localStorage.getItem("brai_activity_md_preview")).toBe("true");
    expect(screen.getByLabelText("MD просмотр описания действия").closest("[data-slot='scroll-area']")).toBeInTheDocument();
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Большое описание");
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Цель");
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("важно");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("# Цель");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("##");
    expect(screen.getByLabelText("MD просмотр описания действия")).not.toHaveTextContent("**");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));

    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-detail",
            type: "update_description",
            payload: { description_md: "# Большое описание\n\n## Цель\n\n**важно**" },
          }),
        ]),
      );
    });
  }, 10_000);

  it("shows Action AI badges and workflow details", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState({
      server_time_utc: "2026-07-12T12:00:00.000Z",
      server_revision: 17,
      actions: [
        {
          id: "action-ai-running",
          title: "Действие на AI",
          description_md: "",
          status: "New",
          created_at_utc: "2026-07-12T10:00:00.000Z",
          updated_at_utc: "2026-07-12T10:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
          item_roles_id: null,
          initial_event_id: "activity:create-running",
          workflow_execution_id: 21,
          workflow_status: "running",
          workflow_step: "raw_normalizer",
          workflow_attempt_count: 1,
          workflow_last_error: null,
          temporal_workflow_id: "brai:activity:action-ai-running",
          temporal_run_id: "run-activity-21",
          ai_processing_status: "running",
          ai_processing_error: null,
        },
        {
          id: "action-ai-done",
          title: "Нормализованное действие",
          description_md: "",
          status: "New",
          created_at_utc: "2026-07-12T09:00:00.000Z",
          updated_at_utc: "2026-07-12T09:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
          item_roles_id: null,
          initial_event_id: "activity:create-done",
          workflow_execution_id: 22,
          workflow_status: "completed",
          workflow_step: "apply_normalized_raw",
          workflow_attempt_count: 1,
          workflow_last_error: null,
          temporal_workflow_id: "brai:activity:action-ai-done",
          temporal_run_id: "run-activity-22",
          ai_processing_status: "running",
          ai_processing_error: null,
        },
      ],
      archived_actions: [],
    });

    const baseFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/activities/action-ai-running/workflow")) {
        return new Response(JSON.stringify({
          definition: {
            id: "activity.raw-normalization",
            version: 1,
            title: "Activity raw normalization",
            task_queue: "brai-inbox-normalization",
            steps: ["ingest", "dispatch", "prepare_raw", "image_describer", "raw_normalizer", "apply_normalized_raw"],
            input_schema_version: "brai.activity.raw.v1",
            output_schema_version: "brai.activity.normalized.v1",
          },
          execution: {
            workflow_id: "brai:activity:action-ai-running",
            run_id: "run-activity-21",
            status: "running",
            current_step: "raw_normalizer",
            attempt_count: 1,
            last_error: null,
          },
          step_states: [
            { id: "ingest", state: "completed", reason: null },
            { id: "dispatch", state: "completed", reason: null },
            { id: "prepare_raw", state: "completed", reason: null },
            { id: "image_describer", state: "skipped", reason: "not_required" },
            { id: "raw_normalizer", state: "running", reason: null },
            { id: "apply_normalized_raw", state: "pending", reason: null },
          ],
          attempts: [{
            id: 77,
            agent_id: "activity.normalizer",
            status: "done",
            ai_title: "Разобрал Activity-запись",
            attempt_number: 1,
            json_data: { metadata: {} },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return baseFetch(input, init);
    }));

    render(<BraiApp />);

    const runningTitle = await screen.findByRole("textbox", { name: "Название действия: Действие на AI" });
    const runningRow = runningTitle.closest(".action-row") as HTMLElement;
    expect(within(runningRow).getByText("AI-working")).toBeInTheDocument();
    const normalizedTitle = screen.getByRole("textbox", { name: "Название действия: Нормализованное действие" });
    const normalizedRow = normalizedTitle.closest(".action-row") as HTMLElement;
    expect(within(normalizedRow).getByText("AI")).toBeInTheDocument();
    expect(within(normalizedRow).queryByText("AI-working")).not.toBeInTheDocument();

    fireEvent.click(runningTitle);
    fireEvent.click(screen.getByRole("tab", { name: "AI" }));
    expect((await screen.findByText(/image_describer/)).closest("[data-workflow-step-state]"))
      .toHaveAttribute("data-workflow-step-state", "skipped");
    expect((await screen.findByText("raw_normalizer")).closest("[data-workflow-step-state]"))
      .toHaveAttribute("data-workflow-step-state", "running");
    expect(screen.getByText("activity.normalizer")).toBeInTheDocument();
    expect(screen.getByText("brai:activity:action-ai-running")).toBeInTheDocument();
  });

  it("keeps autosaved action description when sync ack returns stale equal-revision state", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    const staleState = cachedActivitiesState("action-stale-description", "Стабильное действие");
    await saveActivitiesState(staleState);

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByText("Стабильное действие")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Стабильное действие" }));
    const fetchMock = vi.mocked(fetch);
    let syncCalled = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/activities/events/sync")) {
        syncCalled = true;
        const body = JSON.parse(String(init?.body ?? "{}")) as { events?: Array<{ event_id: string }> };
        return new Response(JSON.stringify({
          acknowledged_event_ids: (body.events ?? []).map((event) => event.event_id),
          ignored_events: [],
          server_revision: staleState.server_revision,
          server_time_utc: staleState.server_time_utc,
          state: {
            server_time_utc: staleState.server_time_utc,
            server_revision: staleState.server_revision,
            activities: staleState.actions,
            archived_activities: [],
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    });

    const descriptionEditor = screen.getByRole("textbox", { name: "Описание действия" });
    descriptionEditor.textContent = "Свежее описание";
    fireEvent.input(descriptionEditor);
    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));

    await waitFor(() => expect(syncCalled).toBe(true));
    await waitFor(async () => expect(await pendingActivityEvents()).toEqual([]));
    expect(screen.getByText("Свежее описание")).toBeInTheDocument();
  });

  it("keeps desktop action rows aligned and visually bounded", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState({
      server_time_utc: "2026-06-20T12:00:00.000Z",
      server_revision: 9,
      actions: [
        {
          id: "action-long",
          title: "Очень длинное действие которое должно занимать только две строки и мягко исчезать",
          description_md: "Тихое описание действия",
          status: "New",
          created_at_utc: "2026-06-20T10:00:00.000Z",
          updated_at_utc: "2026-06-20T10:00:00.000Z",
          completed_at_utc: null,
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
        {
          id: "action-done",
          title: "Завершенное действие",
          description_md: "",
          status: "Done",
          created_at_utc: "2026-06-20T09:00:00.000Z",
          updated_at_utc: "2026-06-20T09:30:00.000Z",
          completed_at_utc: "2026-06-20T09:30:00.000Z",
          sort_order: null,
          deleted_at_utc: null,
          restored_at_utc: null,
        },
      ],
      archived_actions: [],
    });

    render(<BraiApp />);

    const activeTitle = await screen.findByRole("textbox", { name: /Название действия: Очень длинное действие/ });
    const activeRow = activeTitle.closest(".action-row") as HTMLElement;
    const completedTitle = screen.getByRole("textbox", { name: "Название действия: Завершенное действие" });
    const completedRow = completedTitle.closest(".action-row") as HTMLElement;
    const completedToggle = screen.getByRole("button", { name: "Выполнено 1" });

    expect(activeRow.querySelector(".action-row-surface")).toHaveClass("grid-cols-[20px_28px_minmax(0,1fr)]");
    expect(completedRow.querySelector(".action-row-surface")).toHaveClass("grid-cols-[20px_28px_minmax(0,1fr)]");
    expect(activeRow).toHaveClass("max-[860px]:select-none");
    expect(completedRow).toHaveClass("max-[860px]:select-none");
    expect(activeRow.querySelector(".action-drag-handle svg")).toBeInTheDocument();
    expect(completedRow.querySelector(".action-drag-placeholder")).toBeInTheDocument();
    expect(completedRow.querySelector(".action-drag-handle")).not.toBeInTheDocument();
    expect(activeTitle).toHaveClass("max-h-12", "overflow-hidden", "text-base/6");
    expect(activeTitle).toHaveAttribute("data-title-fade");
    expect(activeRow.querySelector(".action-description-preview")?.className).toContain("text-xs/5");
    expect(activeRow.querySelector(".action-description-preview")?.className).toContain("text-muted-foreground/70");
    expect(completedToggle).toHaveClass("text-sm", "font-medium");
    expect(completedToggle.querySelector("svg.toggle-caret")).toBeInTheDocument();
    expect(completedToggle.querySelector("strong")).toHaveClass("text-primary");

    fireEvent.click(activeRow.querySelector(".action-row-surface") as HTMLElement);
    await waitFor(() => expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument());
    expect(activeRow).toHaveClass("selected", "bg-primary/10");
    expect(activeRow).toHaveClass("rounded-lg", "border-b-transparent");
    expect(activeRow).toHaveClass("[&:has(+_.action-row.selected)]:border-b-transparent");
    expect(activeRow).not.toHaveClass("grid-cols-[minmax(0,1fr)_44px_44px]");
    const deleteButton = activeRow.querySelector(".action-delete-button") as HTMLElement;
    const focusButton = activeRow.querySelector(".action-focus-button") as HTMLElement;
    expect(activeRow).toContainElement(deleteButton);
    expect(activeRow.querySelector(".action-row-controls")).toContainElement(deleteButton);
    expect(activeRow.querySelector(".action-row-controls")).toContainElement(focusButton);
    expect(deleteButton.compareDocumentPosition(focusButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("queues action focus from a desktop action row", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-focus", "Фокус"));

    render(<BraiApp />);

    await waitFor(
      () => expect(document.querySelector("[data-app-shell]")).not.toHaveAttribute("inert"),
      { timeout: 10_000 },
    );
    expect(screen.getByRole("textbox", { name: "Название действия: Фокус" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Фокусироваться: Фокус", hidden: true }));

    await waitFor(async () =>
      expect(await pendingEvents()).toEqual([
        expect.objectContaining({
          type: "start_activity_focus",
          metadata: { activity_id: "action-focus" },
        }),
      ]),
    );
  }, 15_000);

  it("shows and stops active action focus from a desktop action row", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    const startedAtUtc = new Date(Date.now() - 120_000).toISOString();
    await saveActivitiesState(cachedActivitiesState("action-focus", "Фокус"));
    await saveCanonicalState({
      server_time_utc: new Date().toISOString(),
      server_revision: 5,
      timezone: "Europe/Moscow",
      active_session: {
        id: "session-active",
        started_at_utc: startedAtUtc,
        ended_at_utc: null,
        duration_seconds: null,
        intervals: [
          {
            id: "interval-active",
            focus_session_id: "session-active",
            activity_id: "action-focus",
            activity_title: "Фокус",
            started_at_utc: startedAtUtc,
            ended_at_utc: null,
            duration_seconds: null,
          },
        ],
        active_interval: {
          id: "interval-active",
          focus_session_id: "session-active",
          activity_id: "action-focus",
          activity_title: "Фокус",
          started_at_utc: startedAtUtc,
          ended_at_utc: null,
          duration_seconds: null,
        },
        active_activity_id: "action-focus",
        start_origin: "activity",
        started_by_activity_id: "action-focus",
      },
      elapsed_seconds: 120,
      active_interval: {
        id: "interval-active",
        focus_session_id: "session-active",
        activity_id: "action-focus",
        activity_title: "Фокус",
        started_at_utc: startedAtUtc,
        ended_at_utc: null,
        duration_seconds: null,
      },
      active_interval_elapsed_seconds: 120,
      active_activity_id: "action-focus",
      active_session_start_origin: "activity",
      active_session_started_by_activity_id: "action-focus",
    });

    render(<BraiApp />);

    await waitFor(
      () => expect(document.querySelector("[data-app-shell]")).not.toHaveAttribute("inert"),
      { timeout: 10_000 },
    );
    const stopButton = screen.getByRole("button", { name: "Остановить фокус: Фокус" });
    expect(within(stopButton).queryByText("Стоп")).not.toBeInTheDocument();
    expect(stopButton.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(stopButton);

    await waitFor(async () =>
      expect(await pendingEvents()).toEqual([
        expect.objectContaining({
          type: "stop_activity_focus",
          metadata: { activity_id: "action-focus" },
        }),
      ]),
    );
  }, 15_000);

  it("requires a second mobile tap before stopping active action focus", async () => {
    vi.useFakeTimers();
    try {
      const onStopFocus = vi.fn(async () => undefined);
      render(
        <ActionRow
          action={{
            id: "action-focus",
            title: "Фокус",
            description_md: "",
            status: "New",
            created_at_utc: "2026-06-16T10:00:00.000Z",
            updated_at_utc: "2026-06-16T10:00:00.000Z",
            completed_at_utc: null,
            sort_order: null,
            deleted_at_utc: null,
            restored_at_utc: null,
          }}
          selected={false}
          activeFocus
          activeFocusElapsedSeconds={120}
          deleteOpen={false}
          onCloseDelete={() => undefined}
          onDelete={async () => undefined}
          onEditMobile={() => undefined}
          onOpenDelete={() => undefined}
          onSelect={() => undefined}
          onSetStatus={async () => undefined}
          onStopFocus={onStopFocus}
          onUpdateTitle={async () => undefined}
        />,
      );

      const stopButton = screen.getByRole("button", { name: "Остановить фокус: Фокус" });
      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1700);
      });
      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(stopButton);
      });
      expect(onStopFocus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mirrors desktop title drafts between the list and detail editor", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-title-draft", "Черновик"));

    render(<BraiApp />);

    const listTitle = await screen.findByRole("textbox", { name: "Название действия: Черновик" });
    const row = listTitle.closest(".action-row") as HTMLElement;
    fireEvent.click(row.querySelector(".action-row-surface") as HTMLElement);
    const detailTitle = await screen.findByRole("textbox", { name: "Название действия" });
    expect(document.activeElement).toBe(detailTitle);

    fireEvent.change(detailTitle, { target: { value: "Из detail без переноса" } });
    const mirroredListTitle = await screen.findByRole("textbox", { name: "Название действия: Из detail без переноса" });
    expect(detailTitle).toHaveValue("Из detail без переноса");
    expect(mirroredListTitle).toHaveTextContent("Из detail без переноса");

    const description = screen.getByRole("textbox", { name: "Описание действия" });
    description.textContent = "Описание";
    fireEvent.input(description);
    fireEvent.keyDown(detailTitle, { key: "Enter" });
    expect(document.activeElement).toBe(description);

    mirroredListTitle.textContent = "Из списка";
    fireEvent.input(mirroredListTitle);
    await waitFor(() => expect(detailTitle).toHaveValue("Из списка"));

    fireEvent.blur(mirroredListTitle);
    await waitFor(async () => {
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-title-draft",
            type: "update_title",
            payload: { title: "Из списка" },
          }),
        ]),
      );
    });
  });

  it("opens the desktop side panel only for a selected Action", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        media: "(max-width: 860px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
    await saveActivitiesState(cachedActivitiesState("action-info-replace", "Информационная замена"));

    render(<BraiApp />);

    expect(screen.queryByRole("button", { name: "Информация о действиях" })).not.toBeInTheDocument();
    expect(document.querySelector(".actions-info-panel.desktop")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText("Информационная замена")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Информационная замена" }));
    expect(document.querySelector(".actions-info-panel.desktop")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Закрыть редактор" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть редактор" }));
    expect(document.querySelector(".actions-info-panel.desktop")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Закрыть редактор" })).not.toBeInTheDocument();
  }, 10_000);

  it("opens the mobile full-screen detail editor and flushes through the Android back bridge", async () => {
    await saveActivitiesState(cachedActivitiesState("action-mobile-detail", "Мобильное действие"));

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByText("Мобильное действие")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Мобильное действие" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Сохранить и закрыть" })).toBeInTheDocument());

    const plainDescription = "https://magicui.design/docs/templates/changelog использовать вот этот\nшаблон";
    const descriptionEditor = screen.getByRole("textbox", { name: "Описание действия" });
    descriptionEditor.textContent = plainDescription;
    fireEvent.input(descriptionEditor);
    fireEvent.click(screen.getByRole("button", { name: "Читать описание" }));
    const preview = await screen.findByLabelText("MD просмотр описания действия");
    expect(preview).toHaveTextContent("https://magicui.design/docs/templates/changelog");
    expect(preview.querySelector(".markdown-content")).toBeNull();
    expect(preview.querySelector(".whitespace-pre-wrap")).toHaveClass("leading-[1.48]");
    fireEvent.click(screen.getByRole("button", { name: "Редактировать описание" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Описание действия" }).textContent).toBe(plainDescription));
    expect(window.localStorage.getItem("brai_activity_md_preview")).toBe("false");
    await waitFor(() => expect(window.BraiAndroidBack).toBeTypeOf("function"));
    expect(window.BraiAndroidBack?.()).toBe(true);

    await waitFor(async () => {
      expect(screen.queryByRole("button", { name: "Сохранить и закрыть" })).not.toBeInTheDocument();
      expect(await pendingActivityEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actionId: "action-mobile-detail",
            type: "update_description",
            payload: { description_md: plainDescription },
          }),
        ]),
      );
    }, { timeout: 8_000 });
  }, 15_000);

  it("restores the global activity Markdown preview preference", async () => {
    window.localStorage.setItem("brai_activity_md_preview", "true");
    await saveActivitiesState(cachedActivitiesState("action-preview-preference", "Сохраненный режим", "## Цель"));

    render(<BraiApp />);

    await waitFor(() => expect(screen.getByText("Сохраненный режим")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("textbox", { name: "Название действия: Сохраненный режим" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Редактировать описание" })).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByLabelText("MD просмотр описания действия")).toHaveTextContent("Цель");
    expect(screen.queryByRole("textbox", { name: "Описание действия" })).not.toBeInTheDocument();
  });
});
