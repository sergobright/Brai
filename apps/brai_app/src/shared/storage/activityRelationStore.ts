import type { ActivitiesState, PendingActivityEvent } from "@/shared/types/activities";
import type { PendingRelationEvent, RelationItem } from "@/shared/types/relations";
import {
  assertClientUserInCurrentTransaction,
  clientDb,
  ensureClientMeta,
  randomId,
  setMeta,
} from "./db";
import { saveActivitiesSnapshotInCurrentTransaction } from "./activityStore";

/**
 * Commits terminal Activity outcomes and their Relation dependency barrier as
 * one durable acknowledgement. A failed transaction leaves the Activity in
 * the outbox, so dependent Relations remain retry-safe after restart.
 */
export async function acknowledgeActivitySyncEvents(params: {
  acknowledgedEventIds: string[];
  ignoredEvents: Array<{ event_id: string; reason: string }>;
  state: ActivitiesState;
  expectedUserId?: string;
}): Promise<boolean> {
  const ignored = new Map(params.ignoredEvents.map((event) => [event.event_id, event.reason]));
  const acknowledged = [...new Set([...params.acknowledgedEventIds, ...ignored.keys()])];

  const db = clientDb();
  return db.transaction(
    "rw",
    [db.meta, db.action_outbox_events, db.actions_cache, db.ignored_events, db.relation_outbox_events],
    async () => {
      if (params.expectedUserId !== undefined) {
        await assertClientUserInCurrentTransaction(params.expectedUserId);
      }
      if (ignored.size > 0) {
        const acknowledgedAtUtc = new Date().toISOString();
        await db.ignored_events.bulkPut([...ignored].map(([eventId, reason]) => ({
          eventId,
          reason,
          acknowledgedAtUtc,
        })));

        const relations = await db.relation_outbox_events.toArray();
        await Promise.all(relations.map((event) => {
          const rejected = (event.payload.dependency_event_ids ?? []).find((eventId) => ignored.has(eventId));
          if (!rejected) return Promise.resolve(0);
          const reason = ignored.get(rejected)?.trim() || "ignored";
          return db.relation_outbox_events.update(event.eventId, {
            status: "blocked",
            lastError: `dependency_rejected:${reason}`.slice(0, 200),
          });
        }));
      }
      const accepted = await saveActivitiesSnapshotInCurrentTransaction(params.state);
      await db.action_outbox_events.bulkDelete(acknowledged);
      return accepted;
    },
  );
}

/**
 * Persists an Activity delete and all visible Relation endings as one local
 * intent. Restore intentionally does not recreate ended memberships.
 */
export async function enqueueActivityDeleteWithRelationEnds(params: {
  activityId: string;
  activityBaseServerRevision: number;
  relationBaseServerRevision: number;
  expectedUserId?: string;
}): Promise<PendingActivityEvent> {
  const db = clientDb();
  return db.transaction(
    "rw",
    db.meta,
    db.action_outbox_events,
    db.relation_outbox_events,
    db.relations_cache,
    async () => {
      if (params.expectedUserId !== undefined) {
        await assertClientUserInCurrentTransaction(params.expectedUserId);
      }
      const meta = await ensureClientMeta();
      const now = new Date().toISOString();
      const activityEvent = deleteActivityEvent({
        activityId: params.activityId,
        deviceId: meta.deviceId,
        sequence: meta.nextClientSequence,
        now,
        baseServerRevision: params.activityBaseServerRevision,
      });
      await db.action_outbox_events.add(activityEvent);

      const [cached, relationOutbox] = await Promise.all([
        db.relations_cache
          .filter((relation) => relation.status === "active" && touches(relation, params.activityId))
          .toArray(),
        db.relation_outbox_events.toArray(),
      ]);
      const canceledCreates = relationOutbox.filter((event) =>
        event.type === "create" && event.status !== "syncing" && touchesPayload(event, params.activityId),
      );
      if (canceledCreates.length > 0) {
        await db.relation_outbox_events.bulkDelete(canceledCreates.map((event) => event.eventId));
      }

      const canceledIds = new Set(canceledCreates.map((event) => event.relationId));
      const alreadyEnding = new Set(relationOutbox
        .filter((event) => event.type === "end")
        .map((event) => event.relationId));
      const active = new Map<string, RelationItem | PendingRelationEvent>();
      for (const relation of cached) active.set(relation.id, relation);
      for (const event of relationOutbox) {
        if (event.type === "create" && event.status === "syncing" && touchesPayload(event, params.activityId)) {
          active.set(event.relationId, event);
        }
      }

      let sequence = activityEvent.clientSequence + 1;
      for (const [relationId] of active) {
        if (canceledIds.has(relationId) || alreadyEnding.has(relationId)) continue;
        await db.relation_outbox_events.add(endRelationEvent({
          relationId,
          dependencyEventId: activityEvent.eventId,
          deviceId: meta.deviceId,
          sequence,
          now,
          baseServerRevision: params.relationBaseServerRevision,
        }));
        sequence += 1;
      }

      const staleReorders = relationOutbox.filter((event) =>
        event.type === "reorder" && event.status !== "syncing" && event.payload.target_items_id === params.activityId,
      );
      if (staleReorders.length > 0) {
        await db.relation_outbox_events.bulkDelete(staleReorders.map((event) => event.eventId));
      }
      await setMeta("nextClientSequence", sequence);
      return activityEvent;
    },
  );
}

function deleteActivityEvent(input: {
  activityId: string;
  deviceId: string;
  sequence: number;
  now: string;
  baseServerRevision: number;
}): PendingActivityEvent {
  return {
    eventId: `${input.deviceId}:activity:${input.sequence}:${randomId()}`,
    deviceId: input.deviceId,
    clientSequence: input.sequence,
    type: "delete",
    occurredAtUtc: input.now,
    actionId: input.activityId,
    payload: {},
    baseServerRevision: input.baseServerRevision,
    payloadVersion: 1,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    enqueuedAtUtc: input.now,
    lastSyncAttemptAtUtc: null,
  };
}

function endRelationEvent(input: {
  relationId: string;
  dependencyEventId: string;
  deviceId: string;
  sequence: number;
  now: string;
  baseServerRevision: number;
}): PendingRelationEvent {
  return {
    eventId: `${input.deviceId}:relation:${input.sequence}:${randomId()}`,
    deviceId: input.deviceId,
    clientSequence: input.sequence,
    type: "end",
    occurredAtUtc: input.now,
    relationId: input.relationId,
    payload: { reason: "endpoint_deleted", dependency_event_ids: [input.dependencyEventId] },
    baseServerRevision: input.baseServerRevision,
    payloadVersion: 1,
    status: "pending",
    attemptCount: 0,
    lastError: null,
    enqueuedAtUtc: input.now,
    lastSyncAttemptAtUtc: null,
  };
}

function touches(relation: RelationItem, itemId: string): boolean {
  return relation.source_items_id === itemId || relation.target_items_id === itemId;
}

function touchesPayload(event: PendingRelationEvent, itemId: string): boolean {
  return event.payload.source_items_id === itemId || event.payload.target_items_id === itemId;
}
