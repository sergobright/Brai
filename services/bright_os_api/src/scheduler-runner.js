import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { BrightOsStore } from './store.js';

const TASKS_MD_HANDLER_ID = 'maintenance.tasks_md_deduper';
const TASKS_BRANCH_PREFIX = 'codex/tasks-md-dedupe-';
const DEFAULT_LOCK_SECONDS = 10 * 60;
const DEFAULT_CODEX_TIMEOUT_MS = 120000;
const MAX_ERROR_LENGTH = 1000;

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(dirname, '..');
const repoRoot = path.resolve(serviceRoot, '..', '..');

const HANDLERS = new Map([[TASKS_MD_HANDLER_ID, runTasksMdDeduper]]);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export async function main(env = process.env) {
  const config = schedulerConfig(env);
  const store = new BrightOsStore(config.dbPath);
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

export async function runDueSchedules({ store, nowDate = new Date(), config = schedulerConfig(), logger = console, handlers = HANDLERS } = {}) {
  const nowIso = nowDate.toISOString();
  const rows = store.db.prepare(`
    SELECT s.*, h.kind, h.llm_model, h.llm_prompt_template, h.llm_timeout_ms
    FROM handler_schedules s
    JOIN handlers h ON h.id = s.handler_id
    WHERE s.status = 'active'
      AND h.status = 'active'
      AND s.next_run_at_utc IS NOT NULL
      AND s.next_run_at_utc <= ?
      AND (s.locked_until_utc IS NULL OR s.locked_until_utc <= ?)
    ORDER BY s.next_run_at_utc ASC, s.id ASC
    LIMIT 5
  `).all(nowIso, nowIso);

  const results = [];
  for (const row of rows) {
    const timeoutMs = handlerTimeoutMs(row, config);
    const lockUntil = new Date(nowDate.getTime() + Math.max(DEFAULT_LOCK_SECONDS, Math.ceil(timeoutMs / 1000) + 300) * 1000)
      .toISOString();
    const claimed = store.db.prepare(`
      UPDATE handler_schedules
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
      const runHandler = handlers.get(row.handler_id);
      if (!runHandler) throw new Error(`unknown scheduled handler: ${row.handler_id}`);
      const output = await runHandler({ schedule: row, config, timeoutMs, nowDate });
      finishSchedule(store, row, new Date(), null);
      logger.log(`${row.id}: ${output?.skipped ? 'skipped' : 'completed'}`);
      results.push({ id: row.id, ok: true, output });
    } catch (error) {
      finishSchedule(store, row, new Date(), error);
      logger.error(`${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ id: row.id, ok: false, error });
    }
  }
  return results;
}

export async function runTasksMdDeduper({ schedule, config, timeoutMs, nowDate = new Date() }) {
  const openPr = openDedupePr(config);
  if (openPr) return { skipped: true, reason: `open PR already exists: ${openPr}`, prUrl: openPr };

  const remoteUrl = command(['git', '-C', config.repoRoot, 'config', '--get', 'remote.origin.url']).stdout.trim();
  if (!remoteUrl) throw new Error('remote.origin.url is not configured');

  fs.mkdirSync(config.workRoot, { recursive: true });
  const worktree = fs.mkdtempSync(path.join(config.workRoot, 'tasks-md-dedupe-'));
  try {
    command(['git', 'clone', '--no-tags', '--branch', 'main', '--single-branch', remoteUrl, worktree], {
      timeoutMs: config.gitTimeoutMs
    });

    const tasksPath = path.join(worktree, 'TASKS.md');
    const currentTasksMd = fs.readFileSync(tasksPath, 'utf8');
    const nextTasksMd = cleanTasksMdCandidate(codexTasksMd(currentTasksMd, { schedule, config, timeoutMs, cwd: worktree }));
    if (!nextTasksMd || nextTasksMd === currentTasksMd) return { skipped: true, reason: 'no changes' };

    const branch = `${TASKS_BRANCH_PREFIX}${branchTimestamp(nowDate)}`;
    command(['git', '-C', worktree, 'checkout', '-b', branch], { timeoutMs: config.gitTimeoutMs });
    fs.writeFileSync(tasksPath, nextTasksMd);

    const changedFiles = command(['git', '-C', worktree, 'diff', '--name-only'], { timeoutMs: config.gitTimeoutMs })
      .stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    if (changedFiles.length === 0) return { skipped: true, reason: 'no git diff' };
    if (changedFiles.length !== 1 || changedFiles[0] !== 'TASKS.md') {
      throw new Error(`TASKS.md handler changed unexpected files: ${changedFiles.join(', ')}`);
    }

    command(['git', '-C', worktree, 'add', 'TASKS.md'], { timeoutMs: config.gitTimeoutMs });
    command(['git', '-C', worktree, 'commit', '-m', 'Deduplicate TASKS.md entries'], {
      env: gitCommitEnv(config.env),
      timeoutMs: config.gitTimeoutMs
    });
    const headSha = command(['git', '-C', worktree, 'rev-parse', 'HEAD'], { timeoutMs: config.gitTimeoutMs }).stdout.trim();
    command(['git', '-C', worktree, 'push', '-u', 'origin', branch], {
      env: gitCommitEnv(config.env),
      timeoutMs: config.gitTimeoutMs
    });
    const prUrl = createDedupePr({ config, cwd: worktree, branch, headSha });
    return { branch, prUrl };
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
}

export function cleanTasksMdCandidate(output) {
  const trimmed = String(output ?? '').trim();
  if (!trimmed || trimmed === 'NO_CHANGES') return null;
  const fenced = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  const text = (fenced ? fenced[1] : trimmed).trimEnd();
  if (!text.startsWith('# TASKS.md')) throw new Error('Codex returned invalid TASKS.md: missing title');
  if (!text.includes('## Записи')) throw new Error('Codex returned invalid TASKS.md: missing entries section');
  return `${text}\n`;
}

function schedulerConfig(env = process.env) {
  return {
    env,
    dbPath: env.BRIGHT_OS_DB ?? path.join(serviceRoot, 'data', 'bright_os.sqlite'),
    repoRoot: env.BRIGHT_OS_ROOT ?? repoRoot,
    workRoot: env.BRIGHT_OS_SCHEDULER_WORK_ROOT ?? path.join(os.tmpdir(), 'bright-os-scheduler'),
    codexBin: env.BRIGHT_OS_CODEX_BIN ?? 'codex',
    codexModel: env.BRIGHT_OS_SCHEDULER_CODEX_MODEL?.trim() || env.BRIGHT_OS_CODEX_MODEL?.trim() || null,
    codexTimeoutMs: numberEnv(env.BRIGHT_OS_SCHEDULER_CODEX_TIMEOUT_MS),
    gitTimeoutMs: numberEnv(env.BRIGHT_OS_SCHEDULER_GIT_TIMEOUT_MS) ?? 120000
  };
}

function handlerTimeoutMs(row, config) {
  return config.codexTimeoutMs ?? (Number.isFinite(row.llm_timeout_ms) ? row.llm_timeout_ms : DEFAULT_CODEX_TIMEOUT_MS);
}

function finishSchedule(store, row, finishedAt, error) {
  const finishedIso = finishedAt.toISOString();
  const nextRun = row.interval_seconds
    ? new Date(finishedAt.getTime() + row.interval_seconds * 1000).toISOString()
    : null;
  const status = row.interval_seconds ? 'active' : 'paused';
  store.db.prepare(`
    UPDATE handler_schedules
    SET status = ?,
      next_run_at_utc = ?,
      locked_until_utc = NULL,
      last_finished_at_utc = ?,
      last_error = ?,
      updated_at_utc = ?
    WHERE id = ?
  `).run(status, nextRun, finishedIso, errorText(error), finishedIso, row.id);
}

function codexTasksMd(tasksMd, { schedule, config, timeoutMs, cwd }) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-tasks-md-codex-'));
  const outputPath = path.join(outputDir, 'TASKS.md');
  try {
    const args = ['--sandbox', 'read-only', '--ask-for-approval', 'never'];
    if (config.codexModel) args.push('--model', config.codexModel);
    args.push('exec', '--ephemeral', '--skip-git-repo-check', '--output-last-message', outputPath, '-');
    const result = spawnSync(config.codexBin, args, {
      cwd,
      input: renderPrompt(schedule.llm_prompt_template, tasksMd),
      encoding: 'utf8',
      env: config.env,
      timeout: timeoutMs,
      stdio: ['pipe', 'ignore', 'pipe']
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr?.trim() || `Codex exited with ${result.status}`);
    return fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

function openDedupePr(config) {
  const result = command([
    'gh',
    'pr',
    'list',
    '--base',
    'main',
    '--state',
    'open',
    '--json',
    'headRefName,url',
    '--jq',
    `.[] | select(.headRefName | startswith("${TASKS_BRANCH_PREFIX}")) | .url`
  ], { cwd: config.repoRoot, timeoutMs: config.gitTimeoutMs });
  return result.stdout.trim().split('\n').find(Boolean) ?? null;
}

function createDedupePr({ config, cwd, branch, headSha }) {
  const prUrl = command([
    'gh',
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    branch,
    '--title',
    'Deduplicate TASKS.md entries',
    '--body',
    'Automated TASKS.md maintenance by the Bright OS scheduler. The handler only updates TASKS.md and enables auto-merge through normal branch protection.'
  ], { cwd, env: gitCommitEnv(config.env), timeoutMs: config.gitTimeoutMs }).stdout.trim();
  if (!prUrl) throw new Error('gh pr create did not return a PR URL');

  command([
    'gh',
    'pr',
    'merge',
    prUrl,
    '--squash',
    '--auto',
    '--match-head-commit',
    headSha
  ], { cwd, env: gitCommitEnv(config.env), timeoutMs: config.gitTimeoutMs });
  return prUrl;
}

function command(args, { cwd, env = process.env, timeoutMs = 30000 } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function renderPrompt(template, tasksMd) {
  const source = template?.trim() || '{{tasks_md}}';
  return source.includes('{{tasks_md}}') ? source.replaceAll('{{tasks_md}}', tasksMd) : `${source}\n\n${tasksMd}`;
}

function branchTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase();
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

function gitCommitEnv(env) {
  return {
    ...env,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? 'Bright OS Scheduler',
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? 'scheduler@brightos.world',
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? 'Bright OS Scheduler',
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? 'scheduler@brightos.world'
  };
}
