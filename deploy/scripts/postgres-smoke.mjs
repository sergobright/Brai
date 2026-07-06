#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");

const databaseUrl = process.env.BRAI_DATABASE_URL ?? process.env.DATABASE_URL ?? process.argv[2];
if (!databaseUrl) throw new Error("BRAI_DATABASE_URL, DATABASE_URL, or argv[2] is required");
const expectImported = process.env.BRAI_EXPECT_IMPORTED === "true" || process.argv.includes("--expect-imported");

const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
try {
  const checks = await Promise.all([
    scalar("SELECT 1"),
    scalar("SELECT COUNT(*)::int FROM schema_migrations"),
    scalar("SELECT COUNT(*)::int FROM supabase_migration_files"),
    scalar("SELECT COUNT(*)::int FROM version_types WHERE id IN ('apk', 'build')"),
    scalar("SELECT COUNT(*)::int FROM activity_types WHERE id IN ('action', 'operation')"),
    scalar("SELECT COUNT(*)::int FROM inbox_record_types"),
    scalar("SELECT COUNT(*)::int FROM build_version_counters WHERE version_type_id IN ('apk', 'build')"),
    expectImported ? scalar("SELECT value FROM app_settings WHERE key = 'postgres_imported_from_sqlite'") : Promise.resolve("")
  ]);
  const [ping, migrations, supabaseMigrations, versionTypes, activityTypes, inboxTypes, counters, importMarker] = checks;
  if (ping !== 1) throw new Error("Postgres ping failed");
  if (migrations < 1) throw new Error("schema_migrations is empty");
  if (supabaseMigrations < 1) throw new Error("supabase_migration_files is empty");
  if (versionTypes !== 2) throw new Error("version_types seed is incomplete");
  if (activityTypes !== 2) throw new Error("activity_types seed is incomplete");
  if (inboxTypes < 4) throw new Error("inbox_record_types seed is incomplete");
  if (counters !== 2) throw new Error("build_version_counters seed is incomplete");
  if (expectImported && importMarker !== "true") throw new Error("SQLite import marker is missing");
  console.log(JSON.stringify({ ok: true, migrations, supabaseMigrations, versionTypes, activityTypes, inboxTypes, counters, importMarker: importMarker || undefined }, null, 2));
} finally {
  await pool.end();
}

async function scalar(sql) {
  const result = await pool.query(sql);
  return Object.values(result.rows[0])[0];
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
