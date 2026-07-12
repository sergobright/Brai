import { beforeEach, describe, expect, it } from "vitest";
import { enqueueInboxEvent, loadInboxState, pendingInboxEvents, projectInboxState, saveInboxState } from "@/shared/storage/inboxStore";
import { clientDb, getMeta } from "@/shared/storage/db";
import type { InboxState } from "@/shared/types/inbox";

describe("inbox store", () => {
  beforeEach(async () => {
    const db = clientDb();
    await Promise.all(db.tables.map((table) => table.clear()));
    window.localStorage.clear();
  });

  it("stores local inbox events and projects visible state without statuses", async () => {
    const created = await enqueueInboxEvent({
      type: "create",
      payload: { title: " Входящее\r\nважное ", description_md: "строка\r\n2" },
      baseServerRevision: 0,
    });

    const projected = projectInboxState(null, await pendingInboxEvents());
    const item = projected.inbox[0];

    expect(created.inboxId).toContain(":inbox:");
    expect(created.eventId).toContain(":inbox:");
    expect(projected.inbox).toHaveLength(1);
    expect(item).toMatchObject({
      id: created.inboxId,
      title: "Входящее важное",
      description_md: "строка\n2",
      source: "brai-app",
      source_key: created.deviceId,
      explanation_text: "Входящее важное",
      status: "New",
      completed_at_utc: null,
      is_normalized: false,
      item_roles_id: null,
      workflow_status: "queued",
      workflow_step: "ingest",
      pending: true,
    });
    expect(item.status).toBe("New");
    expect(item.completed_at_utc).toBeNull();
  });

  it("projects pending descriptions and coalesces repeated description edits", async () => {
    await saveInboxState(state(5, "inbox-1", "Входящее", ""));
    await enqueueInboxEvent({
      type: "update_description",
      inboxId: "inbox-1",
      payload: { description_md: "первая" },
      baseServerRevision: 5,
    });
    await enqueueInboxEvent({
      type: "update_description",
      inboxId: "inbox-1",
      payload: { description_md: "**вторая**\r\nстрока" },
      baseServerRevision: 5,
    });

    const pending = await pendingInboxEvents();
    const projected = projectInboxState(await loadInboxState(), pending);

    expect(pending.filter((event) => event.type === "update_description")).toHaveLength(1);
    expect(projected.inbox[0]).toMatchObject({
      description_md: "**вторая**\nстрока",
      pending: true,
    });
  });

  it("projects pending deletes by hiding the inbox item", async () => {
    await saveInboxState(state(5, "inbox-1", "Входящее"));
    await enqueueInboxEvent({
      type: "delete",
      inboxId: "inbox-1",
      payload: {},
      baseServerRevision: 5,
    });

    const projected = projectInboxState(await loadInboxState(), await pendingInboxEvents());

    expect(projected.inbox).toHaveLength(0);
  });

  it("does not overwrite cached inbox with older server revisions", async () => {
    expect(await saveInboxState(state(5, "inbox-1", "Свежее"))).toBe(true);
    expect(await saveInboxState(state(4, "inbox-1", "Старое"))).toBe(false);

    expect((await loadInboxState())?.inbox[0].title).toBe("Свежее");
    expect(await getMeta<number>("lastInboxServerRevision")).toBe(5);
  });
});

function state(serverRevision: number, id: string, title: string, descriptionMd = ""): InboxState {
  return {
    server_time_utc: `2026-06-16T12:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    inbox: [
      {
        id,
        title,
        description_md: descriptionMd,
        source: "",
        item_date: null,
        author: "",
        preliminary_section: "",
        urgency: "",
        status: "New",
        completed_at_utc: null,
        attachment_links: [],
        explanation_text: "",
        normalization_text: "",
        is_normalized: false,
        created_at_utc: "2026-06-16T10:00:00.000Z",
        updated_at_utc: "2026-06-16T10:00:00.000Z",
        deleted_at_utc: null,
      },
    ],
  };
}
