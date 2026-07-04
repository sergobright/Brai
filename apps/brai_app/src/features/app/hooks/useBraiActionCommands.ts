import type { Dispatch, SetStateAction } from "react";
import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import { clearActivityEditDraft, enqueueActivityEvent, pendingActivityEvents, projectActivitiesState } from "@/shared/storage/activityStore";
import type { ActivityItem, ActivitiesState, ActivityStatus } from "@/shared/types/activities";
import type { SyncStatus } from "@/shared/types/timer";
import { ACTION_DELETE_COLLAPSE_MS } from "../sections/actions/constants";

/**
 * Creates the action handlers that write local outbox events before syncing.
 */
export function createBraiActionCommands({
  actions,
  flushActionPending,
  publishActionsSnapshot,
  setActionPendingCount,
  setActions,
  setSyncStatus,
}: {
  actions: ActivitiesState;
  flushActionPending: () => Promise<void>;
  publishActionsSnapshot?: (nextActions: ActivitiesState) => Promise<void>;
  setActionPendingCount: Dispatch<SetStateAction<number>>;
  setActions: Dispatch<SetStateAction<ActivitiesState>>;
  setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
}) {
  async function queueActionEvent(event: Parameters<typeof enqueueActivityEvent>[0]) {
    await enqueueActivityEvent(event);
    const queued = await pendingActivityEvents();
    const projected = projectActivitiesState(actions, queued);
    setActions(projected);
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    await publishActionsSnapshot?.(projected);
    void flushActionPending().catch(() => undefined);
  }

  async function onCreateAction(title: string, descriptionMd = "") {
    const trimmed = cleanTitle(title);
    if (!trimmed) return;
    await queueActionEvent({
      type: "create",
      payload: { title: trimmed, description_md: normalizeDescription(descriptionMd) },
      baseServerRevision: actions.server_revision,
    });
  }

  async function onUpdateActionTitle(action: ActivityItem, title: string) {
    const trimmed = cleanTitle(title);
    if (!trimmed || trimmed === action.title) return;
    await queueActionEvent({
      type: "update_title",
      actionId: action.id,
      payload: { title: trimmed },
      baseServerRevision: actions.server_revision,
    });
  }

  async function onAutosaveActionDetails(action: ActivityItem, title: string, descriptionMd: string) {
    const trimmed = cleanTitle(title);
    const current = actions.actions.find((item) => item.id === action.id) ?? action;
    const nextDescription = normalizeDescription(descriptionMd);
    let changed = false;

    if (trimmed && trimmed !== current.title) {
      await enqueueActivityEvent({
        type: "update_title",
        actionId: action.id,
        payload: { title: trimmed },
        baseServerRevision: actions.server_revision,
      });
      changed = true;
    }
    if (nextDescription !== normalizeDescription(current.description_md)) {
      await enqueueActivityEvent({
        type: "update_description",
        actionId: action.id,
        payload: { description_md: nextDescription },
        baseServerRevision: actions.server_revision,
      });
      changed = true;
    }

    clearActivityEditDraft(action.id);
    if (!changed) return;

    const queued = await pendingActivityEvents();
    const projected = projectActivitiesState(actions, queued);
    setActions(projected);
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    await publishActionsSnapshot?.(projected);
    void flushActionPending().catch(() => undefined);
  }

  async function onSetActionStatus(action: ActivityItem, status: ActivityStatus) {
    if (action.status === status) return;
    await queueActionEvent({
      type: "set_status",
      actionId: action.id,
      payload: { status },
      baseServerRevision: actions.server_revision,
    });
  }

  async function onDeleteAction(action: ActivityItem) {
    await enqueueActivityEvent({
      type: "delete",
      actionId: action.id,
      payload: {},
      baseServerRevision: actions.server_revision,
    });
    await delayActionProjection();
  }

  async function onRestoreAction(action: ActivityItem) {
    await enqueueActivityEvent({
      type: "restore",
      actionId: action.id,
      payload: {},
      baseServerRevision: actions.server_revision,
    });
    await delayActionProjection();
  }

  async function delayActionProjection() {
    const queued = await pendingActivityEvents();
    setActionPendingCount(queued.length);
    setSyncStatus("pending_sync");
    window.setTimeout(() => {
      let projected = actions;
      setActions((current) => {
        projected = projectActivitiesState(current, queued);
        return projected;
      });
      void publishActionsSnapshot?.(projected);
      void flushActionPending();
    }, ACTION_DELETE_COLLAPSE_MS);
  }

  async function onReorderActions(orderedIds: string[], movedAction: ActivityItem) {
    const currentIds = actions.actions.filter((action) => action.status === "New").map((action) => action.id);
    if (orderedIds.join("\n") === currentIds.join("\n")) return;
    await queueActionEvent({
      type: "reorder",
      actionId: movedAction.id,
      payload: { ordered_ids: orderedIds },
      baseServerRevision: actions.server_revision,
    });
  }

  return {
    onAutosaveActionDetails,
    onCreateAction,
    onDeleteAction,
    onReorderActions,
    onRestoreAction,
    onSetActionStatus,
    onUpdateActionTitle,
  };
}
