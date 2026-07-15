import { parentPort, workerData } from 'node:worker_threads';
import { BraiStore } from '../src/store.js';
import { withUserScope } from '../src/user-scope.js';

const store = new BraiStore(workerData.databaseUrl);
const lockRelationMutationDomain = store.lockRelationMutationDomain;
let transactionReported = false;
store.lockRelationMutationDomain = function reportTransaction(...args) {
  if (!transactionReported && this.db.currentTxId) {
    transactionReported = true;
    parentPort.postMessage({
      type: 'transaction', pid: this.db.prepare('SELECT pg_backend_pid() AS pid').get().pid
    });
  }
  return lockRelationMutationDomain.apply(this, args);
};
parentPort.postMessage({ type: 'ready' });
parentPort.once('message', (message) => {
  if (message !== 'sync') throw new Error('unexpected_worker_message');
  try {
    const outcome = withUserScope(workerData.userId, () => store.syncActivityEvents(workerData.input));
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
