import { parentPort, workerData } from 'node:worker_threads';
import { BraiStore } from '../src/store.js';
import { withUserScope } from '../src/user-scope.js';

const store = new BraiStore(workerData.databaseUrl);
if (workerData.mode === 'resolve') {
  const lockRelationMutationDomain = store.lockRelationMutationDomain;
  let transactionReported = false;
  store.lockRelationMutationDomain = function reportTransaction(...args) {
    if (!transactionReported) {
      transactionReported = true;
      parentPort.postMessage({
        type: 'transaction', pid: this.db.prepare('SELECT pg_backend_pid() AS pid').get().pid
      });
    }
    return lockRelationMutationDomain.apply(this, args);
  };
}

parentPort.postMessage({ type: 'ready' });
parentPort.once('message', (message) => {
  if (message !== 'start') throw new Error('unexpected_worker_message');
  try {
    const outcome = withUserScope(workerData.userId, () => workerData.mode === 'hold_relation'
      ? holdRelation()
      : store.resolveContextDecision(workerData.input));
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

function holdRelation() {
  const gate = new Int32Array(workerData.gate);
  return store.db.transaction(() => {
    const outcome = store.createRelation(workerData.input);
    parentPort.postMessage({
      type: 'holding', pid: store.db.prepare('SELECT pg_backend_pid() AS pid').get().pid
    });
    if (Atomics.wait(gate, 0, 0, 5_000) === 'timed-out') throw new Error('relation_hold_timeout');
    return outcome;
  })();
}
