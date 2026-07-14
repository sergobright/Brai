import {
  assertClientUserInCurrentTransaction,
  clientDb,
  ensureClientMeta,
  randomId,
  setMeta,
} from "./db";
import { migrateBraiLocalStoragePrefix, removeBraiLocalStorageItem, setBraiLocalStorageItem } from "./localStorageKeys";
import type {
  ActivitiesState,
  ActivityEventPayload,
  ActivityEventType,
  ActivityItem,
  ActivityStatus,
  ActivityType,
  PendingActivityEvent,
} from "@/shared/types/activities";
import { emptyActivitiesState } from "@/shared/types/activities";
import { cleanTitle, normalizeDescription } from "@/shared/activities/text";

export { cleanTitle, markdownPreviewSource, normalizeDescription, visibleDescriptionPreview } from "@/shared/activities/text";

/**
 * Adds an activity mutation to the durable local outbox.
 */
export async function enqueueActivityEvent(params: {
  type: ActivityEventType;
  actionId?: string;
  payload: ActivityEventPayload;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingActivityEvent> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.action_outbox_events, async () => {
    if (params.expectedUserId !== undefined) {
      await assertClientUserInCurrentTransaction(params.expectedUserId);
    }
    const meta = await ensureClientMeta();
    const sequence = meta.nextClientSequence;
    const now = new Date().toISOString();
    const actionId = params.actionId ?? `${meta.deviceId}:activity:${sequence}`;
    if (
      (params.type === "update_title" || params.type === "update_description" || params.type === "reorder") &&
      (params.actionId || params.type === "reorder")
    ) {
      const staleEvents = await db.action_outbox_events.filter((event) => {
        if (event.status === "syncing" || event.type !== params.type) return false;
        return params.type === "reorder" || event.actionId === params.actionId;
      }).toArray();
      if (staleEvents.length > 0) {
        await db.action_outbox_events.bulkDelete(staleEvents.map((event) => event.eventId));
      }
    }
    const event: PendingActivityEvent = {
      eventId: `${meta.deviceId}:activity:${sequence}:${randomId()}`,
      deviceId: meta.deviceId,
      clientSequence: sequence,
      type: params.type,
      occurredAtUtc: now,
      actionId,
      payload: normalizedPayload(params.payload),
      baseServerRevision: params.baseServerRevision,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      lastError: null,
      enqueuedAtUtc: now,
      lastSyncAttemptAtUtc: null,
    };
    await db.action_outbox_events.add(event);
    await setMeta("nextClientSequence", sequence + 1);
    return event;
  });
}

export async function pendingActivityEvents(expectedUserId?: string): Promise<PendingActivityEvent[]> {
  const db = clientDb();
  return db.transaction("r", db.meta, db.action_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return db.action_outbox_events.orderBy("clientSequence").toArray();
  });
}

/** Marks Activity events as being attempted within the optional expected owner scope. */
export async function markActivityAttempt(
  events: PendingActivityEvent[],
  expectedUserId?: string,
): Promise<void> {
  const db = clientDb();
  const now = new Date().toISOString();
  await db.transaction("rw", db.meta, db.action_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.action_outbox_events.update(event.eventId, {
          status: "syncing",
          attemptCount: event.attemptCount + 1,
          lastSyncAttemptAtUtc: now,
          lastError: null,
        }),
      ),
    );
  });
}

export async function markActivityFailure(
  events: PendingActivityEvent[],
  message: string,
  expectedUserId?: string,
): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.action_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await Promise.all(
      events.map((event) =>
        db.action_outbox_events.update(event.eventId, {
          status: "failed",
          lastError: message,
        }),
      ),
    );
  });
}

export async function acknowledgeActivityEvents(ids: string[], expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.action_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    await db.action_outbox_events.bulkDelete(ids);
  });
}

/** Persists typed Action, Goal, and legacy Operation projections at a monotonic revision. */
export async function saveActivitiesState(
  state: ActivitiesState,
  expectedUserId?: string,
): Promise<boolean> {
  const db = clientDb();
  return db.transaction(
    "rw",
    db.actions_cache,
    db.meta,
    () => saveActivitiesSnapshotInCurrentTransaction(state, expectedUserId),
  );
}

/** Writes an Activity snapshot inside the caller's Dexie transaction. */
export async function saveActivitiesSnapshotInCurrentTransaction(
  state: ActivitiesState,
  expectedUserId?: string,
): Promise<boolean> {
  const db = clientDb();
  if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
  const currentRevision = Number((await db.meta.get("lastActionServerRevision"))?.value ?? 0);
  if (state.server_revision < currentRevision || (currentRevision > 0 && state.server_revision === currentRevision)) return false;

  await db.actions_cache.clear();
  const allActivities = [
    ...state.actions,
    ...state.archived_actions,
    ...(state.legacy_operations ?? []),
    ...(state.goals ?? []),
    ...(state.archived_goals ?? []),
  ].map(normalizeActivityItem);
  if (allActivities.length > 0) await db.actions_cache.bulkPut(allActivities);
  await db.meta.bulkPut([
    { key: "lastActionServerRevision", value: state.server_revision },
    { key: "lastActionServerTimeUtc", value: state.server_time_utc },
    { key: "lastSuccessfulActionsSyncAtUtc", value: new Date().toISOString() },
  ]);
  return true;
}

/**
 * Loads the activities snapshot and its revision from one IndexedDB read transaction.
 */
export async function loadActivitiesState(expectedUserId?: string): Promise<ActivitiesState | null> {
  const db = clientDb();
  const { actions, revision, serverTimeUtc } = await db.transaction("r", db.actions_cache, db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const [cachedActions, revisionRow, serverTimeRow] = await Promise.all([
      db.actions_cache.toArray(),
      db.meta.get("lastActionServerRevision"),
      db.meta.get("lastActionServerTimeUtc"),
    ]);
    return {
      actions: cachedActions,
      revision: (revisionRow?.value as number | undefined) ?? null,
      serverTimeUtc: (serverTimeRow?.value as string | undefined) ?? null,
    };
  });
  if (actions.length === 0 && revision == null) return null;
  const normalized = actions.map(normalizeActivityItem);
  return {
    server_time_utc: serverTimeUtc ?? new Date().toISOString(),
    server_revision: revision ?? 0,
    actions: sortActivities(normalized.filter((item) => item.activity_type_id === "action" && !item.deleted_at_utc)),
    archived_actions: sortArchivedActivities(normalized.filter((item) => item.activity_type_id === "action" && item.deleted_at_utc)),
    legacy_operations: sortActivities(normalized.filter((item) => item.activity_type_id === "operation" && !item.deleted_at_utc)),
    goals: sortActivities(normalized.filter((item) => item.activity_type_id === "goal" && !item.deleted_at_utc)),
    archived_goals: sortArchivedActivities(normalized.filter((item) => item.activity_type_id === "goal" && item.deleted_at_utc)),
  };
}

export async function lastActivityServerRevision(expectedUserId?: string): Promise<number> {
  const db = clientDb();
  return db.transaction("r", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Number((await db.meta.get("lastActionServerRevision"))?.value ?? 0);
  });
}

/**
 * Applies pending activity events over the last accepted server snapshot.
 */
export function projectActivitiesState(
  canonical: ActivitiesState | null,
  pending: PendingActivityEvent[],
  now = new Date(),
): ActivitiesState {
  const base = canonical ?? emptyActivitiesState(now);
  const actions = new Map<string, ActivityItem>(
    base.actions.map((action) => [action.id, { ...normalizeActivityItem(action), pending: false }]),
  );
  for (const action of base.archived_actions) {
    actions.set(action.id, { ...normalizeActivityItem(action), pending: false });
  }
  for (const operation of base.legacy_operations ?? []) {
    actions.set(operation.id, { ...normalizeActivityItem(operation), pending: false });
  }
  for (const goal of base.goals ?? []) {
    actions.set(goal.id, { ...normalizeActivityItem(goal), pending: false });
  }
  for (const goal of base.archived_goals ?? []) {
    actions.set(goal.id, { ...normalizeActivityItem(goal), pending: false });
  }

  for (const event of [...pending].sort(compareActivityEvents)) {
    const existing = actions.get(event.actionId);
    const occurredAtUtc = event.occurredAtUtc;
    if (event.type === "create") {
      const title = cleanTitle(event.payload.title);
      if (!title) continue;
      actions.set(event.actionId, {
        id: event.actionId,
        activity_type_id: activityType(event.payload.activity_type_id),
        title,
        description_md: normalizeDescription(event.payload.description_md),
        author: "",
        reason: "",
        status: "New",
        created_at_utc: occurredAtUtc,
        updated_at_utc: occurredAtUtc,
        completed_at_utc: null,
        sort_order: null,
        deleted_at_utc: null,
        restored_at_utc: null,
        pending: true,
      });
    } else if (event.type === "update_title" && existing) {
      const title = cleanTitle(event.payload.title);
      if (!title) continue;
      actions.set(event.actionId, {
        ...existing,
        title,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "update_description" && existing) {
      actions.set(event.actionId, {
        ...existing,
        description_md: normalizeDescription(event.payload.description_md),
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "set_status" && existing && isActivityStatus(event.payload.status)) {
      actions.set(event.actionId, {
        ...existing,
        status: event.payload.status,
        updated_at_utc: occurredAtUtc,
        completed_at_utc: event.payload.status === "Done" ? occurredAtUtc : null,
        sort_order: null,
        pending: true,
      });
    } else if (
      event.type === "set_type" &&
      existing &&
      isActivityType(event.payload.from_activity_type_id) &&
      isActivityType(event.payload.to_activity_type_id) &&
      existing.activity_type_id === event.payload.from_activity_type_id
    ) {
      actions.set(event.actionId, {
        ...existing,
        activity_type_id: event.payload.to_activity_type_id,
        status: "New",
        completed_at_utc: null,
        sort_order: null,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (event.type === "reorder") {
      applyActivityOrder(actions, normalizeOrderedIds(event.payload.ordered_ids), occurredAtUtc);
    } else if (event.type === "delete") {
      if (!existing) continue;
      actions.set(event.actionId, {
        ...existing,
        deleted_at_utc: occurredAtUtc,
        updated_at_utc: occurredAtUtc,
        sort_order: null,
        pending: true,
      });
    } else if (event.type === "restore") {
      if (!existing) continue;
      actions.set(event.actionId, {
        ...existing,
        status: "New",
        completed_at_utc: null,
        sort_order: null,
        deleted_at_utc: null,
        restored_at_utc: occurredAtUtc,
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    }
  }

  const allActivities = [...actions.values()];
  const activeActions = allActivities.filter((item) => item.activity_type_id === "action" && !item.deleted_at_utc);
  const activeGoals = allActivities.filter((item) => item.activity_type_id === "goal" && !item.deleted_at_utc);
  return {
    ...base,
    actions: sortActivities(activeActions),
    archived_actions: sortArchivedActivities(allActivities.filter((item) => item.activity_type_id === "action" && item.deleted_at_utc)),
    legacy_operations: sortActivities(allActivities.filter((item) => item.activity_type_id === "operation" && !item.deleted_at_utc)),
    goals: sortActivities(activeGoals),
    archived_goals: sortArchivedActivities(allActivities.filter((item) => item.activity_type_id === "goal" && item.deleted_at_utc)),
  };
}

/**
 * Orders active activities for the product list, preserving manual order when present.
 */
export function sortActivities(actions: ActivityItem[]): ActivityItem[] {
  return [...actions].sort((left, right) => {
    if (left.status !== right.status) return left.status === "New" ? -1 : 1;
    if (left.status === "New") {
      const leftManual = Number.isInteger(left.sort_order);
      const rightManual = Number.isInteger(right.sort_order);
      if (leftManual !== rightManual) return leftManual ? 1 : -1;
      if (!leftManual && !rightManual) {
        const leftTime = left.restored_at_utc ?? left.created_at_utc;
        const rightTime = right.restored_at_utc ?? right.created_at_utc;
        const byCreated = rightTime.localeCompare(leftTime);
        return byCreated || left.id.localeCompare(right.id);
      }
      const byOrder = Number(left.sort_order) - Number(right.sort_order);
      return byOrder || left.id.localeCompare(right.id);
    }
    const leftTime = left.status === "Done" ? left.completed_at_utc ?? left.updated_at_utc : left.created_at_utc;
    const rightTime = right.status === "Done" ? right.completed_at_utc ?? right.updated_at_utc : right.created_at_utc;
    const byTime = rightTime.localeCompare(leftTime);
    return byTime || left.id.localeCompare(right.id);
  });
}

export function sortArchivedActivities(actions: ActivityItem[]): ActivityItem[] {
  return [...actions].sort((left, right) => {
    const leftTime = left.deleted_at_utc ?? left.updated_at_utc;
    const rightTime = right.deleted_at_utc ?? right.updated_at_utc;
    const byDeleted = rightTime.localeCompare(leftTime);
    return byDeleted || left.id.localeCompare(right.id);
  });
}

export function saveActivityEditDraft(actionId: string, title: string, descriptionMd: string): void {
  if (typeof window === "undefined") return;
  try {
    setBraiLocalStorageItem(
      actionDraftKey(actionId),
      JSON.stringify({
        actionId,
        title,
        description_md: normalizeDescription(descriptionMd),
        updated_at_utc: new Date().toISOString(),
      }),
    );
  } catch {
    // localStorage can be unavailable in private or constrained WebViews.
  }
}

export function clearActivityEditDraft(actionId: string): void {
  if (typeof window === "undefined") return;
  try {
    removeBraiLocalStorageItem(actionDraftKey(actionId));
  } catch {
    // localStorage can be unavailable in private or constrained WebViews.
  }
}

/**
 * Loads locally saved activity detail drafts after reload or app restart.
 */
export function loadActivityEditDrafts(): Array<{ actionId: string; title: string; descriptionMd: string }> {
  if (typeof window === "undefined") return [];
  const drafts: Array<{ actionId: string; title: string; descriptionMd: string }> = [];
  try {
    migrateBraiLocalStoragePrefix(ACTION_DRAFT_PREFIX);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(ACTION_DRAFT_PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        actionId?: unknown;
        title?: unknown;
        description_md?: unknown;
      };
      const actionId = typeof parsed.actionId === "string" ? parsed.actionId : key.slice(ACTION_DRAFT_PREFIX.length);
      drafts.push({
        actionId,
        title: typeof parsed.title === "string" ? parsed.title : "",
        descriptionMd: normalizeDescription(parsed.description_md),
      });
    }
  } catch {
    return drafts;
  }
  return drafts;
}

function normalizedPayload(payload: ActivityEventPayload): ActivityEventPayload {
  return {
    ...(payload.title == null ? {} : { title: cleanTitle(payload.title) }),
    ...(payload.description_md == null ? {} : { description_md: normalizeDescription(payload.description_md) }),
    ...(payload.status == null ? {} : { status: payload.status }),
    ...(payload.activity_type_id == null ? {} : { activity_type_id: payload.activity_type_id }),
    ...(payload.from_activity_type_id == null ? {} : { from_activity_type_id: payload.from_activity_type_id }),
    ...(payload.to_activity_type_id == null ? {} : { to_activity_type_id: payload.to_activity_type_id }),
    ...(payload.ordered_ids == null ? {} : { ordered_ids: normalizeOrderedIds(payload.ordered_ids) }),
  };
}

function normalizeActivityItem(action: ActivityItem): ActivityItem {
  return {
    ...action,
    activity_type_id: action.activity_type_id ?? "action",
    author: action.author ?? "",
    reason: action.reason ?? "",
    description_md: normalizeDescription(action.description_md),
    sort_order: Number.isInteger(action.sort_order) ? action.sort_order : null,
    deleted_at_utc: action.deleted_at_utc ?? null,
    restored_at_utc: action.restored_at_utc ?? null,
  };
}

function isActivityStatus(value: unknown): value is ActivityStatus {
  return value === "New" || value === "Done";
}

function isActivityType(value: unknown): value is ActivityType {
  return value === "action" || value === "goal" || value === "operation";
}

function activityType(value: unknown): ActivityType {
  return isActivityType(value) ? value : "action";
}

function compareActivityEvents(left: PendingActivityEvent, right: PendingActivityEvent): number {
  const byTime = left.occurredAtUtc.localeCompare(right.occurredAtUtc);
  return byTime || left.clientSequence - right.clientSequence;
}

function applyActivityOrder(actions: Map<string, ActivityItem>, orderedIds: string[], occurredAtUtc: string): void {
  const ordered = new Set(orderedIds);
  for (const action of actions.values()) {
    if (!action.deleted_at_utc && action.status === "New" && ordered.has(action.id)) {
      actions.set(action.id, {
        ...action,
        sort_order: orderedIds.indexOf(action.id),
        updated_at_utc: occurredAtUtc,
        pending: true,
      });
    } else if (!action.deleted_at_utc && action.status === "New") {
      actions.set(action.id, {
        ...action,
        sort_order: null,
      });
    }
  }
}

function normalizeOrderedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const ACTION_DRAFT_PREFIX = "brai_activity_draft:";

function actionDraftKey(actionId: string): string {
  return `${ACTION_DRAFT_PREFIX}${actionId}`;
}

export const enqueueActionEvent = enqueueActivityEvent;
export const pendingActionEvents = pendingActivityEvents;
export const markActionAttempt = markActivityAttempt;
export const markActionFailure = markActivityFailure;
export const acknowledgeActionEvents = acknowledgeActivityEvents;
export const saveActionsState = saveActivitiesState;
export const loadActionsState = loadActivitiesState;
export const lastActionServerRevision = lastActivityServerRevision;
export const projectActionsState = projectActivitiesState;
export const sortActions = sortActivities;
export const sortArchivedActions = sortArchivedActivities;
export const saveActionEditDraft = saveActivityEditDraft;
export const clearActionEditDraft = clearActivityEditDraft;
export const loadActionEditDrafts = loadActivityEditDrafts;
