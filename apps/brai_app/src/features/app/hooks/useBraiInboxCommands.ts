import type { Dispatch, SetStateAction } from "react";
import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import { enqueueInboxEvent, pendingInboxEvents, projectInboxState } from "@/shared/storage/inboxStore";
import type { InboxItem, InboxState } from "@/shared/types/inbox";
import type { SyncStatus } from "@/shared/types/timer";
import { ACTION_DELETE_COLLAPSE_MS } from "../sections/actions/constants";

/**
 * Creates the inbox handlers that write local outbox events before syncing.
 */
export function createBraiInboxCommands({
  flushInboxPending,
  inbox,
  setInbox,
  setInboxPendingCount,
  setSyncStatus,
  beforeLocalMutation,
}: {
  flushInboxPending: () => Promise<void>;
  inbox: InboxState;
  setInbox: Dispatch<SetStateAction<InboxState>>;
  setInboxPendingCount: Dispatch<SetStateAction<number>>;
  setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
  beforeLocalMutation?: (expectedOwnerId?: string) => string;
}) {
  async function queueInboxEvent(event: Parameters<typeof enqueueInboxEvent>[0]) {
    const ownerId = beforeLocalMutation?.();
    await enqueueInboxEvent({ ...event, expectedUserId: ownerId });
    const queued = await pendingInboxEvents(ownerId);
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
    const titleChanged = Boolean(trimmed && trimmed !== current.title);
    const descriptionChanged = nextDescription !== normalizeDescription(current.description_md);

    if (!titleChanged && !descriptionChanged) return;
    const ownerId = beforeLocalMutation?.();

    if (titleChanged) {
      beforeLocalMutation?.(ownerId);
      await enqueueInboxEvent({
        type: "update_title",
        inboxId: item.id,
        payload: { title: trimmed },
        baseServerRevision: inbox.server_revision,
        expectedUserId: ownerId,
      });
    }
    if (descriptionChanged) {
      beforeLocalMutation?.(ownerId);
      await enqueueInboxEvent({
        type: "update_description",
        inboxId: item.id,
        payload: { description_md: nextDescription },
        baseServerRevision: inbox.server_revision,
        expectedUserId: ownerId,
      });
    }

    const queued = await pendingInboxEvents(ownerId);
    setInbox(projectInboxState(inbox, queued));
    setInboxPendingCount(queued.length);
    setSyncStatus("pending_sync");
    await flushInboxPending();
  }

  async function onDeleteInboxItem(item: InboxItem) {
    const ownerId = beforeLocalMutation?.();
    await enqueueInboxEvent({
      type: "delete",
      inboxId: item.id,
      payload: {},
      baseServerRevision: inbox.server_revision,
      expectedUserId: ownerId,
    });
    const queued = await pendingInboxEvents(ownerId);
    setInboxPendingCount(queued.length);
    setSyncStatus("pending_sync");
    window.setTimeout(() => {
      setInbox((current) => projectInboxState(current, queued));
      void flushInboxPending().catch(() => undefined);
    }, ACTION_DELETE_COLLAPSE_MS);
  }

  return {
    onAutosaveInboxDetails,
    onCreateInboxItem,
    onDeleteInboxItem,
    onUpdateInboxTitle,
  };
}
