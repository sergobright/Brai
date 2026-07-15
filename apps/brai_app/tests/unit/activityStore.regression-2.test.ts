import { beforeEach, describe, expect, it } from "vitest";
import {
  enqueueActivityEvent,
  loadActivitiesState,
  pendingActivityEvents,
  saveActivitiesState,
} from "@/shared/storage/activityStore";
import { clientDb, ensureClientUser, getMeta } from "@/shared/storage/db";
import type { ActivitiesState } from "@/shared/types/activities";

describe("preview Activity cache recovery", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
    delete window.__BRAI_RUNTIME_CONFIG__;
  });

  it("accepts a lower reseeded revision after the preview commit changes", async () => {
    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a", commit: "old-commit" };
    await ensureClientUser("user-1");
    await saveActivitiesState(state(314, "Старая preview-запись"));
    await enqueueActivityEvent({
      type: "create",
      payload: { title: "Офлайн-событие" },
      baseServerRevision: 314,
    });

    window.__BRAI_RUNTIME_CONFIG__ = { environment: "preview-a", commit: "new-commit" };
    await ensureClientUser("user-1");

    expect(await getMeta<number>("lastActionServerRevision")).toBeNull();
    expect(await clientDb().actions_cache.count()).toBe(0);
    expect(await pendingActivityEvents()).toHaveLength(1);
    expect(await saveActivitiesState(state(301, "Состояние после reseed"))).toBe(true);
    expect((await loadActivitiesState())?.actions[0].title).toBe("Состояние после reseed");
  });

  it("clears revision metadata and outboxes when the authenticated user changes", async () => {
    await ensureClientUser("user-1");
    await saveActivitiesState(state(20, "Данные первого пользователя"));
    await enqueueActivityEvent({
      type: "create",
      payload: { title: "Не переносить другому пользователю" },
      baseServerRevision: 20,
    });

    await ensureClientUser("user-2");

    expect(await getMeta<number>("lastActionServerRevision")).toBeNull();
    expect(await clientDb().actions_cache.count()).toBe(0);
    expect(await pendingActivityEvents()).toHaveLength(0);
  });

  it("clears ownerless cache and outbox before binding the first authenticated user", async () => {
    await saveActivitiesState(state(20, "Данные без владельца"));
    await enqueueActivityEvent({
      type: "create",
      payload: { title: "Не присваивать первому пользователю" },
      baseServerRevision: 20,
    });

    expect(await clientDb().meta.get("currentUserId")).toBeUndefined();
    expect(await clientDb().actions_cache.count()).toBe(1);
    expect(await pendingActivityEvents()).toHaveLength(1);

    await ensureClientUser("user-1");

    expect(await getMeta<string>("currentUserId")).toBe("user-1");
    expect(await getMeta<number>("lastActionServerRevision")).toBeNull();
    expect(await clientDb().actions_cache.count()).toBe(0);
    expect(await pendingActivityEvents()).toHaveLength(0);
  });

  it("does not let a stale tab clear the newly bound owner's data", async () => {
    await ensureClientUser("user-1");
    await ensureClientUser("user-2");
    await saveActivitiesState(state(30, "Данные второго пользователя"), "user-2");

    await expect(ensureClientUser(null, "user-1")).rejects.toMatchObject({
      name: "ClientUserScopeChangedError",
    });

    expect(await getMeta<string>("currentUserId")).toBe("user-2");
    expect((await loadActivitiesState("user-2"))?.actions[0].title).toBe("Данные второго пользователя");
  });
});

function state(serverRevision: number, title: string): ActivitiesState {
  return {
    server_time_utc: "2026-07-12T23:59:00.000Z",
    server_revision: serverRevision,
    actions: [
      {
        id: "activity-1",
        title,
        description_md: "",
        status: "New",
        created_at_utc: "2026-07-12T23:00:00.000Z",
        updated_at_utc: "2026-07-12T23:00:00.000Z",
        completed_at_utc: null,
        sort_order: null,
        deleted_at_utc: null,
        restored_at_utc: null,
      },
    ],
    archived_actions: [],
  };
}
