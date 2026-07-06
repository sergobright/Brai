#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const Database = requireFromApi("better-sqlite3");
const { Pool } = requireFromApi("pg");

const TABLES = [
  "app_settings",
  "user",
  "session",
  "account",
  "verification",
  "timer_devices",
  "timer_events",
  "activity_types",
  "activities",
  "activity_events",
  "focus_sessions",
  "focus_session_intervals",
  "focus_session_sources",
  "inbox_record_types",
  "inbox",
  "inbox_events",
  "items",
  "item_role_types",
  "item_roles",
  "agents",
  "agent_schedules",
  "ai_logs",
  "brai_cmd_settings",
  "brai_cmd_access_tokens",
  "brai_cmd_usage_events",
  "version_types",
  "build_versions",
  "build_version_refs",
  "deployment_records",
  "table_descriptions",
];

const args = parseArgs(process.argv.slice(2));
const sqlitePath = required(args, "sqlite");
const databaseUrl = required(args, "postgres-url");
const truncate = args.truncate === "true";
const merge = args.merge === "true";
if (!truncate && !merge) throw new Error("Choose --truncate true for source-of-truth import or --merge true for additive dry-run imports");

const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  if (truncate) {
    await client.query(`TRUNCATE ${TABLES.map(quoteIdent).join(", ")} RESTART IDENTITY CASCADE`);
  }

  const summary = [];
  for (const table of TABLES) {
    if (!sqliteTableExists(sqlite, table)) continue;
    const columns = sqlite.prepare(`PRAGMA table_info(${quoteSqliteIdent(table)})`).all().map((row) => row.name);
    if (columns.length === 0) continue;
    const rows = sqlite.prepare(`SELECT ${columns.map(quoteSqliteIdent).join(", ")} FROM ${quoteSqliteIdent(table)}`).all();
    if (rows.length === 0) {
      summary.push({ table, rows: 0 });
      continue;
    }
    const sql = `
      INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")})
      VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
      ON CONFLICT DO NOTHING
    `;
    for (const row of rows) {
      normalizeRow(table, row);
      await client.query(sql, columns.map((column) => row[column]));
    }
    summary.push({ table, rows: rows.length });
  }

  await resetIdentity(client, "ai_logs", "id");
  await resetIdentity(client, "build_versions", "id");
  await resetIdentity(client, "build_version_refs", "id");
  await resetIdentity(client, "deployment_records", "id");
  await resetIdentity(client, "item_roles", "id");
  await syncVersionCounters(client);
  await syncSequenceCounters(client);
  await markImport(client, sqlitePath);

  await client.query("COMMIT");
  console.log(JSON.stringify({ ok: true, imported: summary }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}

function sqliteTableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function normalizeRow(table, row) {
  if (table === "user" && Object.hasOwn(row, "emailVerified")) {
    row.emailVerified = Boolean(row.emailVerified);
  }
}

async function resetIdentity(client, table, column) {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence($1, $2),
      GREATEST(COALESCE((SELECT MAX(${quoteIdent(column)}) FROM ${quoteIdent(table)}), 0), 1),
      COALESCE((SELECT MAX(${quoteIdent(column)}) FROM ${quoteIdent(table)}), 0) > 0
    )
  `, [table, column]);
}

async function syncVersionCounters(client) {
  await client.query(`
    INSERT INTO build_version_counters (version_type_id, last_version)
    SELECT version_type_id, COALESCE(MAX(version), 0)
    FROM build_versions
    GROUP BY version_type_id
    ON CONFLICT (version_type_id) DO UPDATE SET last_version = excluded.last_version
  `);
  await client.query(`
    INSERT INTO build_version_counters (version_type_id, last_version)
    VALUES ('apk', 0), ('build', 0)
    ON CONFLICT DO NOTHING
  `);
}

async function syncSequenceCounters(client) {
  await upsertCounter(client, "timer_events.server_sequence", "SELECT COALESCE(MAX(server_sequence), 0) FROM timer_events");
  await upsertCounter(client, "activity_events.server_sequence", "SELECT COALESCE(MAX(server_sequence), 0) FROM activity_events");
  await upsertCounter(client, "inbox_events.server_sequence", "SELECT COALESCE(MAX(server_sequence), 0) FROM inbox_events");

  for (const row of (await client.query("SELECT device_id, COALESCE(MAX(client_sequence), 0)::int AS value FROM timer_events GROUP BY device_id")).rows) {
    await upsertCounterValue(client, `timer_events.client_sequence.${row.device_id}`, row.value);
  }
  for (const row of (await client.query("SELECT device_id, COALESCE(MAX(ABS(client_sequence)), 0)::int AS value FROM timer_events WHERE client_sequence < 0 GROUP BY device_id")).rows) {
    await upsertCounterValue(client, `timer_events.invalid_client_sequence.${row.device_id}`, row.value);
  }
  for (const row of (await client.query("SELECT device_id, COALESCE(MAX(ABS(client_sequence)), 0)::int AS value FROM activity_events WHERE client_sequence < 0 GROUP BY device_id")).rows) {
    await upsertCounterValue(client, `activity_events.invalid_client_sequence.${row.device_id}`, row.value);
  }
  for (const row of (await client.query("SELECT device_id, COALESCE(MAX(client_sequence), 0)::int AS value FROM inbox_events GROUP BY device_id")).rows) {
    await upsertCounterValue(client, `inbox_events.client_sequence.${row.device_id}`, row.value);
  }
  for (const row of (await client.query("SELECT device_id, COALESCE(MAX(ABS(client_sequence)), 0)::int AS value FROM inbox_events WHERE client_sequence < 0 GROUP BY device_id")).rows) {
    await upsertCounterValue(client, `inbox_events.invalid_client_sequence.${row.device_id}`, row.value);
  }
}

async function upsertCounter(client, name, sql) {
  const value = Number(Object.values((await client.query(sql)).rows[0])[0] ?? 0);
  await upsertCounterValue(client, name, value);
}

async function markImport(client, sqlitePath) {
  const now = new Date().toISOString();
  await client.query(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES
      ('postgres_imported_from_sqlite', 'true', $1),
      ('postgres_imported_from_sqlite_path', $2, $1),
      ('postgres_imported_at_utc', $1, $1)
    ON CONFLICT (key) DO UPDATE
      SET value = excluded.value,
        updated_at_utc = excluded.updated_at_utc
  `, [now, sqlitePath]);
}

async function upsertCounterValue(client, name, value) {
  await client.query(`
    INSERT INTO sequence_counters (name, last_value)
    VALUES ($1, $2)
    ON CONFLICT (name) DO UPDATE SET last_value = excluded.last_value
  `, [name, value]);
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function quoteSqliteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = values[index + 1] ?? "";
  }
  return parsed;
}

function required(values, key) {
  const value = values[key] ?? process.env[key.toUpperCase().replaceAll("-", "_")];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}
