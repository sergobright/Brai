import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const OWNER = 'context-lock-owner';
const NOW = '2026-07-13T19:00:00.000Z';

test('decision accept cannot deadlock a Relation create at deferred origin FK commit', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const observer = await pool.connect();
  const workers = [];
  const gate = new SharedArrayBuffer(4);
  try {
    const proposal = {
      relation_type_id: 'part_of',
      source_items_id: 'decision-lock-action',
      target_items_id: 'decision-lock-goal'
    };
    const decision = owned(fixture, () => {
      seedActivity(fixture.store, 'decision-lock-action', 'action');
      seedActivity(fixture.store, 'decision-lock-goal', 'goal');
      const agent = fixture.store.getAgent('goal.item-matcher');
      return fixture.store.recordContextDecision({
        agentId: agent.id, agentVersion: agent.version,
        promptVersion: agent.prompt_version, model: 'test-model',
        schemaVersion: agent.schema_version, decisionKind: 'relation_add',
        triggerItemsId: proposal.source_items_id, triggerRevision: 1,
        confidence: 0.8, rationale: 'Concurrent lock verification', evidence: [],
        proposal, nowIso: NOW
      }).decision;
    });
    assert.equal(decision.status, 'pending');
    assert.deepEqual(await observer.query(`
      SELECT condeferrable, condeferred FROM pg_constraint
      WHERE conname = 'relations_origin_decision_id_fkey'
    `).then(({ rows }) => rows[0]), { condeferrable: true, condeferred: true });

    const relation = decisionWorker(fixture.databaseUrl, {
      mode: 'hold_relation', gate, input: {
        id: 'decision-lock-relation', ...proposal, relationTypeId: proposal.relation_type_id,
        sourceItemsId: proposal.source_items_id, targetItemsId: proposal.target_items_id,
        operationId: 'decision-lock:relation', originDecisionId: decision.id,
        actorType: 'agent', actorId: 'goal.item-matcher', nowIso: NOW
      }
    });
    workers.push(relation);
    await waitForMessage(relation, 'ready');
    const relationResult = waitForResult(relation);
    const relationHolding = waitForMessage(relation, 'holding');
    relation.postMessage('start');
    await relationHolding;

    const resolver = decisionWorker(fixture.databaseUrl, {
      mode: 'resolve', input: {
        decisionId: decision.id, action: 'accept',
        resolutionKey: 'decision-lock:accept', nowIso: NOW
      }
    });
    workers.push(resolver);
    await waitForMessage(resolver, 'ready');
    const resolverResult = waitForResult(resolver);
    const resolverTx = waitForMessage(resolver, 'transaction');
    resolver.postMessage('start');
    await waitForAdvisoryWait(observer, (await resolverTx).pid);

    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = await Promise.all([relationResult, resolverResult]);
    assert.equal(results.every((result) => result.ok), true, JSON.stringify(results));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, origin_decision_id FROM relations WHERE id = ?
    `).get('decision-lock-relation'), {
      status: 'active', origin_decision_id: decision.id
    });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, resulting_operation_id, resulting_relation_id
      FROM context_decisions WHERE id = ?
    `).get(decision.id), {
      status: 'accepted', resulting_operation_id: 'decision-lock:accept',
      resulting_relation_id: 'decision-lock-relation'
    });
  } finally {
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    observer.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

test('outer auto-apply, audit rejection, and undo take the Relation lock before mutation rows', async () => {
  const fixture = await createFixture([NOW]);
  try {
    const decisions = owned(fixture, () => {
      for (const [id, type] of [
        ['outer-seed-action', 'action'], ['outer-seed-goal', 'goal'],
        ['outer-audit-action', 'action'], ['outer-audit-goal', 'goal'],
        ['outer-undo-action', 'action'], ['outer-undo-goal', 'goal']
      ]) seedActivity(fixture.store, id, type);
      const seed = recordRelationDecision(fixture.store, 10, 'outer-seed-action', 'outer-seed-goal');
      fixture.store.db.prepare(`
        UPDATE context_policies SET state = 'active', active_threshold = 0.5 WHERE id = ?
      `).run(seed.policy.id);
      const audit = assertLockBefore(fixture.store, /^\s*INSERT INTO context_decisions/i, () => (
        recordRelationDecision(fixture.store, 11, 'outer-audit-action', 'outer-audit-goal')
      ));
      const undo = recordRelationDecision(fixture.store, 12, 'outer-undo-action', 'outer-undo-goal');
      fixture.store.db.prepare(`
        INSERT INTO context_audit_batches (
          id, user_id, policies_id, status, window_started_at_utc, window_ended_at_utc,
          due_at_utc, created_at_utc, updated_at_utc
        ) VALUES ('outer-audit', ?, ?, 'pending', ?, ?, ?, ?, ?)
      `).run(OWNER, audit.policy.id, NOW, NOW, '2026-07-14T19:00:00.000Z', NOW, NOW);
      const auditItem = fixture.store.db.prepare(`
        INSERT INTO context_audit_items (
          audit_batches_id, decisions_id, sample_kind, position, created_at_utc
        ) VALUES ('outer-audit', ?, 'random', 0, ?) RETURNING id
      `).get(audit.id, NOW);
      return { audit, auditItem, undo };
    });

    owned(fixture, () => assertLockBefore(
      fixture.store, /context_audit_items|JOIN context_decisions/i,
      () => fixture.store.resolveContextAuditItem({
        auditItemId: decisions.auditItem.id, action: 'reject',
        resolutionKey: 'outer-audit:reject', nowIso: NOW
      })
    ));
    owned(fixture, () => assertLockBefore(
      fixture.store, /FROM context_decisions/i,
      () => fixture.store.undoContextDecision({
        decisionId: decisions.undo.id, operationId: 'outer-undo:compensate', nowIso: NOW
      })
    ));
  } finally {
    await fixture.close();
  }
});

function decisionWorker(databaseUrl, options) {
  return new Worker(new URL('../test-support/context-decision-concurrency-worker.js', import.meta.url), {
    workerData: { databaseUrl, userId: OWNER, ...options }
  });
}

function recordRelationDecision(store, revision, sourceItemsId, targetItemsId) {
  const agent = store.getAgent('goal.item-matcher');
  return store.recordContextDecision({
    agentId: agent.id, agentVersion: agent.version,
    promptVersion: agent.prompt_version, model: 'test-model', schemaVersion: agent.schema_version,
    decisionKind: 'relation_add', triggerItemsId: sourceItemsId, triggerRevision: revision,
    confidence: 0.8, rationale: 'Outer lock verification', evidence: [],
    proposal: {
      relation_type_id: 'part_of', source_items_id: sourceItemsId, target_items_id: targetItemsId
    }, nowIso: NOW
  }).decision;
}

function assertLockBefore(store, rowPattern, callback) {
  const originalLock = store.lockRelationMutationDomain;
  const originalPrepare = store.db.prepare;
  let locked = false;
  store.db.prepare = function guardedPrepare(sql) {
    if (!locked && rowPattern.test(sql)) assert.fail('decision mutation row accessed before Relation lock');
    return originalPrepare.call(this, sql);
  };
  store.lockRelationMutationDomain = function guardedLock(...args) {
    const result = originalLock.apply(this, args);
    locked = true;
    return result;
  };
  try {
    const result = callback();
    assert.equal(locked, true);
    return result;
  } finally {
    store.lockRelationMutationDomain = originalLock;
    store.db.prepare = originalPrepare;
  }
}

function waitForMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup(); resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`context_worker_exit:${code}`)); };
    const cleanup = () => {
      worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
    };
    worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
  });
}

function waitForResult(worker) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== 'result') return;
      cleanup(); resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`context_worker_exit:${code}`)); };
    const cleanup = () => {
      worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit);
    };
    worker.on('message', onMessage); worker.on('error', onError); worker.on('exit', onExit);
  });
}

async function waitForAdvisoryWait(client, pid) {
  const deadline = Date.now() + 3_000;
  let state;
  while (Date.now() < deadline) {
    state = (await client.query(`
      SELECT a.wait_event,
        count(*) FILTER (WHERE l.locktype = 'advisory' AND NOT l.granted)::int AS waiting
      FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid
      WHERE a.pid = $1 GROUP BY a.wait_event
    `, [pid])).rows[0];
    if (state?.wait_event === 'advisory' && state.waiting === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`decision_advisory_wait_timeout:${pid}:${JSON.stringify(state)}`);
}

function owned(fixture, callback) {
  return withUserScope(OWNER, callback);
}

function seedActivity(store, id, type) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, type, id, NOW, NOW, OWNER);
  store.ensureActivityRoleLink({
    id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW
  });
}
