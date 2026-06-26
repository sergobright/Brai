import { beforeEach, describe, expect, it } from "vitest";
import {
  enqueueActivityEvent,
  loadActivityEditDrafts,
  loadActivitiesState,
  markdownPreviewSource,
  pendingActivityEvents,
  projectActivitiesState,
  saveActivityEditDraft,
  saveActivitiesState,
  visibleDescriptionPreview,
} from "@/shared/storage/activityStore";
import { clientDb, getMeta } from "@/shared/storage/db";
import type { ActivitiesState } from "@/shared/types/activities";

describe("action store", () => {
  beforeEach(async () => {
    const db = clientDb();
    await Promise.all(db.tables.map((table) => table.clear()));
    window.localStorage.clear();
  });

  it("stores local action events and projects visible state", async () => {
    const created = await enqueueActivityEvent({
      type: "create",
      payload: { title: " Фокус " },
      baseServerRevision: 0,
    });
    await enqueueActivityEvent({
      type: "set_status",
      actionId: created.actionId,
      payload: { status: "Done" },
      baseServerRevision: 0,
    });

    const projected = projectActivitiesState(null, await pendingActivityEvents());

    expect(created.actionId).toContain(":activity:");
    expect(created.eventId).toContain(":activity:");
    expect(projected.actions).toHaveLength(1);
    expect(projected.actions[0]).toMatchObject({
      id: created.actionId,
      title: "Фокус",
      description_md: "",
      status: "Done",
      sort_order: null,
      pending: true,
    });
  });

  it("projects pending deletes by moving the action to archive", async () => {
    const created = await enqueueActivityEvent({
      type: "create",
      payload: { title: "Фокус" },
      baseServerRevision: 0,
    });
    await enqueueActivityEvent({
      type: "delete",
      actionId: created.actionId,
      payload: {},
      baseServerRevision: 0,
    });

    const projected = projectActivitiesState(null, await pendingActivityEvents());

    expect(projected.actions).toHaveLength(0);
    expect(projected.archived_actions).toHaveLength(1);
    expect(projected.archived_actions[0]).toMatchObject({
      id: created.actionId,
      title: "Фокус",
      deleted_at_utc: expect.any(String),
      pending: true,
    });
  });

  it("projects pending restore by returning the action to the top", async () => {
    await saveActivitiesState({
      server_time_utc: "2026-06-16T12:00:00.000Z",
      server_revision: 5,
      actions: [action("action-active", "Активное", "2026-06-16T10:00:00.000Z")],
      archived_actions: [
        {
          ...action("action-archived", "Архивное", "2026-06-16T09:00:00.000Z"),
          status: "Done",
          completed_at_utc: "2026-06-16T09:30:00.000Z",
          deleted_at_utc: "2026-06-16T10:30:00.000Z",
        },
      ],
    });
    await enqueueActivityEvent({
      type: "restore",
      actionId: "action-archived",
      payload: {},
      baseServerRevision: 5,
    });

    const projected = projectActivitiesState(await loadActivitiesState(), await pendingActivityEvents());

    expect(projected.archived_actions).toHaveLength(0);
    expect(projected.actions.map((item) => [item.id, item.status, item.pending])).toEqual([
      ["action-archived", "New", true],
      ["action-active", "New", false],
    ]);
  });

  it("projects pending descriptions and coalesces repeated description edits", async () => {
    await saveActivitiesState(state(5, "Фокус", ""));
    await enqueueActivityEvent({
      type: "update_description",
      actionId: "action-1",
      payload: { description_md: "первая" },
      baseServerRevision: 5,
    });
    await enqueueActivityEvent({
      type: "update_description",
      actionId: "action-1",
      payload: { description_md: "**вторая**\r\nстрока" },
      baseServerRevision: 5,
    });

    const pending = await pendingActivityEvents();
    const projected = projectActivitiesState(await loadActivitiesState(), pending);

    expect(pending.filter((event) => event.type === "update_description")).toHaveLength(1);
    expect(projected.actions[0]).toMatchObject({
      description_md: "**вторая**\nстрока",
      pending: true,
    });
  });

  it("projects pending manual reorder and coalesces repeated reorder events", async () => {
    await saveActivitiesState({
      server_time_utc: "2026-06-16T12:00:00.000Z",
      server_revision: 5,
      actions: [
        action("action-1", "Первое", "2026-06-16T10:00:00.000Z"),
        action("action-2", "Второе", "2026-06-16T10:01:00.000Z"),
        action("action-3", "Третье", "2026-06-16T10:02:00.000Z"),
      ],
      archived_actions: [],
    });
    await enqueueActivityEvent({
      type: "reorder",
      actionId: "action-1",
      payload: { ordered_ids: ["action-1", "action-2", "action-3"] },
      baseServerRevision: 5,
    });
    await enqueueActivityEvent({
      type: "reorder",
      actionId: "action-3",
      payload: { ordered_ids: ["action-3", "action-1", "action-2"] },
      baseServerRevision: 5,
    });

    const pending = await pendingActivityEvents();
    const projected = projectActivitiesState(await loadActivitiesState(), pending);

    expect(pending.filter((event) => event.type === "reorder")).toHaveLength(1);
    expect(projected.actions.map((item) => [item.id, item.sort_order, item.pending])).toEqual([
      ["action-3", 0, true],
      ["action-1", 1, true],
      ["action-2", 2, true],
    ]);
  });

  it("stores local action edit drafts for recovery", () => {
    saveActivityEditDraft("action-1", "Фокус", "строка 1\r\nстрока 2");

    expect(loadActivityEditDrafts()).toContainEqual({
      actionId: "action-1",
      title: "Фокус",
      descriptionMd: "строка 1\nстрока 2",
    });
  });

  it("normalizes compact markdown headings for description previews", () => {
    expect(markdownPreviewSource("##Описание")).toBe("## Описание");
    expect(markdownPreviewSource("## Цель")).toBe("## Цель");
    expect(markdownPreviewSource("# Большое\n\n## Цель")).toBe("# Большое\n\n## Цель");
    expect(visibleDescriptionPreview("##Описание\n\nтекст")).toBe("Описание текст");
    expect(visibleDescriptionPreview("# Большое\n\n## Цель\n\n**важно** и `код`")).toBe("Большое Цель важно и код");
  });

  it("does not overwrite cached actions with older server revisions", async () => {
    expect(await saveActivitiesState(state(5, "Фокус"))).toBe(true);
    expect(await saveActivitiesState(state(4, "Старое"))).toBe(false);

    expect((await loadActivitiesState())?.actions[0].title).toBe("Фокус");
    expect(await getMeta<number>("lastActionServerRevision")).toBe(5);
  });
});

function state(serverRevision: number, title: string, descriptionMd = ""): ActivitiesState {
  return {
    server_time_utc: `2026-06-16T12:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    actions: [
      {
        id: "action-1",
        title,
        description_md: descriptionMd,
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
  };
}

function action(id: string, title: string, createdAtUtc: string) {
  return {
    id,
    title,
    description_md: "",
    status: "New" as const,
    created_at_utc: createdAtUtc,
    updated_at_utc: createdAtUtc,
    completed_at_utc: null,
    sort_order: null,
    deleted_at_utc: null,
    restored_at_utc: null,
  };
}
