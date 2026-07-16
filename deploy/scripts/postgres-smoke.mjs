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

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: postgresSsl(databaseUrl),
  max: Number(process.env.BRAI_POSTGRES_SMOKE_POOL_MAX || 1)
});
try {
  const runtimeSchema = await scalar("SELECT current_schema()");
  const schemaParam = [runtimeSchema];
  const checks = await Promise.all([
    scalar("SELECT 1"),
    scalar("SELECT COUNT(*)::int FROM schema_migrations"),
    scalar("SELECT COUNT(*)::int FROM supabase_migration_files"),
    scalar("SELECT COUNT(*)::int FROM version_types WHERE id IN ('apk', 'build', 'macos', 'ios')"),
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
          ('workflow_executions', 'trace_status'),
          ('workflow_execution_steps', 'step_key'),
          ('workflow_worker_heartbeats', 'last_seen_at_utc')
        )
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
    scalar("SELECT COUNT(*)::int FROM build_version_counters WHERE version_type_id IN ('apk', 'build') AND (SELECT COUNT(*) FROM build_version_counters) = 2"),
    scalar("SELECT COUNT(*)::int FROM schema_migrations WHERE version = 67"),
    scalar("SELECT COUNT(*)::int FROM supabase_migration_files WHERE version = '0033' AND name = '0033_normalize_version_work_history.sql'"),
    scalar(`
      SELECT COUNT(*)::int
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (
          'release_works',
          'github_pull_requests',
          'build_version_details',
          'build_version_pull_requests'
        )
    `),
    scalar(`
      SELECT COUNT(*)::int
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('build_versions', 'release_works_id'),
          ('release_works', 'work_key'),
          ('github_pull_requests', 'work_role'),
          ('build_version_details', 'display_order'),
          ('build_version_pull_requests', 'version_type_id')
        )
    `),
    scalar(`
      SELECT COUNT(*)::int
      FROM build_versions AS versions
      WHERE NOT EXISTS (
        SELECT 1 FROM build_version_details AS details
        WHERE details.build_versions_id = versions.id
      )
    `),
    scalar(`
      SELECT COUNT(*)::int
      FROM build_versions AS versions
      WHERE (
        (versions.version_type_id = 'build' AND versions.version <= 148)
        OR (versions.version_type_id = 'apk' AND versions.version <= 11)
      )
        AND EXISTS (
          SELECT 1 FROM build_version_details AS details
          WHERE details.build_versions_id = versions.id
        )
    `),
    scalar("SELECT COUNT(*)::int FROM github_pull_requests WHERE github_merged_at_utc IS NOT NULL"),
    scalar(`
      SELECT COUNT(*)::int
      FROM build_versions AS versions
      JOIN build_version_pull_requests AS links
        ON links.build_versions_id = versions.id
       AND links.version_type_id = versions.version_type_id
      JOIN github_pull_requests AS pulls ON pulls.id = links.github_pull_requests_id
      WHERE versions.version_type_id = 'apk'
        AND versions.version = 11
        AND pulls.repository = 'sergobright/Brai'
        AND pulls.pull_number = 279
        AND EXISTS (
          SELECT 1 FROM build_version_refs AS refs
          WHERE refs.version_type_id = versions.version_type_id
            AND refs.version = versions.version
            AND refs.target_branch = 'main'
            AND refs.target_commit = '3e30f42f7d2d35a7865b425dfa116a58d816a92f'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM build_version_pull_requests AS wrong_links
          JOIN github_pull_requests AS wrong_pulls ON wrong_pulls.id = wrong_links.github_pull_requests_id
          WHERE wrong_links.build_versions_id = versions.id
            AND wrong_pulls.repository = 'sergobright/Brai'
            AND wrong_pulls.pull_number = 282
        )
    `),
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
    workflowObservabilityColumns,
    workflowColumns,
    counters,
    versionHistoryMigration,
    versionHistoryMigrationFile,
    versionHistoryTables,
    versionHistoryColumns,
    versionsWithoutDetails,
    cutoffVersionsWithDetails,
    importedMergedPulls,
    apk11Correction,
    rlsAutoTrigger,
    rlsFunctionSearchPath,
    rlsProtectedTables,
    publicTablesWithoutRls
  ] = checks;
  if (ping !== 1) throw new Error("Postgres ping failed");
  if (migrations < 1) throw new Error("schema_migrations is empty");
  if (supabaseMigrations < 1) throw new Error("supabase_migration_files is empty");
  if (versionTypes !== 4) throw new Error("version_types seed is incomplete");
  if (activityTypes !== 2) throw new Error("activity_types seed is incomplete");
  if (inboxTypes < 4) throw new Error("inbox_record_types seed is incomplete");
  if (roleStatuses !== 3) throw new Error("role_statuses seed is incomplete");
  if (roleContracts < 3) throw new Error("role_contracts seed is incomplete");
  if (inboxWorkflowDefinitions !== 1) throw new Error("Inbox workflow definition is missing");
  if (observabilityMigration !== 1 || observabilityMigrationFile !== 1) throw new Error("Workflow observability migration history is incomplete");
  if (workflowObservabilityColumns !== 4) throw new Error("Workflow observability schema is incomplete");
  if (workflowColumns !== 6) throw new Error("Agent role workflow columns are incomplete");
  if (counters !== 2) throw new Error("build_version_counters seed is incomplete");
  if (versionHistoryMigration !== 1 || versionHistoryMigrationFile !== 1) throw new Error("Version history migration is incomplete");
  if (versionHistoryTables !== 4 || versionHistoryColumns !== 5) throw new Error("Version history schema is incomplete");
  if (versionsWithoutDetails !== 0) throw new Error(`Version history contains ${versionsWithoutDetails} parent versions without details`);
  if (cutoffVersionsWithDetails !== 159) throw new Error(`Version history cutoff backfill is incomplete: ${cutoffVersionsWithDetails}/159 versions have details`);
  if (importedMergedPulls < 288) throw new Error(`Version history PR cutoff backfill is incomplete: ${importedMergedPulls}/288 merged PRs imported`);
  if (apk11Correction !== 1) throw new Error("APK v11 is not linked exclusively to PR #279 and its corrected ref");
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
    workflowObservabilityColumns,
    workflowColumns,
    counters,
    versionHistoryMigration,
    versionHistoryMigrationFile,
    versionHistoryTables,
    versionHistoryColumns,
    versionsWithoutDetails,
    cutoffVersionsWithDetails,
    importedMergedPulls,
    apk11Correction,
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
