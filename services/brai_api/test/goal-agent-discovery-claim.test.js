import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { NOW, OWNER, claimOwner, owner } from './goal-agent-test-support.js';

const CLAIM_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
Promise.all([import(workerData.storeUrl), import(workerData.scopeUrl)]).then(([storeModule, scopeModule]) => {
  const store = new storeModule.BraiStore(workerData.databaseUrl);
  store.configureGoalAgentEnvironment('prod');
  parentPort.postMessage({ type: 'ready' });
  parentPort.once('message', () => {
    try {
      const outcome = scopeModule.withUserScope(workerData.userId, () =>
        store.ensureEligibleGoalDiscoveries({ nowIso: workerData.nowIso }));
      parentPort.postMessage({ type: 'result', ok: true, outcome });
    } catch (error) {
      parentPort.postMessage({
        type: 'result', ok: false,
        error: { message: error?.message, code: error?.code, status: error?.status }
      });
    } finally {
      store.db.close();
    }
  });
}).catch((error) => parentPort.postMessage({
  type: 'result', ok: false, error: { message: error?.message }
}));
`;

test('concurrent discovery claims create and return exactly one active execution', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const lockClient = await pool.connect();
  const workers = [];
  let transactionOpen = false;
  try {
    claimOwner(fixture);
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 5, nowIso: NOW }));
    await lockClient.query('BEGIN');
    transactionOpen = true;
    await lockClient.query(`
      SELECT user_id FROM context_discovery_watermarks WHERE user_id = $1 FOR UPDATE
    `, [OWNER]);
    workers.push(claimWorker(fixture), claimWorker(fixture));
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const resultPromises = workers.map((worker) => waitForWorkerMessage(worker, 'result'));
    workers.forEach((worker) => worker.postMessage('claim'));
    assert.equal(await Promise.race([
      Promise.all(resultPromises).then(() => 'completed'),
      delay(100).then(() => 'blocked')
    ]), 'blocked');

    await lockClient.query('COMMIT');
    transactionOpen = false;
    const results = await Promise.all(resultPromises);
    const claimed = results.flatMap((result) => result.outcome);
    assert.equal(claimed.length, 1);
    assert.deepEqual(discoveryExecutionSummary(fixture), {
      execution_count: 1, active_count: 1, active_workflow_execution_id: claimed[0].id
    });
  } finally {
    if (transactionOpen) await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

test('failed discovery watermark claim rolls back its queued execution', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  let triggerInstalled = false;
  try {
    claimOwner(fixture);
    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 5, nowIso: NOW }));
    await pool.query(`
      CREATE FUNCTION reject_discovery_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.active_workflow_execution_id IS NULL AND NEW.active_workflow_execution_id IS NOT NULL THEN
          RAISE EXCEPTION 'forced_discovery_claim_failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_discovery_claim
        BEFORE UPDATE ON context_discovery_watermarks
        FOR EACH ROW EXECUTE FUNCTION reject_discovery_claim()
    `);
    triggerInstalled = true;
    assert.throws(
      () => fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW }),
      /forced_discovery_claim_failure/
    );
    assert.deepEqual(discoveryExecutionSummary(fixture), {
      execution_count: 0, active_count: 0, active_workflow_execution_id: null
    });

    await dropRejectTrigger(pool);
    triggerInstalled = false;
    const [retry] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW });
    assert.ok(retry);
    assert.deepEqual(discoveryExecutionSummary(fixture), {
      execution_count: 1, active_count: 1, active_workflow_execution_id: retry.id
    });
  } finally {
    if (triggerInstalled) await dropRejectTrigger(pool).catch(() => {});
    await pool.end();
    await fixture.close();
  }
});

function claimWorker(fixture) {
  return new Worker(CLAIM_WORKER, {
    eval: true,
    workerData: {
      databaseUrl: fixture.databaseUrl, userId: OWNER, nowIso: NOW,
      storeUrl: new URL('../src/store.js', import.meta.url).href,
      scopeUrl: new URL('../src/user-scope.js', import.meta.url).href
    }
  });
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      if (message.ok === false) reject(Object.assign(new Error(message.error?.message), message.error));
      else resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`discovery_claim_worker_exit:${code}`)); };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function discoveryExecutionSummary(fixture) {
  const execution = fixture.store.db.prepare(`
    SELECT count(*)::int AS execution_count,
      count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active_count
    FROM workflow_executions WHERE user_id = ? AND workflow_definition_id = 'goal.discovery'
  `).get(OWNER);
  const watermark = fixture.store.db.prepare(`
    SELECT active_workflow_execution_id FROM context_discovery_watermarks WHERE user_id = ?
  `).get(OWNER);
  return { ...execution, active_workflow_execution_id: watermark.active_workflow_execution_id };
}

function dropRejectTrigger(pool) {
  return pool.query(`
    DROP TRIGGER IF EXISTS reject_discovery_claim ON context_discovery_watermarks;
    DROP FUNCTION IF EXISTS reject_discovery_claim()
  `);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
