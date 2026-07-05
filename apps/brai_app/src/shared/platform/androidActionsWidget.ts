import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNativeShell, platformName } from "@/shared/platform/platform";
import type { ActivityItem, ActivityStatus, ActivitiesState } from "@/shared/types/activities";

export const DEFAULT_ACTIONS_WIDGET_VIEW_ID = "all";

export type AndroidActionsWidgetStatusChange = {
  id: string;
  actionId: string;
  status: ActivityStatus;
  baseServerRevision: number;
  occurredAtUtc: string;
};

type BraiActionsWidgetPlugin = {
  saveSnapshot(options: {
    viewId: string;
    serverRevision: number;
    snapshotVersion: number;
    actions: Array<Pick<ActivityItem, "id" | "title" | "status">>;
  }): Promise<void>;
  pendingStatusChanges(): Promise<{ changes: AndroidActionsWidgetStatusChange[] }>;
  acknowledgeStatusChanges(options: { ids: string[] }): Promise<void>;
  clear(): Promise<void>;
  addListener(eventName: "statusChangesPending", listenerFunc: () => void): Promise<PluginListenerHandle>;
};

const BraiActionsWidget = registerPlugin<BraiActionsWidgetPlugin>("BraiActionsWidget");

/**
 * Pushes one widget view snapshot to Android; pass a filtered action list later instead of snapshotting every action.
 */
export async function saveAndroidActionsWidgetSnapshot(
  state: ActivitiesState,
  options: { viewId?: string; actions?: ActivityItem[]; snapshotVersion?: number } = {},
): Promise<void> {
  if (!isAndroidShell()) return;
  const actions = options.actions ?? state.actions;
  try {
    await BraiActionsWidget.saveSnapshot({
      viewId: options.viewId ?? DEFAULT_ACTIONS_WIDGET_VIEW_ID,
      serverRevision: state.server_revision,
      snapshotVersion: options.snapshotVersion ?? snapshotVersionFor(state, actions),
      actions: actions.map((action) => ({
        id: action.id,
        title: action.title,
        status: action.status,
      })),
    });
  } catch {
    // Older APKs and browser-like shells keep the web app's IndexedDB source of truth working.
  }
}

export async function pendingAndroidActionsWidgetStatusChanges(): Promise<AndroidActionsWidgetStatusChange[]> {
  if (!isAndroidShell()) return [];
  try {
    const { changes } = await BraiActionsWidget.pendingStatusChanges();
    return changes.filter((change) => change.status === "New" || change.status === "Done");
  } catch {
    return [];
  }
}

export async function listenAndroidActionsWidgetStatusChangesPending(
  onPending: () => void,
): Promise<PluginListenerHandle | null> {
  if (!isAndroidShell()) return null;
  try {
    return await BraiActionsWidget.addListener("statusChangesPending", onPending);
  } catch {
    return null;
  }
}

export async function acknowledgeAndroidActionsWidgetStatusChanges(ids: string[]): Promise<void> {
  if (!isAndroidShell() || ids.length === 0) return;
  try {
    await BraiActionsWidget.acknowledgeStatusChanges({ ids });
  } catch {
    // Leave native pending changes in place; the next WebView run can consume them.
  }
}

export async function clearAndroidActionsWidgetData(): Promise<void> {
  if (!isAndroidShell()) return;
  try {
    await BraiActionsWidget.clear();
  } catch {
    // Old APKs do not have widget storage to clear.
  }
}

function isAndroidShell(): boolean {
  return isNativeShell() && platformName() === "android";
}

function snapshotVersionFor(state: ActivitiesState, actions: ActivityItem[]): number {
  let version = Math.max(0, state.server_revision, Date.parse(state.server_time_utc) || 0);
  for (const action of [...actions, ...state.archived_actions]) {
    version = Math.max(
      version,
      Date.parse(action.created_at_utc) || 0,
      Date.parse(action.updated_at_utc) || 0,
      Date.parse(action.completed_at_utc ?? "") || 0,
      Date.parse(action.restored_at_utc ?? "") || 0,
      Date.parse(action.deleted_at_utc ?? "") || 0,
    );
  }
  return version;
}
