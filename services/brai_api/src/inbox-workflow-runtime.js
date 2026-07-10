import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
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
      applyNormalizedInboxForWorkflow({ ...input, store, nowDate: now() })),
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
        workflowIdReusePolicy: 'REJECT_DUPLICATE'
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

  return {
    taskQueue,
    start,
    async recoverQueued({ limit = 500 } = {}) {
      const queued = store.listQueuedInboxWorkflowStarts({ limit });
      for (const entry of queued) {
        const started = await start({ ownerUserId: entry.owner_user_id, inboxId: entry.inbox_id });
        void started.completion.catch((error) => logger.error?.('Recovered Inbox workflow failed', {
          error: error instanceof Error ? error.message : String(error),
          inboxId: entry.inbox_id
        }));
      }
      return queued.length;
    },
    async close() {
      worker.shutdown();
      await workerRun.catch(() => {});
      store.db.close();
      await clientConnection.close();
      await nativeConnection.close();
    }
  };
}
