import { useEffect, useRef } from "react";
import { loadActivityEditDrafts } from "@/shared/storage/activityStore";
import type { ActivityItem } from "@/shared/types/activities";

export function useRestoreActionEditDrafts(
  actions: ActivityItem[],
  onAutosaveDetails: (action: ActivityItem, title: string, descriptionMd: string) => Promise<void>,
) {
  const restoredDraftsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const draftItem of loadActivityEditDrafts()) {
      if (restoredDraftsRef.current.has(draftItem.actionId)) continue;
      const action = actions.find((item) => item.id === draftItem.actionId);
      if (!action) continue;
      restoredDraftsRef.current.add(draftItem.actionId);
      void onAutosaveDetails(action, draftItem.title || action.title, draftItem.descriptionMd);
    }
  }, [actions, onAutosaveDetails]);
}
