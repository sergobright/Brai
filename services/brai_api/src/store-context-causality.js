import { stableHash } from './context-policy.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export function captureCreatedObjectCheckpoints(store, compensation, operationId) {
  const graph = cachedGraphReader(store);
  const relationCheckpoints = (compensation.relation_ids ?? []).map((id) => {
    const relation = currentRelation(store, id);
    const createdEventId = `${operationId}:relation-created:${id}`;
    return relation?.operation_id === operationId
      && latestRelationEventId(store, id) === createdEventId && {
      id,
      created_event_id: createdEventId,
      fingerprint: stableHash(relation),
      source_items_id: relation.source_items_id,
      target_items_id: relation.target_items_id,
      source_graph: graph(relation.source_items_id),
      target_graph: graph(relation.target_items_id)
    };
  }).filter(Boolean);
  const activityCheckpoints = (compensation.activity_ids ?? []).map((id, index) => {
    const activity = currentActivity(store, id);
    const createdEventId = compensation.activity_event_ids?.[index];
    return activity?.last_event_id === createdEventId && {
      id,
      created_event_id: createdEventId,
      relation_graph: graph(id)
    };
  }).filter(Boolean);
  return {
    ...compensation,
    ...(relationCheckpoints.length > 0 && { relation_checkpoints: relationCheckpoints }),
    ...(activityCheckpoints.length > 0 && { activity_checkpoints: activityCheckpoints })
  };
}

export function createdObjectCompensationGuards(store, data) {
  const graph = cachedGraphReader(store);
  const activityStates = new Map((data.activity_checkpoints ?? []).map((checkpoint) => {
    const current = currentActivity(store, checkpoint.id);
    const eligible = current && !current.deleted_at_utc
      && current.last_event_id === checkpoint.created_event_id
      && sameGraph(checkpoint.relation_graph, graph(checkpoint.id));
    return [checkpoint.id, Boolean(eligible)];
  }));
  const relationIds = new Set((data.relation_checkpoints ?? []).filter((checkpoint) => {
    const current = currentRelation(store, checkpoint.id);
    return current?.status === 'active'
      && checkpoint.created_event_id === latestRelationEventId(store, checkpoint.id)
      && checkpoint.fingerprint === stableHash(current)
      && sameGraph(checkpoint.source_graph, graph(checkpoint.source_items_id))
      && sameGraph(checkpoint.target_graph, graph(checkpoint.target_items_id))
      && [checkpoint.source_items_id, checkpoint.target_items_id]
        .every((id) => !activityStates.has(id) || activityStates.get(id));
  }).map((checkpoint) => checkpoint.id));
  return {
    activityIds: new Set([...activityStates].filter(([, eligible]) => eligible).map(([id]) => id)),
    relationIds
  };
}

export function relationGraphCheckpoint(store, itemsId) {
  const userId = scopedUserId();
  if (!userId) return null;
  const revision = store.db.prepare(`
    SELECT COALESCE(MAX(e.domain_sequence), 0) AS revision
    FROM events e
    WHERE e.event_domain = 'relation' AND e.status = 'accepted' AND e.user_id = ?
      AND (e.subject_id = ? OR EXISTS (
        SELECT 1 FROM relations r WHERE r.user_id = e.user_id
          AND (r.source_items_id = ? OR r.target_items_id = ?)
          AND (r.id = e.subject_id OR (e.event_type = 'reorder' AND r.target_items_id = e.subject_id))
      ))
  `).get(userId, itemsId, itemsId, itemsId).revision;
  return {
    fingerprint: stableHash(activeRelationsForItem(store, itemsId)),
    revision
  };
}

function sameGraph(expected, current) {
  return expected?.fingerprint === current?.fingerprint && expected?.revision === current?.revision;
}

function cachedGraphReader(store) {
  const cache = new Map();
  return (itemsId) => {
    if (!cache.has(itemsId)) cache.set(itemsId, relationGraphCheckpoint(store, itemsId));
    return cache.get(itemsId);
  };
}

function activeRelationsForItem(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT * FROM relations WHERE status = 'active'
      AND (source_items_id = ? OR target_items_id = ?) ${scope.clause}
    ORDER BY id
  `).all(id, id, ...scope.params);
}

function currentActivity(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`SELECT * FROM activities WHERE id = ?${scope.clause}`)
    .get(id, ...scope.params) ?? null;
}

function currentRelation(store, id) {
  const scope = scopeSql();
  return store.db.prepare(`SELECT * FROM relations WHERE id = ?${scope.clause}`)
    .get(id, ...scope.params) ?? null;
}

function latestRelationEventId(store, relationId) {
  const scope = scopeSql();
  return store.db.prepare(`
    SELECT event_id FROM events WHERE event_domain = 'relation' AND status = 'accepted'
      AND subject_id = ? ${scope.clause}
    ORDER BY domain_sequence DESC LIMIT 1
  `).get(relationId, ...scope.params)?.event_id ?? null;
}
