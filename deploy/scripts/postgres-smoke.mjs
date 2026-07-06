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

const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
try {
  const runtimeSchema = await scalar("SELECT current_schema()");
  const schemaParam = [runtimeSchema];
  const checks = await Promise.all([
    scalar("SELECT 1"),
    scalar("SELECT COUNT(*)::int FROM schema_migrations"),
    scalar("SELECT COUNT(*)::int FROM supabase_migration_files"),
    scalar("SELECT COUNT(*)::int FROM version_types WHERE id IN ('apk', 'build')"),
    scalar("SELECT COUNT(*)::int FROM activity_types WHERE id IN ('action', 'operation')"),
    scalar("SELECT COUNT(*)::int FROM inbox_record_types"),
    scalar("SELECT COUNT(*)::int FROM build_version_counters WHERE version_type_id IN ('apk', 'build')"),
    scalar("SELECT COUNT(*)::int FROM pg_event_trigger WHERE evtname = 'brai_enable_rls_for_new_public_tables' AND evtenabled IN ('O', 'R', 'A')"),
    scalar(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
          AND p.proname = 'brai_enable_rls_for_new_public_tables'
          AND EXISTS (
            SELECT 1
            FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS config(value)
            WHERE config.value LIKE 'search_path=%'
              AND translate(substring(config.value FROM length('search_path=') + 1), '"'' ', '') = ''
          )
      )::int
    `, schemaParam),
    scalar(`
      SELECT COUNT(*)::int
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relrowsecurity
    `, schemaParam),
    rows(`
      SELECT format('%I.%I', n.nspname, c.relname) AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND NOT c.relrowsecurity
      ORDER BY c.relname
    `, schemaParam)
  ]);
  const [
    ping,
    migrations,
    supabaseMigrations,
    versionTypes,
    activityTypes,
    inboxTypes,
    counters,
    rlsAutoTrigger,
    rlsFunctionSearchPath,
    rlsProtectedTables,
    publicTablesWithoutRls
  ] = checks;
  if (ping !== 1) throw new Error("Postgres ping failed");
  if (migrations < 1) throw new Error("schema_migrations is empty");
  if (supabaseMigrations < 1) throw new Error("supabase_migration_files is empty");
  if (versionTypes !== 2) throw new Error("version_types seed is incomplete");
  if (activityTypes !== 2) throw new Error("activity_types seed is incomplete");
  if (inboxTypes < 4) throw new Error("inbox_record_types seed is incomplete");
  if (counters !== 2) throw new Error("build_version_counters seed is incomplete");
  if (rlsAutoTrigger !== 1) throw new Error("public table RLS auto-enable trigger is missing or disabled");
  if (rlsFunctionSearchPath !== 1) throw new Error("public table RLS auto-enable function search_path is mutable");
  if (publicTablesWithoutRls.length > 0) {
    throw new Error(`Runtime tables without RLS in ${runtimeSchema}: ${publicTablesWithoutRls.map((row) => row.table_name).join(", ")}`);
  }
  console.log(JSON.stringify({
    ok: true,
    runtimeSchema,
    migrations,
    supabaseMigrations,
    versionTypes,
    activityTypes,
    inboxTypes,
    counters,
    rlsAutoTrigger,
    rlsFunctionSearchPath,
    rlsProtectedTables,
    publicTablesWithoutRls: publicTablesWithoutRls.length
  }, null, 2));
} finally {
  await pool.end();
}

async function scalar(sql, params = []) {
  const result = await pool.query(sql, params);
  return Object.values(result.rows[0])[0];
}

async function rows(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
