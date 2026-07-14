import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { loadActivityEditDrafts } from "@/shared/storage/activityStore";
import type { ActivityItem } from "@/shared/types/activities";
import { ACTIONS_SPLIT_DEFAULT_PERCENT, ACTIONS_SPLIT_MIN_PERCENT, clampActionsSplitPercent } from "./constants";

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

/** Keeps the desktop Actions split resizer keyboard and pointer accessible. */
export function useActionsSplit(workspaceRef: RefObject<HTMLDivElement | null>) {
  const [splitPercent, setSplitPercent] = useState(ACTIONS_SPLIT_DEFAULT_PERCENT);
  const dragStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);

  function resetSplit() {
    setSplitPercent(ACTIONS_SPLIT_DEFAULT_PERCENT);
  }

  function onSplitPointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (!workspaceRef.current) return;
    event.preventDefault();
    dragStyleRef.current = { cursor: document.documentElement.style.cursor, userSelect: document.body.style.userSelect };
    document.documentElement.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onSplitPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !workspaceRef.current) return;
    const bounds = workspaceRef.current.getBoundingClientRect();
    setSplitPercent(clampActionsSplitPercent(((event.clientX - bounds.left) / bounds.width) * 100));
  }

  function onSplitPointerEnd(event: PointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const previous = dragStyleRef.current;
    if (!previous) return;
    document.documentElement.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
    dragStyleRef.current = null;
  }

  function onSplitKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setSplitPercent((current) => clampActionsSplitPercent(current + (event.key === "ArrowLeft" ? -2 : 2)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setSplitPercent(event.key === "Home" ? ACTIONS_SPLIT_MIN_PERCENT : 100 - ACTIONS_SPLIT_MIN_PERCENT);
    }
  }

  return { onSplitKeyDown, onSplitPointerDown, onSplitPointerEnd, onSplitPointerMove, resetSplit, splitPercent };
}
