import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadActivitiesState } from "@/shared/storage/activityStore";
import { acknowledgeActivitySyncEvents, enqueueActivityDeleteWithRelationEnds } from "@/shared/storage/activityRelationStore";
import { ClientUserScopeChangedError, clientDb, getMeta, setMeta } from "@/shared/storage/db";
import {
  enqueueActionWithGoalRelation,
  enqueueGoalForItemRelation,
  enqueueRelationEvent,
  loadRelationsState,
  markRelationAttempt,
  markRelationFailure,
  pendingRelationEvents,
  projectRelationsState,
  readyRelationEvents,
  reconcileRelationDependencies,
  saveRelationSyncIssues,
  saveRelationsState,
} from "@/shared/storage/relationStore";
import type { ActivitiesState } from "@/shared/types/activities";
import type { RelationItem, RelationsState, RelationTypeItem } from "@/shared/types/relations";

describe("relation store", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("atomically enqueues an Action and dependent Goal Relation", async () => {
    const result = await enqueueActionWithGoalRelation({
      title: " Первый шаг ",
      descriptionMd: "строка 1\r\nстрока 2",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 4,
      relationBaseServerRevision: 7,
    });

    expect(await clientDb().action_outbox_events.toArray()).toEqual([result.activityEvent]);
    expect(await pendingRelationEvents()).toEqual([result.relationEvent]);
    expect(result.activityEvent.payload).toMatchObject({
      title: "Первый шаг",
      description_md: "строка 1\nстрока 2",
      activity_type_id: "action",
    });
    expect(result.relationEvent.payload).toMatchObject({
      relation_type_id: "part_of",
      source_items_id: result.activityEvent.actionId,
      target_items_id: "goal-1",
      dependency_event_ids: [result.activityEvent.eventId],
    });
    expect(await readyRelationEvents()).toEqual([]);
    expect(await getMeta<number>("nextClientSequence")).toBe(result.relationEvent.clientSequence + 1);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [result.activityEvent.eventId],
      ignoredEvents: [],
      state: activitiesState(1, result.activityEvent.actionId, "Первый шаг"),
    });
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([result.relationEvent.eventId]);
  });

  it("atomically enqueues a Goal and links the current item to it", async () => {
    const result = await enqueueGoalForItemRelation({
      title: " Новая цель ",
      sourceItemsId: "operation-1",
      activityBaseServerRevision: 4,
      relationBaseServerRevision: 7,
    });

    expect(await clientDb().action_outbox_events.toArray()).toEqual([result.activityEvent]);
    expect(await pendingRelationEvents()).toEqual([result.relationEvent]);
    expect(result.activityEvent.payload).toMatchObject({ title: "Новая цель", activity_type_id: "goal" });
    expect(result.relationEvent.payload).toMatchObject({
      relation_type_id: "part_of",
      source_items_id: "operation-1",
      target_items_id: result.activityEvent.actionId,
      dependency_event_ids: [result.activityEvent.eventId],
    });
    expect(projectRelationsState(null, [result.relationEvent]).relations).toMatchObject([{
      source_items_id: "operation-1",
      target_items_id: result.activityEvent.actionId,
      pending: true,
    }]);
    expect(await readyRelationEvents()).toEqual([]);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [result.activityEvent.eventId],
      ignoredEvents: [],
      state: activitiesStateWithGoal(1, result.activityEvent.actionId, "Новая цель"),
    });
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([result.relationEvent.eventId]);
  });

  it("keeps causal Action and Relation outboxes through reopen, dependency acknowledgement, and retry", async () => {
    const result = await enqueueActionWithGoalRelation({
      title: "Пережить перезапуск",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 4,
      relationBaseServerRevision: 7,
    });

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(result.activityEvent.eventId)).toMatchObject({
      status: "pending",
      actionId: result.activityEvent.actionId,
    });
    expect(await clientDb().relation_outbox_events.get(result.relationEvent.eventId)).toMatchObject({
      status: "pending",
      payload: { dependency_event_ids: [result.activityEvent.eventId] },
    });
    expect(await readyRelationEvents()).toEqual([]);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [result.activityEvent.eventId],
      ignoredEvents: [],
      state: activitiesState(5, result.activityEvent.actionId, "Пережить перезапуск"),
    });

    clientDb().close();
    await clientDb().open();
    const ready = await readyRelationEvents();
    expect(ready.map((event) => event.eventId)).toEqual([result.relationEvent.eventId]);
    await markRelationAttempt(ready);
    await markRelationFailure(ready, "offline");

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(result.activityEvent.eventId)).toBeUndefined();
    expect(await pendingRelationEvents()).toMatchObject([{
      eventId: result.relationEvent.eventId,
      status: "failed",
      attemptCount: 1,
      lastError: "offline",
    }]);
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([result.relationEvent.eventId]);
  });

  it("keeps the new owner's Relation cache and outboxes untouched by a stale tab", async () => {
    await setMeta("currentUserId", "user-a");
    await setMeta("currentUserId", "user-b");
    const event = await enqueueRelationEvent({
      type: "create",
      payload: { relation_type_id: "part_of", source_items_id: "action-b", target_items_id: "goal-b" },
      baseServerRevision: 1,
      expectedUserId: "user-b",
    });
    await saveRelationsState(state(1), "user-b");
    const beforeRelationOutbox = await clientDb().relation_outbox_events.toArray();
    const beforeActionOutbox = await clientDb().action_outbox_events.toArray();
    const beforeCache = await clientDb().relations_cache.toArray();
    const beforeSequence = await getMeta<number>("nextClientSequence");

    await expect(enqueueRelationEvent({
      type: "create",
      payload: { relation_type_id: "part_of", source_items_id: "action-a", target_items_id: "goal-a" },
      baseServerRevision: 1,
      expectedUserId: "user-a",
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(enqueueActionWithGoalRelation({
      title: "stale A action",
      goalItemsId: "goal-a",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
      expectedUserId: "user-a",
    })).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(markRelationAttempt([event], "user-a")).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(markRelationFailure([event], "stale failure", "user-a"))
      .rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(reconcileRelationDependencies("user-a")).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(saveRelationSyncIssues(
      [{ event_id: event.eventId, reason: "stale issue" }],
      "user-a",
      "2026-07-13T00:00:00.000Z",
    )).rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(saveRelationsState({ ...state(2), relations: [] }, "user-a"))
      .rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(pendingRelationEvents("user-a")).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await pendingRelationEvents("user-b")).toEqual(beforeRelationOutbox);
    expect(await clientDb().action_outbox_events.toArray()).toEqual(beforeActionOutbox);
    expect(await clientDb().relations_cache.toArray()).toEqual(beforeCache);
    expect(await getMeta<number>("nextClientSequence")).toBe(beforeSequence);
    expect(await getMeta("relationSyncIssues")).toBeNull();
    expect(await loadRelationsState("user-b")).toMatchObject({ server_revision: 1, relations: [{ id: "relation-1" }] });
  });

  it("cannot lose an acknowledged Action between outbox removal and canonical snapshot", async () => {
    const result = await enqueueActionWithGoalRelation({
      title: "Атомарный шаг",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 4,
      relationBaseServerRevision: 7,
    });
    const canonical = activitiesState(5, result.activityEvent.actionId, "Атомарный шаг");
    const failure = vi.spyOn(clientDb().action_outbox_events, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected_ack_failure"));

    await expect(acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [result.activityEvent.eventId],
      ignoredEvents: [],
      state: canonical,
    })).rejects.toThrow("injected_ack_failure");
    failure.mockRestore();

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(result.activityEvent.eventId)).toBeDefined();
    expect(await loadActivitiesState()).toBeNull();
    expect(await readyRelationEvents()).toEqual([]);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [result.activityEvent.eventId],
      ignoredEvents: [],
      state: canonical,
    });
    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(result.activityEvent.eventId)).toBeUndefined();
    expect((await loadActivitiesState())?.actions).toMatchObject([{ id: result.activityEvent.actionId, item_roles_id: 42 }]);
    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([result.relationEvent.eventId]);
  });

  it("projects create, reorder, and end without deleting history", async () => {
    await enqueueRelationEvent({
      type: "create",
      relationId: "relation-2",
      payload: { relation_type_id: "part_of", source_items_id: "action-2", target_items_id: "goal-1", position: 0 },
      baseServerRevision: 0,
    });
    await enqueueRelationEvent({
      type: "reorder",
      payload: { relation_type_id: "part_of", target_items_id: "goal-1", ordered_relation_ids: ["relation-1", "relation-2"] },
      baseServerRevision: 0,
    });
    await enqueueRelationEvent({
      type: "end",
      relationId: "relation-1",
      payload: { reason: "removed_by_user" },
      baseServerRevision: 0,
    });

    const projected = projectRelationsState(state(0), await pendingRelationEvents());

    expect(projected.relations).toMatchObject([{ id: "relation-2", position: 1, status: "active" }]);
    expect(projected.ended_relations).toMatchObject([{ id: "relation-1", position: 0, status: "ended" }]);
  });

  it("coalesces offline create/end/create into the final active intent", async () => {
    const first = await enqueueRelationEvent({
      type: "create",
      relationId: "transient-relation",
      payload: { relation_type_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1" },
      baseServerRevision: 0,
    });
    await enqueueRelationEvent({ type: "end", relationId: first.relationId, payload: {}, baseServerRevision: 0 });
    expect(await pendingRelationEvents()).toEqual([]);

    const final = await enqueueRelationEvent({
      type: "create",
      payload: { relation_type_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1" },
      baseServerRevision: 0,
    });
    const projected = projectRelationsState(null, await pendingRelationEvents());
    expect(projected.relations).toMatchObject([{ id: final.relationId, status: "active" }]);
    expect(projected.ended_relations).toEqual([]);
  });

  it("persists canonical Relation state and refuses stale snapshots", async () => {
    expect(await saveRelationsState(state(5))).toBe(true);
    expect(await saveRelationsState({ ...state(4), relations: [] })).toBe(false);

    const cached = await loadRelationsState();

    expect(cached?.server_revision).toBe(5);
    expect(cached?.relation_types).toMatchObject([{ id: "part_of", is_ordered: 1 }]);
    expect(cached?.relations).toMatchObject([{ id: "relation-1", relation_types_id: "part_of" }]);
  });

  it("repairs an old incomplete cache at the same server revision", async () => {
    expect(await saveRelationsState(state(5))).toBe(true);
    await setMeta("relationsSnapshotComplete", false);
    const complete = state(5);
    complete.relations.push({ ...relation(), id: "relation-2", source_items_id: "action-2" });

    expect(await saveRelationsState(complete)).toBe(true);
    expect((await loadRelationsState())?.relations.map((item) => item.id)).toEqual(["relation-1", "relation-2"]);
  });

  it("coalesces duplicate pending memberships", async () => {
    const params = {
      type: "create" as const,
      payload: { relation_type_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1" },
      baseServerRevision: 0,
    };
    const first = await enqueueRelationEvent(params);
    const duplicate = await enqueueRelationEvent(params);

    expect(duplicate.eventId).toBe(first.eventId);
    expect(await pendingRelationEvents()).toHaveLength(1);
  });

  it("keeps server-deferred Relation events durable for retry", async () => {
    const event = await enqueueRelationEvent({
      type: "create",
      payload: { relation_type_id: "part_of", source_items_id: "action-raw", target_items_id: "goal-1" },
      baseServerRevision: 1,
    });
    await markRelationAttempt([event]);
    await markRelationFailure([event], "endpoint_not_ready");

    expect(await pendingRelationEvents()).toMatchObject([{ eventId: event.eventId, status: "failed", lastError: "endpoint_not_ready" }]);
  });

  it("blocks a dependent Relation when Activity creation is terminally ignored", async () => {
    const { activityEvent, relationEvent } = await enqueueActionWithGoalRelation({
      title: "Невалидное действие",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
    });
    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [activityEvent.eventId],
      ignoredEvents: [{ event_id: activityEvent.eventId, reason: "title_required" }],
      state: activitiesState(1),
    });

    expect(await pendingRelationEvents()).toEqual([]);
    expect(await readyRelationEvents()).toEqual([]);
    expect(await clientDb().relation_outbox_events.get(relationEvent.eventId)).toMatchObject({
      status: "blocked",
      lastError: "dependency_rejected:title_required",
    });
  });

  it("does not let a terminally blocked create freeze independent Goal reorders", async () => {
    const { activityEvent } = await enqueueActionWithGoalRelation({
      title: "Невалидное действие",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
    });
    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [activityEvent.eventId],
      ignoredEvents: [{ event_id: activityEvent.eventId, reason: "title_required" }],
      state: activitiesState(1),
    });
    const reorder = await enqueueRelationEvent({
      type: "reorder",
      payload: { relation_type_id: "part_of", target_items_id: "goal-1", ordered_relation_ids: ["relation-1"] },
      baseServerRevision: 1,
    });

    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([reorder.eventId]);
  });

  it("keeps a retryable failed create as a reorder dependency barrier", async () => {
    const create = await enqueueRelationEvent({
      type: "create",
      payload: { relation_type_id: "part_of", source_items_id: "action-2", target_items_id: "goal-1" },
      baseServerRevision: 1,
    });
    await markRelationAttempt([create]);
    await markRelationFailure([create], "offline");
    await enqueueRelationEvent({
      type: "reorder",
      payload: { relation_type_id: "part_of", target_items_id: "goal-1", ordered_relation_ids: ["relation-1"] },
      baseServerRevision: 1,
    });

    expect((await readyRelationEvents()).map((event) => event.eventId)).toEqual([create.eventId]);
  });

  it("keeps an ignored Activity create retryable when its causal acknowledgement rolls back", async () => {
    const { activityEvent, relationEvent } = await enqueueActionWithGoalRelation({
      title: "Пережить rollback",
      goalItemsId: "goal-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
    });
    const failure = vi.spyOn(clientDb().action_outbox_events, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected_ack_failure"));

    await expect(acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [activityEvent.eventId],
      ignoredEvents: [{ event_id: activityEvent.eventId, reason: "title_required" }],
      state: activitiesState(1),
    })).rejects.toThrow("injected_ack_failure");
    failure.mockRestore();

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(activityEvent.eventId)).toBeDefined();
    expect(await clientDb().ignored_events.get(activityEvent.eventId)).toBeUndefined();
    expect(await clientDb().relation_outbox_events.get(relationEvent.eventId)).toMatchObject({ status: "pending" });
    expect(await readyRelationEvents()).toEqual([]);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [activityEvent.eventId],
      ignoredEvents: [{ event_id: activityEvent.eventId, reason: "title_required" }],
      state: activitiesState(1),
    });
    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(activityEvent.eventId)).toBeUndefined();
    expect(await clientDb().ignored_events.get(activityEvent.eventId)).toMatchObject({ reason: "title_required" });
    expect(await clientDb().relation_outbox_events.get(relationEvent.eventId)).toMatchObject({
      status: "blocked",
      lastError: "dependency_rejected:title_required",
    });
    expect(await readyRelationEvents()).toEqual([]);
  });

  it("never releases a Relation end when an ignored Activity delete acknowledgement rolls back", async () => {
    await saveRelationsState(state(1));
    const deletion = await enqueueActivityDeleteWithRelationEnds({
      activityId: "action-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
    });
    const relationEnd = (await clientDb().relation_outbox_events.toArray())[0];
    const failure = vi.spyOn(clientDb().action_outbox_events, "bulkDelete")
      .mockRejectedValueOnce(new Error("injected_ack_failure"));

    await expect(acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [deletion.eventId],
      ignoredEvents: [{ event_id: deletion.eventId, reason: "activity_not_found" }],
      state: activitiesState(1),
    })).rejects.toThrow("injected_ack_failure");
    failure.mockRestore();

    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(deletion.eventId)).toBeDefined();
    expect(await clientDb().ignored_events.get(deletion.eventId)).toBeUndefined();
    expect(await clientDb().relation_outbox_events.get(relationEnd.eventId)).toMatchObject({ status: "pending" });
    expect(await readyRelationEvents()).toEqual([]);

    await acknowledgeActivitySyncEvents({
      acknowledgedEventIds: [deletion.eventId],
      ignoredEvents: [{ event_id: deletion.eventId, reason: "activity_not_found" }],
      state: activitiesState(1),
    });
    clientDb().close();
    await clientDb().open();
    expect(await clientDb().action_outbox_events.get(deletion.eventId)).toBeUndefined();
    expect(await clientDb().relation_outbox_events.get(relationEnd.eventId)).toMatchObject({
      status: "blocked",
      lastError: "dependency_rejected:activity_not_found",
    });
    expect(await readyRelationEvents()).toEqual([]);
  });

  it("atomically ends memberships on delete and never recreates them on restore", async () => {
    await saveRelationsState(state(1));
    const deletion = await enqueueActivityDeleteWithRelationEnds({
      activityId: "action-1",
      activityBaseServerRevision: 1,
      relationBaseServerRevision: 1,
    });
    const pending = await pendingRelationEvents();
    expect(await clientDb().action_outbox_events.get(deletion.eventId)).toBeDefined();
    expect(pending).toMatchObject([{
      type: "end",
      relationId: "relation-1",
      payload: { dependency_event_ids: [deletion.eventId], reason: "endpoint_deleted" },
    }]);
    expect(projectRelationsState(state(1), pending).relations).toEqual([]);

    await clientDb().action_outbox_events.add({
      ...deletion,
      eventId: "restore-event",
      clientSequence: deletion.clientSequence + 2,
      type: "restore",
    });
    expect(projectRelationsState(state(1), await pendingRelationEvents()).relations).toEqual([]);
  });
});

function activitiesState(serverRevision: number, actionId?: string, title = "Действие"): ActivitiesState {
  return {
    server_time_utc: `2026-07-13T00:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    actions: actionId ? [{
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
    }] : [],
    archived_actions: [],
    legacy_operations: [],
    goals: [],
    archived_goals: [],
  };
}

function activitiesStateWithGoal(serverRevision: number, goalId: string, title: string): ActivitiesState {
  return {
    ...activitiesState(serverRevision),
    goals: [{
      id: goalId,
      activity_type_id: "goal",
      title,
      description_md: "",
      status: "New",
      item_roles_id: 84,
      created_at_utc: "2026-07-13T00:00:00.000Z",
      updated_at_utc: "2026-07-13T00:00:00.000Z",
      completed_at_utc: null,
      sort_order: null,
      deleted_at_utc: null,
      restored_at_utc: null,
    }],
  };
}

function state(serverRevision: number): RelationsState {
  return {
    server_time_utc: `2026-07-13T00:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    relation_types: [relationType()],
    relations: [relation()],
    ended_relations: [],
    next_cursor: null,
  };
}

function relation(): RelationItem {
  return {
    id: "relation-1",
    user_id: "user-1",
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
    created_by_actor_id: "user-1",
    ended_by_actor_type: null,
    ended_by_actor_id: null,
    end_reason: null,
    metadata_json: {},
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}

function relationType(): RelationTypeItem {
  return {
    id: "part_of",
    user_id: null,
    key: "part_of",
    title: "Часть",
    description: "Нижний Item является частью верхнего",
    directionality: "directed",
    source_label: "часть",
    target_label: "содержит",
    is_ordered: 1,
    status: "active",
    is_system: 1,
    created_by_actor_type: "system",
    created_by_actor_id: "migration:62",
    endpoint_rules: [],
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
    retired_at_utc: null,
  };
}
