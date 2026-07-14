import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRelationEvents,
  type RelationIdAliases,
} from "@/shared/storage/relationAcknowledgement";
import { ClientUserScopeChangedError, clientDb, getMeta, setMeta } from "@/shared/storage/db";
import {
  enqueueRelationEvent,
  loadRelationsState,
  markRelationAttempt,
  pendingRelationEvents,
  readyRelationEvents,
  saveRelationsState,
} from "@/shared/storage/relationStore";
import type { RelationItem, RelationsState } from "@/shared/types/relations";

describe("Relation acknowledgement", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("rebinds an end queued during duplicate create sync and preserves it through reopen", async () => {
    const create = await enqueueRelationEvent({
      type: "create",
      relationId: "provisional-relation",
      payload: { relation_type_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1" },
      baseServerRevision: 0,
    });
    await markRelationAttempt([create]);
    const end = await enqueueRelationEvent({
      type: "end",
      relationId: create.relationId,
      payload: { reason: "removed_by_user" },
      baseServerRevision: 0,
    });

    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([create.eventId]);
    await acknowledgeRelationEvents({
      acknowledgedEventIds: [create.eventId],
      acceptedEvents: [create],
      ignoredEvents: [],
      state: relationState([relation("canonical-relation", "action-1", 0)]),
    });

    expect(await getMeta<RelationIdAliases>("relationIdAliases")).toMatchObject({
      "provisional-relation": "canonical-relation",
    });
    clientDb().close();
    await clientDb().open();
    expect(await pendingRelationEvents()).toMatchObject([{
      eventId: end.eventId,
      type: "end",
      relationId: "canonical-relation",
    }]);
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([end.eventId]);
  });

  it("rebinds a Goal reorder only after its provisional create is canonical", async () => {
    const create = await enqueueRelationEvent({
      type: "create",
      relationId: "provisional-second",
      payload: { relation_type_id: "part_of", source_items_id: "action-2", target_items_id: "goal-1" },
      baseServerRevision: 0,
    });
    await markRelationAttempt([create]);
    const reorder = await enqueueRelationEvent({
      type: "reorder",
      payload: {
        relation_type_id: "part_of",
        target_items_id: "goal-1",
        ordered_relation_ids: ["provisional-second", "canonical-first"],
      },
      baseServerRevision: 0,
    });

    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([create.eventId]);
    await acknowledgeRelationEvents({
      acknowledgedEventIds: [create.eventId],
      acceptedEvents: [create],
      ignoredEvents: [],
      state: relationState([
        relation("canonical-first", "action-1", 1),
        relation("canonical-second", "action-2", 0),
      ]),
    });

    clientDb().close();
    await clientDb().open();
    expect(await pendingRelationEvents()).toMatchObject([{
      eventId: reorder.eventId,
      type: "reorder",
      baseServerRevision: 1,
      payload: { ordered_relation_ids: ["canonical-second", "canonical-first"] },
    }]);
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([reorder.eventId]);
  });

  it("rolls back Relation snapshot, aliases, ignored rows, and outbox acknowledgement together", async () => {
    await saveRelationsState(relationState([], 1));
    const create = await enqueueRelationEvent({
      type: "create",
      relationId: "provisional-relation",
      payload: { relation_type_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1" },
      baseServerRevision: 1,
    });
    await markRelationAttempt([create]);
    const canonical = relationState([relation("canonical-relation", "action-1", 0)], 2);
    const failure = vi.spyOn(clientDb().relation_outbox_events, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected_ack_failure"));

    await expect(acknowledgeRelationEvents({
      acknowledgedEventIds: [create.eventId],
      acceptedEvents: [create],
      ignoredEvents: [{ event_id: "ignored-relation-event", reason: "stale_revision" }],
      state: canonical,
    })).rejects.toThrow("injected_ack_failure");
    failure.mockRestore();

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().relation_outbox_events.get(create.eventId)).toBeDefined();
    expect(await getMeta<RelationIdAliases>("relationIdAliases")).toBeNull();
    expect(await clientDb().ignored_events.get("ignored-relation-event")).toBeUndefined();
    expect(await loadRelationsState()).toMatchObject({ server_revision: 1, relations: [] });

    await acknowledgeRelationEvents({
      acknowledgedEventIds: [create.eventId],
      acceptedEvents: [create],
      ignoredEvents: [{ event_id: "ignored-relation-event", reason: "stale_revision" }],
      state: canonical,
    });
    clientDb().close();
    await clientDb().open();
    expect(await clientDb().relation_outbox_events.get(create.eventId)).toBeUndefined();
    expect(await getMeta<RelationIdAliases>("relationIdAliases")).toMatchObject({
      "provisional-relation": "canonical-relation",
    });
    expect(await clientDb().ignored_events.get("ignored-relation-event")).toMatchObject({ reason: "stale_revision" });
    expect(await loadRelationsState()).toMatchObject({ server_revision: 2, relations: [{ id: "canonical-relation" }] });
  });

  it("does not apply a stale tab acknowledgement to the new owner's Relations", async () => {
    await setMeta("currentUserId", "user-a");
    await setMeta("currentUserId", "user-b");
    await saveRelationsState(relationState([relation("relation-b", "action-b", 0)], 1), "user-b");
    const event = await enqueueRelationEvent({
      type: "end",
      relationId: "relation-b",
      payload: { reason: "removed_by_user" },
      baseServerRevision: 1,
      expectedUserId: "user-b",
    });
    const beforeOutbox = await clientDb().relation_outbox_events.toArray();
    const beforeCache = await clientDb().relations_cache.toArray();

    await expect(acknowledgeRelationEvents({
      acknowledgedEventIds: [event.eventId],
      acceptedEvents: [event],
      ignoredEvents: [{ event_id: "ignored-by-a", reason: "stale_revision" }],
      state: relationState([], 2),
      expectedUserId: "user-a",
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await clientDb().relation_outbox_events.toArray()).toEqual(beforeOutbox);
    expect(await clientDb().relations_cache.toArray()).toEqual(beforeCache);
    expect(await clientDb().ignored_events.get("ignored-by-a")).toBeUndefined();
    expect(await getMeta<RelationIdAliases>("relationIdAliases")).toBeNull();
    expect(await loadRelationsState("user-b")).toMatchObject({
      server_revision: 1,
      relations: [{ id: "relation-b" }],
    });
  });
});

function relationState(relations: RelationItem[], serverRevision = 1): RelationsState {
  return {
    server_time_utc: "2026-07-13T00:00:00.000Z",
    server_revision: serverRevision,
    relation_types: [{
      id: "part_of", user_id: null, key: "part_of", title: "Часть", description: "",
      directionality: "directed", source_label: "часть", target_label: "содержит", is_ordered: 1,
      status: "active", is_system: 1, created_by_actor_type: "system", created_by_actor_id: "migration:62", endpoint_rules: [],
      created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z",
      retired_at_utc: null,
    }],
    relations,
    ended_relations: [],
    next_cursor: null,
  };
}

function relation(id: string, sourceItemsId: string, position: number): RelationItem {
  return {
    id, user_id: "user-1", relation_types_id: "part_of", source_items_id: sourceItemsId,
    target_items_id: "goal-1", status: "active", position,
    active_from_utc: "2026-07-13T00:00:00.000Z", active_to_utc: null,
    operation_id: `operation:${id}`, ended_operation_id: null, origin_decision_id: null,
    created_by_actor_type: "user", created_by_actor_id: "user-1",
    ended_by_actor_type: null, ended_by_actor_id: null, end_reason: null,
    metadata_json: {}, created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}
