#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { inspectOwnedSequences, unsafeOwnedSequenceAllocations } from "./supabase-branch.mjs";

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
    scalar("SELECT COUNT(*)::int FROM role_statuses WHERE id IN ('active', 'ended', 'deleted')"),
    scalar("SELECT COUNT(*)::int FROM role_contracts"),
    scalar("SELECT COUNT(*)::int FROM workflow_definitions WHERE id = 'inbox.raw-normalization' AND version = 1"),
    scalar("SELECT COUNT(*)::int FROM schema_migrations WHERE version = 57"),
    scalar("SELECT COUNT(*)::int FROM supabase_migration_files WHERE version = '0016' AND name = '0016_admin_role_workflow_observability.sql'"),
    scalar(`
      SELECT COUNT(*)::int
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('workflow_definitions', 'process_json'),
          ('workflow_executions', 'trace_status')
        )
    `),
    scalar(`
      SELECT COUNT(*)::int
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('workflow_execution_steps', 'workflow_worker_heartbeats')
    `),
    scalar(`
      SELECT COUNT(*)::int
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('inbox', 'item_roles_id'),
          ('inbox', 'initial_event_id'),
          ('inbox', 'workflow_execution_id'),
          ('events', 'item_roles_id'),
          ('ai_logs', 'workflow_id'),
          ('ai_logs', 'attempt_number')
        )
    `),
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
    roleStatuses,
    roleContracts,
    inboxWorkflowDefinitions,
    observabilityMigration,
    observabilityMigrationFile,
    observabilityColumns,
    observabilityTables,
    workflowColumns,
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
  if (roleStatuses !== 3) throw new Error("role_statuses seed is incomplete");
  if (roleContracts < 3) throw new Error("role_contracts seed is incomplete");
  if (inboxWorkflowDefinitions !== 1) throw new Error("Inbox workflow definition is missing");
  if (observabilityMigration !== 1 || observabilityMigrationFile !== 1) throw new Error("Workflow observability migration history is incomplete");
  if (observabilityColumns !== 2 || observabilityTables !== 2) throw new Error("Workflow observability schema is incomplete");
  if (workflowColumns !== 6) throw new Error("Agent role workflow columns are incomplete");
  if (counters !== 2) throw new Error("build_version_counters seed is incomplete");
  if (runtimeSchema === "public" && rlsAutoTrigger !== 1) {
    throw new Error("public table RLS auto-enable trigger is missing or disabled");
  }
  if (rlsFunctionSearchPath !== 1) throw new Error("public table RLS auto-enable function search_path is mutable");
  if (publicTablesWithoutRls.length > 0) {
    throw new Error(`Runtime tables without RLS in ${runtimeSchema}: ${publicTablesWithoutRls.map((row) => row.table_name).join(", ")}`);
  }
  const sequenceClient = await pool.connect();
  let ownedSequences;
  let unsafeSequences;
  try {
    await sequenceClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    ownedSequences = await inspectOwnedSequences(sequenceClient, {
      schema: runtimeSchema,
      lockOwnedTables: true
    });
    unsafeSequences = unsafeOwnedSequenceAllocations(ownedSequences);
    if (unsafeSequences.length > 0) {
      throw new Error(`Unsafe owned sequence allocation in ${runtimeSchema}: ${unsafeSequences.map((sequence) => (
        `${sequence.table_name}.${sequence.column_name} (${sequence.sequence_schema}.${sequence.sequence_name}, ${sequence.allocation.reason}, next=${sequence.allocation.nextValue})`
      )).join(", ")}`);
    }
    await sequenceClient.query("COMMIT");
  } catch (error) {
    await sequenceClient.query("ROLLBACK");
    throw error;
  } finally {
    sequenceClient.release();
  }
  console.log(JSON.stringify({
    ok: true,
    runtimeSchema,
    migrations,
    supabaseMigrations,
    versionTypes,
    activityTypes,
    inboxTypes,
    roleStatuses,
    roleContracts,
    inboxWorkflowDefinitions,
    observabilityMigration,
    observabilityMigrationFile,
    observabilityColumns,
    observabilityTables,
    workflowColumns,
    counters,
    rlsAutoTrigger,
    rlsFunctionSearchPath,
    rlsProtectedTables,
    publicTablesWithoutRls: publicTablesWithoutRls.length,
    ownedSequences: ownedSequences.length,
    unsafeSequences: unsafeSequences.length
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
