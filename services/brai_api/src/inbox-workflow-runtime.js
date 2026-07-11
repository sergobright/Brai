import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import { IllegalStateError, NativeConnection, Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import {
  applyNormalizedInboxForWorkflow,
  describeInboxImagesForWorkflow,
  normalizeInboxRawForWorkflow,
  prepareInboxNormalization
} from './inbox.js';
import { BraiStore } from './store.js';
import { inboxWorkflowId } from './store-workflows.js';
import { withUserScope } from './user-scope.js';

const TERMINAL_TEMPORAL_STATUSES = new Set(['FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']);

export async function createInboxWorkflowRuntime({
  databaseUrl,
  storageRoot,
  codexBin,
  codexModel,
  codexFallbackModel,
  codexTimeoutMs,
  address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace = process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue = process.env.BRAI_TEMPORAL_INBOX_TASK_QUEUE ?? `brai-inbox-normalization-${process.env.PORT ?? '3020'}`,
  now = () => new Date(),
  logger = console
}) {
  const store = new BraiStore(databaseUrl);
  store.logger = logger;
  store.syncInboxWorkflowTaskQueue(taskQueue);
  const nativeConnection = await NativeConnection.connect({ address });
  const clientConnection = await Connection.connect({ address });
  const activities = {
    prepareInboxNormalization: (input) => withUserScope(input.ownerUserId, () =>
      prepareInboxNormalization({ ...input, store, storageRoot, nowDate: now() })),
    describeInboxImages: (input) => withUserScope(input.ownerUserId, () =>
      describeInboxImagesForWorkflow({
        ...input,
        store,
        storageRoot,
        codexBin,
        codexModel,
        codexTimeoutMs,
        nowDate: now()
      })),
    normalizeInboxRaw: (input) => withUserScope(input.ownerUserId, () =>
      normalizeInboxRawForWorkflow({
        ...input,
        store,
        codexBin,
        codexModel: input.attempt > 1 && codexFallbackModel ? codexFallbackModel : codexModel,
        codexTimeoutMs,
        nowDate: now()
      })),
    applyNormalizedInbox: (input) => withUserScope(input.ownerUserId, () =>
      applyNormalizedInboxForWorkflow({ ...input, store, deferTerminal: true, nowDate: now() })),
    failInboxNormalization: (input) => withUserScope(input.ownerUserId, () =>
      store.failInboxWorkflow({ ...input, nowIso: now().toISOString() }))
  };
  const worker = await Worker.create({
    activities,
    connection: nativeConnection,
    namespace,
    taskQueue,
    workflowsPath: fileURLToPath(new URL('./inbox-workflows.js', import.meta.url))
  });
  const workerRun = worker.run();
  workerRun.catch((error) => logger.error?.('Inbox Temporal worker stopped', error));
  const client = new Client({ connection: clientConnection, namespace });

  async function start({ ownerUserId, inboxId }) {
    const workflowId = inboxWorkflowId(inboxId);
    let handle;
    try {
      handle = await client.workflow.start('InboxNormalizationWorkflow', {
        args: [{ ownerUserId, inboxId }],
        taskQueue,
        workflowId,
        workflowIdConflictPolicy: 'USE_EXISTING',
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowExecutionTimeout: '2 minutes'
      });
    } catch (error) {
      if (error?.name !== 'WorkflowExecutionAlreadyStartedError') throw error;
      handle = client.workflow.getHandle(workflowId);
    }
    const runId = handle.firstExecutionRunId || (await handle.describe()).runId;
    await withUserScope(ownerUserId, () => store.markInboxWorkflowStarted({
      inboxId,
      workflowId,
      runId,
      nowIso: now().toISOString()
    }));
    return { workflowId, runId, completion: handle.result() };
  }

  async function observe({ workflowId, runId }) {
    const handle = client.workflow.getHandle(workflowId, runId ?? undefined, { followRuns: true });
    try {
      await handle.result();
      return { temporalStatus: 'COMPLETED' };
    } catch (error) {
      if (error instanceof WorkflowNotFoundError) return { temporalStatus: 'NOT_FOUND' };
      let description;
      try {
        description = await handle.describe();
      } catch (describeError) {
        if (describeError instanceof WorkflowNotFoundError) return { temporalStatus: 'NOT_FOUND' };
        throw describeError;
      }
      const temporalStatus = description.status.name;
      if (TERMINAL_TEMPORAL_STATUSES.has(temporalStatus)) return { temporalStatus };
      throw error;
    }
  }

  const reconciler = createQueuedInboxWorkflowReconciler({
    store,
    startWorkflow: start,
    observeWorkflow: observe,
    logger,
    now
  });
  let closePromise = null;

  return {
    taskQueue,
    start,
    recoverQueued: reconciler.run,
    startQueuedReconciler: reconciler.start,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        await reconciler.close();
        try {
          worker.shutdown();
        } catch (error) {
          if (!(error instanceof IllegalStateError)) throw error;
        }
        await workerRun.catch(() => {});
        store.db.close();
        await clientConnection.close();
        await nativeConnection.close();
      })();
      return closePromise;
    }
  };
}

export function createQueuedInboxWorkflowReconciler({
  store,
  startWorkflow,
  observeWorkflow = null,
  logger = console,
  now = () => new Date(),
  intervalMs = 500,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval
}) {
  let activeRun = null;
  let interval = null;
  let closing = false;
  const observers = new Map();

  function run({ limit = 500 } = {}) {
    if (closing) return Promise.resolve(0);
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const queued = store.listQueuedInboxWorkflowStarts({ limit });
      let startedCount = 0;
      for (const entry of queued) {
        if (closing) break;
        try {
          const started = await startWorkflow({ ownerUserId: entry.owner_user_id, inboxId: entry.inbox_id });
          startedCount += 1;
          void started.completion.catch((error) => logger.error?.('Recovered Inbox workflow completion observer failed', {
            error: error instanceof Error ? error.message : String(error),
            inboxId: entry.inbox_id
          }));
        } catch (error) {
          logger.error?.('Queued Inbox workflow dispatch failed', {
            error: error instanceof Error ? error.message : String(error),
            inboxId: entry.inbox_id
          });
        }
      }

      if (observeWorkflow) {
        const running = store.listRunningInboxWorkflowExecutions({ limit });
        for (const entry of running) {
          if (closing) break;
          const key = `${entry.workflow_id}\0${entry.run_id ?? ''}`;
          if (observers.has(key)) continue;
          const observer = Promise.resolve()
            .then(() => observeWorkflow({ workflowId: entry.workflow_id, runId: entry.run_id }))
            .then(({ temporalStatus }) => {
              if (closing) return;
              withUserScope(entry.owner_user_id, () => store.reconcileInboxWorkflowTerminal({
                inboxId: entry.inbox_id,
                workflowId: entry.workflow_id,
                runId: entry.run_id,
                temporalStatus,
                nowIso: now().toISOString()
              }));
            })
            .catch((error) => logger.error?.('Running Inbox workflow observation failed', {
              error: error instanceof Error ? error.message : String(error),
              inboxId: entry.inbox_id
            }))
            .finally(() => observers.delete(key));
          observers.set(key, observer);
        }
      }
      return startedCount;
    })().finally(() => {
      activeRun = null;
    });
    return activeRun;
  }

  return {
    run,
    start() {
      if (closing || interval) return;
      interval = scheduleInterval(() => {
        void run().catch((error) => logger.error?.('Inbox queued workflow reconciliation failed', {
          error: error instanceof Error ? error.message : String(error)
        }));
      }, intervalMs);
      interval.unref?.();
    },
    async close() {
      closing = true;
      if (interval) clearScheduledInterval(interval);
      interval = null;
      await activeRun?.catch(() => {});
      observers.clear();
    }
  };
}
