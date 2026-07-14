import crypto from 'node:crypto';
import { stableHash } from './context-policy.js';
import {
  captureCreatedObjectCheckpoints,
  createdObjectCompensationGuards,
  relationGraphCheckpoint
} from './store-context-causality.js';
import { parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const contextApplyMethods = {
  applyContextDecisionPackage({ decision, payload, operationId, nowIso }) {
    const userId = requireUser();
    const now = nowIso ?? new Date().toISOString();
    const requestHash = stableHash({ decision_id: decision.id, kind: decision.decision_kind, payload });
    return atomic(this, () => {
      this.lockRelationMutationDomain();
      const replay = beginOperation(this, {
        id: operationId, userId, kind: decision.decision_kind,
        requestHash, now, originalOperationId: null
      });
      if (replay) return replay;
      let outcome;
      if (decision.decision_kind === 'relation_add') {
        outcome = applyRelationDecision(this, { decision, payload, operationId, now });
      } else if (decision.decision_kind === 'activity_type_change') {
        outcome = applyTypeDecision(this, { decision, payload, operationId, now });
      } else if (decision.decision_kind === 'goal_discovery') {
        outcome = applyGoalDiscovery(this, { decision, payload, operationId, now });
      } else if (decision.decision_kind === 'goal_plan') {
        outcome = applyGoalPlan(this, { decision, payload, operationId, now });
      } else {
        throw applyError('decision_kind_unsupported', 400);
      }
      outcome.compensation = captureCreatedObjectCheckpoints(this, outcome.compensation, operationId);
      finishOperation(this, operationId, userId, outcome, now);
      return outcome.result;
    })();
  },

  compensateContextDecision({ decision, operationId, nowIso }) {
    const userId = requireUser();
    const now = nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      this.lockRelationMutationDomain();
      const originalId = requiredText(decision.operation_id, 'original_operation_id_required');
      const original = this.db.prepare(`
        SELECT * FROM context_operations WHERE id = ? AND user_id = ? AND status IN ('completed', 'compensated') FOR UPDATE
      `).get(originalId, userId);
      if (!original) throw applyError('original_operation_not_found', 404);
      const requestHash = stableHash({ decision_id: decision.id, original_operation_id: originalId });
      const replay = beginOperation(this, {
        id: operationId, userId, kind: 'compensation', requestHash, now,
        originalOperationId: originalId
      });
      if (replay) return replay;
      const data = parseJsonObject(original.compensation_json);
      compensate(this, { decision, data, operationId, now });
      const outcome = {
        result: { operation_id: operationId, compensated_operation_id: originalId },
        compensation: {}
      };
      finishOperation(this, operationId, userId, outcome, now);
      this.db.prepare(`UPDATE context_operations SET status = 'compensated', updated_at_utc = ? WHERE id = ? AND user_id = ?`)
        .run(now, originalId, userId);
      return outcome.result;
    })();
  }
};

function applyRelationDecision(store, { decision, payload, operationId, now }) {
  const relationId = operationEntityId(operationId, 'relation');
  const relation = store.createRelationWithEvent({
    id: relationId,
    relationTypeId: requiredText(payload.relation_type_id, 'relation_type_id_required'),
    sourceItemsId: requiredText(payload.source_items_id ?? decision.subject_items_id, 'source_items_id_required'),
    targetItemsId: requiredText(payload.target_items_id, 'target_items_id_required'),
    position: payload.position ?? payload.suggested_position,
    operationId,
    originDecisionId: decision.id,
    actorType: 'agent',
    actorId: decision.agent_id,
    metadata: { decision_id: decision.id },
    nowIso: now
  }).relation;
  return {
    result: { operation_id: operationId, relation_id: relation.id },
    compensation: { kind: 'relation_add', relation_ids: [relation.id] }
  };
}

function applyTypeDecision(store, { decision, payload, operationId, now }) {
  const itemsId = requiredText(payload.items_id ?? payload.subject_items_id ?? decision.subject_items_id, 'items_id_required');
  const activity = currentActivity(store, itemsId);
  if (!activity) {
    return applyInboxConversion(store, { decision, payload, operationId, now, itemsId });
  }
  const fromType = requiredText(payload.from_activity_type_id ?? activity.activity_type_id, 'from_activity_type_id_required');
  const toType = requiredText(payload.to_activity_type_id ?? payload.target_type, 'to_activity_type_id_required');
  if (activity.activity_type_id !== fromType) throw applyError('stale_activity_type', 409);
  if (!['action', 'goal'].includes(toType) || toType === fromType) throw applyError('invalid_activity_type', 400);
  const priorRelations = activeRelationsForItem(store, itemsId);
  const appliedTypeEventId = applyActivityType(store, {
    itemsId, fromType, toType, operationId, decision, now
  });
  const postApplyRelationGraph = relationGraphCheckpoint(store, itemsId);
  return {
    result: { operation_id: operationId, activity_id: itemsId },
    compensation: {
      kind: 'activity_type_change', items_id: itemsId,
      from_activity_type_id: fromType, to_activity_type_id: toType,
      applied_type_event_id: appliedTypeEventId,
      post_apply_relation_graph: postApplyRelationGraph,
      prior_relations: priorRelations
    }
  };
}

function applyInboxConversion(store, { decision, payload, operationId, now, itemsId }) {
  const scope = scopeSql('i');
  const inbox = store.db.prepare(`
    SELECT i.*, r.status AS role_status FROM inbox i
    JOIN item_roles r ON r.id = i.item_roles_id
    WHERE i.id = ? AND i.is_normalized = 1 AND i.deleted_at_utc IS NULL
      AND r.status = 'active' ${scope.clause}
  `).get(itemsId, ...scope.params);
  if (!inbox) throw applyError('activity_or_inbox_not_found', 404);
  if (inbox.preliminary_section === 'operation') throw applyError('forced_operation_conversion_forbidden', 409);
  const toType = requiredText(payload.to_activity_type_id ?? payload.target_type, 'to_activity_type_id_required');
  if (!['action', 'goal'].includes(toType)) throw applyError('invalid_activity_type', 400);
  createActivity(store, {
    id: itemsId,
    type: toType,
    title: sanitizeText(payload.title) ?? inbox.title,
    description: typeof payload.description_md === 'string' ? payload.description_md : inbox.description_text,
    operationId,
    decision,
    now
  });
  store.db.prepare(`
    UPDATE item_roles SET status = 'ended', active_to_utc = ?
    WHERE id = ? AND status = 'active'
  `).run(now, inbox.item_roles_id);
  return {
    result: { operation_id: operationId, activity_id: itemsId },
    compensation: {
      kind: 'inbox_conversion', items_id: itemsId,
      inbox_item_roles_id: inbox.item_roles_id,
      activity_type_id: toType,
      created_activity_event_id: operationEventId(operationId, 'activity-created')
    }
  };
}

function applyGoalDiscovery(store, { decision, payload, operationId, now }) {
  const title = requiredText(payload.title, 'goal_title_required');
  const memberIds = uniqueIds(payload.member_items_ids ?? payload.members?.map((member) => member.items_id));
  if (memberIds.length < 2 || memberIds.length > 50) throw applyError('goal_member_count_invalid', 400);
  const goalId = operationEntityId(operationId, 'goal');
  createActivity(store, {
    id: goalId, type: 'goal', title,
    description: payload.description_md ?? payload.description ?? '',
    operationId, decision, now
  });
  const relationIds = memberIds.map((sourceItemsId, position) => store.createRelationWithEvent({
    id: operationEntityId(operationId, `relation:${position}`),
    relationTypeId: 'part_of', sourceItemsId, targetItemsId: goalId, position,
    operationId, originDecisionId: decision.id, actorType: 'agent',
    actorId: decision.agent_id, nowIso: now
  }).relation.id);
  return {
    result: { operation_id: operationId, activity_id: goalId, relation_ids: relationIds },
    compensation: {
      kind: 'goal_discovery', activity_ids: [goalId], relation_ids: relationIds,
      activity_event_ids: [operationEventId(operationId, 'activity-created')]
    }
  };
}

function applyGoalPlan(store, { decision, payload, operationId, now }) {
  const goalId = requiredText(payload.goal_items_id ?? decision.subject_items_id, 'goal_items_id_required');
  const goal = currentActivity(store, goalId);
  if (!goal || goal.activity_type_id !== 'goal' || goal.deleted_at_utc) throw applyError('goal_not_found', 404);
  if (goal.status !== 'New') throw applyError('goal_not_eligible', 409);
  const actions = Array.isArray(payload.actions) ? payload.actions : Array.isArray(payload.steps) ? payload.steps : [];
  if (actions.length < 2 || actions.length > 20) throw applyError('goal_plan_action_count_invalid', 400);
  const activityIds = [];
  const relationIds = [];
  actions.forEach((action, index) => {
    const activityId = operationEntityId(operationId, `action:${index}`);
    createActivity(store, {
      id: activityId, type: 'action', title: requiredText(action.title, 'action_title_required'),
      description: action.description_md ?? action.description ?? '',
      operationId: `${operationId}:action:${index}`, decision, now
    });
    const relation = store.createRelationWithEvent({
      id: operationEntityId(operationId, `relation:${index}`), relationTypeId: 'part_of',
      sourceItemsId: activityId, targetItemsId: goalId, position: index,
      operationId, originDecisionId: decision.id, actorType: 'agent',
      actorId: decision.agent_id, nowIso: now
    }).relation;
    activityIds.push(activityId);
    relationIds.push(relation.id);
  });
  return {
    result: { operation_id: operationId, activity_ids: activityIds, relation_ids: relationIds },
    compensation: {
      kind: 'goal_plan', activity_ids: activityIds, relation_ids: relationIds,
      activity_event_ids: activityIds.map((_, index) => (
        operationEventId(`${operationId}:action:${index}`, 'activity-created')
      ))
    }
  };
}

function applyActivityType(store, { itemsId, fromType, toType, operationId, decision, now }) {
  const eventId = operationEventId(operationId, 'activity-type');
  const payload = { from_activity_type_id: fromType, to_activity_type_id: toType };
  insertActivityEvent(store, {
    eventId, eventType: 'set_type', itemsId, payload, decision, now
  });
  store.projectActivity(itemsId, now);
  store.reconcileActivityRelations([{
    event_id: eventId, operation_id: operationId, activity_id: itemsId,
    change_type: 'set_type', payload_json: stableJson(payload)
  }], now);
  return eventId;
}

function createActivity(store, { id, type, title, description, operationId, decision, now }) {
  if (!['action', 'goal'].includes(type)) throw applyError('invalid_activity_type', 400);
  const cleanTitle = boundedText(title, 200, 'activity_title_invalid', true);
  const cleanDescription = boundedText(description ?? '', 8_000, 'activity_description_invalid');
  const existing = currentActivity(store, id);
  if (existing) {
    if (existing.activity_type_id !== type || existing.title !== cleanTitle) throw applyError('activity_idempotency_conflict', 409);
    return existing;
  }
  const userId = requireUser();
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'New', ?, ?, ?)
  `).run(id, type, cleanTitle, cleanDescription, decision.agent_id ?? 'agent', 'agent_decision', now, now, userId);
  const linked = store.ensureActivityRoleLink({
    id, title: cleanTitle, description_md: cleanDescription,
    author: decision.agent_id ?? 'agent', created_at_utc: now, updated_at_utc: now
  });
  const eventId = operationEventId(operationId, 'activity-created');
  insertActivityEvent(store, {
    eventId, eventType: 'create', itemsId: id,
    itemRolesId: linked.item_roles_id,
    payload: { activity_type_id: type, title: cleanTitle, description_md: cleanDescription },
    decision, now
  });
  store.db.prepare(`
    UPDATE activities SET initial_event_id = ?, last_event_id = ? WHERE id = ? AND user_id = ?
  `).run(`activity:${eventId}`, eventId, id, userId);
  return store.getActivityItem(id);
}

function insertActivityEvent(store, { eventId, eventType, itemsId, itemRolesId, payload, decision, now }) {
  const payloadJson = stableJson(payload);
  const existing = store.db.prepare(`SELECT payload_json FROM events WHERE event_domain = 'activity' AND event_id = ?`).get(eventId);
  if (existing) {
    if (existing.payload_json !== payloadJson) throw applyError('activity_event_idempotency_conflict', 409);
    return;
  }
  const sequence = store.insertEventRecord({
    id: `activity:${eventId}`, eventId, eventDomain: 'activity', eventType,
    eventAction: `activity.${eventType === 'set_type' ? 'type_changed' : eventType}`,
    title: `Activity ${eventType}`, itemsId, itemRolesId,
    subjectType: 'activity', subjectId: itemsId,
    actorType: 'agent', actorId: decision.agent_id,
    occurredAtUtc: now, receivedAtUtc: now, status: 'accepted',
    payloadVersion: 1, payloadJson
  });
  if (!sequence) throw applyError('activity_event_conflict', 409);
}

function compensate(store, { decision, data, operationId, now }) {
  const guards = createdObjectCompensationGuards(store, data);
  for (const relationId of data.relation_ids ?? []) {
    const relation = currentRelation(store, relationId);
    if (relation?.status === 'active' && guards.relationIds.has(relationId)) store.endRelationWithEvent({
      id: relationId, operationId, reason: 'decision_compensated',
      actorType: 'system', actorId: 'context-compensation', nowIso: now
    });
  }
  if (data.kind === 'activity_type_change') {
    const current = currentActivity(store, data.items_id);
    const relationGraph = relationGraphCheckpoint(store, data.items_id);
    if (current?.activity_type_id === data.to_activity_type_id
      && latestAcceptedTypeEventId(store, data.items_id) === data.applied_type_event_id
      && data.post_apply_relation_graph?.fingerprint === relationGraph.fingerprint
      && data.post_apply_relation_graph?.revision === relationGraph.revision) {
      applyActivityType(store, {
        itemsId: data.items_id,
        fromType: data.to_activity_type_id,
        toType: data.from_activity_type_id,
        operationId,
        decision: { ...decision, agent_id: 'context-compensation' },
        now
      });
      restoreRelations(store, data.prior_relations, decision, operationId, now);
    }
  }
  for (const activityId of data.activity_ids ?? []) {
    if (guards.activityIds.has(activityId)) endActivity(store, activityId, decision, operationId, now);
  }
  if (data.kind === 'inbox_conversion') {
    const current = currentActivity(store, data.items_id);
    const originalRolesStillCurrent = current && store.db.prepare(`
      SELECT 1 FROM inbox i
      JOIN item_roles inbox_role ON inbox_role.id = i.item_roles_id
      JOIN item_roles activity_role ON activity_role.id = ?
      JOIN items item ON item.id = i.id
      WHERE i.id = ? AND i.user_id = ? AND i.deleted_at_utc IS NULL
        AND i.item_roles_id = ?
        AND inbox_role.items_id = i.id AND inbox_role.status = 'ended'
        AND activity_role.items_id = i.id AND activity_role.status = 'active'
        AND item.user_id = ? AND item.deleted_at_utc IS NULL
    `).get(current.item_roles_id, data.items_id, requireUser(), data.inbox_item_roles_id, requireUser());
    if (current?.last_event_id === data.created_activity_event_id
      && activeRelationsForItem(store, data.items_id).length === 0
      && originalRolesStillCurrent) {
      endActivity(store, data.items_id, decision, operationId, now);
      const restoredRole = store.db.prepare(`
        UPDATE item_roles SET status = 'active', active_to_utc = NULL
        WHERE id = ? AND items_id = ? AND status = 'ended'
      `).run(data.inbox_item_roles_id, data.items_id);
      const restoredItem = store.db.prepare(`
        UPDATE items SET deleted_at_utc = NULL
        WHERE id = ? AND user_id = ? AND deleted_at_utc = ?
      `).run(data.items_id, requireUser(), now);
      if (restoredRole.changes !== 1 || restoredItem.changes !== 1) {
        throw applyError('inbox_compensation_conflict', 409);
      }
    }
  }
}

function endActivity(store, activityId, decision, operationId, now) {
  const current = currentActivity(store, activityId);
  if (!current || current.deleted_at_utc) return;
  const eventId = operationEventId(operationId, `activity-ended:${activityId}`);
  insertActivityEvent(store, { eventId, eventType: 'delete', itemsId: activityId, itemRolesId: current.item_roles_id, payload: {}, decision, now });
  store.projectActivity(activityId, now);
  store.reconcileActivityRelations([{
    event_id: eventId, operation_id: operationId, activity_id: activityId,
    change_type: 'delete', payload_json: '{}'
  }], now);
}

function restoreRelations(store, relations, decision, operationId, now) {
  for (const [index, relation] of (relations ?? []).entries()) {
    try {
      store.createRelationWithEvent({
        id: operationEntityId(operationId, `restore-relation:${index}`),
        relationTypeId: relation.relation_types_id,
        sourceItemsId: relation.source_items_id,
        targetItemsId: relation.target_items_id,
        position: relation.position,
        operationId,
        originDecisionId: decision.id,
        actorType: 'system', actorId: 'context-compensation', nowIso: now
      });
    } catch (error) {
      if (!['invalid_relation_endpoints', 'relation_type_not_found'].includes(error?.code)) throw error;
    }
  }
}

function beginOperation(store, { id, userId, kind, requestHash, now, originalOperationId }) {
  const existing = store.db.prepare('SELECT * FROM context_operations WHERE id = ? AND user_id = ? FOR UPDATE').get(id, userId);
  if (existing) {
    if (existing.request_hash !== requestHash || existing.kind !== kind) throw applyError('operation_idempotency_conflict', 409);
    if (existing.status === 'completed' || existing.status === 'compensated') {
      return parseJsonObject(existing.result_json);
    }
    return null;
  }
  store.db.prepare(`
    INSERT INTO context_operations (
      id, user_id, kind, request_hash, status, original_operation_id, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(id, userId, kind, requestHash, originalOperationId, now, now);
  return null;
}

function finishOperation(store, id, userId, outcome, now) {
  store.db.prepare(`
    UPDATE context_operations SET status = 'completed', result_json = ?::jsonb,
      compensation_json = ?::jsonb, last_error = NULL, updated_at_utc = ?
    WHERE id = ? AND user_id = ?
  `).run(JSON.stringify(outcome.result), JSON.stringify(outcome.compensation), now, id, userId);
}

function currentActivity(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`SELECT * FROM activities WHERE id = ?${scope.clause}`).get(id, ...scope.params) ?? null;
}

function currentRelation(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`SELECT * FROM relations WHERE id = ?${scope.clause}`).get(id, ...scope.params) ?? null;
}

function activeRelationsForItem(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT * FROM relations WHERE status = 'active'
      AND (source_items_id = ? OR target_items_id = ?) ${scope.clause}
    ORDER BY id
  `).all(id, id, ...scope.params);
}

function latestAcceptedTypeEventId(store, itemsId) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT event_id FROM events
    WHERE event_domain = 'activity' AND event_type = 'set_type'
      AND status = 'accepted' AND items_id = ? ${scope.clause}
    ORDER BY occurred_at_utc DESC, domain_sequence DESC LIMIT 1
  `).get(itemsId, ...scope.params)?.event_id ?? null;
}

function uniqueIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(sanitizeText).filter(Boolean))];
}

function stableUuid(value) {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  const id = hex.join('');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function operationEntityId(operationId, kind) {
  return stableUuid(stableJson({ kind, operation_id: operationId, user_id: requireUser() }));
}

function operationEventId(operationId, kind) {
  return `${operationEntityId(operationId, 'event-scope')}:${kind}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function requiredText(value, code) {
  const text = sanitizeText(value);
  if (!text) throw applyError(code, 400);
  return text;
}

function boundedText(value, maximum, code, required = false) {
  if (typeof value !== 'string') throw applyError(code, 400);
  const text = required ? value.trim() : value;
  if ((required && !text) || text.length > maximum) throw applyError(code, 400);
  return text;
}

function requireUser() {
  const userId = sanitizeText(scopedUserId());
  if (!userId) throw applyError('unauthorized', 401);
  return userId;
}

function atomic(store, fn) {
  return store.db.currentTxId ? fn : store.db.transaction(fn);
}

function applyError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
