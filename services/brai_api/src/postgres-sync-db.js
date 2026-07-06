import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 30000;

export function isPostgresUrl(value) {
  return /^postgres(?:ql)?:\/\//.test(String(value ?? ''));
}

export class PostgresSyncDatabase {
  constructor(databaseUrl, {
    timeoutMs = Number(process.env.BRAI_PG_SYNC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    ssl = postgresSsl(databaseUrl)
  } = {}) {
    this.dialect = 'postgres';
    this.timeoutMs = timeoutMs;
    this.currentTxId = null;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-pg-sync-'));
    this.worker = new Worker(path.join(dirname, 'postgres-sync-worker.js'), {
      workerData: { databaseUrl, ssl },
      execArgv: []
    });
    this.workerError = null;
    this.worker.on('error', (error) => {
      this.workerError = error;
    });
    this.worker.on('exit', (code) => {
      if (code !== 0 && !this.workerError) this.workerError = new Error(`Postgres worker exited with code ${code}`);
    });
  }

  prepare(sql) {
    return new PostgresSyncStatement(this, sql);
  }

  exec(sql) {
    return this.request('query', { sql, params: [] });
  }

  pragma() {
    return null;
  }

  transaction(fn) {
    return (...args) => {
      const previousTxId = this.currentTxId;
      const { txId } = this.request('begin');
      this.currentTxId = txId;
      try {
        const result = fn(...args);
        this.request('commit', { txId });
        return result;
      } catch (error) {
        try {
          this.request('rollback', { txId });
        } finally {
          this.currentTxId = previousTxId;
        }
        throw error;
      } finally {
        this.currentTxId = previousTxId;
      }
    };
  }

  close() {
    try {
      this.request('close');
    } finally {
      this.worker.terminate();
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    }
  }

  request(action, body = {}) {
    const signal = new SharedArrayBuffer(4);
    const view = new Int32Array(signal);
    const resultPath = path.join(this.tmpDir, `${Date.now()}-${Math.random()}.json`);
    this.worker.postMessage({
      ...body,
      action,
      txId: body.txId ?? this.currentTxId,
      signal,
      resultPath
    });
    const wait = Atomics.wait(view, 0, 0, this.timeoutMs);
    if (this.workerError) throw this.workerError;
    if (wait === 'timed-out') throw new Error(`Postgres query timed out after ${this.timeoutMs}ms`);
    const payload = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    fs.rmSync(resultPath, { force: true });
    if (!payload.ok) {
      const error = new Error(payload.error);
      error.stack = payload.stack || error.stack;
      throw error;
    }
    return payload.result;
  }
}

class PostgresSyncStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  get(...params) {
    return this.all(...params)[0];
  }

  all(...params) {
    const query = translateSql(this.sql);
    return this.db.request('query', { sql: query.sql, params }).rows;
  }

  run(...params) {
    const query = translateSql(this.sql, { returningId: /^INSERT\s+INTO\s+ai_logs\b/i.test(this.sql.trim()) });
    const result = this.db.request('query', { sql: query.sql, params });
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows?.[0]?.id ?? 0
    };
  }
}

function translateSql(sql, { returningId = false } = {}) {
  let text = sql.trim().replace(/;+\s*$/, '');
  text = text.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  text = replaceSqliteIs(text);
  text = replaceQuestionParams(text);
  text = replaceInstr(text);
  if (/^INSERT\s+INTO\b/i.test(text) && !/\bON\s+CONFLICT\b/i.test(text) && /\bINSERT\s+OR\s+IGNORE\b/i.test(sql)) {
    text += ' ON CONFLICT DO NOTHING';
  }
  if (returningId && !/\bRETURNING\b/i.test(text)) {
    text += ' RETURNING id';
  }
  return { sql: text };
}

function replaceQuestionParams(sql) {
  let index = 0;
  let quote = null;
  let result = '';
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (quote) {
      result += char;
      if (char === quote && sql[i + 1] === quote) {
        result += sql[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '\'' || char === '"') {
      quote = char;
      result += char;
    } else if (char === '?') {
      index += 1;
      result += `$${index}`;
    } else {
      result += char;
    }
  }
  return result;
}

function replaceSqliteIs(sql) {
  return sql
    .replace(/\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+IS\s+(excluded\.[a-z_][a-z0-9_]*)/gi, '$1 IS NOT DISTINCT FROM $2')
    .replace(/\b([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+IS\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi, '$1 IS NOT DISTINCT FROM $2');
}

function replaceInstr(sql) {
  return sql.replace(/instr\(([^,]+),\s*(\$\d+)\)\s*>\s*0/gi, 'position($2 in $1) > 0');
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === 'false' || override === '0') return false;
  if (override === 'true' || override === '1') return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
