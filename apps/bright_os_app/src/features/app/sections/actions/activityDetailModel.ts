import { useEffect, useState } from "react";
import { normalizeDescription } from "@/shared/activities/text";
import { loadActivityEditDrafts, saveActivityEditDraft } from "@/shared/storage/activityStore";
import type { ActivityItem } from "@/shared/types/activities";

export function activityDraftValues(action: ActivityItem): { title: string; descriptionMd: string } {
  const draft = loadActivityEditDrafts().find((item) => item.actionId === action.id);
  return {
    title: draft?.title || action.title,
    descriptionMd: draft?.descriptionMd ?? normalizeDescription(action.description_md),
  };
}

export function useActivityDraftAutosave(
  action: ActivityItem,
  onAutosaveDetails: (action: ActivityItem, title: string, descriptionMd: string) => Promise<void>,
) {
  const [autosave] = useState(() => createActivityDraftAutosave());

  useEffect(() => {
    autosave.setTarget(action, onAutosaveDetails);
  }, [action, autosave, onAutosaveDetails]);

  return autosave;
}

export function scheduleActivityDraftEdit(
  action: ActivityItem,
  title: string,
  descriptionMd: string,
  onTitleDraftChange: (actionId: string, title: string | null) => void,
  autosave: ActivityDraftAutosave,
) {
  onTitleDraftChange(action.id, title === action.title ? null : title);
  saveActivityEditDraft(action.id, title, descriptionMd);
  autosave.schedule(title, descriptionMd);
}

type ActivityDraftAutosave = ReturnType<typeof createActivityDraftAutosave>;

function createActivityDraftAutosave() {
  let latest: { title: string; descriptionMd: string } | null = null;
  let timer: number | null = null;
  let maxTimer: number | null = null;
  let action: ActivityItem | null = null;
  let callback: ((action: ActivityItem, title: string, descriptionMd: string) => Promise<void>) | null = null;

  function clearTimers() {
    if (timer != null) window.clearTimeout(timer);
    if (maxTimer != null) window.clearTimeout(maxTimer);
    timer = null;
    maxTimer = null;
  }

  function flush() {
    if (!latest || !action || !callback) return;
    const next = latest;
    latest = null;
    clearTimers();
    void callback(action, next.title, next.descriptionMd);
  }

  return {
    setTarget(
      nextAction: ActivityItem,
      nextCallback: (action: ActivityItem, title: string, descriptionMd: string) => Promise<void>,
    ) {
      action = nextAction;
      callback = nextCallback;
    },
    flush,
    schedule(title: string, descriptionMd: string) {
      latest = { title, descriptionMd };
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 600);
      if (maxTimer == null) maxTimer = window.setTimeout(flush, 2000);
    },
  };
}
