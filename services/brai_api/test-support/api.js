import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import { createBraiServer } from '../src/server.js';

export const TOKEN = 'test-token';
export const INBOX_API_KEY = 'test-inbox-api-key';
export const WEB_PASSWORD = 'test-password';
export const RELEASE_PASSWORD = 'release-password';
export const SESSION_SECRET = 'test-session-secret';
export const BETTER_AUTH_SECRET = 'test-better-auth-secret-with-enough-entropy-32';
export const USER_AI_ENCRYPTION_KEY = crypto.createHash('sha256').update('brai-test-user-ai-key').digest('base64url');

export async function createFixture(times, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-api-'));
  let database;
  let runtime;
  let closed = false;
  try {
    database = await createTestDatabase();
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
    runtime = createBraiServer({
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
      userAiEncryptionKey: options.userAiEncryptionKey ?? USER_AI_ENCRYPTION_KEY,
      userAiFetch: options.userAiFetch,
      inboxExternalAi: options.inboxExternalAi,
      inboxImageDescriber: options.inboxImageDescriber,
      inboxNormalizer: options.inboxNormalizer,
      inboxWorkflowStarter: options.inboxWorkflowStarter,
      inboxAutoProcess: options.inboxAutoProcess ?? false,
      activityNormalizer: options.activityNormalizer,
      activityWorkflowStarter: options.activityWorkflowStarter,
      activityAutoProcess: options.activityAutoProcess ?? false,
      braiCmd: options.braiCmd,
      braiChatRuntime: options.braiChatRuntime,
      branch: options.branch,
      commit: options.commit,
      databaseBranch: options.databaseBranch,
      testEmailLogin: options.testEmailLogin,
      goalAgentsEnabled: options.goalAgentsEnabled ?? true,
      shutdownGraceMs: options.shutdownGraceMs,
      braiChatAttachmentReapIntervalMs: options.braiChatAttachmentReapIntervalMs,
      braiChatUploadMaxConcurrent: options.braiChatUploadMaxConcurrent,
      braiChatUploadMaxPerUser: options.braiChatUploadMaxPerUser,
      authBackendTimeoutMs: options.authBackendTimeoutMs,
      now: () => new Date(times[Math.min(index++, times.length - 1)]),
      logger: options.logger ?? { error: () => {} },
      createAuth: options.createAuth
    });
    runtime.store.configureGoalAgentEnvironment(options.goalAgentEnvironment ?? 'prod');
    runtime.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), times[0]);

    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        if (runtime) await runtime.close();
      } finally {
        try {
          await database.drop();
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
    };

    await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const address = runtime.server.address();
    return {
      url: `http://127.0.0.1:${address.port}`,
      wsUrl: `ws://127.0.0.1:${address.port}`,
      databaseUrl: database.url,
      openDatabasePool: () => new Pool({ connectionString: database.url, ssl: postgresSsl(database.url) }),
      runtime,
      store: runtime.store,
      close
    };
  } catch (error) {
    if (runtime) {
      await runtime.close().catch(() => {});
    }
    if (database) {
      await database.drop().catch(() => {});
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
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

export async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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

export async function createTestDatabase(migrations = [
  '0001_brai_baseline.sql',
  '0010_agent_role_normalization_workflows.sql',
  '0011_inbox_workflow_reliability.sql',
  '0012_inbox_raw_input_preservation.sql',
  '0013_drop_legacy_event_tables.sql',
  '0015_runtime_settings_timezone_ai_provider.sql',
  '0016_admin_role_workflow_observability.sql',
  '0017_repair_workflow_observability_history.sql',
  '0018_entity_role_data_repair.sql',
  '0019_preliminary_brai_cmd_users.sql',
  '0024_authenticated_brai_cmd_tokens.sql',
  '0020_inbox_operation_status.sql',
  '0021_activity_raw_normalization_workflows.sql',
  '0022_activity_image_describer_workflow_step.sql',
  '0027_relations_goal_catalog.sql',
  '0028_context_decision_calibration.sql',
  '0029_goal_agent_workflows.sql',
  '0030_authenticated_brai_cmd_tokens_compat.sql',
  '0026_user_ai_provider_credentials.sql',
  '0031_agent_operations_inbox_guard.sql',
  '0032_pending_goal_plan_invariant.sql',
  '0033_normalize_version_work_history.sql',
  '0034_brai_codex_chat.sql',
  '0035_brai_chat_generated_titles.sql',
  '0036_brai_codex_identity.sql'
]) {
  const baseUrl = process.env.BRAI_TEST_DATABASE_URL?.trim();
  if (!baseUrl) throw new Error('BRAI_TEST_DATABASE_URL is required for API tests');
  const branch = process.env.BRAI_TEST_BRANCH?.trim();
  const runId = process.env.BRAI_TEST_RUN_ID?.trim();
  if (Boolean(branch) !== Boolean(runId)) throw new Error('BRAI_TEST_BRANCH and BRAI_TEST_RUN_ID must be set together');
  const scope = branch ? `${scopeHash(branch)}_${scopeHash(runId)}` : '';
  const schema = [
    'brai_test',
    scope,
    process.pid.toString(36),
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 8)
  ].filter(Boolean).join('_');
  const pool = new Pool({ connectionString: baseUrl, ssl: postgresSsl(baseUrl) });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    for (const migration of migrations) {
      await client.query(fs.readFileSync(path.resolve(import.meta.dirname, '../../../supabase/migrations', migration), 'utf8'));
    }
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

function scopeHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === 'false' || override === '0') return false;
  if (override === 'true' || override === '1') return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
