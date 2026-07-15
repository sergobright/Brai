import type { PendingRelationEvent, RelationEventPayload, RelationItem, RelationsState } from "@/shared/types/relations";
import { assertClientUserInCurrentTransaction, clientDb, getMeta, setMeta } from "./db";

export type RelationIdAliases = Record<string, string>;

/** Resolves a provisional Relation id through the durable canonical-id aliases. */
export function resolveRelationId(id: string | undefined, aliases: RelationIdAliases): string | undefined {
  let current = id;
  const visited = new Set<string>();
  while (current && aliases[current] && !visited.has(current)) {
    visited.add(current);
    current = aliases[current];
  }
  return current;
}

/** Replaces provisional Relation ids embedded in a mutation payload. */
export function resolveRelationPayload(payload: RelationEventPayload, aliases: RelationIdAliases): RelationEventPayload {
  if (!payload.ordered_relation_ids?.length) return payload;
  return {
    ...payload,
    ordered_relation_ids: [...new Set(payload.ordered_relation_ids.map((id) => resolveRelationId(id, aliases) ?? id))],
  };
}

/** Atomically acknowledges synced events and rebinds queued mutations to canonical Relation ids. */
export async function acknowledgeRelationEvents(params: {
  acknowledgedEventIds: string[];
  acceptedEvents: PendingRelationEvent[];
  ignoredEvents: Array<{ event_id: string; reason: string }>;
  state: RelationsState;
  expectedUserId?: string;
}): Promise<boolean> {
  if (params.state.next_cursor) throw new Error("relation_snapshot_incomplete");
  const db = clientDb();
  return db.transaction("rw", db.meta, db.relations_cache, db.relation_outbox_events, db.ignored_events, async () => {
    if (params.expectedUserId !== undefined) await assertClientUserInCurrentTransaction(params.expectedUserId);
    const existing = (await getMeta<RelationIdAliases>("relationIdAliases")) ?? {};
    const aliases = { ...existing };
    const rebaseTargets = new Set<string>();
    for (const event of params.acceptedEvents) {
      if (event.type !== "create") continue;
      if (event.payload.target_items_id) rebaseTargets.add(event.payload.target_items_id);
      const canonical = canonicalRelation(params.state, event);
      if (canonical && canonical.id !== event.relationId) aliases[event.relationId] = canonical.id;
    }
    const acknowledged = new Set(params.acknowledgedEventIds);
    const queued = await db.relation_outbox_events.toArray();
    for (const event of queued) {
      if (acknowledged.has(event.eventId)) continue;
      const relationId = resolveRelationId(event.relationId, aliases) ?? event.relationId;
      const payload = resolveRelationPayload(event.payload, aliases);
      const rebase = event.type === "reorder" && rebaseTargets.has(event.payload.target_items_id ?? "");
      if (relationId !== event.relationId || payload !== event.payload || rebase) {
        await db.relation_outbox_events.update(event.eventId, {
          relationId,
          payload,
          ...(rebase ? { baseServerRevision: params.state.server_revision } : {}),
        });
      }
    }
    if (params.ignoredEvents.length > 0) {
      const acknowledgedAtUtc = new Date().toISOString();
      await db.ignored_events.bulkPut(params.ignoredEvents.map((event) => ({
        eventId: event.event_id,
        reason: event.reason,
        acknowledgedAtUtc,
      })));
    }
    const accepted = await saveRelationsSnapshotInCurrentTransaction(params.state, params.expectedUserId);
    await db.relation_outbox_events.bulkDelete(params.acknowledgedEventIds);
    await setMeta("relationIdAliases", aliases);
    return accepted;
  });
}

/** Writes a complete Relation snapshot inside the caller's Dexie transaction. */
export async function saveRelationsSnapshotInCurrentTransaction(
  state: RelationsState,
  expectedUserId?: string,
): Promise<boolean> {
  if (state.next_cursor) return false;
  const db = clientDb();
  if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
  const [revisionRow, completeRow] = await Promise.all([
    db.meta.get("lastRelationServerRevision"),
    db.meta.get("relationsSnapshotComplete"),
  ]);
  const currentRevision = Number(revisionRow?.value ?? 0);
  const currentComplete = completeRow?.value === true;
  if (state.server_revision < currentRevision || (currentComplete && currentRevision > 0 && state.server_revision === currentRevision)) return false;

  await db.relations_cache.clear();
  const relations = [...state.relations, ...state.ended_relations].map(normalizeRelationItem);
  if (relations.length > 0) await db.relations_cache.bulkPut(relations);
  await db.meta.bulkPut([
    { key: "lastRelationServerRevision", value: state.server_revision },
    { key: "lastRelationServerTimeUtc", value: state.server_time_utc },
    { key: "relationTypesCache", value: state.relation_types },
    { key: "relationsSnapshotComplete", value: true },
    { key: "lastSuccessfulRelationsSyncAtUtc", value: new Date().toISOString() },
  ]);
  return true;
}

/** Normalizes optional Relation fields before durable cache storage. */
export function normalizeRelationItem(item: RelationItem): RelationItem {
  return {
    ...item,
    position: Number.isInteger(item.position) && Number(item.position) >= 0 ? Number(item.position) : null,
    active_to_utc: item.active_to_utc ?? null,
    ended_operation_id: item.ended_operation_id ?? null,
    origin_decision_id: item.origin_decision_id ?? null,
    created_by_actor_id: item.created_by_actor_id ?? null,
    ended_by_actor_type: item.ended_by_actor_type ?? null,
    ended_by_actor_id: item.ended_by_actor_id ?? null,
    end_reason: item.end_reason ?? null,
    metadata_json: item.metadata_json && typeof item.metadata_json === "object" ? item.metadata_json : {},
  };
}

function canonicalRelation(state: RelationsState, event: PendingRelationEvent): RelationItem | undefined {
  const typeId = event.payload.relation_type_id;
  const sourceId = event.payload.source_items_id;
  const targetId = event.payload.target_items_id;
  const symmetric = state.relation_types.find((type) => type.id === typeId)?.directionality === "symmetric";
  return [...state.relations, ...state.ended_relations].find((relation) =>
    relation.relation_types_id === typeId && (
      relation.source_items_id === sourceId && relation.target_items_id === targetId
      || symmetric && relation.source_items_id === targetId && relation.target_items_id === sourceId
    ));
}
