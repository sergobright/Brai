"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import type { ActivitiesState } from "@/shared/types/activities";
import type { InboxState } from "@/shared/types/inbox";
import type { RelationsState } from "@/shared/types/relations";
import { buildActionsWorkspace, type WorkspaceFilterId } from "../sections/actions/actionsWorkspaceModel";

const STORAGE_KEY = "brai_actions_workspace_filter";

/** Shares one persisted Actions filter between desktop navigation and the mobile drawer. */
export function useActionsWorkspace(activities: ActivitiesState, inbox: InboxState, relations: RelationsState) {
  const [filter, setFilter] = useState<WorkspaceFilterId>(loadFilter);
  const workspace = useMemo(() => buildActionsWorkspace({ activities, inbox, relations, filter }), [activities, filter, inbox, relations]);
  const snapshotReady = activities.server_revision > 0 || inbox.server_revision > 0 || relations.server_revision > 0
    || activities.actions.length > 0 || (activities.goals?.length ?? 0) > 0 || (activities.archived_goals?.length ?? 0) > 0;
  const selectFilter = useCallback((nextFilter: WorkspaceFilterId) => {
    setFilter(nextFilter);
  }, []);

  if (snapshotReady && workspace.filter !== filter) setFilter(workspace.filter);
  useEffect(() => {
    persistFilter(filter);
  }, [filter]);

  return { selectFilter, workspace };
}

function loadFilter(): WorkspaceFilterId {
  if (typeof window === "undefined") return "actions";
  try {
    const value = getBraiLocalStorageItem(STORAGE_KEY);
    if (value === "all" || value === "actions" || value === "operations" || value === "without-goal") return value;
    return value?.startsWith("goal:") ? value as WorkspaceFilterId : "actions";
  } catch {
    return "actions";
  }
}

function persistFilter(filter: WorkspaceFilterId): void {
  if (typeof window === "undefined") return;
  try { setBraiLocalStorageItem(STORAGE_KEY, filter); } catch { /* Storage can be unavailable in constrained WebViews. */ }
}
