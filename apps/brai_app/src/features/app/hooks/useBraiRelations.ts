"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { BraiApi } from "@/shared/api/braiApi";
import { pendingActivityEvents, projectActivitiesState } from "@/shared/storage/activityStore";
import { ClientUserScopeChangedError, ensureClientMeta, type ClientOwnerScope } from "@/shared/storage/db";
import {
  enqueueActionWithGoalRelation,
  enqueueRelationEvent,
  loadRelationSyncIssues,
  loadRelationsState,
  markRelationAttempt,
  markRelationFailure,
  pendingRelationEvents,
  projectRelationsState,
  reconcileRelationDependencies,
  readyRelationEvents,
  saveRelationsState,
  saveRelationSyncIssues,
} from "@/shared/storage/relationStore";
import { acknowledgeRelationEvents } from "@/shared/storage/relationAcknowledgement";
import type { ActivitiesState } from "@/shared/types/activities";
import { emptyRelationsState, type RelationItem, type RelationSyncIssue, type RelationsState } from "@/shared/types/relations";
import type { SyncStatus } from "@/shared/types/timer";

type RelationWorkspaceOptions = {
  api: BraiApi;
  beforeLocalMutation?: (expectedOwnerId?: string) => string;
  beforeSync?: (sourceApi?: BraiApi, requestedScope?: ClientOwnerScope) => Promise<ClientOwnerScope | null>;
  isScopeCurrent?: (scope: ClientOwnerScope) => boolean;
  onScopeChanged?: (error: unknown) => void;
  flushActionPending: (sourceApi?: BraiApi, requestedScope?: ClientOwnerScope) => Promise<void>;
  getActions: () => ActivitiesState;
  setActions: Dispatch<SetStateAction<ActivitiesState>>;
  setActionPendingCount: Dispatch<SetStateAction<number>>;
  setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
};

const RELATION_SYNC_BATCH_LIMIT = 500;

/** Owns the restart-safe Relation snapshot, outbox, and Goal membership commands. */
export function useBraiRelations({
  api,
  beforeLocalMutation,
  beforeSync,
  isScopeCurrent,
  onScopeChanged,
  flushActionPending,
  getActions,
  setActions,
  setActionPendingCount,
  setSyncStatus,
}: RelationWorkspaceOptions) {
  const apiRef = useRef(api);
  const revisionRef = useRef(0);
  const canonicalRef = useRef<RelationsState>(emptyRelationsState());
  const stateRef = useRef<RelationsState>(emptyRelationsState());
  const flushInFlightRef = useRef(false);
  const flushAgainRef = useRef(false);
  const flushAgainScopeRef = useRef<ClientOwnerScope | null>(null);
  const [relations, setRelations] = useState<RelationsState>(stateRef.current);
  const [relationPendingCount, setRelationPendingCount] = useState(0);
  const [relationSyncIssues, setRelationSyncIssues] = useState<RelationSyncIssue[]>([]);

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  function setSnapshot(next: RelationsState) {
    if (next.server_revision < revisionRef.current) return;
    revisionRef.current = next.server_revision;
    stateRef.current = next;
    setRelations(next);
  }

  async function loadLocalRelations(expectedUserId?: string) {
    await reconcileRelationDependencies(expectedUserId);
    const [cached, pending] = await Promise.all([loadRelationsState(expectedUserId), pendingRelationEvents(expectedUserId)]);
    if (cached) revisionRef.current = cached.server_revision;
    canonicalRef.current = cached ?? emptyRelationsState();
    setSnapshot(projectRelationsState(cached, pending));
    setRelationPendingCount(pending.length);
    setRelationSyncIssues(await loadRelationSyncIssues(expectedUserId));
  }

  async function refreshRelationsAndFlush(sourceApi = apiRef.current, requestedScope?: ClientOwnerScope) {
    const scope = beforeSync ? (await beforeSync(sourceApi, requestedScope)) ?? undefined : requestedScope;
    if (beforeSync && !scope) return;
    if (scope) sourceApi.setExpectedUserId(scope.userId);
    const next = await sourceApi.relations();
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    const accepted = next.server_revision >= revisionRef.current && await saveRelationsState(next, scope?.userId);
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    const pending = await pendingRelationEvents(scope?.userId);
    const canonical = accepted ? next : await loadRelationsState(scope?.userId);
    if (canonical) {
      canonicalRef.current = canonical;
      setSnapshot(projectRelationsState(canonical, pending));
    }
    setRelationPendingCount(pending.length);
    await flushRelationPending(sourceApi, scope);
  }

  async function applyRelationsState(next: RelationsState, scope?: ClientOwnerScope) {
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    if (next.server_revision < revisionRef.current) return;
    const accepted = await saveRelationsState(next, scope?.userId);
    if (!accepted) return;
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    const pending = await pendingRelationEvents(scope?.userId);
    canonicalRef.current = next;
    setSnapshot(projectRelationsState(next, pending));
    setRelationPendingCount(pending.length);
  }

  async function flushRelationPending(sourceApi = apiRef.current, requestedScope?: ClientOwnerScope) {
    if (flushInFlightRef.current) {
      flushAgainRef.current = true;
      flushAgainScopeRef.current = requestedScope ?? null;
      return;
    }
    flushInFlightRef.current = true;
    let scope: ClientOwnerScope | undefined;
    try {
      scope = beforeSync ? (await beforeSync(sourceApi, requestedScope)) ?? undefined : requestedScope;
      if (beforeSync && !scope) return;
      if (scope) sourceApi.setExpectedUserId(scope.userId);
      await reconcileRelationDependencies(scope?.userId);
      const allPending = await pendingRelationEvents(scope?.userId);
      if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
      setRelationPendingCount(allPending.length);
      if (allPending.length === 0) {
        setRelationSyncIssues(await loadRelationSyncIssues(scope?.userId));
        return;
      }
      const ready = (await readyRelationEvents(scope?.userId)).slice(0, RELATION_SYNC_BATCH_LIMIT);
      if (ready.length === 0) {
        setSyncStatus("pending_sync");
        return;
      }
      setSyncStatus("pending_sync");
      await markRelationAttempt(ready, scope?.userId);
      const meta = await ensureClientMeta();
      const response = await sourceApi.syncRelationEvents({
        deviceId: meta.deviceId,
        platform: meta.platform,
        events: ready,
        lastKnownServerTimeUtc: stateRef.current.server_time_utc,
      });
      if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
      const deferredIds = new Set(response.deferred_events.map((event) => event.event_id));
      const acknowledged = [...response.acknowledged_event_ids, ...response.ignored_events.map((event) => event.event_id)]
        .filter((eventId) => !deferredIds.has(eventId));
      if (response.ignored_events.length > 0) {
        const ignoredWithDraft = response.ignored_events.map((issue) => {
          const event = ready.find((candidate) => candidate.eventId === issue.event_id);
          return { ...issue, relation_id: event?.relationId, change_type: event?.type, payload: event?.payload };
        });
        await saveRelationSyncIssues(ignoredWithDraft, scope?.userId);
      }
      const responseState = response.state.next_cursor ? await sourceApi.relations() : response.state;
      if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
      const ignoredIds = new Set(response.ignored_events.map((event) => event.event_id));
      const accepted = await acknowledgeRelationEvents({
        acknowledgedEventIds: acknowledged,
        acceptedEvents: ready.filter((event) => acknowledged.includes(event.eventId) && !ignoredIds.has(event.eventId)),
        ignoredEvents: response.ignored_events,
        state: responseState,
        expectedUserId: scope?.userId,
      });
      const deferred = ready.filter((event) => deferredIds.has(event.eventId));
      if (deferred.length > 0) await markRelationFailure(deferred, "endpoint_not_ready", scope?.userId);
      if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
      const remaining = await pendingRelationEvents(scope?.userId);
      const canonical = accepted ? responseState : await loadRelationsState(scope?.userId);
      if (canonical) {
        canonicalRef.current = canonical;
        setSnapshot(projectRelationsState(canonical, remaining));
      }
      setRelationPendingCount(remaining.length);
      setRelationSyncIssues(await loadRelationSyncIssues(scope?.userId));
      if (acknowledged.length > 0 && (await readyRelationEvents(scope?.userId)).length > 0) flushAgainRef.current = true;
      if (remaining.length === 0) setSyncStatus("synced");
    } catch (error) {
      if (error instanceof ClientUserScopeChangedError || (error instanceof Error && error.name === "UserScopeChangedError")) {
        onScopeChanged?.(error);
        return;
      }
      const syncing = (await pendingRelationEvents(scope?.userId)).filter((event) => event.status === "syncing");
      if (syncing.length > 0) await markRelationFailure(syncing, error instanceof Error ? error.message : "sync_failed", scope?.userId);
      setRelationSyncIssues(await loadRelationSyncIssues(scope?.userId));
      setSyncStatus(typeof navigator !== "undefined" && navigator.onLine ? "sync_failed" : "offline");
    } finally {
      flushInFlightRef.current = false;
      if (flushAgainRef.current) {
        flushAgainRef.current = false;
        const nextScope = flushAgainScopeRef.current;
        flushAgainScopeRef.current = null;
        void flushRelationPending(sourceApi, nextScope ?? undefined).catch(() => undefined);
      }
    }
  }

  async function queueRelation(input: Parameters<typeof enqueueRelationEvent>[0]) {
    const ownerId = beforeLocalMutation?.();
    await enqueueRelationEvent({ ...input, expectedUserId: ownerId });
    const pending = await pendingRelationEvents(ownerId);
    const projected = projectRelationsState(canonicalRef.current, pending);
    stateRef.current = projected;
    setRelations(projected);
    setRelationPendingCount(pending.length);
    setSyncStatus("pending_sync");
    void flushRelationPending().catch(() => undefined);
  }

  async function reprojectRelationOutbox(expectedUserId?: string) {
    await reconcileRelationDependencies(expectedUserId);
    const pending = await pendingRelationEvents(expectedUserId);
    const canonical = await loadRelationsState(expectedUserId);
    if (canonical) canonicalRef.current = canonical;
    const projected = projectRelationsState(canonicalRef.current, pending);
    stateRef.current = projected;
    setRelations(projected);
    setRelationPendingCount(pending.length);
    setRelationSyncIssues(await loadRelationSyncIssues(expectedUserId));
  }

  async function ensureGoalRelationsSynced(goalItemsId: string, expectedOwnerId?: string) {
    const ownerId = beforeLocalMutation?.(expectedOwnerId);
    await flushRelationPending();
    beforeLocalMutation?.(ownerId);
    const pending = await pendingRelationEvents(ownerId);
    if (pending.some((event) =>
      event.payload.target_items_id === goalItemsId
      || (event.type === "end" && stateRef.current.ended_relations.some((relation) =>
        relation.id === event.relationId && relation.target_items_id === goalItemsId && relation.pending,
      )),
    )) {
      throw new Error("goal_membership_pending");
    }
  }

  async function onAddToGoals(itemsId: string, goalIds: string[]) {
    const activeTargets = new Set(stateRef.current.relations
      .filter((relation) => relation.status === "active" && relation.relation_types_id === "part_of" && relation.source_items_id === itemsId)
      .map((relation) => relation.target_items_id));
    const addedGoalIds = [...new Set(goalIds)].filter((goalId) => !activeTargets.has(goalId));
    const ownerId = addedGoalIds.length > 0 ? beforeLocalMutation?.() : undefined;
    for (const goalId of addedGoalIds) {
      beforeLocalMutation?.(ownerId);
      await enqueueRelationEvent({
        type: "create",
        payload: { relation_type_id: "part_of", source_items_id: itemsId, target_items_id: goalId },
        baseServerRevision: stateRef.current.server_revision,
        expectedUserId: ownerId,
      });
    }
    const pending = await pendingRelationEvents(ownerId);
    const projected = projectRelationsState(canonicalRef.current, pending);
    stateRef.current = projected;
    setRelations(projected);
    setRelationPendingCount(pending.length);
    if (pending.length > 0) {
      setSyncStatus("pending_sync");
      void flushRelationPending().catch(() => undefined);
    }
  }

  async function onRemoveFromGoal(relation: RelationItem) {
    await queueRelation({
      type: "end",
      relationId: relation.id,
      payload: { reason: "removed_by_user" },
      baseServerRevision: stateRef.current.server_revision,
    });
  }

  async function onReorderGoal(goalId: string, orderedRelationIds: string[]) {
    await queueRelation({
      type: "reorder",
      payload: { relation_type_id: "part_of", target_items_id: goalId, ordered_relation_ids: orderedRelationIds },
      baseServerRevision: stateRef.current.server_revision,
    });
  }

  async function onPlanGoal(goal: { id: string }) {
    const scope = beforeSync ? (await beforeSync(apiRef.current)) ?? undefined : undefined;
    if (beforeSync && !scope) throw new Error("session_revalidation_required");
    if (scope) apiRef.current.setExpectedUserId(scope.userId);
    return apiRef.current.requestGoalPlan(goal.id);
  }

  async function onCreateActionInGoal(title: string, descriptionMd: string, goalItemsId: string) {
    const ownerId = beforeLocalMutation?.();
    await enqueueActionWithGoalRelation({
      title,
      descriptionMd,
      goalItemsId,
      position: 0,
      activityBaseServerRevision: getActions().server_revision,
      relationBaseServerRevision: stateRef.current.server_revision,
      expectedUserId: ownerId,
    });
    const [activityPending, relationPending] = await Promise.all([pendingActivityEvents(ownerId), pendingRelationEvents(ownerId)]);
    setActions(projectActivitiesState(getActions(), activityPending));
    setActionPendingCount(activityPending.length);
    const projected = projectRelationsState(canonicalRef.current, relationPending);
    stateRef.current = projected;
    setRelations(projected);
    setRelationPendingCount(relationPending.length);
    setSyncStatus("pending_sync");
    await flushActionPending();
    void flushRelationPending().catch(() => undefined);
  }

  function resetRelations() {
    revisionRef.current = 0;
    canonicalRef.current = emptyRelationsState();
    stateRef.current = emptyRelationsState();
    setRelations(stateRef.current);
    setRelationPendingCount(0);
    setRelationSyncIssues([]);
  }

  return {
    applyRelationsState,
    ensureGoalRelationsSynced,
    flushRelationPending,
    loadLocalRelations,
    onAddToGoals,
    onCreateActionInGoal,
    onRemoveFromGoal,
    onReorderGoal,
    onPlanGoal,
    refreshRelationsAndFlush,
    relationServerRevision: stateRef.current.server_revision,
    relationPendingCount,
    relationSyncIssues,
    relations,
    reprojectRelationOutbox,
    resetRelations,
  };
}
