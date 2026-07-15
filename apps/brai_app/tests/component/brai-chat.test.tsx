import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BraiChatSection } from "@/features/app/sections/brai/BraiChatSection";
import { DesktopRail, MainDock } from "@/features/app/navigation/AppNavigation";
import { emptyTimerState } from "@/shared/types/timer";
import { SidebarProvider } from "@/shared/ui/sidebar";

const chatFixture = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  failUrls: [] as string[],
  messages: [] as Array<Record<string, unknown>>,
  messageIds: [] as string[],
  retry: vi.fn(async () => undefined),
  searchResults: [] as Array<Record<string, unknown>>,
  threads: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/features/app/sections/brai/BraiCopilotSurface", () => ({
  BraiCopilotSurface: (props: Record<string, unknown>) => (
    <div data-testid="copilot-chat" data-thread-id={props.threadId as string}>
      {chatFixture.messageIds.map((id) => <div key={id} id={`brai-message-${id}`} />)}
      <button type="button" onClick={() => (props.onRunStateChange as (running: boolean) => void)(true)}>Начать тестовый run</button>
      <button type="button" onClick={() => {
        (props.onRetryChange as (retry: () => Promise<void>) => void)(chatFixture.retry);
        (props.onError as (message: string, retryable: boolean) => void)("Ранний сбой", true);
      }}>Вызвать ранний сбой</button>
      <button type="button" onClick={() => {
        (props.onRunStateChange as (running: boolean) => void)(false);
        (props.onRunFinished as () => void)();
      }}>Завершить тестовый run</button>
    </div>
  ),
}));

describe("Brai chat client", () => {
  beforeEach(() => {
    chatFixture.events = [];
    chatFixture.failUrls = [];
    chatFixture.messages = [];
    chatFixture.messageIds = [];
    chatFixture.retry.mockClear();
    chatFixture.searchResults = [];
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
      if (url.includes("/threads?")) return json({ threads: chatFixture.threads });
      if (url.includes("/messages")) return json({ messages: chatFixture.messages, next_cursor: null });
      if (url.includes("/events")) return json({ events: chatFixture.events, next_cursor: null });
      if (url.includes("/search")) return json({ results: chatFixture.searchResults });
      if (url.includes("/models")) return json({ models: [{ id: "codex", display_name: "Codex", reasoning_efforts: ["medium"] }] });
      if (url.endsWith("/threads") && !url.includes("?")) return json({ thread: { ...thread, id: "thread-2", title: "Новый чат" } }, 201);
      return json({});
    }));
  });

  it("renders the dominant self-hosted chat and thread lifecycle controls", async () => {
    render(<BraiChatSection userId="user-1" />);

    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-1"));
    expect(screen.getByRole("region", { name: "Чат с Браем" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Чаты Брая" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Поиск по чатам" })).toHaveAttribute("id", "brai-chat-search");
    expect(screen.getByRole("searchbox", { name: "Поиск по чатам" })).toHaveAttribute("name", "query");
    expect(screen.getByText("Только чтение")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Открыть артефакты" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Показать архив чатов" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("archived=archived"), expect.any(Object)));
  });

  it("refreshes history and the thread title after a run finishes", async () => {
    render(<BraiChatSection userId="user-1" />);
    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toBeInTheDocument());
    const before = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/messages")).length;

    fireEvent.click(screen.getByRole("button", { name: "Завершить тестовый run" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/messages")).length).toBeGreaterThan(before));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/events")).length).toBeGreaterThan(1);
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/threads?")).length).toBeGreaterThan(1);
  });

  it("renders a selectable artifact collection, private image and accessible source link", async () => {
    chatFixture.messageIds = ["message-1"];
    chatFixture.messages = [{
      version: 1, id: "message-1", thread_id: "thread-1", turn_id: "turn-1", role: "user", content: "Снимок",
      status: "completed", sequence: 1, created_at_utc: "2026-07-15T00:00:00Z",
      attachments: [{ version: 1, id: "attachment-1", thread_id: "thread-1", message_id: "message-1", filename: "screen.png", media_type: "image/png", byte_size: 10, checksum_sha256: "hash", created_at_utc: "2026-07-15T00:00:00Z" }],
    }];
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<BraiChatSection userId="user-1" />);
    const trigger = await screen.findByRole("button", { name: "Открыть артефакты" });
    await waitFor(() => expect(trigger).toBeEnabled());
    trigger.focus();
    fireEvent.click(trigger);

    const inspector = await screen.findByRole("complementary", { name: "Инспектор чата" });
    expect(window.history.state?.braiMobileSheet).toBeUndefined();
    expect(within(inspector).getByRole("tab", { name: "Артефакты" })).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByRole("option", { name: /screen\.png/ })).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByRole("img", { name: "screen.png" })).toHaveAttribute("src", "/api/v1/brai-chat/attachments/attachment-1");
    await waitFor(() => expect(within(inspector).getByRole("tabpanel")).toHaveFocus());

    fireEvent.click(within(inspector).getByRole("button", { name: "К источнику" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    fireEvent.click(within(inspector).getByRole("button", { name: "Закрыть инспектор" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("polls live run events and projects artifacts before the run finishes", async () => {
    render(<BraiChatSection userId="user-1" />);
    await screen.findByTestId("copilot-chat");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/events"))).toBe(true));
    const before = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/events")).length;
    chatFixture.events = [{
      version: 1, id: "event-live", thread_id: "thread-1", message_id: null, turn_id: "turn-1", sequence: 1, type: "CUSTOM",
      safe_payload: { type: "CUSTOM", name: "brai.artifact.v1", value: { kind: "diff", name: "Live diff", source_event_id: "tool-live" } },
      truncated: false, created_at_utc: "2026-07-15T00:00:00Z",
    }];

    fireEvent.click(screen.getByRole("button", { name: "Начать тестовый run" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/events")).length).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByRole("button", { name: "Открыть артефакты" })).toBeEnabled());
  });

  it("offers retry in the visible alert after an early Copilot failure", async () => {
    render(<BraiChatSection userId="user-1" />);
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
    render(<BraiChatSection userId="user-1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Открыть артефакты" })).toBeEnabled());

    chatFixture.threads = [{ ...thread, id: "thread-2", title: "Следующий чат" }];
    chatFixture.messages = [];
    fireEvent.click(screen.getByRole("button", { name: "Архивировать: Проверка чата" }));

    await waitFor(() => expect(screen.getByTestId("copilot-chat")).toHaveAttribute("data-thread-id", "thread-2"));
    expect(screen.getByRole("button", { name: "Открыть артефакты" })).toBeDisabled();
  });

  it("shows search failures and catches a rejected archived search hit", async () => {
    render(<BraiChatSection userId="user-1" />);
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

  it("opens an event search hit only after history is loaded and anchors its inspector row", async () => {
    const detail = { version: 1, id: "event-1", thread_id: "thread-1", message_id: null, turn_id: "turn-1", sequence: 1, type: "CUSTOM", safe_payload: { type: "CUSTOM", name: "brai.detail.v1", value: { kind: "commandExecution", source_event_id: "tool-1", status: "completed", result: "ok" } }, truncated: false, created_at_utc: "2026-07-15T00:00:00Z" };
    chatFixture.events = [detail];
    chatFixture.searchResults = [{ version: 1, id: "hit-1", thread_id: "thread-1", thread_title: "Проверка чата", snippet: "до <mark>ok</mark> после", source_event_id: "event-1", archived_at_utc: null }];
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render(<BraiChatSection userId="user-1" />);
    await screen.findByTestId("copilot-chat");
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск по чатам" }), { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    const snippet = await screen.findByText("ok");
    expect(snippet.tagName).toBe("MARK");
    expect(snippet.closest("button")).toHaveTextContent("Проверка чатадо ok после");
    expect(snippet.closest("button")).not.toHaveTextContent("<mark>");
    fireEvent.click(snippet.closest("button")!);

    const inspector = await screen.findByRole("complementary", { name: "Инспектор чата" });
    await waitFor(() => expect(within(inspector).getByRole("option", { name: /commandExecution/ })).toHaveAttribute("aria-selected", "true"));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("keeps MainDock order and uses the exact raster brand mark", () => {
    const { container } = render(<MainDock section="brai" hidden={false} mobileViewport timer={emptyTimerState()} onSection={() => undefined} />);
    const mobile = container.querySelector(".mobile-nav");
    expect(mobile).toBeInstanceOf(HTMLElement);
    expect(within(mobile as HTMLElement).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual(["Брай", "Действия", "Inbox", "Фокус", "Factory"]);
    const icon = mobile?.querySelector("img");
    expect(icon).toBeInstanceOf(HTMLImageElement);
    expect(icon).toHaveAttribute("src", "/favicon.png");
    expect(icon).not.toHaveAttribute("style");
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
