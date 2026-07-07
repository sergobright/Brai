import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { createBraiServer } from '../src/server.js';

export const TOKEN = 'test-token';
export const INBOX_API_KEY = 'test-inbox-api-key';
export const WEB_PASSWORD = 'test-password';
export const RELEASE_PASSWORD = 'release-password';
export const SESSION_SECRET = 'test-session-secret';
export const BETTER_AUTH_SECRET = 'test-better-auth-secret-with-enough-entropy-32';

export async function createFixture(times, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-api-'));
  const database = await createTestDatabase();
  const releaseDir = path.join(tmp, 'releases');
  if (options.releaseFiles) {
    fs.mkdirSync(releaseDir);
    for (const [fileName, content] of Object.entries(options.releaseFiles)) {
      fs.writeFileSync(path.join(releaseDir, fileName), content);
    }
  }
  if (options.mobileFiles) {
    const mobileDir = path.join(tmp, 'mobile-update');
    fs.mkdirSync(mobileDir);
    for (const [fileName, content] of Object.entries(options.mobileFiles)) {
      fs.writeFileSync(path.join(mobileDir, fileName), content);
    }
  }
  let index = 0;
  const runtime = createBraiServer({
    databaseUrl: database.url,
    dataRoot: tmp,
    token: TOKEN,
    webPassword: options.webPassword,
    releasePassword: options.releasePassword,
    sessionSecret: options.sessionSecret,
    betterAuthSecret: options.betterAuthSecret ?? BETTER_AUTH_SECRET,
    betterAuthUrl: options.betterAuthUrl,
    resendApiKey: options.resendApiKey,
    authFromEmail: options.authFromEmail,
    sendOtp: options.sendOtp,
    releaseDir: options.releaseFiles || options.mobileFiles ? releaseDir : null,
    inboxApiKey: options.inboxApiKey ?? INBOX_API_KEY,
    inboxStorageRoot: options.inboxStorageRoot ?? path.join(tmp, 'inbox-attachments'),
    vaultRoot: options.vaultRoot,
    syncthingGuiAddress: options.syncthingGuiAddress,
    syncthingApiKey: options.syncthingApiKey,
    syncthingFolderIdPrefix: options.syncthingFolderIdPrefix,
    prepareUserVault: options.prepareUserVault,
    codexBin: options.codexBin,
    codexModel: options.codexModel,
    codexFallbackModel: options.codexFallbackModel,
    codexTimeoutMs: options.codexTimeoutMs,
    inboxImageDescriber: options.inboxImageDescriber,
    inboxNormalizer: options.inboxNormalizer,
    inboxAutoProcess: options.inboxAutoProcess ?? false,
    braiCmd: options.braiCmd,
    branch: options.branch,
    commit: options.commit,
    databaseBranch: options.databaseBranch,
    now: () => new Date(times[Math.min(index++, times.length - 1)]),
    logger: options.logger ?? { error: () => {} }
  });

  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  const address = runtime.server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}`,
    store: runtime.store,
    close: async () => {
      await runtime.close();
      await database.drop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

export async function request(baseUrl, pathName, options = {}, authorized = true) {
  return jsonRequest(
    baseUrl,
    pathName,
    {
      ...options,
      headers: authorized
        ? {
            authorization: `Bearer ${TOKEN}`,
            ...(options.headers ?? {})
          }
        : options.headers
    }
  );
}

export async function inboxRequest(baseUrl, pathName, options = {}, authorized = true) {
  return jsonRequest(
    baseUrl,
    pathName,
    {
      ...options,
      headers: authorized
        ? {
            'x-brai-api-key': INBOX_API_KEY,
            ...(options.headers ?? {})
          }
        : options.headers
    }
  );
}

export async function jsonRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    }
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

export async function textRequest(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, options);
  return { status: response.status, headers: response.headers, body: await response.text() };
}

export function onceOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

export async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('condition was not met before timeout');
}

export function syncEvent(eventId, clientSequence, type, occurredAtUtc) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    type,
    occurred_at_utc: occurredAtUtc,
    local_timer_id: `local-${eventId}`
  };
}

export function actionEvent(eventId, clientSequence, type, actionId, occurredAtUtc, payload = {}) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    change_type: type,
    activity_id: actionId,
    occurred_at_utc: occurredAtUtc,
    payload
  };
}

export function inboxEvent(eventId, clientSequence, type, inboxId, occurredAtUtc, payload = {}) {
  return {
    event_id: eventId,
    client_sequence: clientSequence,
    type,
    inbox_id: inboxId,
    occurred_at_utc: occurredAtUtc,
    payload
  };
}

export function tableCount(fixture, table) {
  assert.match(table, /^[a-z_]+$/);
  return Number(fixture.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
}

export function activityTypeCount(fixture, activityTypeId) {
  return Number(fixture.store.db
    .prepare('SELECT COUNT(*) AS count FROM activities WHERE activity_type_id = ?')
    .get(activityTypeId).count);
}

export function eventDomainCount(fixture, eventDomain) {
  return Number(fixture.store.db
    .prepare('SELECT COUNT(*) AS count FROM events WHERE event_domain = ?')
    .get(eventDomain).count);
}

export async function createTestDatabase() {
  const baseUrl = process.env.BRAI_TEST_DATABASE_URL?.trim();
  if (!baseUrl) throw new Error('BRAI_TEST_DATABASE_URL is required for API tests');
  const schema = `brai_test_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const pool = new Pool({ connectionString: baseUrl, ssl: postgresSsl(baseUrl) });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    await client.query(fs.readFileSync(path.resolve(import.meta.dirname, '../../../supabase/migrations/0001_brai_baseline.sql'), 'utf8'));
  } catch (error) {
    await dropTestSchema(baseUrl, schema).catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  return {
    url: databaseUrlForSchema(baseUrl, schema),
    drop: () => dropTestSchema(baseUrl, schema)
  };
}

async function dropTestSchema(baseUrl, schema) {
  const cleanup = new Pool({ connectionString: baseUrl, ssl: postgresSsl(baseUrl) });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } finally {
    await cleanup.end();
  }
}

function databaseUrlForSchema(baseUrl, schema) {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === 'false' || override === '0') return false;
  if (override === 'true' || override === '1') return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
