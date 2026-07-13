import test from 'node:test';
import assert from 'node:assert/strict';
import { processActivityItem } from '../src/activity-normalization.js';
import { createQueuedInboxWorkflowReconciler } from '../src/inbox-workflow-runtime.js';
import { actionEvent, createFixture, request, waitFor } from '../test-support/api.js';

test('Activity normalization retries validation failures three times and requests review', async () => {
  const fixture = await createRawActivity('activity-needs-review');
  const validationErrors = [];

  try {
    const result = await processActivityItem({
      store: fixture.store,
      activityId: 'activity-needs-review',
      codexModel: 'test-model',
      normalizer: async ({ validationError }) => {
        validationErrors.push(validationError);
        return { title: '' };
      },
      nowDate: new Date('2026-07-12T20:00:01.000Z')
    });

    assert.deepEqual(result, { ok: false, reason: 'normalizer_validation_failed' });
    assert.equal(validationErrors.length, 3);
    assert.equal(validationErrors[0], '');
    assert.match(validationErrors[1], /invalid_normalizer_output|schema_validation_failed/);
    assert.match(validationErrors[2], /invalid_normalizer_output|schema_validation_failed/);

    const execution = fixture.store.getActivityWorkflowExecution('activity-needs-review');
    assert.equal(execution.status, 'needs_review');
    assert.equal(execution.attempt_count, 3);
    assert.equal(fixture.store.getActivityItem('activity-needs-review').item_roles_id, null);
    assert.equal(activityAiLogCount(fixture, 'activity-needs-review'), 3);
  } finally {
    await fixture.close();
  }
});

test('Activity normalization does not retry an operational model failure', async () => {
  const fixture = await createRawActivity('activity-model-failed');
  let calls = 0;

  try {
    const result = await processActivityItem({
      store: fixture.store,
      activityId: 'activity-model-failed',
      codexModel: 'test-model',
      normalizer: async () => {
        calls += 1;
        throw new Error('model unavailable');
      },
      nowDate: new Date('2026-07-12T20:00:01.000Z')
    });

    assert.deepEqual(result, { ok: false, reason: 'normalizer_failed' });
    assert.equal(calls, 1);
    const execution = fixture.store.getActivityWorkflowExecution('activity-model-failed');
    assert.equal(execution.status, 'failed');
    assert.equal(execution.attempt_count, 1);
    assert.equal(execution.last_error, 'model unavailable');
    assert.equal(activityAiLogCount(fixture, 'activity-model-failed'), 1);
  } finally {
    await fixture.close();
  }
});

test('Activity validation retry keeps the supported primary model when no fallback is configured', async () => {
  const fixture = await createRawActivity('activity-primary-model-retry');
  let calls = 0;

  try {
    const result = await processActivityItem({
      store: fixture.store,
      activityId: 'activity-primary-model-retry',
      codexModel: 'supported-primary-model',
      normalizer: async () => {
        calls += 1;
        if (calls === 1) return { title: '' };
        return {
          title: 'Повтор успешен',
          description: 'Вторая попытка прошла валидацию',
          reason: '',
          normalization: 'Проверена модель повторной попытки'
        };
      },
      nowDate: new Date('2026-07-12T20:00:01.000Z')
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    const models = fixture.store.db.prepare(`
      SELECT json_data
      FROM ai_logs
      WHERE agent_id = 'activity.normalizer' AND flow_id = ?
      ORDER BY attempt_number
    `).all('activity-primary-model-retry').map((row) => JSON.parse(row.json_data).usage.model);
    assert.deepEqual(models, ['supported-primary-model', 'supported-primary-model']);
  } finally {
    await fixture.close();
  }
});

test('Activity Temporal dispatch failure stays queued for recovery', async () => {
  const errors = [];
  const fixture = await createFixture(['2026-07-12T20:00:00.000Z'], {
    activityAutoProcess: true,
    activityWorkflowStarter: async () => {
      throw new Error('Temporal unavailable');
    },
    logger: { error: (...args) => errors.push(args) }
  });

  try {
    await syncCreate(fixture, 'activity-dispatch-retry');
    await waitFor(() => errors.some(([message]) => message === 'Activity workflow dispatch failed; queued for retry'));

    const execution = fixture.store.getActivityWorkflowExecution('activity-dispatch-retry');
    assert.equal(execution.status, 'queued');
    assert.equal(execution.last_error, null);
    assert.deepEqual(
      fixture.store.listQueuedActivityWorkflowStarts().map((row) => row.activity_id),
      ['activity-dispatch-retry']
    );
    const log = fixture.store.db.prepare(`
      SELECT status, reason, json_data
      FROM logs
      WHERE operation = 'activity.workflow_dispatch'
    `).get();
    assert.equal(log.status, 'failed');
    assert.equal(log.reason, 'Temporal unavailable');
    assert.equal(JSON.parse(log.json_data).retry_scheduled, true);
  } finally {
    await fixture.close();
  }
});

test('Activity completion observer failure remains running for durable reconciliation', async () => {
  const errors = [];
  let fixture;
  fixture = await createFixture(['2026-07-12T20:00:00.000Z'], {
    activityAutoProcess: true,
    activityWorkflowStarter: async ({ activityId }) => {
      const execution = fixture.store.getActivityWorkflowExecution(activityId);
      fixture.store.markActivityWorkflowStarted({
        activityId,
        workflowId: execution.workflow_id,
        runId: 'activity-running-run',
        nowIso: '2026-07-12T20:00:01.000Z'
      });
      return { completion: Promise.reject(new Error('observer disconnected')) };
    },
    logger: { error: (...args) => errors.push(args) }
  });

  try {
    await syncCreate(fixture, 'activity-running');
    await waitFor(() => errors.some(([message]) => message === 'Activity workflow completion observer failed; durable reconciliation remains active'));

    const execution = fixture.store.getActivityWorkflowExecution('activity-running');
    assert.equal(execution.status, 'running');
    assert.equal(execution.run_id, 'activity-running-run');
    assert.equal(execution.last_error, null);
    const log = fixture.store.db.prepare(`
      SELECT status, json_data
      FROM logs
      WHERE operation = 'activity.workflow_completion_observer'
    `).get();
    assert.equal(log.status, 'failed');
    assert.equal(JSON.parse(log.json_data).terminal_reconcile_pending, true);
  } finally {
    await fixture.close();
  }
});

test('Activity queued reconciler starts a durable queued workflow once', async () => {
  const fixture = await createRawActivity('activity-reconcile');
  const starts = [];
  const reconciler = createQueuedInboxWorkflowReconciler({
    store: fixture.store,
    startWorkflow: async () => ({ completion: Promise.resolve() }),
    startActivityWorkflow: async ({ ownerUserId, activityId }) => {
      starts.push({ ownerUserId, activityId });
      const execution = fixture.store.getActivityWorkflowExecution(activityId);
      fixture.store.markActivityWorkflowStarted({
        activityId,
        workflowId: execution.workflow_id,
        runId: 'recovered-activity-run',
        nowIso: '2026-07-12T20:00:02.000Z'
      });
      return { completion: Promise.resolve() };
    },
    now: () => new Date('2026-07-12T20:00:02.000Z')
  });

  try {
    assert.equal(await reconciler.run(), 1);
    assert.equal(await reconciler.run(), 0);
    assert.deepEqual(starts.map(({ activityId }) => activityId), ['activity-reconcile']);
    assert.equal(fixture.store.getActivityWorkflowExecution('activity-reconcile').status, 'running');
  } finally {
    await reconciler.close();
    await fixture.close();
  }
});

async function createRawActivity(activityId) {
  const fixture = await createFixture(['2026-07-12T20:00:00.000Z']);
  try {
    await syncCreate(fixture, activityId);
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

async function syncCreate(fixture, activityId) {
  const response = await request(fixture.url, '/v1/activities/events/sync', {
    method: 'POST',
    body: JSON.stringify({
      device: { device_id: `qa-${activityId}`, platform: 'web' },
      events: [actionEvent(
        `${activityId}-create`,
        1,
        'create',
        activityId,
        '2026-07-12T19:59:00.000Z',
        { title: 'Сырая Activity', description_md: 'Проверить надёжность workflow' }
      )]
    })
  });
  assert.equal(response.status, 200);
}

function activityAiLogCount(fixture, activityId) {
  return Number(fixture.store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM ai_logs
    WHERE agent_id = 'activity.normalizer' AND flow_id = ?
  `).get(activityId).count);
}
