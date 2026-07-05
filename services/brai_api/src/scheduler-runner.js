import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BraiStore } from './store.js';

const DEFAULT_LOCK_SECONDS = 10 * 60;
const DEFAULT_AGENT_TIMEOUT_MS = 120000;
const MAX_ERROR_LENGTH = 1000;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(dirname, '..');

const AGENTS = new Map();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export async function main(env = process.env) {
  const config = schedulerConfig(env);
  const store = new BraiStore(config.dbPath);
  try {
    return await runDueSchedules({
      store,
      nowDate: new Date(),
      config,
      logger: console
    });
  } finally {
    store.close();
  }
}

export async function runDueSchedules({ store, nowDate = new Date(), config = schedulerConfig(), logger = console, agents = AGENTS } = {}) {
  const nowIso = nowDate.toISOString();
  const rows = store.db.prepare(`
    SELECT s.*, a.kind, a.title AS agent_title, a.version AS agent_version,
      a.llm_model, a.llm_prompt_template, a.llm_timeout_ms
    FROM agent_schedules s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.status = 'active'
      AND a.status = 'active'
      AND s.next_run_at_utc IS NOT NULL
      AND s.next_run_at_utc <= ?
      AND (s.locked_until_utc IS NULL OR s.locked_until_utc <= ?)
    ORDER BY s.next_run_at_utc ASC, s.id ASC
    LIMIT 5
  `).all(nowIso, nowIso);

  const results = [];
  for (const row of rows) {
    const timeoutMs = agentTimeoutMs(row, config);
    const lockUntil = new Date(nowDate.getTime() + Math.max(DEFAULT_LOCK_SECONDS, Math.ceil(timeoutMs / 1000) + 300) * 1000)
      .toISOString();
    const claimed = store.db.prepare(`
      UPDATE agent_schedules
      SET locked_until_utc = ?,
        last_started_at_utc = ?,
        updated_at_utc = ?
      WHERE id = ?
        AND status = 'active'
        AND next_run_at_utc IS NOT NULL
        AND next_run_at_utc <= ?
        AND (locked_until_utc IS NULL OR locked_until_utc <= ?)
    `).run(lockUntil, nowIso, nowIso, row.id, nowIso, nowIso);
    if (claimed.changes !== 1) continue;

    try {
      const runAgent = agents.get(row.agent_id);
      if (!runAgent) throw new Error(`unknown scheduled agent: ${row.agent_id}`);
      const output = await runAgent({ schedule: row, config, timeoutMs, nowDate });
      const finish = finishSchedule(store, row, new Date(), null);
      recordScheduledAgentAiLog(store, { row, finish, status: 'done', output });
      logger.log(`${row.id}: ${output?.skipped ? 'skipped' : 'completed'}`);
      results.push({ id: row.id, ok: true, output });
    } catch (error) {
      const finish = finishSchedule(store, row, new Date(), error);
      recordScheduledAgentAiLog(store, { row, finish, status: 'failed', error });
      logger.error(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ id: row.id, ok: false, error });
    }
  }
  return results;
}

function schedulerConfig(env = process.env) {
  return {
    env,
    dbPath: env.BRAI_DB ?? path.join(serviceRoot, 'data', 'brai.sqlite'),
    agentTimeoutMs: numberEnv(env.BRAI_SCHEDULER_AGENT_TIMEOUT_MS)
  };
}

function agentTimeoutMs(row, config) {
  return config.agentTimeoutMs ?? (Number.isFinite(row.llm_timeout_ms) ? row.llm_timeout_ms : DEFAULT_AGENT_TIMEOUT_MS);
}

function finishSchedule(store, row, finishedAt, error) {
  const finishedIso = finishedAt.toISOString();
  const nextRun = row.interval_seconds
    ? new Date(finishedAt.getTime() + row.interval_seconds * 1000).toISOString()
    : null;
  const status = row.interval_seconds ? 'active' : 'paused';
  store.db.prepare(`
    UPDATE agent_schedules
    SET status = ?,
      next_run_at_utc = ?,
      locked_until_utc = NULL,
      last_finished_at_utc = ?,
      last_error = ?,
      updated_at_utc = ?
    WHERE id = ?
  `).run(status, nextRun, finishedIso, errorText(error), finishedIso, row.id);
  return { status, nextRun, finishedIso, lastError: errorText(error) };
}

function recordScheduledAgentAiLog(store, { row, finish, status, output, error }) {
  store.recordAiLog({
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    dt: finish.finishedIso,
    status,
    aiTitle: status === 'done' ? 'Выполнил scheduled AI-агента' : 'Ошибка scheduled AI-агента',
    jsonData: {
      schema: 'brai.ai_log.v1',
      inputs: [
        { ref: 'agent_schedules.id', value: row.id },
        { ref: 'agent_schedules.next_run_at_utc', value: row.next_run_at_utc },
        { ref: 'agent_schedules.interval_seconds', value: row.interval_seconds }
      ],
      outputs: [
        { ref: 'agent_schedules.status', value: finish.status },
        { ref: 'agent_schedules.next_run_at_utc', value: finish.nextRun },
        { ref: 'agent_schedules.last_finished_at_utc', value: finish.finishedIso },
        { ref: 'agent_schedules.last_error', value: finish.lastError },
        { ref: 'result', value: output ?? null }
      ],
      metadata: {
        error: errorText(error) || null,
        agent_title: row.agent_title
      }
    }
  });
}

function numberEnv(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorText(error) {
  if (!error) return '';
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}
