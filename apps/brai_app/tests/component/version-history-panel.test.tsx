import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VersionHistoryItem, VersionHistoryPage } from "@/shared/api/braiApi";
import { VersionHistoryPanel } from "@/features/app/sections/engine/VersionHistoryPanel";

const CURRENT_COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("VersionHistoryPanel", () => {
  it("keeps cards compact, opens details, filters future types, and paginates", async () => {
    const api = {
      versionHistory: vi.fn()
        .mockResolvedValueOnce(page([historyItem(3, "build", {
          pull_requests: [pullRequest("javascript:alert(1)", "Текст\n<script>alert('x')</script>")],
        })], "older"))
        .mockResolvedValueOnce(page([
          historyItem(2, "build", { refs: [versionRef(CURRENT_COMMIT)] }),
          historyItem(1, "build"),
        ]))
        .mockResolvedValueOnce(page([historyItem(1, "macos")], null)),
    };
    const view = render(<VersionHistoryPanel api={api} currentCommit={CURRENT_COMMIT} />);

    expect(screen.getByRole("status")).toHaveTextContent("Загружаем историю");
    const version3 = await screen.findByRole("button", { name: "Новая версия 3: Работа 3" });
    expect(version3).toHaveTextContent("Работа 3");
    expect(version3).toHaveTextContent("Версия 3");
    expect(screen.queryByText(/Подробности работы 3/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Все" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(version3);
    expect(await screen.findByRole("heading", { name: "Работа 3" })).toBeInTheDocument();
    expect(screen.getByText("PR #303: PR 303").closest("a")).toBeNull();
    expect(view.container.querySelector("script")).toBeNull();
    expect(screen.getByText("Полные данные PR #303")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Закрыть подробности версии" }));
    expect(screen.queryByRole("heading", { name: "Работа 3" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать более ранние" }));
    expect(await screen.findByRole("button", { name: "Установлена 2: Работа 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Установлена 1: Работа 1" })).toBeInTheDocument();
    expect(api.versionHistory).toHaveBeenLastCalledWith({ type: null, cursor: "older", limit: 30 });

    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(await screen.findByRole("button", { name: "Новая версия 1: Работа 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Работа 3/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "macOS" })).toHaveAttribute("aria-pressed", "true");
    expect(api.versionHistory).toHaveBeenLastCalledWith({ type: "macos", cursor: null, limit: 30 });
  });

  it("keeps loaded versions when pagination fails and retries the failed cursor", async () => {
    const api = {
      versionHistory: vi.fn()
        .mockResolvedValueOnce(page([historyItem(3, "build")], "older"))
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(page([historyItem(2, "build")], null)),
    };
    render(<VersionHistoryPanel api={api} />);

    expect(await screen.findByRole("button", { name: "Новая версия 3: Работа 3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Показать более ранние" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("История не загрузилась");
    expect(screen.getByRole("button", { name: "Новая версия 3: Работа 3" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("button", { name: "Новая версия 2: Работа 2" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.versionHistory).toHaveBeenLastCalledWith({ type: null, cursor: "older", limit: 30 });
  });

  it("ignores stale filter responses and explains empty and no-PR states", async () => {
    const build = deferred<VersionHistoryPage>();
    const macos = deferred<VersionHistoryPage>();
    const api = {
      versionHistory: vi.fn()
        .mockResolvedValueOnce(page([historyItem(3, "build", { pull_requests: [] })]))
        .mockImplementationOnce(() => build.promise)
        .mockImplementationOnce(() => macos.promise),
    };
    render(<VersionHistoryPanel api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Новая версия 3: Работа 3" }));
    expect(await screen.findByText("Нет связанных pull request.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть подробности версии" }));
    fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
    await waitFor(() => expect(api.versionHistory).toHaveBeenLastCalledWith({ type: "build", cursor: null, limit: 30 }));
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    macos.resolve(page([], null));
    expect(await screen.findByText("Для выбранного типа версий пока нет.")).toBeInTheDocument();
    build.resolve(page([historyItem(9, "build")], null));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Работа 9/ })).not.toBeInTheDocument());
  });

  it("stacks mobile details and Back closes only the top sheet", async () => {
    const onClose = vi.fn();
    const api = { versionHistory: vi.fn().mockResolvedValue(page([historyItem(3, "build")])) };
    render(<VersionHistoryPanel api={api} mobile onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Новая версия 3: Работа 3" }));
    expect(await screen.findByRole("heading", { name: "Работа 3" })).toBeInTheDocument();
    expect(document.querySelectorAll(".mobile-context-backdrop")).toHaveLength(2);
    expect(document.querySelector(".mobile-context-backdrop:not(.version-history-detail-backdrop)")).toHaveAttribute("inert");
    expect(screen.getByRole("heading", { name: "Работа 3" })).toHaveFocus();
    expect(document.querySelector(".version-history-detail-backdrop .actions-detail-close")).not.toBeInTheDocument();
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();

    act(() => {
      window.history.replaceState({ ...window.history.state, braiMobileSheet: "История версий" }, "", window.location.href);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });

    await waitFor(() => expect(document.querySelectorAll(".mobile-context-backdrop")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Новая версия 3: Работа 3" })).toBeInTheDocument();
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
    expect(document.querySelector(".mobile-context-backdrop")).not.toHaveAttribute("inert");
    await waitFor(() => expect(screen.getByRole("button", { name: "Новая версия 3: Работа 3" })).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
  });
});

function page(items: VersionHistoryItem[], nextCursor: string | null = null): VersionHistoryPage {
  return {
    items,
    types: [
      { id: "build", title: "Сборка" },
      { id: "apk", title: "APK" },
      { id: "macos", title: "macOS" },
    ],
    next_cursor: nextCursor,
  };
}

function historyItem(id: number, type: string, patch: Partial<VersionHistoryItem> = {}): VersionHistoryItem {
  return {
    id,
    type,
    version: id,
    short_changes: `Работа ${id}`,
    detailed_changes: `Подробности работы ${id}`,
    reason: `Причина ${id}`,
    released_at_utc: `2026-07-${String(10 + id).padStart(2, "0")}T10:00:00.000Z`,
    created_at_utc: `2026-07-${String(10 + id).padStart(2, "0")}T10:00:00.000Z`,
    work: { key: `work_${id}`, status: "finalized", created_at_utc: "2026-07-10T10:00:00.000Z", updated_at_utc: "2026-07-10T10:00:00.000Z", finalized_at_utc: "2026-07-10T10:00:00.000Z" },
    details: [{ id, title: `Изменение ${id}`, description: `Результат ${id}`, display_order: 1, pull_request_id: null }],
    pull_requests: [],
    refs: [versionRef(`target-${id}`)],
    ...patch,
  };
}

function versionRef(targetCommit: string) {
  return {
    source_branch: "codex/work",
    source_commit: "source",
    target_branch: "main",
    target_commit: targetCommit,
    created_at_utc: "2026-07-10T10:00:00.000Z",
  };
}

function pullRequest(url: string, body: string) {
  return {
    id: 303,
    role: "owner" as const,
    repository: "sergobright/Brai",
    number: 303,
    url,
    title: "PR 303",
    body,
    author_login: "sergobright",
    state: "MERGED",
    is_draft: false,
    head_branch: "codex/work-303",
    base_branch: "main",
    merge_commit_sha: "abc303",
    created_at_utc: "2026-07-10T10:00:00.000Z",
    updated_at_utc: "2026-07-11T10:00:00.000Z",
    closed_at_utc: "2026-07-11T10:00:00.000Z",
    merged_at_utc: "2026-07-11T10:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
