import { recordInternalRelationEvent } from './store-relations.js';
import { sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const goalRelationMethods = {
  lockRelationMutationDomain() {
    const userId = sanitizeText(scopedUserId());
    if (!userId) return null;
    if (!this.db.currentTxId) throw goalError('relation_transaction_required', 500);
    this.db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(
      JSON.stringify([userId, 'relations', 'mutations'])
    );
    return userId;
  },
  lockRelationList(userId, typeId, targetItemsId) {
    this.lockRelationMutationDomain();
    this.db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(
      JSON.stringify([userId, typeId, targetItemsId])
    );
  },

  lockGoalInvariantLists({ memberItemsIds = [], goalItemsIds = [] } = {}) {
    const members = [...new Set(memberItemsIds.map(sanitizeText).filter(Boolean))];
    const goalIds = new Set(goalItemsIds.map(sanitizeText).filter(Boolean));
    if (members.length === 0 && goalIds.size === 0) return [];
    const userId = this.lockRelationMutationDomain();
    // Legacy single-user data can be mutated before the first account claims it.
    // Relations always have an owner, so there is no Goal list to lock yet.
    if (!userId) return [];
    const findGoals = this.db.prepare(`
      SELECT DISTINCT target_items_id AS id FROM relations
      WHERE user_id = ? AND source_items_id = ?
        AND relation_types_id = 'part_of' AND status = 'active'
    `);
    for (const itemsId of members) {
      for (const row of findGoals.all(userId, itemsId)) goalIds.add(row.id);
    }
    const orderedGoalIds = [...goalIds].sort();
    for (const goalId of orderedGoalIds) {
      this.db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))').get(
        JSON.stringify([userId, 'part_of', goalId])
      );
    }
    return orderedGoalIds;
  },

  lockRelationEndpointPayloads(itemsIds = []) {
    const userId = sanitizeText(scopedUserId());
    if (!userId) throw goalError('unauthorized', 401);
    for (const itemsId of [...new Set(itemsIds.map(sanitizeText).filter(Boolean))].sort()) {
      this.db.prepare('SELECT id FROM activities WHERE id = ? AND user_id = ? FOR UPDATE').get(itemsId, userId);
      this.db.prepare('SELECT id FROM inbox WHERE id = ? AND user_id = ? FOR UPDATE').get(itemsId, userId);
    }
  },

  createRelationWithEvent(input) {
    const now = input.nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      const result = this.createRelation(input);
      const relationEventId = input.eventId ?? `${input.operationId}:relation-created:${result.relation.id}`;
      if (!result.duplicate) recordInternalRelationEvent(this, {
        eventId: relationEventId,
        changeType: 'create',
        relationId: result.relation.id,
        actorType: input.actorType,
        actorId: input.actorId,
        occurredAtUtc: now,
        payload: {
          relation_type_id: result.relation.relation_types_id,
          source_items_id: result.relation.source_items_id,
          target_items_id: result.relation.target_items_id,
          position: result.relation.position,
          operation_id: input.operationId,
          origin_decision_id: input.originDecisionId ?? null
        }
      });
      this.recheckGoalInvariants({
        goalIds: [result.relation.target_items_id],
        reason: 'membership_added',
        causalEventId: relationEventId,
        operationId: input.operationId,
        nowIso: now
      });
      if (!result.duplicate && this.getAgent('goal.discovery')) {
        this.noteGoalDiscoveryChanges({ nowIso: now });
      }
      return result;
    })();
  },

  endRelationWithEvent(input) {
    const now = input.nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      const result = this.endRelation(input);
      const relationEventId = input.eventId ?? `${input.operationId}:relation-ended:${result.relation.id}`;
      if (!result.duplicate) recordInternalRelationEvent(this, {
        eventId: relationEventId,
        changeType: 'end',
        relationId: result.relation.id,
        actorType: input.actorType,
        actorId: input.actorId,
        occurredAtUtc: now,
        payload: { reason: input.reason, operation_id: input.operationId }
      });
      this.recheckGoalInvariants({
        goalIds: [result.relation.target_items_id],
        reason: 'membership_removed',
        causalEventId: relationEventId,
        operationId: input.operationId,
        nowIso: now
      });
      if (!result.duplicate && this.getAgent('goal.discovery')) {
        this.noteGoalDiscoveryChanges({ nowIso: now });
      }
      return result;
    })();
  },

  reorderRelationsWithEvent(input) {
    const now = input.nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      const result = this.reorderRelations(input);
      recordInternalRelationEvent(this, {
        eventId: input.eventId ?? `${input.operationId}:relations-reordered:${input.targetItemsId}`,
        changeType: 'reorder',
        relationId: input.targetItemsId,
        actorType: input.actorType,
        actorId: input.actorId,
        occurredAtUtc: now,
        payload: {
          relation_type_id: input.relationTypeId,
          target_items_id: input.targetItemsId,
          ordered_relation_ids: result.ordered_relation_ids,
          operation_id: input.operationId
        }
      });
      return result;
    })();
  },

  reconcileActivityRelations(events, nowIso) {
    if (!scopedUserId()) return [];
    const affectedGoals = new Set();
    for (const event of events) {
      if (!event.activity_id) continue;
      const cause = eventCause(event, 'activity');
      const eventGoals = new Set();
      if (event.change_type === 'delete') {
        const ended = this.endRelationsForItem(event.activity_id, {
          operationId: cause.operationId,
          actorType: 'system',
          actorId: 'goal-invariant-repair',
          reason: 'item_deleted',
          nowIso
        });
        for (const goalId of ended.affected_goal_ids) eventGoals.add(goalId);
      }
      if (event.change_type === 'set_type') {
        const reconciled = reconcileTypeChange(this, event, cause, nowIso);
        for (const goalId of reconciled.affectedGoalIds) eventGoals.add(goalId);
      }
      if (event.change_type === 'set_status') {
        for (const goalId of goalIdsForMember(this, event.activity_id)) eventGoals.add(goalId);
      }
      // Projection is ordered by client event time. A status accepted while this
      // Item was still an Action (or did not exist yet) can therefore become a
      // Goal status after a late type/create event is replayed. Recheck the
      // projected Goal itself, not only Goals reached through Relations.
      if (currentGoal(this, event.activity_id)) eventGoals.add(event.activity_id);
      for (const goalId of eventGoals) affectedGoals.add(goalId);
      this.recheckGoalInvariants({
        goalIds: [...eventGoals],
        reason: event.change_type === 'set_type' ? 'activity_type_changed' : 'member_activity_changed',
        causalEventId: cause.eventId,
        operationId: cause.operationId,
        nowIso
      });
    }
    return [...affectedGoals];
  },

  reconcileInboxRelations(events, nowIso) {
    if (!scopedUserId()) return [];
    const affectedGoals = new Set();
    for (const event of events) {
      if (!event.inbox_id) continue;
      const cause = eventCause(event, 'inbox');
      const eventGoals = new Set();
      if (event.type === 'delete') {
        const ended = this.endRelationsForItem(event.inbox_id, {
          operationId: cause.operationId,
          actorType: 'system',
          actorId: 'goal-invariant-repair',
          reason: 'operation_deleted',
          nowIso
        });
        for (const goalId of ended.affected_goal_ids) eventGoals.add(goalId);
      }
      if (event.type === 'set_status') {
        for (const goalId of goalIdsForMember(this, event.inbox_id)) eventGoals.add(goalId);
      }
      for (const goalId of eventGoals) affectedGoals.add(goalId);
      this.recheckGoalInvariants({
        goalIds: [...eventGoals],
        reason: 'member_operation_changed',
        causalEventId: cause.eventId,
        operationId: cause.operationId,
        nowIso
      });
    }
    return [...affectedGoals];
  },

  recheckGoalsForMember(itemsId, { reason = 'member_changed', causalEventId, operationId, nowIso } = {}) {
    return this.recheckGoalInvariants({
      goalIds: goalIdsForMember(this, itemsId),
      reason,
      causalEventId: causalEventId ?? operationId,
      operationId: operationId ?? `member:${itemsId}:${nowIso}`,
      nowIso
    });
  },

  recheckGoalsForRelationEvent({ eventId, nowIso }) {
    const id = sanitizeText(eventId);
    if (!id) return [];
    const event = this.db.prepare(`
      SELECT event_type, subject_id, payload_json FROM events
      WHERE event_domain = 'relation' AND event_id = ? AND status = 'accepted'
    `).get(id);
    if (!event || event.event_type === 'reorder') return [];
    const relation = this.db.prepare(`
      SELECT target_items_id FROM relations WHERE id = ?
    `).get(event.subject_id);
    if (!relation) return [];
    let envelope = {};
    try { envelope = JSON.parse(event.payload_json ?? '{}'); } catch { /* accepted legacy payload */ }
    const operationId = sanitizeText(envelope?.payload?.operation_id) ?? id;
    return this.recheckGoalInvariants({
      goalIds: [relation.target_items_id],
      reason: 'relation_changed',
      causalEventId: id,
      operationId,
      nowIso
    });
  },

  recheckGoalInvariants({ goalIds, reason, causalEventId, operationId, nowIso }) {
    const reopened = [];
    const now = nowIso ?? new Date().toISOString();
    for (const goalId of [...new Set(goalIds ?? [])]) {
      const goal = currentGoal(this, goalId);
      if (!goal || goal.status !== 'Done') continue;
      let completion;
      try {
        completion = this.goalCompletionState(goalId);
      } catch {
        completion = { eligible: false };
      }
      if (completion.eligible) continue;
      const causalOperation = sanitizeText(operationId) ?? `goal-repair:${goalId}:${now}`;
      const causalEvent = sanitizeText(causalEventId) ?? causalOperation;
      const eventId = `${causalEvent}:goal-reopened:${goalId}`;
      const repairAt = activityRepairTime(this, goalId, now);
      const payload = {
        reason: sanitizeText(reason)?.slice(0, 500) ?? 'goal_invariant_changed',
        causal_event_id: causalEvent,
        causal_operation_id: causalOperation
      };
      const existing = this.db.prepare(`
        SELECT payload_json FROM events WHERE event_domain = 'activity' AND event_id = ?
      `).get(eventId);
      if (existing) {
        if (existing.payload_json !== stableJson(payload)) throw goalError('goal_reopen_idempotency_conflict', 409);
        continue;
      }
      const sequence = this.insertEventRecord({
        id: `activity:${eventId}`,
        eventId,
        eventDomain: 'activity',
        eventType: 'goal_reopened',
        eventAction: 'activity.goal_reopened',
        title: 'Goal reopened',
        itemsId: goalId,
        itemRolesId: goal.item_roles_id,
        subjectType: 'activity',
        subjectId: goalId,
        actorType: 'system',
        actorId: 'goal-invariant-repair',
        occurredAtUtc: repairAt,
        receivedAtUtc: now,
        status: 'accepted',
        payloadVersion: 1,
        payloadJson: stableJson(payload)
      });
      if (!sequence) throw goalError('goal_reopen_event_conflict', 409);
      this.projectActivity(goalId, repairAt);
      this.recordLog({
        dt: repairAt,
        source: 'goal',
        operation: 'goal.auto_reopen',
        status: 'done',
        eventDomain: 'activity',
        eventId,
        // A replay repair can run before raw Goal normalization creates its
        // canonical Item. Keep the log subject in json_data without violating
        // the logs.items_id foreign key during that readiness window.
        itemsId: goal.item_roles_id ? goalId : null,
        reason: payload.reason,
        message: 'Goal reopened after invariant change',
        jsonData: {
          goal_id: goalId,
          causal_event_id: causalEvent,
          causal_operation_id: causalOperation
        }
      });
      reopened.push(goalId);
    }
    return reopened;
  }
};

function reconcileTypeChange(store, event, cause, nowIso) {
  const userId = scopedUserId();
  const rows = store.db.prepare(`
    SELECT r.*, t.directionality, t.status AS relation_type_status
    FROM relations r
    JOIN relation_types t ON t.id = r.relation_types_id
    WHERE r.user_id = ? AND r.status = 'active'
      AND (r.source_items_id = ? OR r.target_items_id = ?)
    ORDER BY r.id FOR UPDATE
  `).all(userId, event.activity_id, event.activity_id);
  const affectedGoalIds = new Set();
  for (const row of rows) {
    if (isCurrentGoal(store, row.target_items_id)) affectedGoalIds.add(row.target_items_id);
    const disposition = relationDisposition(store, row, userId);
    if (disposition === 'keep') continue;
    let replacement = null;
    let replacementError = null;
    if (disposition === 'reverse') {
      try {
        replacement = store.createRelation({
          id: `relation-reversal:${cause.eventId}:${row.id}`,
          relationTypeId: row.relation_types_id,
          sourceItemsId: row.target_items_id,
          targetItemsId: row.source_items_id,
          position: row.position,
          operationId: cause.operationId,
          actorType: 'system',
          actorId: 'goal-relation-reconciliation',
          metadata: {
            reconciliation_outcome: 'reverse',
            causal_event_id: cause.eventId,
            prior_relation_id: row.id
          },
          nowIso
        });
      } catch (error) {
        if (!['goal_member_not_done', 'invalid_relation_endpoints'].includes(error?.code)) throw error;
        replacementError = error.code;
      }
    }
    const outcome = replacement ? 'end_reverse' : 'end_invalid';
    store.endRelation({
      id: row.id,
      operationId: cause.operationId,
      actorType: 'system',
      actorId: 'goal-relation-reconciliation',
      reason: `activity_type_changed:${outcome}`,
      nowIso
    });
    const endEventId = `${cause.eventId}:relation-reconcile:end:${row.id}`;
    recordInternalRelationEvent(store, {
      eventId: endEventId,
      changeType: 'end',
      relationId: row.id,
      actorType: 'system',
      actorId: 'goal-relation-reconciliation',
      occurredAtUtc: nowIso,
      payload: {
        reason: `activity_type_changed:${outcome}`,
        reconciliation_outcome: outcome,
        causal_event_id: cause.eventId,
        causal_operation_id: cause.operationId,
        replacement_relation_id: replacement?.relation.id ?? null,
        replacement_error: replacementError
      }
    });
    if (replacement && !replacement.duplicate) recordInternalRelationEvent(store, {
      eventId: `${cause.eventId}:relation-reconcile:create:${replacement.relation.id}`,
      changeType: 'create',
      relationId: replacement.relation.id,
      actorType: 'system',
      actorId: 'goal-relation-reconciliation',
      occurredAtUtc: nowIso,
      payload: {
        relation_type_id: replacement.relation.relation_types_id,
        source_items_id: replacement.relation.source_items_id,
        target_items_id: replacement.relation.target_items_id,
        position: replacement.relation.position,
        reconciliation_outcome: 'reverse',
        causal_event_id: cause.eventId,
        causal_operation_id: cause.operationId,
        prior_relation_id: row.id
      }
    });
    if (replacement && isCurrentGoal(store, replacement.relation.target_items_id)) {
      affectedGoalIds.add(replacement.relation.target_items_id);
    }
  }
  return { affectedGoalIds: [...affectedGoalIds] };
}

function relationDisposition(store, relation, userId) {
  if (relation.relation_type_status !== 'active') return 'end';
  const rules = store.db.prepare(`
    SELECT * FROM relation_type_endpoint_rules WHERE relation_types_id = ? ORDER BY id
  `).all(relation.relation_types_id);
  const source = itemSemantics(store, relation.source_items_id, userId);
  const target = itemSemantics(store, relation.target_items_id, userId);
  if (rulesMatch(rules, source, target)) return 'keep';
  if (relation.directionality === 'directed' && rulesMatch(rules, target, source)) return 'reverse';
  if (relation.directionality === 'symmetric' && rulesMatch(rules, target, source)) return 'keep';
  return 'end';
}

function itemSemantics(store, itemsId, userId) {
  return store.db.prepare(`
    SELECT rt.title_system AS role_key,
      CASE WHEN rt.title_system = 'activity' THEN a.activity_type_id
        WHEN rt.title_system = 'inbox' AND i.is_normalized = 1
          AND i.preliminary_section = 'operation' THEN 'operation' END AS type_key
    FROM items item
    JOIN item_roles r ON r.items_id = item.id AND r.status = 'active'
    JOIN item_role_types rt ON rt.id = r.item_role_types_id AND rt.deleted_at_utc IS NULL
    LEFT JOIN activities a ON a.item_roles_id = r.id AND a.deleted_at_utc IS NULL
    LEFT JOIN inbox i ON i.item_roles_id = r.id AND i.deleted_at_utc IS NULL
    WHERE item.id = ? AND item.user_id = ? AND item.deleted_at_utc IS NULL
  `).all(itemsId, userId).filter((entry) => entry.type_key);
}

function rulesMatch(rules, source, target) {
  return rules.some((rule) => source.some((entry) =>
    entry.role_key === rule.source_role_key && entry.type_key === rule.source_type_key)
    && target.some((entry) =>
      entry.role_key === rule.target_role_key && entry.type_key === rule.target_type_key));
}

function eventCause(event, domain) {
  let payload = {};
  try { payload = JSON.parse(event.payload_json ?? '{}'); } catch { /* accepted legacy payload */ }
  const eventId = sanitizeText(event.event_id) ?? `${domain}-repair:${event.server_sequence ?? 'unknown'}`;
  return {
    eventId,
    operationId: sanitizeText(event.operation_id) ?? sanitizeText(payload.operation_id) ?? eventId
  };
}

function goalIdsForMember(store, itemsId) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT DISTINCT target_items_id AS id FROM relations
    WHERE source_items_id = ? AND relation_types_id = 'part_of' AND status = 'active'
      ${scope.clause}
    ORDER BY target_items_id
  `).all(itemsId, ...scope.params).map((row) => row.id);
}

function currentGoal(store, goalId) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT * FROM activities WHERE id = ? AND activity_type_id = 'goal'
      AND deleted_at_utc IS NULL ${scope.clause}
  `).get(goalId, ...scope.params);
}

function activityRepairTime(store, goalId, nowIso) {
  const scope = scopeSql();
  const latest = store.db.prepare(`
    SELECT occurred_at_utc FROM events
    WHERE event_domain = 'activity' AND status = 'accepted' AND subject_id = ?
      ${scope.clause}
    ORDER BY occurred_at_utc DESC, domain_sequence DESC
    LIMIT 1
  `).get(goalId, ...scope.params)?.occurred_at_utc;
  const nowMs = Date.parse(nowIso);
  const latestMs = Date.parse(latest);
  if (!Number.isFinite(nowMs) || !Number.isFinite(latestMs) || latestMs < nowMs) return nowIso;
  return new Date(latestMs + 1).toISOString();
}

function isCurrentGoal(store, itemsId) {
  return Boolean(currentGoal(store, itemsId));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function atomic(store, fn) {
  return store.db.currentTxId ? fn : store.db.transaction(fn);
}

function goalError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
