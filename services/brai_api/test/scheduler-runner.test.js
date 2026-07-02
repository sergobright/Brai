import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BraiStore } from '../src/store.js';
import { cleanTasksMdCandidate, runDueSchedules } from '../src/scheduler-runner.js';

const HANDLER_ID = 'maintenance.tasks_md_deduper';

test('scheduler claims due recurring schedule and advances it', async () => {
  const fixture = createStore();
  const now = new Date();
  let calls = 0;
  try {
    fixture.store.db.prepare(`
      UPDATE handler_schedules
      SET next_run_at_utc = ?, locked_until_utc = NULL, last_started_at_utc = NULL, last_finished_at_utc = NULL, last_error = ''
      WHERE id = ?
    `).run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), HANDLER_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: now,
      config: { codexTimeoutMs: 1000 },
      logger: quietLogger(),
      handlers: new Map([[HANDLER_ID, async () => {
        calls += 1;
        return { branch: 'codex/tasks-md-dedupe-test' };
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
  } finally {
    fixture.close();
  }
});

test('scheduler skips locked schedule', async () => {
  const fixture = createStore();
  try {
    fixture.store.db.prepare(`
      UPDATE handler_schedules
      SET next_run_at_utc = ?, locked_until_utc = ?, last_started_at_utc = NULL
      WHERE id = ?
    `).run('2026-07-01T06:00:00.000Z', '2026-07-01T13:00:00.000Z', HANDLER_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: new Date('2026-07-01T12:00:00.000Z'),
      config: { codexTimeoutMs: 1000 },
      logger: quietLogger(),
      handlers: new Map([[HANDLER_ID, async () => {
        throw new Error('should not run');
      }]])
    });

    assert.equal(results.length, 0);
    assert.equal(scheduleRow(fixture.store).last_started_at_utc, null);
  } finally {
    fixture.close();
  }
});

test('scheduler records failure and still advances recurring schedule', async () => {
  const fixture = createStore();
  const now = new Date();
  try {
    fixture.store.db.prepare(`
      UPDATE handler_schedules
      SET next_run_at_utc = ?, locked_until_utc = NULL, last_error = ''
      WHERE id = ?
    `).run(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), HANDLER_ID);

    const results = await runDueSchedules({
      store: fixture.store,
      nowDate: now,
      config: { codexTimeoutMs: 1000 },
      logger: quietLogger(),
      handlers: new Map([[HANDLER_ID, async () => {
        throw new Error('boom');
      }]])
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    const row = scheduleRow(fixture.store);
    assert.equal(row.locked_until_utc, null);
    assert.equal(row.last_error, 'boom');
    assert.ok(Date.parse(row.next_run_at_utc) > Date.parse(now.toISOString()));
  } finally {
    fixture.close();
  }
});

test('TASKS.md candidate output is strict', () => {
  assert.equal(cleanTasksMdCandidate('NO_CHANGES'), null);
  assert.equal(
    cleanTasksMdCandidate('```markdown\n# TASKS.md\n\n## Записи\n\n- one\n```'),
    '# TASKS.md\n\n## Записи\n\n- one\n'
  );
  assert.throws(() => cleanTasksMdCandidate('updated file'), /missing title/);
});

function createStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-scheduler-test-'));
  const store = new BraiStore(path.join(tmp, 'brai.sqlite'));
  store.db.prepare('UPDATE handlers SET status = ? WHERE id = ?').run('active', HANDLER_ID);
  store.db
    .prepare('UPDATE handler_schedules SET status = ?, interval_seconds = ? WHERE id = ?')
    .run('active', 21600, HANDLER_ID);
  return {
    store,
    close() {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function scheduleRow(store) {
  return store.db.prepare('SELECT * FROM handler_schedules WHERE id = ?').get(HANDLER_ID);
}

function quietLogger() {
  return { log: () => {}, error: () => {} };
}
