import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBraiInboxCommands } from "@/features/app/hooks/useBraiInboxCommands";
import { clientDb } from "@/shared/storage/db";
import { pendingInboxEvents } from "@/shared/storage/inboxStore";
import { emptyInboxState, type InboxItem } from "@/shared/types/inbox";

describe("createBraiInboxCommands", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("checks the local mutation boundary before every durable Inbox path", async () => {
    const blocked = new Error("local_snapshot_not_ready");
    const beforeLocalMutation = vi.fn(() => { throw blocked; });
    const item = inboxItem();
    const inbox = emptyInboxState();
    inbox.inbox = [item];
    const commands = createBraiInboxCommands({
      beforeLocalMutation,
      flushInboxPending: vi.fn(async () => undefined),
      inbox,
      setInbox: vi.fn(),
      setInboxPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    });

    const attempts: Array<() => Promise<void>> = [
      () => commands.onCreateInboxItem("Новая запись"),
      () => commands.onUpdateInboxTitle(item, "Новое название"),
      () => commands.onAutosaveInboxDetails(item, item.title, "Новое описание"),
      () => commands.onDeleteInboxItem(item),
    ];

    for (const attempt of attempts) await expect(attempt()).rejects.toBe(blocked);

    expect(beforeLocalMutation).toHaveBeenCalledTimes(attempts.length);
    expect(await pendingInboxEvents()).toEqual([]);
  });

  it("keeps the boundary callback optional for existing callers", async () => {
    const inbox = emptyInboxState();
    const commands = createBraiInboxCommands({
      flushInboxPending: vi.fn(async () => undefined),
      inbox,
      setInbox: vi.fn(),
      setInboxPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    });

    await commands.onCreateInboxItem("Локальная запись");

    expect(await pendingInboxEvents()).toHaveLength(1);
  });
});

function inboxItem(): InboxItem {
  return {
    id: "inbox-1",
    items_id: "item-1",
    title: "Запись",
    description_md: "",
    source: "user",
    source_key: "inbox-1",
    response_required: false,
    related_inbox_id: null,
    record_type_id: 1,
    item_date: null,
    author: "",
    preliminary_section: "inbox",
    urgency: "normal",
    attachment_links: [],
    explanation_text: "",
    normalization_text: "",
    is_normalized: false,
    status: "New",
    completed_at_utc: null,
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
    deleted_at_utc: null,
  };
}
