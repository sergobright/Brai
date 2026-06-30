import type { Dispatch, SetStateAction } from "react";
import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import { enqueueInboxEvent, pendingInboxEvents, projectInboxState } from "@/shared/storage/inboxStore";
import type { InboxItem, InboxState } from "@/shared/types/inbox";
import type { SyncStatus } from "@/shared/types/timer";
import { ACTION_DELETE_COLLAPSE_MS } from "../sections/actions/constants";

/**
 * Creates the inbox handlers that write local outbox events before syncing.
 */
export function createBrightOsInboxCommands({
  flushInboxPending,
  inbox,
  setInbox,
  setInboxPendingCount,
  setSyncStatus,
}: {
  flushInboxPending: () => Promise<void>;
  inbox: InboxState;
  setInbox: Dispatch<SetStateAction<InboxState>>;
  setInboxPendingCount: Dispatch<SetStateAction<number>>;
  setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
}) {
  async function queueInboxEvent(event: Parameters<typeof enqueueInboxEvent>[0]) {
    await enqueueInboxEvent(event);
    const queued = await pendingInboxEvents();
    setInbox(projectInboxState(inbox, queued));
    setInboxPendingCount(queued.length);
    setSyncStatus("pending_sync");
    await flushInboxPending();
  }

  async function onCreateInboxItem(title: string, descriptionMd = "") {
    const trimmed = cleanTitle(title);
    if (!trimmed) return;
    await queueInboxEvent({
      type: "create",
      payload: { title: trimmed, description_md: normalizeDescription(descriptionMd) },
      baseServerRevision: inbox.server_revision,
    });
  }

  async function onUpdateInboxTitle(item: InboxItem, title: string) {
    const trimmed = cleanTitle(title);
    if (!trimmed || trimmed === item.title) return;
    await queueInboxEvent({
      type: "update_title",
      inboxId: item.id,
      payload: { title: trimmed },
      baseServerRevision: inbox.server_revision,
    });
  }

  async function onAutosaveInboxDetails(item: InboxItem, title: string, descriptionMd: string) {
    const trimmed = cleanTitle(title);
    const current = inbox.inbox.find((entry) => entry.id === item.id) ?? item;
    const nextDescription = normalizeDescription(descriptionMd);
    let changed = false;

    if (trimmed && trimmed !== current.title) {
      await enqueueInboxEvent({
        type: "update_title",
        inboxId: item.id,
        payload: { title: trimmed },
        baseServerRevision: inbox.server_revision,
      });
      changed = true;
    }
    if (nextDescription !== normalizeDescription(current.description_md)) {
      await enqueueInboxEvent({
        type: "update_description",
        inboxId: item.id,
        payload: { description_md: nextDescription },
        baseServerRevision: inbox.server_revision,
      });
      changed = true;
    }
    if (!changed) return;

    const queued = await pendingInboxEvents();
    setInbox(projectInboxState(inbox, queued));
    setInboxPendingCount(queued.length);
    setSyncStatus("pending_sync");
    await flushInboxPending();
  }

  async function onDeleteInboxItem(item: InboxItem) {
    await enqueueInboxEvent({
      type: "delete",
      inboxId: item.id,
      payload: {},
      baseServerRevision: inbox.server_revision,
    });
    const queued = await pendingInboxEvents();
    setInboxPendingCount(queued.length);
    setSyncStatus("pending_sync");
    window.setTimeout(() => {
      setInbox((current) => projectInboxState(current, queued));
      void flushInboxPending();
    }, ACTION_DELETE_COLLAPSE_MS);
  }

  return {
    onAutosaveInboxDetails,
    onCreateInboxItem,
    onDeleteInboxItem,
    onUpdateInboxTitle,
  };
}
