import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import type { InboxEventPayload, InboxEventType, InboxItem, InboxState, PendingInboxEvent } from "@/shared/types/inbox";
import { emptyInboxState } from "@/shared/types/inbox";
import { assertClientUserInCurrentTransaction, clientDb, ensureClientMeta, randomId, setMeta } from "./db";

export { cleanTitle, markdownPreviewSource, normalizeDescription, visibleDescriptionPreview } from "@/shared/activities/text";

/**
 * Adds an inbox mutation to the durable local outbox.
 */
export async function enqueueInboxEvent(params: {
  type: InboxEventType;
  inboxId?: string;
  payload: InboxEventPayload;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingInboxEvent> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.inbox_outbox_events, async () => {
    if (params.expectedUserId !== undefined) await assertClientUserInCurrentTransaction(params.expectedUserId);
    const meta = await ensureClientMeta();
    const sequence = meta.nextClientSequence;
    const now = new Date().toISOString();
    const inboxId = params.inboxId ?? `${meta.deviceId}:inbox:${sequence}`;
    if ((params.type === "update_title" || params.type === "update_description") && params.inboxId) {
      const staleEvents = await db.inbox_outbox_events.filter((event) => {
        if (event.status === "syncing" || event.type !== params.type) return false;
        return event.inboxId === params.inboxId;
      }).toArray();
      if (staleEvents.length > 0) {
        await db.inbox_outbox_events.bulkDelete(staleEvents.map((event) => event.eventId));
      }
    }
    const event: PendingInboxEvent = {
      eventId: `${meta.deviceId}:inbox:${sequence}:${randomId()}`,
      deviceId: meta.deviceId,
      clientSequence: sequence,
      type: params.type,
      occurredAtUtc: now,
      inboxId,
      payload: normalizedPayload(params.payload, params.type, meta.deviceId),
      baseServerRevision: params.baseServerRevision,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      lastError: null,
      enqueuedAtUtc: now,
      lastSyncAttemptAtUtc: null,
    };
    await db.inbox_outbox_events.add(event);
    await setMeta("nextClientSequence", sequence + 1);
    return event;
  });
}

export async function pendingInboxEvents(expectedUserId?: string): Promise<PendingInboxEvent[]> {
  const db = clientDb();
  return db.transaction("r", db.meta, db.inbox_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return db.inbox_outbox_events.orderBy("clientSequence").toArray();
  });
}

export async function markInboxAttempt(events: PendingInboxEvent[], expectedUserId?: string): Promise<void> {
  const now = new Date().toISOString();
  const db = clientDb();
  await db.transaction("rw", db.meta, db.inbox_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.inbox_outbox_events.update(event.eventId, {
          status: "syncing",
          attemptCount: event.attemptCount + 1,
          lastSyncAttemptAtUtc: now,
          lastError: null,
        }),
      ),
    );
  });
}

export async function markInboxFailure(events: PendingInboxEvent[], message: string, expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.inbox_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.inbox_outbox_events.update(event.eventId, {
          status: "failed",
          lastError: message,
        }),
      ),
    );
  });
}

export async function acknowledgeInboxEvents(ids: string[], expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.inbox_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await db.inbox_outbox_events.bulkDelete(ids);
  });
}

/** Atomically accepts an Inbox sync snapshot, ignored rows, and outbox acknowledgements. */
export async function acknowledgeInboxSyncEvents(params: {
  acknowledgedEventIds: string[];
  ignoredEvents: Array<{ event_id: string; reason: string }>;
  state: InboxState;
  expectedUserId?: string;
}): Promise<boolean> {
  const acknowledged = [...new Set([
    ...params.acknowledgedEventIds,
    ...params.ignoredEvents.map((event) => event.event_id),
  ])];
  const db = clientDb();
  return db.transaction("rw", db.inbox_cache, db.inbox_outbox_events, db.ignored_events, db.meta, async () => {
    if (params.expectedUserId !== undefined) await assertClientUserInCurrentTransaction(params.expectedUserId);
    if (params.ignoredEvents.length > 0) {
      const acknowledgedAtUtc = new Date().toISOString();
      await db.ignored_events.bulkPut(params.ignoredEvents.map((event) => ({
        eventId: event.event_id,
        reason: event.reason,
        acknowledgedAtUtc,
      })));
    }
    const accepted = await saveInboxSnapshotInCurrentTransaction(params.state, params.expectedUserId);
    await db.inbox_outbox_events.bulkDelete(acknowledged);
    return accepted;
  });
}

export async function saveInboxState(state: InboxState, expectedUserId?: string): Promise<boolean> {
  const db = clientDb();
  return db.transaction("rw", db.inbox_cache, db.meta, () => saveInboxSnapshotInCurrentTransaction(state, expectedUserId));
}

/** Writes an Inbox snapshot inside the caller's Dexie transaction. */
export async function saveInboxSnapshotInCurrentTransaction(state: InboxState, expectedUserId?: string): Promise<boolean> {
  const db = clientDb();
  if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
  const currentRevision = Number((await db.meta.get("lastInboxServerRevision"))?.value ?? 0);
  if (state.server_revision < currentRevision || (currentRevision > 0 && state.server_revision === currentRevision)) return false;

  await db.inbox_cache.clear();
  const allItems = state.inbox.map(normalizeInboxItem);
  if (allItems.length > 0) await db.inbox_cache.bulkPut(allItems);
  await db.meta.bulkPut([
    { key: "lastInboxServerRevision", value: state.server_revision },
    { key: "lastInboxServerTimeUtc", value: state.server_time_utc },
    { key: "lastSuccessfulInboxSyncAtUtc", value: new Date().toISOString() },
  ]);
  return true;
}

/**
 * Loads the inbox snapshot and revision from IndexedDB.
 */
export async function loadInboxState(expectedUserId?: string): Promise<InboxState | null> {
  const db = clientDb();
  const { items, revision, serverTimeUtc } = await db.transaction("r", db.inbox_cache, db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const [cachedItems, revisionRow, serverTimeRow] = await Promise.all([
      db.inbox_cache.toArray(),
      db.meta.get("lastInboxServerRevision"),
      db.meta.get("lastInboxServerTimeUtc"),
    ]);
    return {
      items: cachedItems,
      revision: (revisionRow?.value as number | undefined) ?? null,
      serverTimeUtc: (serverTimeRow?.value as string | undefined) ?? null,
    };
  });
  if (items.length === 0 && revision == null) return null;
  return {
    server_time_utc: serverTimeUtc ?? new Date().toISOString(),
    server_revision: revision ?? 0,
    inbox: sortInbox(items.map(normalizeInboxItem).filter((item) => !item.deleted_at_utc)),
  };
}

export async function lastInboxServerRevision(expectedUserId?: string): Promise<number> {
  const db = clientDb();
  return db.transaction("r", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Number((await db.meta.get("lastInboxServerRevision"))?.value ?? 0);
  });
}

/**
 * Applies pending inbox events over the last accepted server snapshot.
 */
export function projectInboxState(
  canonical: InboxState | null,
  pending: PendingInboxEvent[],
  now = new Date(),
): InboxState {
  const base = canonical ?? emptyInboxState(now);
  const items = new Map<string, InboxItem>(
    base.inbox.map((item) => [item.id, { ...normalizeInboxItem(item), pending: false }]),
  );

  for (const event of [...pending].sort(compareInboxEvents)) {
    const existing = items.get(event.inboxId);
    const occurredAtUtc = event.occurredAtUtc;
    if (event.type === "create") {
      const title = cleanTitle(event.payload.title);
      if (!title) continue;
      items.set(event.inboxId, {
        id: event.inboxId,
        items_id: null,
        title,
        description_md: normalizeDescription(event.payload.description_md),
        source: event.payload.source ?? "",
        source_key: event.payload.source_key ?? "",
        response_required: false,
        related_inbox_id: null,
        record_type_id: 4,
        item_date: null,
        author: "",
        preliminary_section: "",
        urgency: "",
        attachment_links: [],
        explanation_text: event.payload.explanation_text ?? "",
        normalization_text: "",
        is_normalized: false,
        status: "New",
        completed_at_utc: null,
        sort_order: null,
        item_roles_id: null,
        initial_event_id: null,
        workflow_execution_id: null,
        workflow_status: "queued",
        workflow_step: "ingest",
        workflow_attempt_count: 0,
        workflow_last_error: null,
        temporal_workflow_id: null,
        temporal_run_id: null,
        ai_processing_status: null,
        ai_processing_error: null,
        created_at_utc: occurredAtUtc,
        updated_at_utc: occurredAtUtc,
        deleted_at_utc: null,
        restored_at_utc: null,
        pending: true,
      });
    } else if (event.type === "update_title" && existing) {
      const title = cleanTitle(event.payload.title);
      if (!title) continue;
      items.set(event.inboxId, {
        ...existing,
        title,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "update_description" && existing) {
      items.set(event.inboxId, {
        ...existing,
        description_md: normalizeDescription(event.payload.description_md),
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "reorder") {
      for (const [index, id] of (event.payload.ordered_ids ?? []).entries()) {
        const ordered = items.get(id);
        if (ordered) items.set(id, { ...ordered, sort_order: index, updated_at_utc: occurredAtUtc, pending: true });
      }
    } else if (event.type === "delete" && existing) {
      items.set(event.inboxId, {
        ...existing,
        deleted_at_utc: occurredAtUtc,
        sort_order: null,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "restore" && existing) {
      items.set(event.inboxId, {
        ...existing,
        deleted_at_utc: null,
        restored_at_utc: occurredAtUtc,
        status: "New",
        completed_at_utc: null,
        sort_order: null,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    }
  }

  return {
    ...base,
    inbox: sortInbox([...items.values()].filter((item) => !item.deleted_at_utc)),
  };
}

export function sortInbox(items: InboxItem[]): InboxItem[] {
  return [...items].sort((left, right) => {
    const leftManual = Number.isInteger(left.sort_order);
    const rightManual = Number.isInteger(right.sort_order);
    if (leftManual !== rightManual) return leftManual ? 1 : -1;
    if (leftManual && rightManual) return Number(left.sort_order) - Number(right.sort_order) || left.id.localeCompare(right.id);
    const byCreated = (right.restored_at_utc ?? right.created_at_utc).localeCompare(left.restored_at_utc ?? left.created_at_utc);
    return byCreated || right.updated_at_utc.localeCompare(left.updated_at_utc) || left.id.localeCompare(right.id);
  });
}

function normalizedPayload(payload: InboxEventPayload, type: InboxEventType, deviceId: string): InboxEventPayload {
  const title = payload.title == null ? undefined : cleanTitle(payload.title);
  const normalized = {
    title,
    description_md: payload.description_md == null ? undefined : normalizeDescription(payload.description_md),
    ordered_ids: Array.isArray(payload.ordered_ids) ? [...new Set(payload.ordered_ids.filter(Boolean))] : undefined,
  };
  if (type !== "create") return normalized;
  return {
    ...normalized,
    source: payload.source?.trim() || "brai-app",
    source_key: payload.source_key?.trim() || deviceId,
    explanation_text: normalizeDescription(payload.explanation_text ?? title ?? ""),
  };
}

function normalizeInboxItem(item: InboxItem): InboxItem {
  return {
    ...item,
    items_id: typeof item.items_id === "string" && item.items_id ? item.items_id : (item.item_roles_id ? item.id : null),
    description_md: normalizeDescription(item.description_md),
    source_key: item.source_key ?? "",
    response_required: Boolean(item.response_required),
    related_inbox_id: item.related_inbox_id ?? null,
    record_type_id: Number.isInteger(item.record_type_id) ? item.record_type_id : 4,
    attachment_links: Array.isArray(item.attachment_links) ? item.attachment_links : [],
    item_date: item.item_date ?? null,
    deleted_at_utc: item.deleted_at_utc ?? null,
    is_normalized: Boolean(item.is_normalized),
    status: item.status === "Done" ? "Done" : "New",
    completed_at_utc: item.completed_at_utc ?? null,
    sort_order: Number.isInteger(item.sort_order) ? item.sort_order : null,
    item_roles_id: Number.isInteger(item.item_roles_id) ? item.item_roles_id : null,
    initial_event_id: item.initial_event_id ?? null,
    workflow_execution_id: Number.isInteger(item.workflow_execution_id) ? item.workflow_execution_id : null,
    workflow_status: ["queued", "running", "completed", "failed", "needs_review"].includes(item.workflow_status ?? "")
      ? item.workflow_status
      : null,
    workflow_step: item.workflow_step ?? null,
    workflow_attempt_count: Number.isInteger(item.workflow_attempt_count) ? item.workflow_attempt_count : 0,
    workflow_last_error: item.workflow_last_error ?? null,
    temporal_workflow_id: item.temporal_workflow_id ?? null,
    temporal_run_id: item.temporal_run_id ?? null,
    ai_processing_status: ["running", "failed", "needs_review"].includes(item.ai_processing_status ?? "")
      ? item.ai_processing_status
      : null,
    ai_processing_error: typeof item.ai_processing_error === "string" ? item.ai_processing_error : null,
    restored_at_utc: item.restored_at_utc ?? null,
  };
}

function compareInboxEvents(left: PendingInboxEvent, right: PendingInboxEvent): number {
  const byTime = left.occurredAtUtc.localeCompare(right.occurredAtUtc);
  return byTime || left.clientSequence - right.clientSequence;
}
