import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInboxRawForWorkflow } from '../src/inbox.js';
import { createQueuedInboxWorkflowReconciler } from '../src/inbox-workflow-runtime.js';
import { createFixture, inboxEvent, request, waitFor } from '../test-support/api.js';

test('initial Temporal dispatch failure stays queued for the reconciler', async () => {
  const errors = [];
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z'], {
    inboxAutoProcess: true,
    inboxWorkflowStarter: async () => {
      throw new Error('Temporal unavailable');
    },
    logger: { error: (...args) => errors.push(args) }
  });
  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'dispatch-device', platform: 'web' },
        events: [inboxEvent(
          'dispatch-create',
          1,
          'create',
          'dispatch-inbox',
          '2026-07-10T11:59:00.000Z',
          { title: 'Retry Temporal dispatch' }
        )]
      })
    });

    assert.equal(response.status, 200);
    await waitFor(() => errors.some(([message]) => message === 'Inbox workflow dispatch failed; queued for retry'));
    const execution = fixture.store.getInboxWorkflowExecution('dispatch-inbox');
    assert.equal(execution.status, 'queued');
    assert.equal(execution.last_error, null);
    assert.deepEqual(
      fixture.store.listQueuedInboxWorkflowStarts().map((row) => row.inbox_id),
      ['dispatch-inbox']
    );
    const log = fixture.store.db.prepare(`
      SELECT status, reason, json_data
      FROM logs
      WHERE operation = 'inbox.workflow_dispatch'
    `).get();
    assert.equal(log.status, 'failed');
    assert.equal(log.reason, 'Temporal unavailable');
    assert.deepEqual(JSON.parse(log.json_data), {
      inbox_id: 'dispatch-inbox',
      workflow_id: 'brai:inbox:dispatch-inbox',
      workflow_status: 'queued',
      retry_scheduled: true
    });
  } finally {
    await fixture.close();
  }
});

test('a generic completion observer failure is left running for durable Temporal reconciliation', async () => {
  const errors = [];
  let fixture;
  fixture = await createFixture(['2026-07-10T12:00:00.000Z'], {
    inboxAutoProcess: true,
    inboxWorkflowStarter: async ({ inboxId }) => {
      const execution = fixture.store.getInboxWorkflowExecution(inboxId);
      fixture.store.markInboxWorkflowStarted({
        inboxId,
        workflowId: execution.workflow_id,
        runId: 'running-dispatch-run',
        nowIso: '2026-07-10T12:00:01.000Z'
      });
      return { completion: Promise.reject(new Error('Workflow activity failed')) };
    },
    logger: { error: (...args) => errors.push(args) }
  });
  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'running-device', platform: 'web' },
        events: [inboxEvent(
          'running-create',
          1,
          'create',
          'running-inbox',
          '2026-07-10T11:59:00.000Z',
          { title: 'Fail after start' }
        )]
      })
    });

    assert.equal(response.status, 200);
    await waitFor(() => errors.some(([message]) => message === 'Inbox workflow completion observer failed; durable reconciliation remains active'));
    const execution = fixture.store.getInboxWorkflowExecution('running-inbox');
    assert.equal(execution.run_id, 'running-dispatch-run');
    assert.equal(execution.status, 'running');
    assert.equal(execution.last_error, null);
    assert.equal(errors.some(([message]) => message === 'Inbox workflow dispatch failed; queued for retry'), false);
    const log = fixture.store.db.prepare(`
      SELECT operation, status, json_data
      FROM logs
      WHERE operation = 'inbox.workflow_completion_observer'
    `).get();
    assert.equal(log.status, 'failed');
    assert.equal(JSON.parse(log.json_data).terminal_reconcile_pending, true);
  } finally {
    await fixture.close();
  }
});

test('committed Inbox ingest survives a technical log failure', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  const errors = [];
  try {
    const recordLog = fixture.store.recordLog.bind(fixture.store);
    fixture.store.logger = { error: (...args) => errors.push(args) };
    fixture.store.recordLog = (input) => {
      if (input.operation === 'inbox.events_sync') throw new Error('logs sequence collision');
      return recordLog(input);
    };

    const result = fixture.store.syncInboxEvents({
      device: { device_id: 'reliability-device', platform: 'web' },
      events: [inboxEvent(
        'reliability-create',
        1,
        'create',
        'reliability-inbox',
        '2026-07-10T11:59:00.000Z',
        { title: 'Persist despite log failure' }
      )],
      nowIso: '2026-07-10T12:00:00.000Z'
    });

    assert.deepEqual(result.acknowledged_event_ids, ['reliability-create']);
    assert.equal(fixture.store.getInboxItem('reliability-inbox').title, 'Persist despite log failure');
    assert.deepEqual(fixture.store.listQueuedInboxWorkflowStarts().map((row) => row.inbox_id), ['reliability-inbox']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].operation, 'inbox.events_sync');
  } finally {
    await fixture.close();
  }
});

test('successful normalization is not rolled back when its technical log fails', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  const errors = [];
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'apply-device', platform: 'web' },
      events: [inboxEvent('apply-create', 1, 'create', 'apply-inbox', '2026-07-10T11:59:00.000Z', { title: 'Raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    const execution = fixture.store.getInboxWorkflowExecution('apply-inbox');
    fixture.store.markInboxWorkflowStarted({
      inboxId: 'apply-inbox',
      workflowId: execution.workflow_id,
      runId: 'apply-run',
      nowIso: '2026-07-10T12:00:01.000Z'
    });

    const recordLog = fixture.store.recordLog.bind(fixture.store);
    fixture.store.logger = { error: (...args) => errors.push(args) };
    fixture.store.recordLog = (input) => {
      if (input.operation === 'inbox.apply_normalized_raw') throw new Error('logs unavailable');
      return recordLog(input);
    };
    const result = fixture.store.applyNormalizedInbox({
      inboxId: 'apply-inbox',
      workflowId: execution.workflow_id,
      runId: 'apply-run',
      normalized: {
        title: 'Normalized',
        description: 'Normalized description',
        classKey: 'note',
        classTitle: '',
        classDescription: ''
      },
      normalizationText: 'Normalized safely',
      deferTerminal: true,
      nowIso: '2026-07-10T12:00:02.000Z'
    });

    assert.equal(result.ok, true);
    assert.equal(result.idempotent, false);
    assert.equal(fixture.store.getInboxItem('apply-inbox').title, 'Normalized');
    assert.equal(fixture.store.getInboxWorkflowExecution('apply-inbox').status, 'running');
    assert.deepEqual(fixture.store.listQueuedInboxWorkflowStarts(), []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].operation, 'inbox.apply_normalized_raw');

    assert.deepEqual(fixture.store.reconcileInboxWorkflowTerminal({
      inboxId: 'apply-inbox',
      workflowId: execution.workflow_id,
      runId: 'apply-run',
      temporalStatus: 'COMPLETED',
      nowIso: '2026-07-10T12:00:03.000Z'
    }), { changed: true, status: 'completed' });
    assert.equal(fixture.store.getInboxWorkflowExecution('apply-inbox').status, 'completed');
  } finally {
    await fixture.close();
  }
});

test('terminal workflow failure survives its technical log failure and is not redispatched', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  const errors = [];
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'failure-device', platform: 'web' },
      events: [inboxEvent('failure-create', 1, 'create', 'failure-inbox', '2026-07-10T11:59:00.000Z', { title: 'Raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    const execution = fixture.store.getInboxWorkflowExecution('failure-inbox');
    const recordLog = fixture.store.recordLog.bind(fixture.store);
    fixture.store.logger = { error: (...args) => errors.push(args) };
    fixture.store.recordLog = (input) => {
      if (input.operation === 'inbox.raw_normalization') throw new Error('logs unavailable');
      return recordLog(input);
    };

    fixture.store.failInboxWorkflow({
      inboxId: 'failure-inbox',
      workflowId: execution.workflow_id,
      runId: 'failure-run',
      reason: 'provider_timeout',
      nowIso: '2026-07-10T12:00:01.000Z'
    });

    assert.equal(fixture.store.getInboxWorkflowExecution('failure-inbox').status, 'failed');
    assert.deepEqual(fixture.store.listQueuedInboxWorkflowStarts(), []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0][1].operation, 'inbox.raw_normalization');
  } finally {
    await fixture.close();
  }
});

test('queued reconciler polls every 500 ms and starts a persisted workflow', async () => {
  let intervalCallback = null;
  let intervalDelay = null;
  let cleared = false;
  let unreferenced = false;
  const starts = [];
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => [{ owner_user_id: 'owner-1', inbox_id: 'lost-callback' }]
    },
    startWorkflow: async (input) => {
      starts.push(input);
      return { completion: Promise.resolve() };
    },
    scheduleInterval: (callback, delay) => {
      intervalCallback = callback;
      intervalDelay = delay;
      return { unref: () => { unreferenced = true; } };
    },
    clearScheduledInterval: () => { cleared = true; }
  });

  reconciler.start();
  assert.equal(intervalDelay, 500);
  assert.equal(unreferenced, true);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [{ ownerUserId: 'owner-1', inboxId: 'lost-callback' }]);

  await reconciler.close();
  assert.equal(cleared, true);
});

test('queued reconciliation does not overlap and close waits for the active pass', async () => {
  let listCalls = 0;
  let startCalls = 0;
  let releaseStart;
  let reportStarted;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const started = new Promise((resolve) => { reportStarted = resolve; });
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => {
        listCalls += 1;
        return [{ owner_user_id: 'owner-1', inbox_id: 'same-inbox' }];
      }
    },
    startWorkflow: async () => {
      startCalls += 1;
      reportStarted();
      await startGate;
      return { completion: Promise.resolve() };
    }
  });

  const first = reconciler.run();
  await started;
  const second = reconciler.run();
  assert.equal(listCalls, 1);
  assert.equal(startCalls, 1);

  let closed = false;
  const close = reconciler.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseStart();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  await close;
  assert.equal(closed, true);
  assert.equal(await reconciler.run(), 0);
  assert.equal(listCalls, 1);
});

test('one failed queued dispatch does not block later queued workflows', async () => {
  const starts = [];
  const errors = [];
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => [
        { owner_user_id: 'owner-1', inbox_id: 'broken' },
        { owner_user_id: 'owner-1', inbox_id: 'healthy' }
      ]
    },
    startWorkflow: async ({ inboxId }) => {
      starts.push(inboxId);
      if (inboxId === 'broken') throw new Error('Temporal unavailable for this start');
      return { completion: Promise.resolve() };
    },
    logger: { error: (...args) => errors.push(args) }
  });

  assert.equal(await reconciler.run(), 1);
  assert.deepEqual(starts, ['broken', 'healthy']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].inboxId, 'broken');
  await reconciler.close();
});

test('a completion observer transport failure does not falsely terminalize a running workflow', async () => {
  const errors = [];
  const failed = [];
  const execution = {
    status: 'running',
    workflow_id: 'brai:inbox:recovered-failure',
    run_id: 'recovered-run',
    current_step: 'prepare_raw'
  };
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => [
        { owner_user_id: 'owner-1', inbox_id: 'recovered-failure' }
      ],
      getInboxWorkflowExecution: () => execution,
      failInboxWorkflow: (input) => {
        failed.push(input);
        execution.status = 'failed';
      }
    },
    startWorkflow: async () => ({ completion: Promise.reject(new Error('Unexpected workflow crash')) }),
    now: () => new Date('2026-07-10T12:00:02.000Z'),
    logger: { error: (...args) => errors.push(args) }
  });

  assert.equal(await reconciler.run(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failed, []);
  assert.equal(execution.status, 'running');
  assert.equal(errors.some(([message]) => message === 'Recovered Inbox workflow completion observer failed'), true);
  await reconciler.close();
});

test('a running workflow is re-observed after restart and terminalized exactly once', async () => {
  let releaseObservation;
  const observation = new Promise((resolve) => { releaseObservation = resolve; });
  let observeCalls = 0;
  const reconciled = [];
  const running = [{
    owner_user_id: 'owner-1',
    inbox_id: 'restart-running',
    workflow_id: 'brai:inbox:restart-running',
    run_id: 'restart-run',
    current_step: 'raw_normalizer'
  }];
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => [],
      listRunningInboxWorkflowExecutions: () => running,
      reconcileInboxWorkflowTerminal: (input) => {
        reconciled.push(input);
        running.length = 0;
      }
    },
    startWorkflow: async () => assert.fail('queued start was not expected'),
    observeWorkflow: async (input) => {
      observeCalls += 1;
      assert.deepEqual(input, {
        workflowId: 'brai:inbox:restart-running',
        runId: 'restart-run'
      });
      return observation;
    },
    now: () => new Date('2026-07-10T12:00:03.000Z')
  });

  assert.equal(await reconciler.run(), 0);
  assert.equal(await reconciler.run(), 0);
  assert.equal(observeCalls, 1);
  releaseObservation({ temporalStatus: 'FAILED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reconciled, [{
    inboxId: 'restart-running',
    workflowId: 'brai:inbox:restart-running',
    runId: 'restart-run',
    temporalStatus: 'FAILED',
    nowIso: '2026-07-10T12:00:03.000Z'
  }]);
  await reconciler.close();
});

test('a failed terminal persistence is retried on the next reconciliation tick', async () => {
  let attempts = 0;
  const errors = [];
  const entry = {
    owner_user_id: 'owner-1',
    inbox_id: 'retry-terminal',
    workflow_id: 'brai:inbox:retry-terminal',
    run_id: 'retry-run',
    current_step: 'apply_normalized_raw'
  };
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: {
      listQueuedInboxWorkflowStarts: () => [],
      listRunningInboxWorkflowExecutions: () => attempts < 2 ? [entry] : [],
      reconcileInboxWorkflowTerminal: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database unavailable');
      }
    },
    startWorkflow: async () => assert.fail('queued start was not expected'),
    observeWorkflow: async () => ({ temporalStatus: 'COMPLETED' }),
    logger: { error: (...args) => errors.push(args) }
  });

  await reconciler.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  await reconciler.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(errors.some(([message]) => message === 'Running Inbox workflow observation failed'), true);
  await reconciler.close();
});

test('a pinned v1 execution completes with its own stored schema', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'v1-device', platform: 'web' },
      events: [inboxEvent('v1-create', 1, 'create', 'v1-inbox', '2026-07-10T11:59:00.000Z', { title: 'Legacy raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    fixture.store.db.prepare(`
      UPDATE workflow_executions
      SET workflow_definition_version = 1
      WHERE raw_record_id = 'v1-inbox'
    `).run();
    const execution = fixture.store.getInboxWorkflowExecution('v1-inbox');
    fixture.store.markInboxWorkflowStarted({
      inboxId: 'v1-inbox',
      workflowId: execution.workflow_id,
      runId: 'v1-run',
      nowIso: '2026-07-10T12:00:01.000Z'
    });
    const normalized = await normalizeInboxRawForWorkflow({
      store: fixture.store,
      inboxId: 'v1-inbox',
      workflowId: execution.workflow_id,
      runId: 'v1-run',
      attempt: 1,
      normalizer: async () => ({
        title: 'Legacy normalized',
        description: 'Processed under the pinned v1 schema.',
        class_key: 'note',
        normalization: 'v1 schema stayed pinned'
      }),
      nowDate: new Date('2026-07-10T12:00:02.000Z')
    });
    assert.equal(normalized.ok, true);
    fixture.store.applyNormalizedInbox({
      inboxId: 'v1-inbox',
      workflowId: execution.workflow_id,
      runId: 'v1-run',
      normalized: normalized.normalized,
      normalizationText: normalized.normalized.normalization,
      deferTerminal: true,
      nowIso: '2026-07-10T12:00:03.000Z'
    });
    const applied = fixture.store.getInboxWorkflowExecution('v1-inbox');
    assert.equal(applied.workflow_definition_version, 1);
    assert.equal(applied.status, 'running');
    assert.deepEqual(fixture.store.reconcileInboxWorkflowTerminal({
      inboxId: 'v1-inbox',
      workflowId: execution.workflow_id,
      runId: 'v1-run',
      temporalStatus: 'COMPLETED',
      nowIso: '2026-07-10T12:00:04.000Z'
    }), { changed: true, status: 'completed' });
    assert.equal(fixture.store.getInboxWorkflowExecution('v1-inbox').status, 'completed');
  } finally {
    await fixture.close();
  }
});

test('late apply cannot revive a terminal failed execution', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'late-device', platform: 'web' },
      events: [inboxEvent('late-create', 1, 'create', 'late-inbox', '2026-07-10T11:59:00.000Z', { title: 'Late raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    const execution = fixture.store.getInboxWorkflowExecution('late-inbox');
    fixture.store.markInboxWorkflowStarted({
      inboxId: 'late-inbox',
      workflowId: execution.workflow_id,
      runId: 'late-run',
      nowIso: '2026-07-10T12:00:01.000Z'
    });
    fixture.store.failInboxWorkflow({
      inboxId: 'late-inbox',
      workflowId: execution.workflow_id,
      runId: 'late-run',
      reason: 'temporal_timed_out',
      nowIso: '2026-07-10T12:00:02.000Z'
    });

    let lateNormalizerCalls = 0;
    const lateNormalization = await normalizeInboxRawForWorkflow({
      store: fixture.store,
      inboxId: 'late-inbox',
      workflowId: execution.workflow_id,
      runId: 'late-run',
      attempt: 1,
      normalizer: async () => {
        lateNormalizerCalls += 1;
        return {};
      },
      nowDate: new Date('2026-07-10T12:00:03.000Z')
    });
    assert.deepEqual(lateNormalization, {
      ok: false,
      validationFailed: false,
      error: 'workflow_not_active'
    });
    assert.equal(lateNormalizerCalls, 0);

    assert.throws(() => fixture.store.applyNormalizedInbox({
      inboxId: 'late-inbox',
      workflowId: execution.workflow_id,
      runId: 'late-run',
      normalized: {
        title: 'Too late',
        description: 'Must not be written.',
        classKey: 'note',
        classTitle: '',
        classDescription: ''
      },
      normalizationText: 'late',
      nowIso: '2026-07-10T12:00:03.000Z'
    }), /workflow_execution_not_running/);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*)::int AS count FROM items WHERE id = 'late-inbox'").get().count, 0);
    assert.equal(fixture.store.getInboxWorkflowExecution('late-inbox').status, 'failed');
  } finally {
    await fixture.close();
  }
});

test('Temporal terminal reconciliation requires matching persisted domain success', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'terminal-device', platform: 'web' },
      events: [inboxEvent('terminal-create', 1, 'create', 'terminal-inbox', '2026-07-10T11:59:00.000Z', { title: 'Terminal raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    const execution = fixture.store.getInboxWorkflowExecution('terminal-inbox');
    fixture.store.markInboxWorkflowStarted({
      inboxId: 'terminal-inbox',
      workflowId: execution.workflow_id,
      runId: 'terminal-run',
      nowIso: '2026-07-10T12:00:01.000Z'
    });

    assert.deepEqual(fixture.store.reconcileInboxWorkflowTerminal({
      inboxId: 'terminal-inbox',
      workflowId: execution.workflow_id,
      runId: 'terminal-run',
      temporalStatus: 'COMPLETED',
      nowIso: '2026-07-10T12:00:02.000Z'
    }), { changed: true, status: 'failed' });
    const terminal = fixture.store.getInboxWorkflowExecution('terminal-inbox');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.last_error, 'temporal_completed_without_domain_result');
    assert.deepEqual(fixture.store.reconcileInboxWorkflowTerminal({
      inboxId: 'terminal-inbox',
      workflowId: execution.workflow_id,
      runId: 'terminal-run',
      temporalStatus: 'FAILED',
      nowIso: '2026-07-10T12:00:03.000Z'
    }), { changed: false, status: null });
  } finally {
    await fixture.close();
  }
});

test('Temporal timeout after domain apply remains an explicit workflow failure', async () => {
  const fixture = await createFixture(['2026-07-10T12:00:00.000Z']);
  try {
    fixture.store.syncInboxEvents({
      device: { device_id: 'timeout-device', platform: 'web' },
      events: [inboxEvent('timeout-create', 1, 'create', 'timeout-inbox', '2026-07-10T11:59:00.000Z', { title: 'Timeout raw' })],
      nowIso: '2026-07-10T12:00:00.000Z'
    });
    const execution = fixture.store.getInboxWorkflowExecution('timeout-inbox');
    fixture.store.markInboxWorkflowStarted({
      inboxId: 'timeout-inbox',
      workflowId: execution.workflow_id,
      runId: 'timeout-run',
      nowIso: '2026-07-10T12:00:01.000Z'
    });
    fixture.store.applyNormalizedInbox({
      inboxId: 'timeout-inbox',
      workflowId: execution.workflow_id,
      runId: 'timeout-run',
      normalized: {
        title: 'Domain applied',
        description: 'The domain transaction committed before Temporal closed.',
        classKey: 'note',
        classTitle: '',
        classDescription: ''
      },
      normalizationText: 'domain committed',
      deferTerminal: true,
      nowIso: '2026-07-10T12:00:02.000Z'
    });
    assert.equal(fixture.store.getInboxWorkflowExecution('timeout-inbox').status, 'running');

    assert.deepEqual(fixture.store.reconcileInboxWorkflowTerminal({
      inboxId: 'timeout-inbox',
      workflowId: execution.workflow_id,
      runId: 'timeout-run',
      temporalStatus: 'TIMED_OUT',
      nowIso: '2026-07-10T12:00:03.000Z'
    }), { changed: true, status: 'failed' });
    const terminal = fixture.store.getInboxWorkflowExecution('timeout-inbox');
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.last_error, 'temporal_timed_out');
    assert.equal(fixture.store.getInboxItem('timeout-inbox').is_normalized, true);
  } finally {
    await fixture.close();
  }
});
