import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = '2026-07-13T18:00:00.000Z';
const OPERATION_ID = 'shared-owner-operation';
const USERS = ['operation-owner-a', 'operation-owner-b'];

test('context operation apply idempotency is isolated by authenticated owner', async () => {
  const fixture = await createFixture([NOW]);
  try {
    const packages = USERS.map((userId, index) => seedPackage(fixture, userId, index));
    const first = apply(fixture, packages[0]);
    const second = apply(fixture, packages[1]);

    assert.equal(first.operation_id, OPERATION_ID);
    assert.equal(second.operation_id, OPERATION_ID);
    assert.notEqual(first.relation_id, second.relation_id);
    assert.deepEqual(apply(fixture, packages[0]), first);
    assert.deepEqual(apply(fixture, packages[1]), second);

    const operations = fixture.store.db.prepare(`
      SELECT user_id, id, status FROM context_operations
      WHERE id = ? ORDER BY user_id
    `).all(OPERATION_ID);
    assert.deepEqual(operations, USERS.map((userId) => ({
      user_id: userId, id: OPERATION_ID, status: 'completed'
    })));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT user_id, operation_id FROM relations
      WHERE operation_id = ? ORDER BY user_id
    `).all(OPERATION_ID), USERS.map((userId) => ({ user_id: userId, operation_id: OPERATION_ID })));

    assert.throws(
      () => apply(fixture, {
        ...packages[0],
        payload: { ...packages[0].payload, suggested_position: 0 }
      }),
      (error) => error?.code === 'operation_idempotency_conflict' && error?.status === 409
    );
    assert.equal(
      fixture.store.db.prepare('SELECT count(*)::int AS count FROM context_operations WHERE id = ?').get(OPERATION_ID).count,
      2
    );
  } finally {
    await fixture.close();
  }
});

function seedPackage(fixture, userId, index) {
  const sourceId = `owner-${index}-action`;
  const targetId = `owner-${index}-goal`;
  seedActivity(fixture, userId, sourceId, 'action');
  seedActivity(fixture, userId, targetId, 'goal');
  const payload = {
    relation_type_id: 'part_of',
    source_items_id: sourceId,
    target_items_id: targetId
  };
  const decision = withUserScope(userId, () => {
    const agent = fixture.store.getAgent('goal.item-matcher');
    return fixture.store.recordContextDecision({
      agentId: agent.id,
      agentVersion: agent.version,
      promptVersion: agent.prompt_version,
      model: 'test-model',
      schemaVersion: agent.schema_version,
      decisionKind: 'relation_add',
      triggerItemsId: sourceId,
      triggerRevision: 1,
      confidence: 0.8,
      rationale: 'Owner-scoped operation regression',
      evidence: [],
      proposal: payload,
      nowIso: NOW
    }).decision;
  });
  return { userId, decision, payload };
}

function seedActivity(fixture, userId, id, type) {
  withUserScope(userId, () => {
    fixture.store.db.prepare(`
      INSERT INTO activities (
        id, activity_type_id, title, description_md, author, reason, status,
        created_at_utc, updated_at_utc, user_id
      ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
    `).run(id, type, id, NOW, NOW, userId);
    fixture.store.ensureActivityRoleLink({
      id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW
    });
  });
}

function apply(fixture, { userId, decision, payload }) {
  return withUserScope(userId, () => fixture.store.applyContextDecisionPackage({
    decision, payload, operationId: OPERATION_ID, nowIso: NOW
  }));
}
