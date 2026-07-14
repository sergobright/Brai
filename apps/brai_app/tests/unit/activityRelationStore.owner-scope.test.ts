import { beforeEach, describe, expect, it } from "vitest";
import { enqueueActivityEvent, loadActivitiesState, saveActivitiesState } from "@/shared/storage/activityStore";
import {
  acknowledgeActivitySyncEvents,
  enqueueActivityDeleteWithRelationEnds,
} from "@/shared/storage/activityRelationStore";
import { ClientUserScopeChangedError, clientDb, setMeta } from "@/shared/storage/db";
import type { ActivitiesState } from "@/shared/types/activities";
import type { RelationItem } from "@/shared/types/relations";

describe("activity/relation owner scope", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("rejects an old-owner composite delete without touching user B caches or outboxes", async () => {
    await clientDb().relations_cache.put(relation());
    await setMeta("currentUserId", "user-a");
    const expectedUserId = "user-a";
    await setMeta("currentUserId", "user-b");

    await expect(enqueueActivityDeleteWithRelationEnds({
      activityId: "action-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
      expectedUserId,
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await clientDb().action_outbox_events.toArray()).toEqual([]);
    expect(await clientDb().relation_outbox_events.toArray()).toEqual([]);
    expect((await clientDb().relations_cache.toArray()).map((item) => item.id)).toEqual([
      "relation-1",
    ]);
  });

  it("rejects an old-owner Activity acknowledgement without touching user B state", async () => {
    await setMeta("currentUserId", "user-a");
    const expectedUserId = "user-a";
    await setMeta("currentUserId", "user-b");
    await saveActivitiesState(activitiesState(5, "action-b", "Действие B"), "user-b");
    const userBEvent = await enqueueActivityEvent({
      type: "create",
      payload: { title: "Новое действие B" },
      baseServerRevision: 5,
      expectedUserId: "user-b",
    });

    await expect(acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [userBEvent.eventId],
      ignoredEvents: [{ event_id: userBEvent.eventId, reason: "old_owner" }],
      state: activitiesState(9, "action-a", "Снимок A"),
      expectedUserId,
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await clientDb().action_outbox_events.toArray()).toEqual([userBEvent]);
    expect((await loadActivitiesState("user-b"))?.actions).toMatchObject([
      { id: "action-b", title: "Действие B" },
    ]);
    expect(await clientDb().ignored_events.toArray()).toEqual([]);
  });
});

function activitiesState(serverRevision: number, actionId: string, title: string): ActivitiesState {
  return {
    server_time_utc: `2026-07-13T00:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    actions: [{
      id: actionId,
      activity_type_id: "action",
      title,
      description_md: "",
      status: "New",
      item_roles_id: 42,
      created_at_utc: "2026-07-13T00:00:00.000Z",
      updated_at_utc: "2026-07-13T00:00:00.000Z",
      completed_at_utc: null,
      sort_order: null,
      deleted_at_utc: null,
      restored_at_utc: null,
    }],
    archived_actions: [],
    legacy_operations: [],
    goals: [],
    archived_goals: [],
  };
}

function relation(): RelationItem {
  return {
    id: "relation-1",
    user_id: "user-b",
    relation_types_id: "part_of",
    source_items_id: "action-1",
    target_items_id: "goal-1",
    status: "active",
    position: 0,
    active_from_utc: "2026-07-13T00:00:00.000Z",
    active_to_utc: null,
    operation_id: "operation-1",
    ended_operation_id: null,
    origin_decision_id: null,
    created_by_actor_type: "user",
    created_by_actor_id: "user-b",
    ended_by_actor_type: null,
    ended_by_actor_id: null,
    end_reason: null,
    metadata_json: {},
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}
