import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBraiRelations } from "@/features/app/hooks/useBraiRelations";
import type { BraiApi } from "@/shared/api/braiApi";
import { clientDb } from "@/shared/storage/db";
import { pendingRelationEvents } from "@/shared/storage/relationStore";
import { pendingActivityEvents } from "@/shared/storage/activityStore";
import { emptyActivitiesState } from "@/shared/types/activities";
import type { PendingRelationEvent, RelationItem, RelationsState, RelationsSyncResponse } from "@/shared/types/relations";

describe("useBraiRelations", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("automatically syncs a canonical end queued while duplicate create is in flight", async () => {
    const firstResponse = deferred<RelationsSyncResponse>();
    const syncRelationEvents = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(async (input: { events: Array<{ eventId: string }> }) =>
        syncResponse(input.events[0].eventId, relationState([], [{
          ...relation("canonical-relation"),
          status: "ended",
          active_to_utc: "2026-07-13T00:00:02.000Z",
        }], 2)));
    const api = { syncRelationEvents } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      flushActionPending: vi.fn(),
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    await act(async () => result.current.onAddToGoals("action-1", ["goal-1"]));
    await waitFor(() => expect(syncRelationEvents).toHaveBeenCalledTimes(1));
    const create = syncRelationEvents.mock.calls[0][0].events[0];
    await waitFor(() => expect(result.current.relations.relations).toHaveLength(1));

    await act(async () => result.current.onRemoveFromGoal(result.current.relations.relations[0]));
    expect(syncRelationEvents).toHaveBeenCalledTimes(1);
    firstResponse.resolve(syncResponse(create.eventId, relationState([relation("canonical-relation")], [], 1)));

    await waitFor(() => expect(syncRelationEvents).toHaveBeenCalledTimes(2));
    expect(syncRelationEvents.mock.calls[1][0].events).toMatchObject([{
      type: "end",
      relationId: "canonical-relation",
    }]);
    await waitFor(async () => expect(await pendingRelationEvents()).toEqual([]));
  });

  it("automatically syncs a rebased canonical reorder queued during create", async () => {
    const firstResponse = deferred<RelationsSyncResponse>();
    const syncRelationEvents = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(async (input: { events: Array<{ eventId: string }> }) =>
        syncResponse(input.events[0].eventId, relationState([relation("canonical-relation")], [], 2)));
    const api = { syncRelationEvents } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      flushActionPending: vi.fn(),
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    await act(async () => result.current.onAddToGoals("action-1", ["goal-1"]));
    await waitFor(() => expect(syncRelationEvents).toHaveBeenCalledTimes(1));
    const create = syncRelationEvents.mock.calls[0][0].events[0];
    await act(async () => result.current.onReorderGoal("goal-1", [create.relationId]));
    firstResponse.resolve(syncResponse(create.eventId, relationState([relation("canonical-relation")], [], 1)));

    await waitFor(() => expect(syncRelationEvents).toHaveBeenCalledTimes(2));
    expect(syncRelationEvents.mock.calls[1][0].events).toMatchObject([{
      type: "reorder",
      baseServerRevision: 1,
      payload: { ordered_relation_ids: ["canonical-relation"] },
    }]);
    await waitFor(async () => expect(await pendingRelationEvents()).toEqual([]));
  });

  it("recovers and drains more than one API-sized Relation batch", async () => {
    const queued = Array.from({ length: 501 }, (_, index) => pendingRelationEvent(index));
    await clientDb().relation_outbox_events.bulkPut(queued);
    let revision = 0;
    const syncRelationEvents = vi.fn(async (input: { events: Array<{ eventId: string }> }) => {
      revision += 1;
      return syncBatchResponse(input.events.map((event) => event.eventId), relationState([], [], revision));
    });
    const api = { syncRelationEvents } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      flushActionPending: vi.fn(),
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    await act(async () => result.current.flushRelationPending());

    await waitFor(() => expect(syncRelationEvents).toHaveBeenCalledTimes(2));
    expect(syncRelationEvents.mock.calls.map(([input]) => input.events.length)).toEqual([500, 1]);
    await waitFor(async () => expect(await pendingRelationEvents()).toEqual([]));
  }, 15_000);

  it("revalidates the session before capturing Relation events for sync", async () => {
    await clientDb().relation_outbox_events.put(pendingRelationEvent(1));
    const syncRelationEvents = vi.fn();
    const beforeSync = vi.fn(async () => {
      await clientDb().relation_outbox_events.clear();
      return null;
    });
    const api = { syncRelationEvents } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      beforeSync,
      flushActionPending: vi.fn(),
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    await act(async () => result.current.flushRelationPending());

    expect(beforeSync).toHaveBeenCalledOnce();
    expect(syncRelationEvents).not.toHaveBeenCalled();
    expect(await pendingRelationEvents()).toEqual([]);
  });

  it("checks the local mutation boundary before every durable Relation path", async () => {
    const blocked = new Error("local_snapshot_not_ready");
    const beforeLocalMutation = vi.fn(() => { throw blocked; });
    const syncRelationEvents = vi.fn();
    const flushActionPending = vi.fn(async () => undefined);
    const api = { syncRelationEvents } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      beforeLocalMutation,
      flushActionPending,
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    const attempts: Array<() => Promise<void>> = [
      () => result.current.onAddToGoals("action-1", ["goal-1"]),
      () => result.current.onRemoveFromGoal(relation("relation-1")),
      () => result.current.onReorderGoal("goal-1", ["relation-1"]),
      () => result.current.onCreateActionInGoal("Новое действие", "", "goal-1"),
    ];

    for (const attempt of attempts) await expect(act(attempt)).rejects.toBe(blocked);

    expect(beforeLocalMutation).toHaveBeenCalledTimes(attempts.length);
    expect(flushActionPending).not.toHaveBeenCalled();
    expect(syncRelationEvents).not.toHaveBeenCalled();
    expect(await pendingActivityEvents()).toEqual([]);
    expect(await pendingRelationEvents()).toEqual([]);
  });

  it("does not apply the local mutation boundary to Goal planning", async () => {
    const beforeLocalMutation = vi.fn(() => { throw new Error("unexpected_guard"); });
    const requestGoalPlan = vi.fn(async () => ({ status: "queued" as const, execution_id: 12, workflow_id: "goal-plan-12" }));
    const api = { requestGoalPlan } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiRelations({
      api,
      beforeLocalMutation,
      flushActionPending: vi.fn(),
      getActions: emptyActivitiesState,
      setActions: vi.fn(),
      setActionPendingCount: vi.fn(),
      setSyncStatus: vi.fn(),
    }));

    await act(async () => { await result.current.onPlanGoal({ id: "goal-1" }); });

    expect(requestGoalPlan).toHaveBeenCalledWith("goal-1");
    expect(beforeLocalMutation).not.toHaveBeenCalled();
  });
});

function syncResponse(eventId: string, state: RelationsState): RelationsSyncResponse {
  return syncBatchResponse([eventId], state);
}

function syncBatchResponse(eventIds: string[], state: RelationsState): RelationsSyncResponse {
  return {
    acknowledged_event_ids: eventIds,
    ignored_events: [],
    deferred_events: [],
    server_revision: state.server_revision,
    server_time_utc: state.server_time_utc,
    state,
  };
}

function pendingRelationEvent(index: number): PendingRelationEvent {
  return {
    eventId: `event-${index}`,
    deviceId: "device-1",
    clientSequence: index + 1,
    type: "create",
    occurredAtUtc: "2026-07-13T00:00:00.000Z",
    relationId: `relation-${index}`,
    payload: {
      relation_type_id: "part_of",
      source_items_id: `action-${index}`,
      target_items_id: `goal-${index}`,
    },
    baseServerRevision: 0,
    payloadVersion: 1,
    status: "failed",
    attemptCount: 1,
    lastError: "relation_batch_too_large",
    enqueuedAtUtc: "2026-07-13T00:00:00.000Z",
  };
}

function relationState(relations: RelationItem[], endedRelations: RelationItem[], revision: number): RelationsState {
  return {
    server_time_utc: `2026-07-13T00:00:0${revision}.000Z`,
    server_revision: revision,
    relation_types: [{
      id: "part_of", user_id: null, key: "part_of", title: "Часть", description: "",
      directionality: "directed", source_label: "часть", target_label: "содержит", is_ordered: 1,
      status: "active", is_system: 1, created_by_actor_type: "system", created_by_actor_id: "migration:62", endpoint_rules: [],
      created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z",
      retired_at_utc: null,
    }],
    relations,
    ended_relations: endedRelations,
    next_cursor: null,
  };
}

function relation(id: string): RelationItem {
  return {
    id, user_id: "user-1", relation_types_id: "part_of", source_items_id: "action-1",
    target_items_id: "goal-1", status: "active", position: 0,
    active_from_utc: "2026-07-13T00:00:00.000Z", active_to_utc: null,
    operation_id: `operation:${id}`, ended_operation_id: null, origin_decision_id: null,
    created_by_actor_type: "user", created_by_actor_id: "user-1",
    ended_by_actor_type: null, ended_by_actor_id: null, end_reason: null,
    metadata_json: {}, created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
