import test from 'node:test';
import assert from 'node:assert/strict';
import { BraiStore } from '../src/store.js';
import { main, runDueSchedules } from '../src/scheduler-runner.js';
import { createTestDatabase } from '../test-support/api.js';

const AGENT_ID = 'test.scheduled.agent';

test('scheduler claims due recurring schedule and advances it', async () => {
  const fixture = await createStore();
  const now = new Date();
  let calls = 0;
  try {
    fixture.store.db.prepare(`
      UPDATE agent_schedules
      SET next_run_at_utc = ?, locked_until_utc = NULL, last_started_at_utc = NULL, last_finished_at_utc = NULL, last_error = ''
      WHERE id = ?
    `).run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), AGENT_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: now,
      config: { agentTimeoutMs: 1000 },
      logger: quietLogger(),
      agents: new Map([[AGENT_ID, async () => {
        calls += 1;
        return { ok: true };
      }]])
    });

    assert.equal(calls, 1);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    const row = scheduleRow(fixture.store);
    assert.equal(row.locked_until_utc, null);
    assert.equal(row.last_started_at_utc, now.toISOString());
    assert.equal(row.last_error, '');
    assert.ok(Date.parse(row.next_run_at_utc) > Date.parse(now.toISOString()));
    const aiLogs = fixture.store.db.prepare('SELECT * FROM ai_logs').all();
    assert.equal(aiLogs.length, 1);
    assert.equal(aiLogs[0].agent_id, AGENT_ID);
    assert.equal(aiLogs[0].agent_version, '1');
    assert.equal(aiLogs[0].status, 'done');
    const aiLogData = JSON.parse(aiLogs[0].json_data);
    assert.equal(aiLogData.inputs.some((input) => input.ref === 'path'), false);
    assert.equal(aiLogData.outputs.some((output) => output.ref === 'agent_schedules.status'), true);
    const runtimeLog = fixture.store.db.prepare("SELECT status, json_data FROM logs WHERE operation = 'scheduler.run_due_schedules'").get();
    assert.equal(runtimeLog.status, 'done');
    assert.deepEqual(JSON.parse(runtimeLog.json_data), {
      due_schedules: 1,
      claimed_schedules: 1,
      completed_schedules: 1,
      skipped_schedules: 0,
      failed_schedules: 0,
      purged_logs: 0,
      retention_purge_failed: false
    });
  } finally {
    await fixture.close();
  }
});

test('scheduler skips locked schedule', async () => {
  const fixture = await createStore();
  try {
    fixture.store.db.prepare(`
      UPDATE agent_schedules
      SET next_run_at_utc = ?, locked_until_utc = ?, last_started_at_utc = NULL
      WHERE id = ?
    `).run('2026-07-01T06:00:00.000Z', '2026-07-01T13:00:00.000Z', AGENT_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: new Date('2026-07-01T12:00:00.000Z'),
      config: { agentTimeoutMs: 1000 },
      logger: quietLogger(),
      agents: new Map([[AGENT_ID, async () => {
        throw new Error('should not run');
      }]])
    });

    assert.equal(results.length, 0);
    assert.equal(scheduleRow(fixture.store).last_started_at_utc, null);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM ai_logs').get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('scheduler records failure and still advances recurring schedule', async () => {
  const fixture = await createStore();
  const now = new Date();
  try {
    fixture.store.db.prepare(`
      UPDATE agent_schedules
      SET next_run_at_utc = ?, locked_until_utc = NULL, last_error = ''
      WHERE id = ?
    `).run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), AGENT_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: now,
      config: { agentTimeoutMs: 1000 },
      logger: quietLogger(),
      agents: new Map([[AGENT_ID, async () => {
        throw new Error('boom');
      }]])
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    const row = scheduleRow(fixture.store);
    assert.equal(row.locked_until_utc, null);
    assert.equal(row.last_error, 'boom');
    assert.ok(Date.parse(row.next_run_at_utc) > Date.parse(now.toISOString()));
    const aiLog = fixture.store.db.prepare('SELECT status, json_data FROM ai_logs').get();
    assert.equal(aiLog.status, 'failed');
    assert.equal(JSON.parse(aiLog.json_data).metadata.error, 'boom');
    const runtimeLog = fixture.store.db.prepare("SELECT status, json_data FROM logs WHERE operation = 'scheduler.run_due_schedules'").get();
    assert.equal(runtimeLog.status, 'failed');
    assert.equal(JSON.parse(runtimeLog.json_data).failed_schedules, 1);
  } finally {
    await fixture.close();
  }
});

test('scheduler continues due schedules when optional logs work fails', async () => {
  const fixture = await createStore();
  const now = new Date();
  let calls = 0;
  const originalPurge = fixture.store.purgeExpiredLogs.bind(fixture.store);
  const originalRecordLog = fixture.store.recordLog.bind(fixture.store);
  fixture.store.purgeExpiredLogs = () => {
    throw new Error('retention offline');
  };
  fixture.store.recordLog = (input) => {
    if (input?.source === 'ai') throw new Error('runtime log offline');
    return originalRecordLog(input);
  };
  try {
    fixture.store.db.prepare(`
      UPDATE agent_schedules
      SET next_run_at_utc = ?, locked_until_utc = NULL, last_error = ''
      WHERE id = ?
    `).run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), AGENT_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: now,
      config: { agentTimeoutMs: 1000 },
      logger: quietLogger(),
      agents: new Map([[AGENT_ID, async () => {
        calls += 1;
        return { ok: true };
      }]])
    });

    assert.equal(calls, 1);
    assert.equal(results[0].ok, true);
    assert.equal(scheduleRow(fixture.store).last_error, '');
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM ai_logs').get().count, 1);
    const runtimeLog = fixture.store.db.prepare("SELECT status, reason, json_data FROM logs WHERE operation = 'scheduler.run_due_schedules'").get();
    assert.equal(runtimeLog.status, 'failed');
    assert.equal(runtimeLog.reason, 'retention_purge_failed');
    assert.equal(JSON.parse(runtimeLog.json_data).retention_purge_failed, true);
  } finally {
    fixture.store.purgeExpiredLogs = originalPurge;
    fixture.store.recordLog = originalRecordLog;
    await fixture.close();
  }
});

test('scheduler logs retention-only purge summary', async () => {
  const fixture = await createStore();
  try {
    fixture.store.recordLog({
      dt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      operation: 'expired.scheduler.log',
      status: 'done',
      expiresAtUtc: '2026-01-02T00:00:00.000Z'
    });

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: new Date('2026-07-01T12:00:00.000Z'),
      config: { agentTimeoutMs: 1000 },
      logger: quietLogger(),
      agents: new Map([[AGENT_ID, async () => {
        throw new Error('should not run');
      }]])
    });

    assert.equal(results.length, 0);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM logs WHERE operation = 'logs.retention_purge'").get().count, 1);
    const runtimeLog = fixture.store.db.prepare("SELECT status, json_data FROM logs WHERE operation = 'scheduler.run_due_schedules'").get();
    assert.equal(runtimeLog.status, 'done');
    assert.equal(JSON.parse(runtimeLog.json_data).purged_logs, 1);
  } finally {
    await fixture.close();
  }
});

test('postgres-only scheduler config refuses missing database URL', async () => {
  await assert.rejects(
    () => main({}),
    /BRAI_DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ URL/
  );
});

async function createStore() {
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  const now = new Date().toISOString();
  store.db.prepare(`
    INSERT INTO agents (
      id, version, target, kind, status, title, summary, trigger_description,
      conditions_description, input_description, output_description,
      interactions_description, side_effects_description, llm_provider,
      llm_model, llm_prompt_template, llm_timeout_ms, fallback_description,
      source_module, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    AGENT_ID,
    '1',
    'test',
    'test_scheduled_agent',
    'active',
    'Test scheduled agent',
    'Test scheduled agent.',
    'Test trigger.',
    'Test conditions.',
    'Test input.',
    'Test output.',
    'Test interactions.',
    'Test side effects.',
    '',
    '',
    '',
    1000,
    '',
    'services/brai_api/test/scheduler-runner.test.js',
    now
  );
  store.db.prepare(`
    INSERT INTO agent_schedules (
      id, agent_id, status, next_run_at_utc, interval_seconds,
      locked_until_utc, last_started_at_utc, last_finished_at_utc,
      last_error, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', ?)
  `).run(AGENT_ID, AGENT_ID, 'active', null, 21600, now);
  return {
    store,
    async close() {
      store.close();
      await database.drop();
    }
  };
}

function scheduleRow(store) {
  return store.db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(AGENT_ID);
}

function quietLogger() {
  return { log: () => {}, error: () => {} };
}
