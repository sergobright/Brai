import { FUTURE_EVENT_TOLERANCE_MS, isPostgresInteger, normalizeOrderedIds, parseJsonObject, sanitizeText } from './store-helpers.js';
import { readGoalMembers, readRelationTypes } from './store-relation-read-models.js';
import { scopedUserId } from './user-scope.js';
const RELATION_EVENT_TYPES = new Set(['create', 'end', 'reorder']);
const ACTOR_TYPES = new Set(['user', 'agent', 'system']);
const MAX_RELATION_BATCH = 500;
export const relationMethods = {
  getRelationServerRevision() {
    return this.getEventDomainRevision('relation');
  },
  listRelationTypes() {
    const userId = requireUser();
    return readRelationTypes(this.db, userId);
  },
  listRelations({ endpointItemsId, relationTypeId, status, limit = 500, cursor } = {}) {
    const userId = requireUser();
    const clauses = ['user_id = ?'];
    const params = [userId];
    if (sanitizeText(endpointItemsId)) {
      clauses.push('(source_items_id = ? OR target_items_id = ?)');
      params.push(endpointItemsId, endpointItemsId);
    }
    if (sanitizeText(relationTypeId)) {
      clauses.push('relation_types_id = ?');
      params.push(relationTypeId);
    }
    if (status === 'active' || status === 'ended') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (sanitizeText(cursor)) {
      clauses.push('id > ?');
      params.push(cursor);
    }
    params.push(Math.max(1, Math.min(Number(limit) || 500, 501)));
    return this.db.prepare(`
      SELECT * FROM relations
      WHERE ${clauses.join(' AND ')}
      ORDER BY id
      LIMIT ?
    `).all(...params).map(formatRelation);
  },
  relationState(nowIso = new Date().toISOString(), {
    endpointItemsId,
    relationTypeId,
    status = 'active',
    limit = 500,
    cursor
  } = {}) {
    return readSnapshot(this, () => {
      const pageLimit = Math.max(1, Math.min(Number(limit) || 500, 500));
      const page = this.listRelations({
        endpointItemsId,
        relationTypeId,
        status,
        limit: pageLimit + 1,
        cursor
      });
      const rows = page.slice(0, pageLimit);
      return {
        server_revision: this.getRelationServerRevision(),
        server_time_utc: nowIso,
        relation_types: this.listRelationTypes(),
        relations: status === 'active' ? rows : [],
        ended_relations: status === 'ended'
          ? rows
          : (endpointItemsId || relationTypeId
              ? this.listRelations({ endpointItemsId, relationTypeId, status: 'ended', limit: 100 })
              : recentEndedRelations(this, 100)),
        next_cursor: page.length > pageLimit ? rows.at(-1)?.id ?? null : null
      };
    });
  },
  syncRelationEvents({ device, events, lastKnownServerTimeUtc = null, nowIso }) {
    const userId = requireUser();
    const receivedAt = nowIso ?? new Date().toISOString();
    const deviceId = sanitizeText(device?.device_id);
    if (!deviceId) throw relationError('device_id_required', 400);
    const uploaded = Array.isArray(events) ? events : [];
    if (uploaded.length > MAX_RELATION_BATCH) throw relationError('relation_batch_too_large', 413);
    const acknowledged = [], ignored = [], deferred = [], reopenedGoalIds = new Set();
    let changedCount = 0;
    const run = runAtomic(this, () => {
      this.upsertDevice({
        device_id: deviceId,
        platform: sanitizeText(device?.platform) ?? 'unknown',
        display_name: sanitizeText(device?.display_name)
      }, receivedAt, {
        lastSyncAtUtc: receivedAt,
        lastServerClockOffsetMs: Number.isFinite(Date.parse(lastKnownServerTimeUtc))
          ? Date.parse(receivedAt) - Date.parse(lastKnownServerTimeUtc)
          : null
      });
      if (uploaded.length > 0) this.lockRelationMutationDomain();
      for (const rawEvent of uploaded) {
        const outcome = ingestRelationEvent(this, { rawEvent, deviceId, userId, receivedAt });
        if (!outcome.event_id) continue;
        if (outcome.deferred) { deferred.push({ event_id: outcome.event_id, reason: outcome.deferred }); continue; }
        acknowledged.push(outcome.event_id);
        if (outcome.reason) ignored.push({ event_id: outcome.event_id, reason: outcome.reason });
        else for (const goalId of this.recheckGoalsForRelationEvent({ eventId: outcome.event_id, nowIso: receivedAt })) reopenedGoalIds.add(goalId);
        if (outcome.domain_changed) changedCount += 1;
      }
      if (changedCount > 0 && this.getAgent('goal.discovery')) this.noteGoalDiscoveryChanges({ count: changedCount, nowIso: receivedAt });
    });
    run();
    const revision = this.getRelationServerRevision();
    this.recordLog({
      dt: receivedAt,
      source: 'sync',
      operation: 'relation.events_sync',
      status: 'done',
      eventDomain: 'relation',
      deviceId,
      message: 'Relation events sync',
      jsonData: { accepted_count: acknowledged.length - ignored.length, ignored_count: ignored.length, deferred_count: deferred.length, server_revision: revision }
    });
    return { server_revision: revision, server_time_utc: receivedAt, acknowledged_event_ids: acknowledged, ignored_events: ignored, deferred_events: deferred, reopened_goal_ids: [...reopenedGoalIds] };
  },
  createRelation(input) {
    const userId = requireUser();
    return runAtomic(this, () => createRelation(this, { ...input, userId }))();
  },
  endRelation(input) {
    const userId = requireUser();
    return runAtomic(this, () => endRelation(this, { ...input, userId }))();
  },
  reorderRelations(input) {
    const userId = requireUser();
    return runAtomic(this, () => reorderRelations(this, { ...input, userId }))();
  },
  listGoalMembers(goalId) {
    const userId = requireUser();
    const targetTypes = itemSemantics(this, goalId, userId);
    if (!targetTypes.some((type) => type.role_key === 'activity' && type.type_key === 'goal')) {
      throw relationError('goal_not_found', 404);
    }
    const members = readGoalMembers(this.db, userId, goalId);
    if (members.some((member) => !member.endpoint_valid || !member.has_semantics)) {
      throw relationError('invalid_relation_endpoint', 404);
    }
    return members.map(({ endpoint_valid, has_semantics, ...member }) => member);
  },
  goalCompletionState(goalId) {
    const members = this.listGoalMembers(goalId);
    const valid = members.filter((member) => member.valid);
    const doneCount = valid.filter((member) => member.done).length;
    return {
      member_count: valid.length,
      done_count: doneCount,
      all_done: valid.length > 0 && doneCount === valid.length,
      eligible: valid.length >= 2 && doneCount === valid.length,
      members
    };
  },
  endRelationsForItem(itemsId, input = {}) {
    const userId = requireUser();
    const operationId = requiredText(input.operationId, 'operation_id_required');
    return runAtomic(this, () => {
      this.lockRelationMutationDomain();
      const rows = this.db.prepare(`
        SELECT * FROM relations
        WHERE user_id = ? AND status = 'active'
          AND (source_items_id = ? OR target_items_id = ?)
        ORDER BY id
      `).all(userId, itemsId, itemsId);
      const affectedGoals = new Set();
      for (const row of rows) {
        affectedGoals.add(row.target_items_id);
        endRelation(this, { id: row.id, userId, ...input, operationId });
        recordInternalRelationEvent(this, {
          eventId: `${operationId}:end:${row.id}`,
          changeType: 'end', relationId: row.id, userId,
          actorType: input.actorType, actorId: input.actorId,
          occurredAtUtc: input.nowIso, payload: { reason: input.reason ?? 'item_ended' }
        });
      }
      return { ended_relation_ids: rows.map((row) => row.id), affected_goal_ids: [...affectedGoals] };
    })();
  }
};

function recentEndedRelations(store, limit) {
  const userId = requireUser();
  return store.db.prepare(`
    SELECT * FROM relations
    WHERE user_id = ? AND status = 'ended'
    ORDER BY active_to_utc DESC, id DESC
    LIMIT ?
  `).all(userId, Math.max(1, Math.min(Number(limit) || 100, 500))).map(formatRelation);
}

function ingestRelationEvent(store, { rawEvent, deviceId, userId, receivedAt }) {
  const eventId = sanitizeText(rawEvent?.event_id);
  if (!eventId) return { event_id: null, reason: null };
  const envelope = normalizeEventEnvelope(rawEvent);
  const payloadJson = stableJson(envelope);
  const existing = store.db.prepare(`
    SELECT status, ignore_reason, payload_json FROM events
    WHERE event_domain = 'relation' AND event_id = ?
  `).get(eventId);
  if (existing) {
    if (existing.payload_json !== payloadJson) throw relationError('idempotency_conflict', 409);
    return {
      event_id: eventId,
      reason: existing.status === 'ignored' ? existing.ignore_reason ?? 'ignored' : null,
      domain_changed: false
    };
  }
  const clientSequence = Number(rawEvent?.client_sequence);
  let storedClientSequence = isPostgresInteger(clientSequence) ? clientSequence : null;
  let reason = null;
  if (!isPostgresInteger(clientSequence)) reason = 'invalid_client_sequence';
  else if (store.existingDeviceSequence('relation', deviceId, clientSequence)) {
    reason = 'duplicate_client_sequence';
    storedClientSequence = null;
  } else if (!RELATION_EVENT_TYPES.has(envelope.change_type)) reason = 'invalid_type';
  const occurredMs = Date.parse(rawEvent?.occurred_at_utc);
  if (!reason && !Number.isFinite(occurredMs)) reason = 'invalid_timestamp';
  if (!reason && occurredMs - Date.parse(receivedAt) > FUTURE_EVENT_TOLERANCE_MS) reason = 'future_timestamp';
  if (!reason && rawEvent?.payload_version !== undefined && rawEvent.payload_version !== 1) reason = 'unsupported_payload_version';
  if (!reason && envelope.change_type === 'create' && Object.hasOwn(envelope.payload, 'origin_decision_id')) reason = 'origin_decision_id_reserved';
  if (!reason && envelope.change_type === 'reorder' && !Number.isInteger(envelope.base_server_revision)) {
    reason = 'base_server_revision_required';
  }
  if (!reason && envelope.change_type === 'reorder' && envelope.base_server_revision !== store.getRelationServerRevision()) {
    reason = 'stale_revision';
  }
  let applied = null;
  if (!reason) {
    try {
      applied = applyEnvelope(store, { envelope, eventId, deviceId, userId, receivedAt });
    } catch (error) {
      if (error?.status === 409 && error?.code === 'idempotency_conflict') throw error;
      if (error?.code === 'invalid_relation_endpoints' && rawEndpointPending(store, envelope, userId)) return { event_id: eventId, deferred: 'endpoint_not_ready' };
      reason = error?.code ?? sanitizeText(error?.message) ?? 'relation_apply_failed';
    }
  }
  const occurredAt = Number.isFinite(occurredMs) ? new Date(occurredMs).toISOString() : receivedAt;
  if (reason) {
    store.recordSyncIgnoredEvent({
      domain: 'relation', eventId, deviceId, clientSequence: storedClientSequence,
      receivedAt, reason, rawEvent
    });
  }
  const sequence = store.insertEventRecord({
    id: `relation:${eventId}`, eventId, eventDomain: 'relation',
    eventType: envelope.change_type ?? 'invalid',
    eventAction: `relation.${eventAction(envelope.change_type)}`,
    title: `Relation ${envelope.change_type ?? 'invalid'}`,
    subjectType: envelope.change_type === 'reorder' ? 'relation_list' : 'relation',
    subjectId: envelope.change_type === 'reorder'
      ? envelope.payload.target_items_id : applied?.relation?.id ?? envelope.relation_id,
    actorType: 'user', actorId: deviceId, deviceId, clientSequence: storedClientSequence,
    occurredAtUtc: occurredAt, receivedAtUtc: receivedAt,
    baseServerRevision: envelope.base_server_revision,
    status: reason ? 'ignored' : 'accepted', ignoreReason: reason,
    payloadVersion: 1, payloadJson
  });
  if (!sequence) throw relationError('relation_event_conflict', 409);
  return { event_id: eventId, reason, domain_changed: !reason && applied?.duplicate !== true };
}
function applyEnvelope(store, { envelope, eventId, deviceId, userId, receivedAt }) {
  const actor = { actorType: 'user', actorId: deviceId, nowIso: receivedAt, operationId: envelope.payload.operation_id ?? eventId };
  if (envelope.change_type === 'create') return createRelation(store, {
    id: envelope.relation_id, userId, relationTypeId: envelope.payload.relation_type_id,
    sourceItemsId: envelope.payload.source_items_id, targetItemsId: envelope.payload.target_items_id,
    position: envelope.payload.position, originDecisionId: envelope.payload.origin_decision_id,
    metadata: envelope.payload.metadata, ...actor
  });
  if (envelope.change_type === 'end') return endRelation(store, {
    id: envelope.relation_id, userId, reason: envelope.payload.reason ?? 'removed_by_user', ...actor
  });
  return reorderRelations(store, {
    userId, relationTypeId: envelope.payload.relation_type_id,
    targetItemsId: envelope.payload.target_items_id,
    orderedRelationIds: envelope.payload.ordered_relation_ids, ...actor
  });
}
function createRelation(store, input) {
  const id = requiredText(input.id, 'relation_id_required');
  const operationId = requiredText(input.operationId, 'operation_id_required');
  const type = visibleRelationType(store, input.relationTypeId, input.userId);
  let sourceItemsId = requiredText(input.sourceItemsId, 'source_items_id_required');
  let targetItemsId = requiredText(input.targetItemsId, 'target_items_id_required');
  if (sourceItemsId === targetItemsId) throw relationError('relation_endpoints_must_differ', 400);
  if (type.directionality === 'symmetric' && sourceItemsId > targetItemsId) {
    [sourceItemsId, targetItemsId] = [targetItemsId, sourceItemsId];
  }
  store.lockRelationList(input.userId, type.id, targetItemsId);
  store.lockRelationEndpointPayloads([sourceItemsId, targetItemsId]);
  if (!endpointPairAllowed(store, type, sourceItemsId, targetItemsId, input.userId)) {
    throw relationError('invalid_relation_endpoints', 409);
  }
  const sourceTypes = itemSemantics(store, sourceItemsId, input.userId), targetTypes = itemSemantics(store, targetItemsId, input.userId);
  if (type.id === 'part_of' && targetTypes.some((entry) => entry.type_key === 'goal' && entry.status === 'Done')) {
    const source = sourceTypes.find((entry) => entry.type_key === 'action' || entry.type_key === 'operation');
    if (source?.status !== 'Done') throw relationError('goal_member_not_done', 409);
  }
  const position = input.position === null || input.position === undefined ? null : Number(input.position);
  if (position !== null && (!Number.isInteger(position) || position < 0)) throw relationError('invalid_relation_position', 400);
  if (!type.is_ordered && position !== null) throw relationError('relation_type_unordered', 400);
  const actorType = actorTypeOf(input.actorType), originDecisionId = sanitizeText(input.originDecisionId);
  if (originDecisionId && actorType === 'user') throw relationError('origin_decision_id_reserved', 400);
  if (originDecisionId && !store.db.prepare('SELECT 1 FROM context_decisions WHERE id = ? AND user_id = ?').get(originDecisionId, input.userId)) throw relationError('origin_decision_not_found', 404);
  const actorId = sanitizeText(input.actorId) ?? (actorType === 'user' ? input.userId : null);
  const now = input.nowIso ?? new Date().toISOString();
  const metadataJson = boundedMetadata(input.metadata);
  const byId = store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
  if (byId) {
    if (byId.status === 'active' && byId.operation_id === operationId && byId.user_id === input.userId
      && byId.relation_types_id === type.id && byId.source_items_id === sourceItemsId && byId.target_items_id === targetItemsId) {
      return { relation: formatRelation(byId), duplicate: true };
    }
    throw relationError('idempotency_conflict', 409);
  }
  const duplicate = store.db.prepare(`
    SELECT * FROM relations
    WHERE user_id = ? AND relation_types_id = ? AND source_items_id = ?
      AND target_items_id = ? AND status = 'active'
  `).get(input.userId, type.id, sourceItemsId, targetItemsId);
  if (duplicate) return { relation: formatRelation(duplicate), duplicate: true };
  const currentOrder = type.is_ordered ? orderedRelationIds(store, input.userId, type.id, targetItemsId) : [];
  const inserted = store.db.prepare(`
    INSERT INTO relations (
      id, user_id, relation_types_id, source_items_id, target_items_id, status,
      position, active_from_utc, active_to_utc, operation_id, origin_decision_id,
      created_by_actor_type, created_by_actor_id, metadata_json, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(id, input.userId, type.id, sourceItemsId, targetItemsId, now, operationId,
    originDecisionId, actorType, actorId, metadataJson, now, now);
  if (inserted.changes === 0) {
    const conflict = store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
    if (conflict) {
      if (conflict.status === 'active' && conflict.operation_id === operationId && conflict.user_id === input.userId
        && conflict.relation_types_id === type.id && conflict.source_items_id === sourceItemsId && conflict.target_items_id === targetItemsId) {
        return { relation: formatRelation(conflict), duplicate: true };
      }
      throw relationError('idempotency_conflict', 409);
    }
    const canonical = store.db.prepare(`SELECT * FROM relations WHERE user_id = ? AND relation_types_id = ?
      AND source_items_id = ? AND target_items_id = ? AND status = 'active'`).get(input.userId, type.id, sourceItemsId, targetItemsId);
    if (canonical) return { relation: formatRelation(canonical), duplicate: true };
    throw relationError('idempotency_conflict', 409);
  }
  if (type.is_ordered) {
    const insertAt = position === null ? currentOrder.length : Math.min(position, currentOrder.length);
    currentOrder.splice(insertAt, 0, id);
    writeDenseOrder(store, input.userId, type.id, targetItemsId, currentOrder, now);
  }
  return { relation: formatRelation(store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id)), duplicate: false };
}
function endRelation(store, input) {
  const id = requiredText(input.id, 'relation_id_required');
  let row = store.db.prepare('SELECT * FROM relations WHERE id = ? AND user_id = ?').get(id, input.userId);
  if (!row) throw relationError('relation_not_found', 404);
  store.lockRelationList(input.userId, row.relation_types_id, row.target_items_id);
  row = store.db.prepare('SELECT * FROM relations WHERE id = ? AND user_id = ? FOR UPDATE').get(id, input.userId);
  if (row.status === 'ended') return { relation: formatRelation(row), duplicate: true };
  const type = visibleRelationType(store, row.relation_types_id, input.userId);
  const now = input.nowIso ?? new Date().toISOString();
  const reason = requiredText(input.reason ?? 'removed_by_user', 'relation_end_reason_required').slice(0, 500);
  const actorType = actorTypeOf(input.actorType);
  const actorId = sanitizeText(input.actorId) ?? (actorType === 'user' ? input.userId : null);
  const operationId = requiredText(input.operationId, 'operation_id_required');
  store.db.prepare(`
    UPDATE relations SET status = 'ended', active_to_utc = ?, ended_operation_id = ?,
      ended_by_actor_type = ?, ended_by_actor_id = ?, end_reason = ?, updated_at_utc = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `).run(now, operationId, actorType, actorId, reason, now, id, input.userId);
  if (type.is_ordered) normalizeDenseOrder(store, input.userId, type.id, row.target_items_id, now);
  return { relation: formatRelation(store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id)), duplicate: false };
}
function reorderRelations(store, input) {
  const type = visibleRelationType(store, input.relationTypeId, input.userId);
  if (!type.is_ordered) throw relationError('relation_type_unordered', 400);
  const targetItemsId = requiredText(input.targetItemsId, 'target_items_id_required');
  store.lockRelationList(input.userId, type.id, targetItemsId);
  itemSemantics(store, targetItemsId, input.userId);
  const requested = normalizeOrderedIds(input.orderedRelationIds);
  if (!Array.isArray(input.orderedRelationIds) || requested.length !== input.orderedRelationIds.length) {
    throw relationError('ordered_relation_ids_invalid', 400);
  }
  const current = orderedRelationIds(store, input.userId, type.id, targetItemsId);
  if (current.length !== requested.length || current.some((id) => !requested.includes(id))) {
    throw relationError('relation_membership_changed', 409);
  }
  writeDenseOrder(store, input.userId, type.id, targetItemsId, requested, input.nowIso ?? new Date().toISOString());
  return { ordered_relation_ids: requested };
}
function visibleRelationType(store, id, userId) {
  const typeId = requiredText(id, 'relation_type_id_required');
  const type = store.db.prepare(`
    SELECT * FROM relation_types
    WHERE id = ? AND status = 'active' AND (is_system = 1 OR user_id = ?)
  `).get(typeId, userId);
  if (!type) throw relationError('relation_type_not_found', 404);
  return type;
}
function itemSemantics(store, itemsId, userId) {
  const id = requiredText(itemsId, 'items_id_required');
  const item = store.db.prepare('SELECT id FROM items WHERE id = ? AND user_id = ? AND deleted_at_utc IS NULL').get(id, userId);
  if (!item) throw relationError('invalid_relation_endpoint', 404);
  const rows = store.db.prepare(`
    SELECT rt.title_system AS role_key, a.activity_type_id, a.status AS activity_status,
      a.deleted_at_utc AS activity_deleted_at_utc, i.preliminary_section,
      i.status AS inbox_status, i.is_normalized, i.deleted_at_utc AS inbox_deleted_at_utc,
      a.id AS activity_id, i.id AS inbox_id
    FROM item_roles r
    JOIN item_role_types rt ON rt.id = r.item_role_types_id
    LEFT JOIN activities a ON a.item_roles_id = r.id
    LEFT JOIN inbox i ON i.item_roles_id = r.id
    WHERE r.items_id = ? AND r.status = 'active' AND rt.deleted_at_utc IS NULL
  `).all(id);
  const result = [];
  for (const row of rows) {
    if (row.role_key === 'activity' && row.activity_id && !row.activity_deleted_at_utc) {
      result.push({ role_key: 'activity', type_key: row.activity_type_id, status: row.activity_status });
    }
    if (row.role_key === 'inbox' && row.inbox_id && !row.inbox_deleted_at_utc
      && row.is_normalized === 1 && row.preliminary_section === 'operation') {
      result.push({ role_key: 'inbox', type_key: 'operation', status: row.inbox_status });
    }
  }
  if (result.length === 0) throw relationError('invalid_relation_endpoint', 404);
  return result;
}
function endpointPairAllowed(store, type, sourceItemsId, targetItemsId, userId) {
  let source;
  let target;
  try {
    source = itemSemantics(store, sourceItemsId, userId);
    target = itemSemantics(store, targetItemsId, userId);
  } catch {
    return false;
  }
  const rules = store.db.prepare('SELECT * FROM relation_type_endpoint_rules WHERE relation_types_id = ?').all(type.id);
  const matches = (left, right) => rules.some((rule) => left.some((entry) =>
    entry.role_key === rule.source_role_key && entry.type_key === rule.source_type_key)
    && right.some((entry) => entry.role_key === rule.target_role_key && entry.type_key === rule.target_type_key));
  return matches(source, target) || (type.directionality === 'symmetric' && matches(target, source));
}
function rawEndpointPending(store, envelope, userId) {
  const pending = store.db.prepare("SELECT 1 FROM activities a JOIN workflow_executions w ON w.id = a.workflow_execution_id WHERE a.id = ? AND a.user_id = ? AND a.item_roles_id IS NULL AND a.deleted_at_utc IS NULL AND w.status IN ('queued', 'running')");
  return envelope.change_type === 'create' && [envelope.payload.source_items_id, envelope.payload.target_items_id].some((id) => sanitizeText(id) && pending.get(id, userId));
}
function orderedRelationIds(store, userId, typeId, targetItemsId) {
  return store.db.prepare(`
    SELECT id FROM relations
    WHERE user_id = ? AND relation_types_id = ? AND target_items_id = ? AND status = 'active'
    ORDER BY position NULLS LAST, active_from_utc, id FOR UPDATE
  `).all(userId, typeId, targetItemsId).map((row) => row.id);
}
function normalizeDenseOrder(store, userId, typeId, targetItemsId, nowIso) {
  writeDenseOrder(store, userId, typeId, targetItemsId, orderedRelationIds(store, userId, typeId, targetItemsId), nowIso);
}
function writeDenseOrder(store, userId, typeId, targetItemsId, ids, nowIso) {
  const update = store.db.prepare(`
    UPDATE relations SET position = ?, updated_at_utc = ?
    WHERE id = ? AND user_id = ? AND relation_types_id = ? AND target_items_id = ? AND status = 'active'
  `);
  ids.forEach((id, position) => update.run(position, nowIso, id, userId, typeId, targetItemsId));
}
export function recordInternalRelationEvent(store, input) {
  const eventId = requiredText(input.eventId, 'event_id_required');
  const payloadJson = stableJson({ change_type: input.changeType, relation_id: input.relationId, base_server_revision: null, payload: input.payload ?? {} });
  const existing = store.db.prepare("SELECT payload_json FROM events WHERE event_domain = 'relation' AND event_id = ?").get(eventId);
  if (existing) {
    if (existing.payload_json !== payloadJson) throw relationError('idempotency_conflict', 409);
    return;
  }
  const now = input.occurredAtUtc ?? new Date().toISOString();
  const sequence = store.insertEventRecord({
    id: `relation:${eventId}`, eventId, eventDomain: 'relation', eventType: input.changeType,
    eventAction: `relation.${eventAction(input.changeType)}`, title: `Relation ${input.changeType}`,
    subjectType: 'relation', subjectId: input.relationId,
    actorType: actorTypeOf(input.actorType), actorId: sanitizeText(input.actorId),
    occurredAtUtc: now, receivedAtUtc: now, status: 'accepted', payloadVersion: 1, payloadJson
  });
  if (!sequence) throw relationError('relation_event_conflict', 409);
}
function normalizeEventEnvelope(rawEvent) {
  const rawPayload = rawEvent?.payload && typeof rawEvent.payload === 'object' && !Array.isArray(rawEvent.payload)
    ? rawEvent.payload : {};
  return {
    change_type: sanitizeText(rawEvent?.change_type) ?? sanitizeText(rawEvent?.type),
    relation_id: sanitizeText(rawEvent?.relation_id),
    base_server_revision: Number.isInteger(rawEvent?.base_server_revision) ? rawEvent.base_server_revision : null,
    payload: parseJsonObject(stableJson(rawPayload))
  };
}
function formatRelation(row) {
  return row ? { ...row, metadata_json: parseJsonObject(row.metadata_json) } : null;
}
function boundedMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const json = stableJson(metadata);
  if (json.length > 16000) throw relationError('relation_metadata_too_large', 413);
  return json;
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
function actorTypeOf(value) {
  const actorType = sanitizeText(value) ?? 'user';
  if (!ACTOR_TYPES.has(actorType)) throw relationError('invalid_actor_type', 400);
  return actorType;
}
function requiredText(value, code) {
  const text = sanitizeText(value);
  if (!text) throw relationError(code, 400);
  return text;
}
function requireUser() {
  const userId = sanitizeText(scopedUserId());
  if (!userId) throw relationError('unauthorized', 401);
  return userId;
}
function readSnapshot(store, fn) {
  if (store.db.currentTxId) return fn();
  return store.db.transaction(() => {
    store.db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn();
  })();
}
function relationError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
function runAtomic(store, fn) { return store.db.currentTxId ? fn : store.db.transaction(fn); }
function eventAction(changeType) {
  return changeType === 'create' ? 'created' : changeType === 'end' ? 'ended' : changeType === 'reorder' ? 'reordered' : 'invalid';
}
