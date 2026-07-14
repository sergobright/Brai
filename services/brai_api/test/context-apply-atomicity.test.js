import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import {
  NOW,
  OWNER,
  claimOwner,
  owner,
  seedActivity
} from './goal-agent-test-support.js';

const INJECTED_FAILURE = 'injected_context_apply_failure';

test('context apply and compensation acquire the Relation mutation lock before row access', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    seedCanonicalActivity(fixture, 'lock-order-action', 'action');
    seedCanonicalActivity(fixture, 'lock-order-goal', 'goal');
    const payload = relationPayload('lock-order-action', 'lock-order-goal');
    const decision = recordDecision(fixture, {
      agentId: 'goal.item-matcher',
      decisionKind: 'relation_add',
      triggerItemsId: 'lock-order-action',
      payload
    });
    const operationId = 'lock-order:apply';
    const result = assertRelationMutationLockFirst(fixture, () => apply(
      fixture, decision, payload, operationId
    ));
    assert.deepEqual(assertRelationMutationLockFirst(fixture, () => apply(
      fixture, decision, payload, operationId
    )), result);

    const compensationDecision = { ...decision, operation_id: operationId };
    const compensationId = 'lock-order:compensate';
    const compensation = assertRelationMutationLockFirst(fixture, () => compensate(
      fixture, compensationDecision, compensationId
    ));
    assert.deepEqual(assertRelationMutationLockFirst(fixture, () => compensate(
      fixture, compensationDecision, compensationId
    )), compensation);
  } finally {
    await fixture.close();
  }
});

test('context apply packages rollback injected failures and retry exactly once', async (t) => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);

    await t.test('relation_add', () => {
      seedCanonicalActivity(fixture, 'atomic-relation-action', 'action');
      seedCanonicalActivity(fixture, 'atomic-relation-goal', 'goal');
      const payload = relationPayload('atomic-relation-action', 'atomic-relation-goal');
      const decision = recordDecision(fixture, {
        agentId: 'goal.item-matcher',
        decisionKind: 'relation_add',
        triggerItemsId: 'atomic-relation-action',
        payload
      });
      const operationId = 'atomic:relation-add';
      const before = canonicalState(fixture);

      failApply(fixture, 'createRelationWithEvent', 'after', () => apply(
        fixture, decision, payload, operationId
      ));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(operationCount(fixture, operationId), 0);
      assert.equal(relationOperationCount(fixture, operationId), 0);
      assert.equal(relationEventCount(fixture, operationId), 0);

      const result = apply(fixture, decision, payload, operationId);
      const after = canonicalState(fixture);
      assert.equal(result.operation_id, operationId);
      assert.equal(relationOperationCount(fixture, operationId), 1);
      assert.equal(relationEventCount(fixture, operationId), 1);
      assertCompletedOnce(fixture, operationId);
      assert.deepEqual(apply(fixture, decision, payload, operationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });

    await t.test('activity_type_change', () => {
      seedCanonicalActivity(fixture, 'atomic-type-action', 'action');
      const payload = {
        items_id: 'atomic-type-action',
        from_activity_type_id: 'action',
        to_activity_type_id: 'goal'
      };
      const decision = recordDecision(fixture, {
        agentId: 'activity.classifier',
        decisionKind: 'activity_type_change',
        triggerItemsId: 'atomic-type-action',
        payload
      });
      const operationId = 'atomic:activity-type';
      const before = canonicalState(fixture);

      failApply(fixture, 'projectActivity', 'after', () => apply(
        fixture, decision, payload, operationId
      ));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(activity(fixture, 'atomic-type-action').activity_type_id, 'action');
      assert.equal(activityTypeEventCount(fixture, 'atomic-type-action'), 0);
      assert.equal(operationCount(fixture, operationId), 0);

      const result = apply(fixture, decision, payload, operationId);
      const after = canonicalState(fixture);
      assert.equal(result.activity_id, 'atomic-type-action');
      assert.equal(activity(fixture, 'atomic-type-action').activity_type_id, 'goal');
      assert.equal(activityTypeEventCount(fixture, 'atomic-type-action'), 1);
      assertCompletedOnce(fixture, operationId);
      assert.deepEqual(apply(fixture, decision, payload, operationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });

    await t.test('same-Item normalized Inbox conversion', () => {
      seedInbox(fixture, 'atomic-inbox');
      const payload = { items_id: 'atomic-inbox', to_activity_type_id: 'action' };
      const decision = recordDecision(fixture, {
        agentId: 'activity.classifier',
        decisionKind: 'activity_type_change',
        triggerItemsId: 'atomic-inbox',
        payload
      });
      const operationId = 'atomic:inbox-conversion';
      const before = canonicalState(fixture);

      failApply(fixture, 'ensureActivityRoleLink', 'after', () => apply(
        fixture, decision, payload, operationId
      ));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(activity(fixture, 'atomic-inbox'), undefined);
      assert.deepEqual(roleStates(fixture, 'atomic-inbox'), ['inbox:active']);
      assert.equal(operationCount(fixture, operationId), 0);

      const result = apply(fixture, decision, payload, operationId);
      const after = canonicalState(fixture);
      assert.equal(result.activity_id, 'atomic-inbox');
      assert.equal(activity(fixture, 'atomic-inbox').activity_type_id, 'action');
      assert.deepEqual(roleStates(fixture, 'atomic-inbox'), ['activity:active', 'inbox:ended']);
      assertCompletedOnce(fixture, operationId);
      assert.deepEqual(apply(fixture, decision, payload, operationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });

    await t.test('goal_discovery', () => {
      seedCanonicalActivity(fixture, 'atomic-discovery-a', 'action');
      seedCanonicalActivity(fixture, 'atomic-discovery-b', 'action');
      const payload = {
        title: 'Атомарная цель',
        member_items_ids: ['atomic-discovery-a', 'atomic-discovery-b']
      };
      const decision = recordDecision(fixture, {
        agentId: 'goal.discovery',
        decisionKind: 'goal_discovery',
        payload
      });
      const operationId = 'atomic:goal-discovery';
      const before = canonicalState(fixture);

      failApply(fixture, 'createRelationWithEvent', 'before', () => apply(
        fixture, decision, payload, operationId
      ));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(operationCount(fixture, operationId), 0);
      assert.equal(agentActivityCount(fixture, 'goal.discovery'), 0);

      const result = apply(fixture, decision, payload, operationId);
      const after = canonicalState(fixture);
      assert.equal(result.relation_ids.length, 2);
      assert.equal(activity(fixture, result.activity_id).activity_type_id, 'goal');
      assert.equal(relationOperationCount(fixture, operationId), 2);
      assertCompletedOnce(fixture, operationId);
      assert.deepEqual(apply(fixture, decision, payload, operationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });

    await t.test('goal_plan', () => {
      seedCanonicalActivity(fixture, 'atomic-plan-goal', 'goal');
      const payload = {
        goal_items_id: 'atomic-plan-goal',
        actions: [{ title: 'Первый атомарный шаг' }, { title: 'Второй атомарный шаг' }]
      };
      const decision = recordDecision(fixture, {
        agentId: 'goal.planner',
        decisionKind: 'goal_plan',
        triggerItemsId: 'atomic-plan-goal',
        payload
      });
      const operationId = 'atomic:goal-plan';
      const before = canonicalState(fixture);

      failApply(fixture, 'createRelationWithEvent', 'before', () => apply(
        fixture, decision, payload, operationId
      ));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(operationCount(fixture, operationId), 0);
      assert.equal(agentActivityCount(fixture, 'goal.planner'), 0);

      const result = apply(fixture, decision, payload, operationId);
      const after = canonicalState(fixture);
      assert.equal(result.activity_ids.length, 2);
      assert.equal(result.relation_ids.length, 2);
      assert.equal(result.activity_ids.every((id) => activity(fixture, id).activity_type_id === 'action'), true);
      assert.equal(relationOperationCount(fixture, operationId), 2);
      assertCompletedOnce(fixture, operationId);
      assert.deepEqual(apply(fixture, decision, payload, operationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });

    await t.test('compensation family', () => {
      seedCanonicalActivity(fixture, 'atomic-compensation-action', 'action');
      seedCanonicalActivity(fixture, 'atomic-compensation-goal', 'goal');
      const payload = relationPayload('atomic-compensation-action', 'atomic-compensation-goal');
      const decision = recordDecision(fixture, {
        agentId: 'goal.item-matcher',
        decisionKind: 'relation_add',
        triggerItemsId: 'atomic-compensation-action',
        payload
      });
      const originalOperationId = 'atomic:compensation-original';
      const original = apply(fixture, decision, payload, originalOperationId);
      const compensationDecision = { ...decision, operation_id: originalOperationId };
      const compensationOperationId = 'atomic:compensation-retry';
      const before = canonicalState(fixture);

      failApply(fixture, 'endRelationWithEvent', 'after', () => owner(fixture, () => (
        fixture.store.compensateContextDecision({
          decision: compensationDecision,
          operationId: compensationOperationId,
          nowIso: NOW
        })
      )));

      assert.deepEqual(canonicalState(fixture), before);
      assert.equal(relation(fixture, original.relation_id).status, 'active');
      assert.equal(operationStatus(fixture, originalOperationId), 'completed');
      assert.equal(operationCount(fixture, compensationOperationId), 0);
      assert.equal(relationEventCount(fixture, compensationOperationId), 0);

      const result = compensate(fixture, compensationDecision, compensationOperationId);
      const after = canonicalState(fixture);
      assert.deepEqual(result, {
        operation_id: compensationOperationId,
        compensated_operation_id: originalOperationId
      });
      assert.equal(relation(fixture, original.relation_id).status, 'ended');
      assert.equal(operationStatus(fixture, originalOperationId), 'compensated');
      assertCompletedOnce(fixture, compensationOperationId);
      assert.equal(relationEventCount(fixture, compensationOperationId), 1);
      assert.deepEqual(compensate(fixture, compensationDecision, compensationOperationId), result);
      assert.deepEqual(canonicalState(fixture), after);
    });
  } finally {
    await fixture.close();
  }
});

let revision = 0;

function recordDecision(fixture, { agentId, decisionKind, triggerItemsId, payload }) {
  const agent = fixture.store.getAgent(agentId);
  revision += 1;
  return owner(fixture, () => fixture.store.recordContextDecision({
    agentId,
    agentVersion: agent.version,
    promptVersion: agent.prompt_version,
    model: 'test-model',
    schemaVersion: agent.schema_version,
    decisionKind,
    triggerItemsId,
    triggerRevision: revision,
    confidence: 0.8,
    rationale: 'Failure-injection verification',
    evidence: [],
    proposal: payload,
    nowIso: NOW
  })).decision;
}

function apply(fixture, decision, payload, operationId) {
  return owner(fixture, () => fixture.store.applyContextDecisionPackage({
    decision,
    payload,
    operationId,
    nowIso: NOW
  }));
}

function compensate(fixture, decision, operationId) {
  return owner(fixture, () => fixture.store.compensateContextDecision({
    decision,
    operationId,
    nowIso: NOW
  }));
}

function failApply(fixture, method, phase, callback) {
  const restore = injectFailureOnce(fixture.store, method, phase);
  try {
    assert.throws(callback, (error) => error?.message === INJECTED_FAILURE);
  } finally {
    restore();
  }
}

function injectFailureOnce(store, method, phase) {
  const hadOwn = Object.hasOwn(store, method);
  const original = store[method];
  assert.equal(typeof original, 'function');
  let injected = false;
  store[method] = function injectedMethod(...args) {
    if (!injected) {
      injected = true;
      if (phase === 'after') original.apply(this, args);
      throw new Error(INJECTED_FAILURE);
    }
    return original.apply(this, args);
  };
  return () => {
    if (hadOwn) store[method] = original;
    else delete store[method];
  };
}

function assertRelationMutationLockFirst(fixture, callback) {
  const store = fixture.store;
  const originalLock = store.lockRelationMutationDomain;
  const originalPrepare = store.db.prepare;
  const hadOwnLock = Object.hasOwn(store, 'lockRelationMutationDomain');
  const hadOwnPrepare = Object.hasOwn(store.db, 'prepare');
  let locked = false;
  store.db.prepare = function guardedPrepare(sql) {
    if (!locked && /\b(?:context_operations|activities|relations|events|inbox|item_roles)\b/i.test(sql)) {
      assert.fail('context apply accessed domain rows before the Relation mutation lock');
    }
    return originalPrepare.call(this, sql);
  };
  store.lockRelationMutationDomain = function guardedLock(...args) {
    assert.ok(this.db.currentTxId, 'Relation mutation lock must be transaction-scoped');
    const result = originalLock.apply(this, args);
    locked = true;
    return result;
  };
  try {
    const result = callback();
    assert.equal(locked, true);
    return result;
  } finally {
    if (hadOwnLock) store.lockRelationMutationDomain = originalLock;
    else delete store.lockRelationMutationDomain;
    if (hadOwnPrepare) store.db.prepare = originalPrepare;
    else delete store.db.prepare;
  }
}

function seedInbox(fixture, id) {
  fixture.store.db.prepare(`
    INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, '', '', ?, ?)
  `).run(id, OWNER, id, NOW, NOW);
  const role = fixture.store.db.prepare(`
    INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
    SELECT ?, id, ?, 'active', '{}' FROM item_role_types WHERE title_system = 'inbox'
    RETURNING id
  `).get(id, NOW);
  fixture.store.db.prepare(`
    INSERT INTO inbox (
      id, title, record_type_id, preliminary_section, is_normalized, status,
      created_at_utc, updated_at_utc, user_id, item_roles_id
    ) VALUES (?, ?, 2, 'follow_up', 1, 'New', ?, ?, ?, ?)
  `).run(id, id, NOW, NOW, OWNER, role.id);
}

function seedCanonicalActivity(fixture, id, type) {
  owner(fixture, () => {
    seedActivity(fixture.store, id, type);
    const activityRow = fixture.store.getActivityItem(id);
    fixture.store.insertEventRecord({
      id: `activity:atomic-create-${id}`,
      eventId: `atomic-create-${id}`,
      eventDomain: 'activity',
      eventType: 'create',
      eventAction: 'activity.create',
      title: 'Activity create',
      itemsId: id,
      itemRolesId: activityRow.item_roles_id,
      subjectType: 'activity',
      subjectId: id,
      actorType: 'user',
      actorId: OWNER,
      occurredAtUtc: NOW,
      receivedAtUtc: NOW,
      status: 'accepted',
      payloadVersion: 1,
      payloadJson: JSON.stringify({ title: id, activity_type_id: type })
    });
  });
}

function canonicalState(fixture) {
  const tables = [
    ['items', 'id'],
    ['item_roles', 'id'],
    ['activities', 'id'],
    ['inbox', 'id'],
    ['relations', 'id'],
    ['events', 'id'],
    ['context_operations', 'id'],
    ['context_discovery_watermarks', 'user_id']
  ];
  return {
    rows: Object.fromEntries(tables.map(([table, order]) => [
      table,
      fixture.store.db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()
    ])),
    counters: fixture.store.db.prepare('SELECT name, last_value FROM sequence_counters ORDER BY name').all()
  };
}

function relationPayload(sourceItemsId, targetItemsId) {
  return { relation_type_id: 'part_of', source_items_id: sourceItemsId, target_items_id: targetItemsId };
}

function assertCompletedOnce(fixture, operationId) {
  assert.equal(operationCount(fixture, operationId), 1);
  assert.equal(operationStatus(fixture, operationId), 'completed');
}

function operationCount(fixture, operationId) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM context_operations WHERE id = ?')
    .get(operationId).count;
}

function operationStatus(fixture, operationId) {
  return fixture.store.db.prepare('SELECT status FROM context_operations WHERE id = ?').get(operationId)?.status;
}

function relationOperationCount(fixture, operationId) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM relations WHERE operation_id = ?')
    .get(operationId).count;
}

function relationEventCount(fixture, operationId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM events
    WHERE event_domain = 'relation' AND payload_json::jsonb #>> '{payload,operation_id}' = ?
  `).get(operationId).count;
}

function activityTypeEventCount(fixture, itemsId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM events
    WHERE event_domain = 'activity' AND event_type = 'set_type' AND items_id = ?
  `).get(itemsId).count;
}

function agentActivityCount(fixture, agentId) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM activities WHERE author = ?')
    .get(agentId).count;
}

function activity(fixture, id) {
  return fixture.store.db.prepare('SELECT * FROM activities WHERE id = ?').get(id);
}

function relation(fixture, id) {
  return fixture.store.db.prepare('SELECT * FROM relations WHERE id = ?').get(id);
}

function roleStates(fixture, itemsId) {
  return fixture.store.db.prepare(`
    SELECT t.title_system || ':' || r.status AS state
    FROM item_roles r JOIN item_role_types t ON t.id = r.item_role_types_id
    WHERE r.items_id = ? ORDER BY state
  `).all(itemsId).map((row) => row.state);
}
