import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, request } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = '2026-07-13T12:00:00.000Z';
const START = '2026-06-01T12:00:00.000Z';

test('periodic audit reconciliation creates the 30-day sample without a new decision', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedOwnerAndAgent(fixture.store);
    const decisions = owner(fixture, () => Array.from({ length: 5 }, (_, index) => recordDecision(fixture.store, index + 1)));
    const policyId = decisions[0].decision.policy.id;
    fixture.store.db.prepare(`
      UPDATE context_decisions SET status = 'auto_accepted' WHERE policies_id = ?
    `).run(policyId);
    fixture.store.db.prepare(`
      UPDATE context_policies SET state = 'active', active_threshold = 0.8,
        auto_accept_count_since_audit = 5, activated_at_utc = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(START, START, policyId);
    const before = count(fixture.store, 'context_decisions');

    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: NOW }), {
      overdue_count: 0,
      created_count: 1
    });
    assert.equal(count(fixture.store, 'context_decisions'), before);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_audit_batches WHERE policies_id = ?
    `).get(policyId).count, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_audit_items i
      JOIN context_audit_batches b ON b.id = i.audit_batches_id WHERE b.policies_id = ?
    `).get(policyId).count, 5);
    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: NOW }), {
      overdue_count: 0,
      created_count: 0
    });
  } finally {
    await fixture.close();
  }
});

test('30-day audit requires five eligible decisions and remains idempotent at 1/4/5', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedOwnerAndAgent(fixture.store);
    const eligibleAt = '2026-06-02T12:00:00.000Z';
    const auditAt = '2026-07-01T12:00:00.000Z';
    const decisions = owner(fixture, () => Array.from({ length: 5 }, (_, index) =>
      recordDecision(fixture.store, index + 101, eligibleAt)));
    const policyId = decisions[0].decision.policy.id;
    const ids = decisions.map(({ decision }) => decision.id);
    fixture.store.db.prepare("UPDATE context_decisions SET status = 'auto_accepted' WHERE id = ?").run(ids[0]);
    fixture.store.db.prepare(`
      UPDATE context_policies SET state = 'active', active_threshold = 0.8,
        auto_accept_count_since_audit = 1, activated_at_utc = ?, updated_at_utc = ?
      WHERE id = ?
    `).run(START, START, policyId);

    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: auditAt }), {
      overdue_count: 0, created_count: 0
    });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT auto_accept_count_since_audit, last_audit_at_utc
      FROM context_policies WHERE id = ?
    `).get(policyId), { auto_accept_count_since_audit: 1, last_audit_at_utc: null });

    fixture.store.db.prepare("UPDATE context_decisions SET status = 'auto_accepted' WHERE id IN (?, ?, ?)")
      .run(ids[1], ids[2], ids[3]);
    fixture.store.db.prepare(`
      UPDATE context_policies SET auto_accept_count_since_audit = 4 WHERE id = ?
    `).run(policyId);
    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: auditAt }), {
      overdue_count: 0, created_count: 0
    });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT auto_accept_count_since_audit, last_audit_at_utc
      FROM context_policies WHERE id = ?
    `).get(policyId), { auto_accept_count_since_audit: 4, last_audit_at_utc: null });
    assert.equal(count(fixture.store, 'context_audit_batches'), 0);

    fixture.store.db.prepare("UPDATE context_decisions SET status = 'auto_accepted' WHERE id = ?").run(ids[4]);
    fixture.store.db.prepare(`
      UPDATE context_policies SET auto_accept_count_since_audit = 5 WHERE id = ?
    `).run(policyId);
    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: auditAt }), {
      overdue_count: 0, created_count: 1
    });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT auto_accept_count_since_audit, last_audit_at_utc
      FROM context_policies WHERE id = ?
    `).get(policyId), { auto_accept_count_since_audit: 0, last_audit_at_utc: auditAt });
    assert.equal(count(fixture.store, 'context_audit_batches'), 1);
    assert.equal(count(fixture.store, 'context_audit_items'), 5);
    assert.deepEqual(fixture.store.reconcileContextAudits({ nowIso: auditAt }), {
      overdue_count: 0, created_count: 0
    });
    assert.equal(count(fixture.store, 'context_audit_batches'), 1);
    assert.equal(count(fixture.store, 'context_audit_items'), 5);
  } finally {
    await fixture.close();
  }
});

test('all overdue batches keep a policy shadow until the final item recalibrates it', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedOwnerAndAgent(fixture.store);
    const decisions = owner(fixture, () => Array.from({ length: 25 }, (_, index) => recordDecision(fixture.store, index + 1)));
    const policyId = decisions[0].decision.policy.id;
    const insertLabel = fixture.store.db.prepare(`
      INSERT INTO context_policy_labels (
        policies_id, decisions_id, source, accepted, confidence, created_at_utc
      ) VALUES (?, ?, 'review', 1, 0.8, ?)
    `);
    decisions.forEach(({ decision }) => insertLabel.run(policyId, decision.id, START));
    fixture.store.db.prepare(`
      UPDATE context_decisions SET status = 'auto_accepted' WHERE id IN (?, ?, ?, ?)
    `).run(...decisions.slice(0, 4).map(({ decision }) => decision.id));
    fixture.store.db.prepare(`
      UPDATE context_policies SET state = 'active', active_threshold = 0.8,
        activated_at_utc = ?, activation_notified_at_utc = ?, updated_at_utc = ? WHERE id = ?
    `).run(START, START, START, policyId);
    const batches = ['overdue-a', 'overdue-b'];
    for (const [batchIndex, batchId] of batches.entries()) {
      fixture.store.db.prepare(`
        INSERT INTO context_audit_batches (
          id, user_id, policies_id, status, window_started_at_utc, window_ended_at_utc,
          due_at_utc, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, 'overdue', ?, ?, ?, ?, ?)
      `).run(batchId, fixture.store.primaryUserId(), policyId, START,
        `2026-06-0${batchIndex + 2}T12:00:00.000Z`, '2026-07-01T12:00:00.000Z',
        START, START);
      for (let position = 0; position < 2; position += 1) {
        fixture.store.db.prepare(`
          INSERT INTO context_audit_items (
            audit_batches_id, decisions_id, sample_kind, position, created_at_utc
          ) VALUES (?, ?, 'nearest_threshold', ?, ?)
        `).run(batchId, decisions[batchIndex * 2 + position].decision.id, position, START);
      }
    }
    const itemIds = fixture.store.db.prepare(`
      SELECT id FROM context_audit_items ORDER BY audit_batches_id, position
    `).all().map((row) => row.id);

    for (let index = 0; index < itemIds.length - 1; index += 1) {
      owner(fixture, () => fixture.store.resolveContextAuditItem({
        auditItemId: itemIds[index], action: 'confirm', resolutionKey: `audit:confirm:${index}`, nowIso: NOW
      }));
      assert.deepEqual(fixture.store.db.prepare(`
        SELECT state, active_threshold, shadow_reason FROM context_policies WHERE id = ?
      `).get(policyId), { state: 'shadow', active_threshold: null, shadow_reason: 'audit_overdue' });
    }

    owner(fixture, () => fixture.store.resolveContextAuditItem({
      auditItemId: itemIds.at(-1), action: 'confirm', resolutionKey: 'audit:confirm:final', nowIso: NOW
    }));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT state, active_threshold, shadow_reason FROM context_policies WHERE id = ?
    `).get(policyId), { state: 'active', active_threshold: 0.8, shadow_reason: null });
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_audit_batches
      WHERE policies_id = ? AND status <> 'completed'
    `).get(policyId).count, 0);
  } finally {
    await fixture.close();
  }
});

test('decision and audit cursors traverse more than 100 owner-scoped rows', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedOwnerAndAgent(fixture.store);
    const ownerDecisions = owner(fixture, () => Array.from({ length: 105 }, (_, index) => recordDecision(fixture.store, index + 1)));
    withUserScope('foreign-context-owner', () => {
      for (let index = 0; index < 5; index += 1) recordDecision(fixture.store, 1_000 + index);
    });
    const policyId = ownerDecisions[0].decision.policy.id;
    for (let index = 0; index < 105; index += 1) {
      const point = new Date(Date.parse(START) + index * 1000).toISOString();
      fixture.store.db.prepare(`
        INSERT INTO context_audit_batches (
          id, user_id, policies_id, status, window_started_at_utc, window_ended_at_utc,
          due_at_utc, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, 'pending', ?, ?, '2026-08-31T12:00:00.000Z', ?, ?)
      `).run(`page-audit-${String(index).padStart(3, '0')}`, fixture.store.primaryUserId(), policyId,
        point, point, NOW, NOW);
    }

    const decisionIds = await collectPages(fixture, '/v1/context-decisions?status=pending&limit=37', 'decisions');
    assert.equal(decisionIds.length, 105);
    assert.equal(new Set(decisionIds).size, 105);
    assert.equal(decisionIds.some((id) => id.includes('foreign')), false);
    const auditIds = await collectPages(fixture, '/v1/context-decisions?status=audit&limit=40', 'audits');
    assert.equal(auditIds.length, 105);
    assert.equal(new Set(auditIds).size, 105);

    assert.equal((await request(fixture.url, '/v1/context-decisions?status=pending&limit=10&cursor=bad')).status, 400);
    assert.equal((await request(fixture.url, '/v1/context-decisions?status=pending&limit=10', {}, false)).status, 401);
  } finally {
    await fixture.close();
  }
});

async function collectPages(fixture, initialPath, field) {
  const ids = [];
  let path = initialPath;
  for (let page = 0; page < 10; page += 1) {
    const response = await request(fixture.url, path);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    ids.push(...response.body[field].map((row) => row.id));
    if (!response.body.next_cursor) return ids;
    path = `${initialPath}&cursor=${encodeURIComponent(response.body.next_cursor)}`;
  }
  assert.fail('pagination did not terminate');
}

function owner(fixture, callback) {
  return withUserScope(fixture.store.primaryUserId(), callback);
}

function recordDecision(store, triggerRevision, nowIso = NOW) {
  return store.recordContextDecision({
    agentId: 'goal.item-matcher', agentVersion: '1', promptVersion: 'prompt-1',
    model: 'test-model', schemaVersion: '1', decisionKind: 'relation_add',
    triggerRevision, confidence: 0.8, rationale: 'Проверка', evidence: [],
    proposal: { relation_type_id: 'part_of', source_items_id: `source-${triggerRevision}`, target_items_id: 'goal' },
    nowIso
  });
}

function seedOwnerAndAgent(store) {
  if (!store.primaryUserId()) {
    store.db.prepare(`
      INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('context-page-owner', 'Context Owner', 'context-page@example.test', true, now(), now())
    `).run();
    store.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES ('primary_user_id', 'context-page-owner', ?)
    `).run(NOW);
  }
  store.db.prepare(`
    INSERT INTO agents (
      id, version, target, kind, status, title, summary, trigger_description,
      conditions_description, input_description, output_description,
      interactions_description, side_effects_description, source_module, updated_at_utc
    ) VALUES ('goal.item-matcher', '1', 'goal', 'runtime', 'active', 'Matcher',
      '', '', '', '', '', '', '', 'test', ?) ON CONFLICT (id) DO NOTHING
  `).run(NOW);
}

function count(store, table) {
  return store.db.prepare(`SELECT count(*)::int AS count FROM ${table}`).get().count;
}
