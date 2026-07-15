import type { Dispatch, SetStateAction } from "react";
import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import { clearActivityEditDraft, enqueueActivityEvent, pendingActivityEvents, projectActivitiesState } from "@/shared/storage/activityStore";
import { enqueueActivityDeleteWithRelationEnds } from "@/shared/storage/activityRelationStore";
import { ClientUserScopeChangedError } from "@/shared/storage/db";
import type { ActivityItem, ActivitiesState, ActivityStatus, PendingActivityEvent } from "@/shared/types/activities";
import type { SyncStatus } from "@/shared/types/timer";
import { ACTION_DELETE_COLLAPSE_MS } from "../sections/actions/constants";

/**
 * Creates the action handlers that write local outbox events before syncing.
 */
export function createBraiActionCommands({
  actions,
  flushActionPending,
  getActions,
  publishActionsSnapshot,
  setActionPendingCount,
  setActions,
  setSyncStatus,
  getRelationServerRevision,
  onRelationLifecycleQueued,
  beforeGoalStatusChange,
  beforeLocalMutation,
}: {
  actions: ActivitiesState;
  flushActionPending: () => Promise<void>;
  getActions?: () => ActivitiesState;
  publishActionsSnapshot?: (nextActions: ActivitiesState) => Promise<void>;
  setActionPendingCount: Dispatch<SetStateAction<number>>;
  setActions: Dispatch<SetStateAction<ActivitiesState>>;
  setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
  getRelationServerRevision?: () => number;
  onRelationLifecycleQueued?: (expectedOwnerId?: string) => Promise<void>;
  beforeGoalStatusChange?: (goal: ActivityItem, status: ActivityStatus, expectedOwnerId?: string) => Promise<void>;
  beforeLocalMutation?: (expectedOwnerId?: string) => string;
}) {
  function currentActions(): ActivitiesState {
    return getActions?.() ?? actions;
  }

  async function queueActionEvent(event: Parameters<typeof enqueueActivityEvent>[0], expectedOwnerId?: string) {
    const ownerId = beforeLocalMutation?.(expectedOwnerId);
    let queued: PendingActivityEvent[];
    try {
      await enqueueActivityEvent({ ...event, expectedUserId: ownerId });
      queued = await pendingActivityEvents(ownerId);
    } catch (error) {
      if (error instanceof ClientUserScopeChangedError) return;
      throw error;
    }
    const projected = projectActivitiesState(currentActions(), queued);
    setActions(projected);
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void publishActionsSnapshot?.(projected).catch(() => undefined);
    void flushActionPending().catch(() => undefined);
  }

  async function onCreateAction(title: string, descriptionMd = "") {
    const trimmed = cleanTitle(title);
    if (!trimmed) return;
    const current = currentActions();
    await queueActionEvent({
      type: "create",
      payload: { title: trimmed, description_md: normalizeDescription(descriptionMd) },
      baseServerRevision: current.server_revision,
    });
  }

  async function onCreateGoal(title: string, descriptionMd = "") {
    const trimmed = cleanTitle(title);
    if (!trimmed) return;
    await queueActionEvent({
      type: "create",
      payload: { title: trimmed, description_md: normalizeDescription(descriptionMd), activity_type_id: "goal" },
      baseServerRevision: currentActions().server_revision,
    });
  }

  async function onUpdateActionTitle(action: ActivityItem, title: string) {
    const trimmed = cleanTitle(title);
    const current = currentActions();
    const currentAction = findActivity(current, action.id) ?? action;
    if (!trimmed || trimmed === currentAction.title) return;
    await queueActionEvent({
      type: "update_title",
      actionId: action.id,
      payload: { title: trimmed },
      baseServerRevision: current.server_revision,
    });
  }

  async function onAutosaveActionDetails(action: ActivityItem, title: string, descriptionMd: string) {
    const trimmed = cleanTitle(title);
    const current = currentActions();
    const currentAction = findActivity(current, action.id) ?? action;
    const nextDescription = normalizeDescription(descriptionMd);
    const titleChanged = Boolean(trimmed && trimmed !== currentAction.title);
    const descriptionChanged = nextDescription !== normalizeDescription(currentAction.description_md);

    if (!titleChanged && !descriptionChanged) {
      clearActivityEditDraft(action.id);
      return;
    }
    const ownerId = beforeLocalMutation?.();
    if (titleChanged) {
      beforeLocalMutation?.(ownerId);
      await enqueueActivityEvent({
        type: "update_title",
        actionId: action.id,
        payload: { title: trimmed },
        baseServerRevision: current.server_revision,
        expectedUserId: ownerId,
      });
    }
    if (descriptionChanged) {
      beforeLocalMutation?.(ownerId);
      await enqueueActivityEvent({
        type: "update_description",
        actionId: action.id,
        payload: { description_md: nextDescription },
        baseServerRevision: current.server_revision,
        expectedUserId: ownerId,
      });
    }

    clearActivityEditDraft(action.id);
    const queued = await pendingActivityEvents(ownerId);
    const projected = projectActivitiesState(currentActions(), queued);
    setActions(projected);
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void publishActionsSnapshot?.(projected).catch(() => undefined);
    void flushActionPending().catch(() => undefined);
  }

  async function onSetActionStatus(action: ActivityItem, status: ActivityStatus, expectedOwnerId?: string) {
    const current = currentActions();
    const currentAction = findActivity(current, action.id) ?? action;
    if (currentAction.status === status) return;
    await queueActionEvent({
      type: "set_status",
      actionId: action.id,
      payload: { status },
      baseServerRevision: current.server_revision,
    }, expectedOwnerId);
  }

  async function onDeleteAction(action: ActivityItem) {
    const current = currentActions();
    const ownerId = beforeLocalMutation?.();
    await enqueueActivityDeleteWithRelationEnds({
      activityId: action.id,
      activityBaseServerRevision: current.server_revision,
      relationBaseServerRevision: getRelationServerRevision?.() ?? 0,
      expectedUserId: ownerId,
    });
    await onRelationLifecycleQueued?.(ownerId);
    beforeLocalMutation?.(ownerId);
    await delayActionProjection(ownerId);
  }

  async function onRestoreAction(action: ActivityItem) {
    const current = currentActions();
    const ownerId = beforeLocalMutation?.();
    await enqueueActivityEvent({
      type: "restore",
      actionId: action.id,
      payload: {},
      baseServerRevision: current.server_revision,
      expectedUserId: ownerId,
    });
    await delayActionProjection(ownerId);
  }

  async function delayActionProjection(ownerId?: string) {
    beforeLocalMutation?.(ownerId);
    const queued = await pendingActivityEvents(ownerId);
    const projectedNow = projectActivitiesState(currentActions(), queued);
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    void publishActionsSnapshot?.(projectedNow).catch(() => undefined);
    window.setTimeout(() => {
      let projected = currentActions();
      setActions((current) => {
        projected = projectActivitiesState(current, queued);
        return projected;
      });
      void publishActionsSnapshot?.(projected).catch(() => undefined);
      void flushActionPending().catch(() => undefined);
    }, ACTION_DELETE_COLLAPSE_MS);
  }

  async function onReorderActions(orderedIds: string[], movedAction: ActivityItem) {
    const current = currentActions();
    const currentIds = current.actions.filter((action) => action.status === "New").map((action) => action.id);
    if (orderedIds.join("\n") === currentIds.join("\n")) return;
    await queueActionEvent({
      type: "reorder",
      actionId: movedAction.id,
      payload: { ordered_ids: orderedIds },
      baseServerRevision: current.server_revision,
    });
  }

  async function onSetGoalStatus(goal: ActivityItem, status: ActivityStatus) {
    const ownerId = beforeLocalMutation?.();
    await beforeGoalStatusChange?.(goal, status, ownerId);
    await onSetActionStatus(goal, status, ownerId);
  }

  return {
    onAutosaveActionDetails,
    onAutosaveGoalDetails: onAutosaveActionDetails,
    onCreateAction,
    onCreateGoal,
    onDeleteAction,
    onDeleteGoal: onDeleteAction,
    onReorderActions,
    onRestoreAction,
    onRestoreGoal: onRestoreAction,
    onSetActionStatus,
    onSetGoalStatus,
    onUpdateActionTitle,
    onUpdateGoalTitle: onUpdateActionTitle,
  };
}

function findActivity(state: ActivitiesState, id: string): ActivityItem | undefined {
  return [state.actions, state.goals ?? [], state.legacy_operations ?? [], state.archived_actions, state.archived_goals ?? []]
    .flat()
    .find((item) => item.id === id);
}
