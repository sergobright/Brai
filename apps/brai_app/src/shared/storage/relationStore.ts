import { cleanTitle, normalizeDescription } from "@/shared/activities/text";
import type { PendingActivityEvent } from "@/shared/types/activities";
import type {
  PendingRelationEvent,
  RelationEventPayload,
  RelationEventType,
  RelationItem,
  RelationSyncIssue,
  RelationsState,
  RelationTypeItem,
} from "@/shared/types/relations";
import { emptyRelationsState } from "@/shared/types/relations";
import { assertClientUserInCurrentTransaction, clientDb, ensureClientMeta, getMeta, randomId, setMeta } from "./db";
import {
  normalizeRelationItem,
  resolveRelationId,
  resolveRelationPayload,
  saveRelationsSnapshotInCurrentTransaction,
  type RelationIdAliases,
} from "./relationAcknowledgement";

/** Adds a Relation mutation to the durable local outbox. */
export async function enqueueRelationEvent(params: {
  type: RelationEventType;
  relationId?: string;
  payload: RelationEventPayload;
  baseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingRelationEvent> {
  const db = clientDb();
  return db.transaction("rw", db.meta, db.relation_outbox_events, async () => {
    if (params.expectedUserId !== undefined) await assertClientUserInCurrentTransaction(params.expectedUserId);
    const aliases = (await getMeta<RelationIdAliases>("relationIdAliases")) ?? {};
    const relationId = resolveRelationId(params.relationId, aliases);
    const payload = resolveRelationPayload(params.payload, aliases);
    if (params.type === "end" && relationId) {
      const pendingCreate = await db.relation_outbox_events
        .where("relationId").equals(relationId)
        .and((event) => event.type === "create" && event.status === "pending" && event.attemptCount === 0)
        .first();
      if (pendingCreate) {
        await db.relation_outbox_events.delete(pendingCreate.eventId);
        return pendingCreate;
      }
    }
    const duplicate = await equivalentPendingEvent(params.type, relationId, payload);
    if (duplicate) return duplicate;
    const meta = await ensureClientMeta();
    const event = relationEvent({
      ...params,
      relationId,
      payload,
      deviceId: meta.deviceId,
      clientSequence: meta.nextClientSequence,
    });
    if (params.type === "reorder") await removeStaleReorders(event);
    await db.relation_outbox_events.add(event);
    await setMeta("nextClientSequence", meta.nextClientSequence + 1);
    return event;
  });
}

/** Atomically persists a new Action and its dependent Goal membership. */
export async function enqueueActionWithGoalRelation(params: {
  title: string;
  descriptionMd?: string;
  goalItemsId: string;
  position?: number;
  activityBaseServerRevision: number;
  relationBaseServerRevision: number;
  expectedUserId?: string;
}): Promise<{ activityEvent: PendingActivityEvent; relationEvent: PendingRelationEvent }> {
  const title = cleanTitle(params.title);
  const goalItemsId = params.goalItemsId.trim();
  if (!title) throw new Error("activity_title_required");
  if (!goalItemsId) throw new Error("goal_items_id_required");
  const db = clientDb();
  return db.transaction("rw", db.meta, db.action_outbox_events, db.relation_outbox_events, async () => {
    if (params.expectedUserId !== undefined) await assertClientUserInCurrentTransaction(params.expectedUserId);
    const meta = await ensureClientMeta();
    const now = new Date().toISOString();
    const activitySequence = meta.nextClientSequence;
    const relationSequence = activitySequence + 1;
    const actionId = `${meta.deviceId}:activity:${activitySequence}`;
    const activityEvent: PendingActivityEvent = {
      eventId: `${meta.deviceId}:activity:${activitySequence}:${randomId()}`,
      deviceId: meta.deviceId,
      clientSequence: activitySequence,
      type: "create",
      occurredAtUtc: now,
      actionId,
      payload: {
        title,
        description_md: normalizeDescription(params.descriptionMd),
        activity_type_id: "action",
      },
      baseServerRevision: params.activityBaseServerRevision,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      lastError: null,
      enqueuedAtUtc: now,
      lastSyncAttemptAtUtc: null,
    };
    const relationEventValue = relationEvent({
      type: "create",
      relationId: randomId(),
      payload: {
        relation_type_id: "part_of",
        source_items_id: actionId,
        target_items_id: goalItemsId,
        position: normalizedPosition(params.position),
        dependency_event_ids: [activityEvent.eventId],
      },
      baseServerRevision: params.relationBaseServerRevision,
      deviceId: meta.deviceId,
      clientSequence: relationSequence,
      occurredAtUtc: now,
    });
    await db.action_outbox_events.add(activityEvent);
    await db.relation_outbox_events.add(relationEventValue);
    await setMeta("nextClientSequence", relationSequence + 1);
    return { activityEvent, relationEvent: relationEventValue };
  });
}

export async function pendingRelationEvents(expectedUserId?: string): Promise<PendingRelationEvent[]> {
  const db = clientDb();
  return db.transaction("r", db.meta, db.relation_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return (await db.relation_outbox_events.orderBy("clientSequence").toArray())
      .filter((event) => event.status !== "blocked");
  });
}

/** Marks causal intents whose Activity dependency was terminally ignored. */
export async function reconcileRelationDependencies(expectedUserId?: string): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.relation_outbox_events, db.ignored_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const relations = await db.relation_outbox_events.toArray();
    const dependencyIds = [...new Set(relations.flatMap((event) => event.payload.dependency_event_ids ?? []))];
    if (dependencyIds.length === 0) return;
    const ignored = new Map((await db.ignored_events.bulkGet(dependencyIds))
      .filter((row): row is NonNullable<typeof row> => row != null)
      .map((row) => [row.eventId, row.reason]));
    await Promise.all(relations.map((event) => {
      const rejected = (event.payload.dependency_event_ids ?? []).find((eventId) => ignored.has(eventId));
      if (!rejected) return Promise.resolve(0);
      return db.relation_outbox_events.update(event.eventId, {
        status: "blocked",
        lastError: boundedReason(`dependency_rejected:${ignored.get(rejected) ?? "ignored"}`),
      });
    }));
  });
}

/** Returns only Relation events whose local Activity dependencies have left the Activity outbox. */
export async function readyRelationEvents(expectedUserId?: string): Promise<PendingRelationEvent[]> {
  const db = clientDb();
  const [relations, pendingActivities, canonicalActivities] = await db.transaction(
    "r",
    db.meta,
    db.relation_outbox_events,
    db.action_outbox_events,
    db.actions_cache,
    async () => {
      if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
      return Promise.all([
        db.relation_outbox_events.orderBy("clientSequence").toArray(),
        db.action_outbox_events.toArray(),
        db.actions_cache.toArray(),
      ]);
    },
  );
  const pendingActivityIds = new Set(pendingActivities.map((event) => event.eventId));
  const canonicalById = new Map(canonicalActivities.map((activity) => [activity.id, activity]));
  const unresolvedCreates = relations.filter((event) => event.type === "create" && event.status !== "blocked");
  const pendingCreateIds = new Set(unresolvedCreates.map((event) => event.relationId));
  const pendingCreateTargets = new Set(unresolvedCreates.map((event) => event.payload.target_items_id));
  return relations.filter((event) => {
    if (event.status === "blocked") return false;
    if (event.type === "end" && pendingCreateIds.has(event.relationId)) return false;
    if (event.type === "reorder" && pendingCreateTargets.has(event.payload.target_items_id)) return false;
    const dependencies = event.payload.dependency_event_ids ?? [];
    if (dependencies.some((eventId) => pendingActivityIds.has(eventId))) return false;
    if (dependencies.length === 0 || event.type !== "create") return true;
    const source = event.payload.source_items_id ? canonicalById.get(event.payload.source_items_id) : null;
    return source?.item_roles_id != null;
  });
}

export async function markRelationAttempt(events: PendingRelationEvent[], expectedUserId?: string): Promise<void> {
  const now = new Date().toISOString();
  await updateRelationEvents(events, (event) => ({
    status: "syncing",
    attemptCount: event.attemptCount + 1,
    lastSyncAttemptAtUtc: now,
    lastError: null,
  }), expectedUserId);
}

export async function markRelationFailure(
  events: PendingRelationEvent[],
  message: string,
  expectedUserId?: string,
): Promise<void> {
  await updateRelationEvents(events, () => ({ status: "failed", lastError: boundedReason(message) }), expectedUserId);
}

/** Retains bounded ignored-event context, including the original local intent. */
export async function saveRelationSyncIssues(
  issues: Array<{ event_id: string; reason: string; relation_id?: string; change_type?: RelationEventType; payload?: RelationEventPayload }>,
  expectedUserId?: string,
  nowIso = new Date().toISOString(),
): Promise<void> {
  if (issues.length === 0) return;
  const db = clientDb();
  await db.transaction("rw", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const previous = (await getMeta<RelationSyncIssue[]>("relationSyncIssues")) ?? [];
    const byId = new Map(previous.map((issue) => [issue.event_id, issue]));
    for (const issue of issues) {
      byId.set(issue.event_id, {
        event_id: issue.event_id,
        reason: boundedReason(issue.reason),
        occurred_at_utc: nowIso,
        ...(issue.relation_id ? { relation_id: issue.relation_id } : {}),
        ...(issue.change_type ? { change_type: issue.change_type } : {}),
        ...(issue.payload ? { payload: normalizedRelationPayload(issue.payload) } : {}),
      });
    }
    await setMeta("relationSyncIssues", [...byId.values()]
      .sort((left, right) => right.occurred_at_utc.localeCompare(left.occurred_at_utc))
      .slice(0, 20));
  });
}

/** Returns recent terminal/retryable Relation sync issues for product feedback. */
export async function loadRelationSyncIssues(expectedUserId?: string): Promise<RelationSyncIssue[]> {
  const db = clientDb();
  const [persisted, outbox] = await db.transaction("r", db.meta, db.relation_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Promise.all([
      getMeta<RelationSyncIssue[]>("relationSyncIssues"),
      db.relation_outbox_events.toArray(),
    ]);
  });
  const live = outbox
    .filter((event) => event.status === "blocked" || event.status === "failed")
    .map((event) => ({
      event_id: event.eventId,
      reason: boundedReason(event.lastError ?? "relation_sync_failed"),
      occurred_at_utc: event.lastSyncAttemptAtUtc ?? event.enqueuedAtUtc,
    }));
  const byId = new Map([...(persisted ?? []), ...live].map((issue) => [issue.event_id, issue]));
  return [...byId.values()]
    .sort((left, right) => right.occurred_at_utc.localeCompare(left.occurred_at_utc))
    .slice(0, 20);
}

/** Stores only a complete monotonic Relation snapshot and repairs legacy partial caches. */
export async function saveRelationsState(state: RelationsState, expectedUserId?: string): Promise<boolean> {
  if (state.next_cursor) return false;
  const db = clientDb();
  return db.transaction(
    "rw",
    db.relations_cache,
    db.meta,
    () => saveRelationsSnapshotInCurrentTransaction(state, expectedUserId),
  );
}

/** Loads the canonical Relation snapshot from one IndexedDB transaction. */
export async function loadRelationsState(expectedUserId?: string): Promise<RelationsState | null> {
  const db = clientDb();
  const result = await db.transaction("r", db.relations_cache, db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const [relations, revision, serverTime, relationTypes] = await Promise.all([
      db.relations_cache.toArray(),
      db.meta.get("lastRelationServerRevision"),
      db.meta.get("lastRelationServerTimeUtc"),
      db.meta.get("relationTypesCache"),
    ]);
    return {
      relations,
      revision: (revision?.value as number | undefined) ?? null,
      serverTime: (serverTime?.value as string | undefined) ?? null,
      relationTypes: (relationTypes?.value as RelationTypeItem[] | undefined) ?? [],
    };
  });
  if (result.relations.length === 0 && result.revision == null) return null;
  const relations = result.relations.map(normalizeRelationItem);
  return {
    server_time_utc: result.serverTime ?? new Date().toISOString(),
    server_revision: result.revision ?? 0,
    relation_types: result.relationTypes,
    relations: sortRelations(relations.filter((item) => item.status === "active")),
    ended_relations: sortEndedRelations(relations.filter((item) => item.status === "ended")),
    next_cursor: null,
  };
}

export async function lastRelationServerRevision(expectedUserId?: string): Promise<number> {
  const db = clientDb();
  return db.transaction("r", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Number((await db.meta.get("lastRelationServerRevision"))?.value ?? 0);
  });
}

/** Applies pending Relation events over the last accepted server snapshot. */
export function projectRelationsState(
  canonical: RelationsState | null,
  pending: PendingRelationEvent[],
  now = new Date(),
): RelationsState {
  const base = canonical ?? emptyRelationsState(now);
  const relations = new Map<string, RelationItem>();
  for (const relation of [...base.relations, ...base.ended_relations]) {
    relations.set(relation.id, { ...normalizeRelationItem(relation), pending: false });
  }
  for (const event of [...pending].sort((a, b) => a.clientSequence - b.clientSequence)) {
    applyRelationEvent(relations, event);
  }
  const projected = [...relations.values()];
  return {
    ...base,
    relations: sortRelations(projected.filter((item) => item.status === "active")),
    ended_relations: sortEndedRelations(projected.filter((item) => item.status === "ended")),
  };
}

export function sortRelations(relations: RelationItem[]): RelationItem[] {
  return [...relations].sort((left, right) => {
    const byTarget = left.target_items_id.localeCompare(right.target_items_id);
    const byPosition = Number(left.position ?? Number.MAX_SAFE_INTEGER) - Number(right.position ?? Number.MAX_SAFE_INTEGER);
    return byTarget || byPosition || left.active_from_utc.localeCompare(right.active_from_utc) || left.id.localeCompare(right.id);
  });
}

function sortEndedRelations(relations: RelationItem[]): RelationItem[] {
  return [...relations].sort((left, right) =>
    (right.active_to_utc ?? right.updated_at_utc).localeCompare(left.active_to_utc ?? left.updated_at_utc) || left.id.localeCompare(right.id),
  );
}

function relationEvent(params: {
  type: RelationEventType;
  relationId?: string;
  payload: RelationEventPayload;
  baseServerRevision: number;
  deviceId: string;
  clientSequence: number;
  occurredAtUtc?: string;
}): PendingRelationEvent {
  const now = params.occurredAtUtc ?? new Date().toISOString();
  return {
    eventId: `${params.deviceId}:relation:${params.clientSequence}:${randomId()}`,
    deviceId: params.deviceId,
    clientSequence: params.clientSequence,
    type: params.type,
    occurredAtUtc: now,
    relationId: params.relationId ?? randomId(),
    payload: normalizedRelationPayload(params.payload),
    baseServerRevision: params.baseServerRevision,
    payloadVersion: 1,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    enqueuedAtUtc: now,
    lastSyncAttemptAtUtc: null,
  };
}

function applyRelationEvent(relations: Map<string, RelationItem>, event: PendingRelationEvent): void {
  const existing = relations.get(event.relationId);
  if (event.type === "create") {
    const typeId = event.payload.relation_type_id;
    const sourceId = event.payload.source_items_id;
    const targetId = event.payload.target_items_id;
    if (!typeId || !sourceId || !targetId || sourceId === targetId) return;
    relations.set(event.relationId, {
      id: event.relationId,
      user_id: "",
      relation_types_id: typeId,
      source_items_id: sourceId,
      target_items_id: targetId,
      status: "active",
      position: normalizedPosition(event.payload.position),
      active_from_utc: event.occurredAtUtc,
      active_to_utc: null,
      operation_id: event.eventId,
      ended_operation_id: null,
      origin_decision_id: null,
      created_by_actor_type: "user",
      created_by_actor_id: event.deviceId,
      ended_by_actor_type: null,
      ended_by_actor_id: null,
      end_reason: null,
      metadata_json: {},
      created_at_utc: event.occurredAtUtc,
      updated_at_utc: event.occurredAtUtc,
      pending: true,
    });
    return;
  }
  if (event.type === "end" && existing) {
    relations.set(existing.id, {
      ...existing,
      status: "ended",
      active_to_utc: event.occurredAtUtc,
      ended_operation_id: event.eventId,
      ended_by_actor_type: "user",
      ended_by_actor_id: event.deviceId,
      end_reason: event.payload.reason ?? "removed_by_user",
      updated_at_utc: event.occurredAtUtc,
      pending: true,
    });
    return;
  }
  if (event.type !== "reorder") return;
  const orderedIds = uniqueStrings(event.payload.ordered_relation_ids);
  orderedIds.forEach((id, position) => {
    const relation = relations.get(id);
    if (!relation || relation.status !== "active" || relation.target_items_id !== event.payload.target_items_id) return;
    relations.set(id, { ...relation, position, updated_at_utc: event.occurredAtUtc, pending: true });
  });
}

function normalizedRelationPayload(payload: RelationEventPayload): RelationEventPayload {
  return {
    relation_type_id: stringValue(payload.relation_type_id),
    source_items_id: stringValue(payload.source_items_id),
    target_items_id: stringValue(payload.target_items_id),
    position: normalizedPosition(payload.position),
    dependency_event_ids: uniqueStrings(payload.dependency_event_ids),
    reason: stringValue(payload.reason),
    ordered_relation_ids: uniqueStrings(payload.ordered_relation_ids),
  };
}

async function equivalentPendingEvent(
  type: RelationEventType,
  relationId: string | undefined,
  payload: RelationEventPayload,
): Promise<PendingRelationEvent | null> {
  const normalized = normalizedRelationPayload(payload);
  const events = await clientDb().relation_outbox_events.toArray();
  return events.find((event) => {
    if (event.type !== type) return false;
    if (type === "create") {
      return event.payload.relation_type_id === normalized.relation_type_id &&
        event.payload.source_items_id === normalized.source_items_id &&
        event.payload.target_items_id === normalized.target_items_id;
    }
    return relationId != null && event.relationId === relationId;
  }) ?? null;
}

async function removeStaleReorders(event: PendingRelationEvent): Promise<void> {
  const db = clientDb();
  const stale = await db.relation_outbox_events.filter((candidate) =>
    candidate.type === "reorder" && candidate.status !== "syncing" &&
    candidate.payload.target_items_id === event.payload.target_items_id,
  ).toArray();
  if (stale.length > 0) await db.relation_outbox_events.bulkDelete(stale.map((item) => item.eventId));
}

async function updateRelationEvents(
  events: PendingRelationEvent[],
  patch: (event: PendingRelationEvent) => Partial<PendingRelationEvent>,
  expectedUserId?: string,
): Promise<void> {
  const db = clientDb();
  await db.transaction("rw", db.meta, db.relation_outbox_events, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const current = await db.relation_outbox_events.bulkGet(events.map((event) => event.eventId));
    const updated = current
      .filter((event): event is PendingRelationEvent => event != null)
      .map((event) => ({ ...event, ...patch(event) }));
    if (updated.length > 0) await db.relation_outbox_events.bulkPut(updated);
  });
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter((item): item is string => Boolean(item)))];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedPosition(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function boundedReason(value: string): string {
  return value.trim().slice(0, 200) || "relation_sync_failed";
}
