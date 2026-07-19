import { useCallback, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BraiChatSection, BraiContextPanelActions } from "@/features/app/sections/brai/BraiChatSection";
import type { BraiContextPanel } from "@/features/app/sections/brai/braiChatModel";
import { DesktopRail, MainDock } from "@/features/app/navigation/AppNavigation";
import { emptyTimerState } from "@/shared/types/timer";
import { SidebarProvider } from "@/shared/ui/sidebar";

const chatFixture = vi.hoisted(() => ({
  delayedNextMessages: null as null | { promise: Promise<Response>; resolve: (response: Response) => void },
  events: [] as Array<Record<string, unknown>>,
  failUrls: [] as string[],
  messages: [] as Array<Record<string, unknown>>,
  messageIds: [] as string[],
  retry: vi.fn(async () => undefined),
  searchResults: [] as Array<Record<string, unknown>>,
  threadSnapshots: [] as Array<Array<Record<string, unknown>>>,
  threads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/app/sections/brai/BraiCopilotSurface", () => ({
  BraiCopilotSurface: (props: Record<string, unknown>) => (
    <div data-testid="copilot-chat" data-thread-id={props.threadId as string}>
      {chatFixture.messageIds.map((id) => <div key={id} id={`brai-message-${id}`} />)}
      <button type="button" onClick={() => {
        (props.onRetryChange as (retry: () => Promise<void>) => void)(chatFixture.retry);
        (props.onError as (message: string, retryable: boolean) => void)("Ранний сбой", true);
      }}>Вызвать ранний сбой</button>
      <button type="button" onClick={() => (props.onRunFinished as () => void)()}>Завершить тестовый run</button>
      <button type="button" onClick={() => (props.onComposerReady as () => void)()}>Композитор готов</button>
    </div>
  ),
}));

describe("Brai chat client", () => {
  beforeEach(() => {
    window.localStorage.clear();
    chatFixture.delayedNextMessages = null;
    chatFixture.events = [];
    chatFixture.failUrls = [];
    chatFixture.messages = [];
    chatFixture.messageIds = [];
    chatFixture.retry.mockClear();
    chatFixture.searchResults = [];
    chatFixture.threadSnapshots = [];
    chatFixture.threads = [thread];
    window.history.replaceState({}, "", window.location.href);
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (chatFixture.failUrls.some((part) => url.includes(part))) return json({ error: "failed" }, 503);
      if (url.includes("/threads?")) return json({ threads: chatFixture.threadSnapshots.shift() ?? chatFixture.threads });
      if (url.includes("/messages")) {
        const delayed = chatFixture.delayedNextMessages;
        if (delayed) {
          chatFixture.delayedNextMessages = null;
          return delayed.promise;
        }
        return json({ messages: chatFixture.messages, next_cursor: null });
      }
      if (url.includes("/events")) return json({ events: chatFixture.events, next_cursor: null });
      if (url.includes("/attachments/")) return new Response(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        { status: 200, headers: { "content-type": "image/png" } },
      );
      if (url.includes("/search")) return json({ results: chatFixture.searchResults });
      if (url.includes("/models")) return json({
        models: [{ id: "codex", display_name: "GPT-5.6-Luna", reasoning_efforts: ["medium"] }],
        default_model: "codex",
        default_reasoning_effort: "medium",
      });
      if (url.endsWith("/threads") && !url.includes("?")) return json({ thread: { ...thread, id: "thread-2", title: "Новый чат" } }, 201);
      return json({});
    }));
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:brai-image"),
      revokeObjectURL: vi.fn(),
    }));
  });

  it("renders the dominant self-hosted chat and thread lifecycle controls", async () => {
    renderChat();

    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));
    expect(screen.getByRole("region", { name: "Чат с Браем" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Чаты Брая" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /Панель/ })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Поиск по чатам" })).toHaveAttribute("id", "brai-chat-search");
    expect(screen.getByRole("searchbox", { name: "Поиск по чатам" })).toHaveAttribute("name", "query");
    expect(screen.getByRole("list", { name: "Чаты" })).toHaveAttribute("data-sidebar", "menu");
    expect(screen.getByRole("list", { name: "Чаты" }).closest("[data-sidebar=content]")).toHaveClass(
      "[&_[data-slot=scroll-area-viewport]]:!pr-0",
    );
    expect(screen.getByRole("button", { name: "Действия чата: Проверка чата" })).toHaveAttribute("data-slot", "dropdown-menu-trigger");
    expect(screen.getByRole("button", { name: "Действия чата: Проверка чата" }).closest("li")).toHaveAttribute("data-sidebar", "menu-item");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Docs" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("combobox", { name: "Модель Брая" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Глубина рассуждений Брая" })).toBeInTheDocument();
    expect(screen.queryByText("Только чтение")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать архив чатов" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("archived=archived"), expect.any(Object)));
  });

  it("opens the last active thread remembered for this user and environment", async () => {
    const remembered = { ...thread, id: "thread-remembered", title: "Последний чат" };
    chatFixture.threads = [thread, remembered];
    window.localStorage.setItem("brai_chat_last_thread:user-1:%2Fapi", remembered.id);

    renderChat();

    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", remembered.id));
    expect(screen.getAllByText("Последний чат")).toHaveLength(2);
  });

  it("shows a focused new-chat launch state until the composer is ready", async () => {
    renderChat();
    await screen.findByTestId("copilot-chat");

    fireEvent.click(screen.getByRole("button", { name: "Новый чат" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Запускается новый чат…");
    expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-2");
    fireEvent.click(screen.getByRole("button", { name: "Композитор готов" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("opens, switches and closes one standard context panel from the header actions", async () => {
    renderChat();
    await screen.findByTestId("copilot-chat");

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByRole("complementary", { name: "Панель Preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("complementary", { name: "Панель Preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Панель Code" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Code" }));
    expect(screen.queryByRole("complementary", { name: /Панель/ })).not.toBeInTheDocument();
  });

  it("uses the shared mobile context sheet for Preview, Code and Docs", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    renderChat();
    await screen.findByTestId("copilot-chat");

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));

    expect(screen.getByRole("complementary", { name: "Docs" })).toHaveClass("mobile-context-sheet");
    expect(window.history.state?.braiMobileSheet).toBe("Docs");
  });

  it("refreshes history and the thread title after a run finishes", async () => {
    renderChat();
    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toBeInTheDocument());
    const before = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/messages")).length;

    fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/messages")).length).toBeGreaterThan(before));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/events")).length).toBeGreaterThan(1);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/threads?")).length).toBeGreaterThan(1);
  });

  it("refreshes a generated title after 2 seconds without restoring event polling", async () => {
    const titleTimers = captureGeneratedTitleTimers();
    try {
      renderChat();
      await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));
      chatFixture.threadSnapshots = [
        [thread],
        [{ ...thread, title: "Весеннее хайку" }],
      ];

      fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));

      await waitFor(() => expect(titleTimers.callbacks.size).toBe(3));
      expect([...titleTimers.callbacks.keys()]).toEqual([2_000, 10_000, 35_000]);
      expect(screen.getAllByText("Проверка чата")).toHaveLength(2);

      await act(async () => {
        titleTimers.callbacks.get(2_000)?.();
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getAllByText("Весеннее хайку")).toHaveLength(2));
      const eventRequests = vi.mocked(fetch).mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/events?"));
      expect(eventRequests.length).toBeGreaterThan(0);
      expect(eventRequests.every((url) => url.includes("after=0"))).toBe(true);
    } finally {
      titleTimers.restore();
    }
  });

  it("blocks a delayed generated-title refresh after switching threads", async () => {
    const titleTimers = captureGeneratedTitleTimers();
    try {
      chatFixture.threads = [thread, { ...thread, id: "thread-2", title: "Следующий чат" }];
      renderChat();
      await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));
      chatFixture.threadSnapshots = [[...chatFixture.threads]];
      fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));
      await waitFor(() => expect(titleTimers.callbacks.size).toBe(3));

      fireEvent.click(screen.getByRole("button", { name: "Следующий чат" }));
      await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-2"));
      const beforeDelayedRefresh = threadRequestCount();

      await act(async () => {
        titleTimers.callbacks.get(2_000)?.();
        await Promise.resolve();
      });

      expect(threadRequestCount()).toBe(beforeDelayedRefresh);
      expect(screen.getAllByText("Следующий чат")).toHaveLength(2);
    } finally {
      titleTimers.restore();
    }
  });

  it("blocks a delayed generated-title refresh after switching archive mode", async () => {
    const titleTimers = captureGeneratedTitleTimers();
    try {
      renderChat();
      await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));
      chatFixture.threadSnapshots = [[thread]];
      fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));
      await waitFor(() => expect(titleTimers.callbacks.size).toBe(3));

      chatFixture.threadSnapshots = [[{ ...thread, archived_at_utc: "2026-07-16T00:00:00Z" }]];
      fireEvent.click(screen.getByRole("button", { name: "Показать архив чатов" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Показать активные чаты" })).toBeInTheDocument());
      const beforeDelayedRefresh = threadRequestCount();

      await act(async () => {
        titleTimers.callbacks.get(2_000)?.();
        await Promise.resolve();
      });

      expect(threadRequestCount()).toBe(beforeDelayedRefresh);
      expect(screen.getAllByText("Проверка чата")).toHaveLength(2);
    } finally {
      titleTimers.restore();
    }
  });

  it("keeps the active Copilot chat mounted when the thread list temporarily fails", async () => {
    renderChat();
    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));

    chatFixture.failUrls = ["archived=archived"];
    fireEvent.click(screen.getByRole("button", { name: "Показать архив чатов" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Брай временно недоступен"));
    expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1");
    expect(screen.getAllByText("Проверка чата")).toHaveLength(2);
  });

  it("keeps a successful artifact projection when the message projection fails", async () => {
    chatFixture.failUrls = ["/messages"];
    chatFixture.events = [{
      version: 1,
      id: "event-partial",
      thread_id: "thread-1",
      message_id: null,
      turn_id: "turn-partial",
      sequence: 1,
      type: "CUSTOM",
      safe_payload: {
        type: "CUSTOM",
        name: "brai.artifact.v1",
        value: { kind: "diff", name: "Сохранённый результат", source_event_id: "file-partial" },
      },
      truncated: false,
      created_at_utc: "2026-07-15T00:00:00Z",
    }];

    renderChat();
    await screen.findByTestId("copilot-chat");
    fireEvent.click(screen.getByRole("button", { name: "Code" }));

    const workspace = await screen.findByRole("complementary", { name: "Панель Code" });
    expect(await within(workspace).findByText("Сохранённый результат")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Часть истории временно не загрузилась");
    expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1");
  });

  it("does not apply a completed run refresh after the user switches threads", async () => {
    const delayed = deferredResponse();
    chatFixture.threads = [thread, { ...thread, id: "thread-2", title: "Следующий чат" }];
    renderChat();
    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));

    chatFixture.delayedNextMessages = delayed;
    fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));
    fireEvent.click(screen.getByRole("button", { name: "Следующий чат" }));
    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-2"));

    delayed.resolve(json({
      messages: [{
        version: 1,
        id: "stale-message",
        thread_id: "thread-1",
        turn_id: "turn-1",
        role: "assistant",
        content: "Старый ответ",
        status: "completed",
        sequence: 2,
        created_at_utc: "2026-07-15T00:00:00Z",
        attachments: [{
          version: 1,
          id: "stale-attachment",
          thread_id: "thread-1",
          message_id: "stale-message",
          filename: "stale.png",
          media_type: "image/png",
          byte_size: 10,
          checksum_sha256: "hash",
          created_at_utc: "2026-07-15T00:00:00Z",
        }],
      }],
      next_cursor: null,
    }));

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const workspace = await screen.findByRole("complementary", { name: "Панель Preview" });
    await waitFor(() => expect(within(workspace).queryByRole("img", { name: "stale.png" })).not.toBeInTheDocument());
    expect(within(workspace).getByText("Изображения и визуальные результаты появятся здесь")).toBeInTheDocument();
  });

  it("projects a private image into Preview with an accessible source link", async () => {
    chatFixture.messageIds = ["message-1"];
    chatFixture.messages = [{
      version: 1, id: "message-1", thread_id: "thread-1", turn_id: "turn-1", role: "user", content: "Снимок",
      status: "completed", sequence: 1, created_at_utc: "2026-07-15T00:00:00Z",
      attachments: [{ version: 1, id: "attachment-1", thread_id: "thread-1", message_id: "message-1", filename: "screen.png", media_type: "image/png", byte_size: 10, checksum_sha256: "hash", created_at_utc: "2026-07-15T00:00:00Z" }],
    }];
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const workspace = await screen.findByRole("complementary", { name: "Панель Preview" });
    expect(window.history.state?.braiMobileSheet).toBeUndefined();
    expect(await within(workspace).findByRole("img", { name: "screen.png" })).toHaveAttribute("src", "blob:brai-image");
    expect(within(workspace).getByRole("button", { name: "Открыть изображение: screen.png" })).toBeInTheDocument();
    expect(within(workspace).getByRole("button", { name: "Скачать изображение" })).toBeInTheDocument();
    fireEvent.click(within(workspace).getByRole("button", { name: "Открыть изображение: screen.png" }));
    const viewer = screen.getByRole("dialog", { name: "screen.png" });
    expect(within(viewer).getByRole("img", { name: "screen.png" })).toHaveAttribute("src", "blob:brai-image");
    fireEvent.click(within(viewer).getByRole("button", { name: "Закрыть просмотр" }));
    expect(screen.queryByRole("dialog", { name: "screen.png" })).not.toBeInTheDocument();

    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(within(workspace).getByRole("button", { name: "Скачать изображение" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/attachments/attachment-1?download=1"),
      expect.objectContaining({ credentials: "include" }),
    ));
    expect(anchorClick).toHaveBeenCalledOnce();
    anchorClick.mockRestore();

    fireEvent.click(within(workspace).getByRole("button", { name: "К сообщению" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("offers retry in the visible alert after an early Copilot failure", async () => {
    renderChat();
    await screen.findByTestId("copilot-chat");

    fireEvent.click(screen.getByRole("button", { name: "Вызвать ранний сбой" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Ранний сбой");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(chatFixture.retry).toHaveBeenCalledOnce());
  });

  it("clears projections when the active thread changes automatically", async () => {
    chatFixture.messages = [{
      version: 1, id: "message-1", thread_id: "thread-1", turn_id: null, role: "user", content: "Снимок", status: "completed", sequence: 1,
      attachments: [{ version: 1, id: "attachment-1", thread_id: "thread-1", message_id: "message-1", filename: "screen.png", media_type: "image/png", byte_size: 10, checksum_sha256: "hash", created_at_utc: "2026-07-15T00:00:00Z" }],
      created_at_utc: "2026-07-15T00:00:00Z",
    }];
    renderChat();
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const workspace = await screen.findByRole("complementary", { name: "Панель Preview" });
    expect(await within(workspace).findByRole("img", { name: "screen.png" })).toBeInTheDocument();

    chatFixture.threads = [{ ...thread, id: "thread-2", title: "Следующий чат" }];
    chatFixture.messages = [];
    fireEvent.pointerDown(screen.getByRole("button", { name: "Действия чата: Проверка чата" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Архивировать" }));

    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-2"));
    expect(within(workspace).queryByRole("img", { name: "screen.png" })).not.toBeInTheDocument();
    expect(within(workspace).getByText("Изображения и визуальные результаты появятся здесь")).toBeInTheDocument();
  });

  it("shows search failures and catches a rejected archived search hit", async () => {
    renderChat();
    await screen.findByTestId("copilot-chat");
    const searchbox = screen.getByRole("searchbox", { name: "Поиск по чатам" });
    fireEvent.change(searchbox, { target: { value: "error" } });
    chatFixture.failUrls = ["/search"];
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Поиск временно недоступен");

    chatFixture.failUrls = [];
    chatFixture.searchResults = [{ version: 1, id: "hit-archived", thread_id: "thread-2", thread_title: "Архивный", snippet: "result", archived_at_utc: "2026-07-14T00:00:00Z" }];
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    const hit = await screen.findByRole("button", { name: /Архивный/ });
    chatFixture.failUrls = ["archived=archived"];
    fireEvent.click(hit);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Результат поиска не открыт"));
  });

  it("opens an artifact search hit only after history is loaded and anchors its Code projection", async () => {
    const artifact = { version: 1, id: "event-1", thread_id: "thread-1", message_id: null, turn_id: "turn-1", sequence: 1, type: "CUSTOM", safe_payload: { type: "CUSTOM", name: "brai.artifact.v1", value: { kind: "diff", name: "Изменения файлов", source_event_id: "file-1" } }, truncated: false, created_at_utc: "2026-07-15T00:00:00Z" };
    chatFixture.events = [artifact];
    chatFixture.searchResults = [{ version: 1, id: "hit-1", thread_id: "thread-1", thread_title: "Проверка чата", snippet: "до <mark>diff</mark> после", source_event_id: "event-1", archived_at_utc: null }];
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    renderChat();
    await screen.findByTestId("copilot-chat");
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск по чатам" }), { target: { value: "diff" } });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    const snippet = await screen.findByText("diff");
    expect(snippet.tagName).toBe("MARK");
    expect(snippet.closest("button")).toHaveTextContent("Проверка чатадо diff после");
    expect(snippet.closest("button")).not.toHaveTextContent("<mark>");
    fireEvent.click(snippet.closest("button")!);

    const workspace = await screen.findByRole("complementary", { name: "Панель Code" });
    expect(await within(workspace).findByText("Изменения файлов")).toBeInTheDocument();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it("keeps MainDock order and uses a currentColor Lucide-style Brai sign", () => {
    const { container } = render(<MainDock section="brai" mobileViewport timer={emptyTimerState()} onSection={() => undefined} />);
    const mobile = container.querySelector(".mobile-nav");
    expect(mobile).toBeInstanceOf(HTMLElement);
    expect(within(mobile as HTMLElement).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual(["Брай", "Действия", "Входящие", "Фокус", "Factory"]);
    const icon = mobile?.querySelector("svg");
    expect(icon).toBeInstanceOf(SVGElement);
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon).toHaveAttribute("stroke", "currentColor");
    expect(icon?.querySelector("image")).not.toBeInTheDocument();
  });

  it("animates the mobile Dock out of the global keyboard viewport", () => {
    const { container } = render(<MainDock section="brai" keyboardOpen mobileViewport timer={emptyTimerState()} onSection={() => undefined} />);
    const dock = container.querySelector(".main-dock");

    expect(dock).toHaveClass("max-[860px]:translate-y-2", "max-[860px]:opacity-0");
    expect(dock).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the global menu in MainDock and the desktop rail service-only", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const { container } = render(
      <SidebarProvider open={false}>
        <DesktopRail
          section="brai"
          appVersionState={null}
          otaRefreshing={false}
          otaState={null}
          pendingCount={0}
          versionError={false}
          versionRefreshing={false}
          syncStatus="synced"
          authUser={null}
          onProfile={() => undefined}
          onSettings={() => undefined}
          onBraiCmd={() => undefined}
          onEngine={() => undefined}
          onArchive={() => undefined}
          onLogout={async () => undefined}
        />
      </SidebarProvider>,
    );

    const rail = container.querySelector('[aria-label="Служебная панель"]');
    expect(rail).toBeInstanceOf(HTMLElement);
    for (const label of ["Брай", "Действия", "Inbox", "Фокус", "Factory", "Draws"]) {
      expect(within(rail as HTMLElement).queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });
});

const thread = {
  version: 1,
  id: "thread-1",
  title: "Проверка чата",
  model: "codex",
  reasoning_effort: "medium",
  archived_at_utc: null,
  active_turn_id: null,
  created_at_utc: "2026-07-15T00:00:00Z",
  updated_at_utc: "2026-07-15T00:00:00Z",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function captureGeneratedTitleTimers() {
  const callbacks = new Map<number, () => void>();
  const nativeSetTimeout = window.setTimeout.bind(window);
  let timerId = 10_000;
  const spy = vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const normalizedDelay = Number(delay ?? 0);
    if (typeof handler === "function" && [2_000, 10_000, 35_000].includes(normalizedDelay)) {
      callbacks.set(normalizedDelay, () => handler(...args));
      timerId += 1;
      return timerId;
    }
    return nativeSetTimeout(handler, delay, ...args);
  }) as typeof window.setTimeout);
  return { callbacks, restore: () => spy.mockRestore() };
}

function threadRequestCount(): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/threads?")).length;
}

function renderChat() {
  return render(<ChatHarness />);
}

function ChatHarness() {
  const [rail, setRail] = useState<ReactNode>(null);
  const [contextPanel, setContextPanel] = useState<BraiContextPanel>("none");
  const registerRail = useCallback((content: ReactNode | null) => setRail(content), []);
  return (
    <SidebarProvider open={false}>
      <div aria-label="Действия заголовка">
        <BraiContextPanelActions panel={contextPanel} onPanelChange={setContextPanel} />
      </div>
      <aside aria-label="Чаты Брая">{rail}</aside>
      <BraiChatSection
        contextPanel={contextPanel}
        theme="dark"
        userId="user-1"
        onContextPanelChange={setContextPanel}
        onRailContent={registerRail}
      />
    </SidebarProvider>
  );
}
