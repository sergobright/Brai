#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");
const [command, ...argv] = process.argv.slice(2);
const args = parseArgs(argv);
const LEGACY_DATABASE_ENV_KEYS = new Set([
  "BRAI_DATA_STORE",
  "BRAI_DB",
  "BRAI_LEGACY_SQLITE_PATH",
]);
const MIGRATION_TABLES = new Set(["schema_migrations", "supabase_migration_files"]);
const TEST_DATA_COPY_EXCLUDED_TABLES = new Set([
  "account",
  "session",
  "verification"
]);

if (command === "preview-env") {
  const branch = required(args, "branch");
  const envFile = required(args, "runtime-env");
  const name = args.name || (isSelfHosted() ? previewSchemaName(branch) : previewBranchName(branch));
  const { databaseUrl, details } = isSelfHosted()
    ? await ensureSelfHostedSchema(name)
    : ensureCloudBranch(name, { persistent: false, withData: false });
  assertBranchReady(name, details, databaseUrl);
  upsertEnvFile(envFile, {
    BRAI_DATABASE_URL: databaseUrl,
    BRAI_SUPABASE_BRANCH: name,
    BRAI_TEST_AUTO_LOGIN: "true"
  });
  await applyMigrations(databaseUrl);
  const seededFromProduction = await seedTestDataFromProduction(databaseUrl);
  if (!seededFromProduction) await applyPreviewSeed(databaseUrl);
  updatePreviewRegistry(branch, name, details);
  console.log(JSON.stringify({ ok: true, branch: name, id: branchId(details), status: branchStatus(details), envFile, seededFromProduction }, null, 2));
} else if (command === "dev-env") {
  const envFile = required(args, "runtime-env");
  const name = args.name || (isSelfHosted() ? "brai_dev" : "brai-dev");
  const { databaseUrl, details } = isSelfHosted()
    ? await ensureSelfHostedSchema(name)
    : ensureCloudBranch(name, { persistent: true, withData: true });
  assertBranchReady(name, details, databaseUrl);
  upsertEnvFile(envFile, {
    BRAI_DATABASE_URL: databaseUrl,
    BRAI_SUPABASE_BRANCH: name,
    BRAI_TEST_AUTO_LOGIN: "true"
  });
  await applyMigrations(databaseUrl);
  const seededFromProduction = await seedTestDataFromProduction(databaseUrl);
  console.log(JSON.stringify({ ok: true, branch: name, envFile, seededFromProduction }, null, 2));
} else if (command === "delete-preview") {
  const branch = required(args, "branch");
  const name = args.name || (isSelfHosted() ? previewSchemaName(branch) : previewBranchName(branch));
  if (isSelfHosted()) {
    const deleted = await dropSelfHostedSchema(name);
    console.log(JSON.stringify({ ok: true, branch: name, deleted }, null, 2));
  } else {
    const projectRef = requiredEnv("SUPABASE_PROJECT_REF");
    const get = runSupabase(["branches", "get", name, "--project-ref", projectRef], { allowFailure: true });
    if (get.status !== 0) {
      if (!isMissingBranch(get)) throw new Error(`Cannot verify Supabase preview branch before delete: ${get.stderr || get.stdout}`);
      console.log(JSON.stringify({ ok: true, branch: name, deleted: false }, null, 2));
      process.exit(0);
    }
    runSupabase(["branches", "delete", name, "--project-ref", projectRef]);
    console.log(JSON.stringify({ ok: true, branch: name, deleted: true }, null, 2));
  }
} else if (command === "migrate") {
  const databaseUrl = args["postgres-url"] || process.env.BRAI_DATABASE_URL;
  await applyMigrations(databaseUrl);
  console.log(JSON.stringify({ ok: true, migrated: true }, null, 2));
} else {
  throw new Error("usage: supabase-branch.mjs preview-env --branch <codex/...> --runtime-env <path> | dev-env --runtime-env <path> | delete-preview --branch <codex/...> | migrate --postgres-url <url>");
}

function ensureCloudBranch(name, { persistent, withData }) {
  const projectRef = requiredEnv("SUPABASE_PROJECT_REF");
  ensureBranch(name, { projectRef, persistent, withData });
  const details = waitForBranch(name, projectRef);
  const env = branchEnv(name, projectRef);
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL ?? env.SUPABASE_DB_URL;
  return { databaseUrl, details };
}

function ensureBranch(name, { projectRef, persistent, withData }) {
  const get = runSupabase(["branches", "get", name, "--project-ref", projectRef], { allowFailure: true });
  if (get.status === 0) return;
  const args = ["branches", "create", name, "--project-ref", projectRef];
  if (persistent) args.push("--persistent");
  if (withData) args.push("--with-data");
  runSupabase(args);
}

async function ensureSelfHostedSchema(name) {
  const adminUrl = selfHostedDatabaseUrl();
  const databaseUrl = databaseUrlWithSearchPath(adminUrl, name);
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") {
    return { databaseUrl, details: { id: name, status: "ready" } };
  }
  const pool = new Pool({ connectionString: adminUrl, ssl: postgresSsl(adminUrl) });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await pool.end();
  }
  return { databaseUrl, details: { id: name, status: "ready" } };
}

async function dropSelfHostedSchema(name) {
  const adminUrl = selfHostedDatabaseUrl();
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") return true;
  const pool = new Pool({ connectionString: adminUrl, ssl: postgresSsl(adminUrl) });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(name)} CASCADE`);
  } finally {
    await pool.end();
  }
  return true;
}

function waitForBranch(name, projectRef) {
  const attempts = Number(process.env.BRAI_SUPABASE_BRANCH_WAIT_ATTEMPTS || 60);
  let details = {};
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    details = branchDetails(name, projectRef);
    const status = branchStatus(details);
    if (!status || /active|available|healthy|ready/i.test(status)) return details;
    runSleep(attempt);
  }
  return details;
}

function branchEnv(name, projectRef) {
  const explicit = process.env.SUPABASE_BRANCH_DATABASE_URL;
  if (explicit) return { DATABASE_URL: checkedExplicitDatabaseUrl(explicit, name) };
  for (const outputArgs of [["-o", "env"], ["--output", "env"]]) {
    const result = runSupabase(["branches", "get", name, "--project-ref", projectRef, ...outputArgs], { allowFailure: true });
    const env = parseEnv(result.stdout);
    if (env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DB_URL) return env;
  }
  const details = branchDetails(name, projectRef);
  const databaseUrl = findDatabaseUrl(details);
  return databaseUrl ? { DATABASE_URL: databaseUrl } : {};
}

function checkedExplicitDatabaseUrl(databaseUrl, name) {
  if (process.env.BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE !== "true") {
    throw new Error("SUPABASE_BRANCH_DATABASE_URL requires BRAI_ALLOW_SUPABASE_BRANCH_DATABASE_URL_OVERRIDE=true");
  }
  const text = String(databaseUrl);
  if (!/^postgres(?:ql)?:\/\//.test(text)) {
    throw new Error("SUPABASE_BRANCH_DATABASE_URL must be a Postgres URL");
  }
  const decoded = decodeURIComponent(text);
  if (!decoded.includes(name)) {
    throw new Error(`SUPABASE_BRANCH_DATABASE_URL must include expected branch/schema marker: ${name}`);
  }
  return text;
}

function branchDetails(name, projectRef) {
  for (const outputArgs of [["-o", "json"], ["--output", "json"], []]) {
    const result = runSupabase(["branches", "get", name, "--project-ref", projectRef, ...outputArgs], { allowFailure: true });
    const parsed = parseJson(result.stdout);
    if (parsed) return parsed;
  }
  return {};
}

async function applyMigrations(databaseUrl) {
  if (process.env.BRAI_SUPABASE_APPLY_MIGRATIONS === "false") return;
  if (!databaseUrl) throw new Error("Cannot apply Supabase migrations without BRAI_DATABASE_URL");
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") return;
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS supabase_migration_files (
        version text PRIMARY KEY,
        name text NOT NULL,
        applied_at_utc timestamptz NOT NULL DEFAULT now()
      )
    `);
    const migrationsDir = path.join(root, "supabase/migrations");
    for (const entry of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      const version = entry.match(/^(\d+)/)?.[1] || "";
      if (!version) throw new Error(`Invalid Supabase migration filename: ${entry}`);
      const existing = await pool.query("SELECT 1 FROM supabase_migration_files WHERE version = $1", [version]);
      if (existing.rows.length > 0) continue;
      await pool.query(fs.readFileSync(path.join(migrationsDir, entry), "utf8"));
      await pool.query(
        "INSERT INTO supabase_migration_files (version, name, applied_at_utc) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING",
        [version, entry]
      );
    }
  } finally {
    await pool.end();
  }
}

async function applyPreviewSeed(databaseUrl) {
  if (process.env.BRAI_SUPABASE_APPLY_PREVIEW_SEED === "false") return;
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") return;
  const seedPath = path.join(root, "supabase/preview_seed.sql");
  if (!fs.existsSync(seedPath)) return;
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    await pool.query(fs.readFileSync(seedPath, "utf8"));
  } finally {
    await pool.end();
  }
}

async function seedTestDataFromProduction(targetDatabaseUrl) {
  if (process.env.BRAI_SUPABASE_SEED_FROM_PROD === "false") return false;
  if (!isSelfHosted()) return false;
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") return true;
  const sourceDatabaseUrl = process.env.BRAI_PROD_DATABASE_URL || process.env.BRAI_DATABASE_URL || "";
  if (!sourceDatabaseUrl) throw new Error("BRAI_PROD_DATABASE_URL is required to seed test data from production");

  const sourceSchema = searchPathSchema(sourceDatabaseUrl);
  const targetSchema = searchPathSchema(targetDatabaseUrl);
  if (sourceSchema === targetSchema) {
    throw new Error(`Refusing to seed test data: source and target schema are both ${sourceSchema}`);
  }

  const adminUrl = selfHostedDatabaseUrl();
  const pool = new Pool({ connectionString: adminUrl, ssl: postgresSsl(adminUrl) });
  try {
    await copySchemaData(pool, { sourceSchema, targetSchema });
  } finally {
    await pool.end();
  }
  return true;
}

async function copySchemaData(pool, { sourceSchema, targetSchema }) {
  const targetTables = await schemaTables(pool, targetSchema);
  const truncatableTables = targetTables.filter((table) => !MIGRATION_TABLES.has(table));
  if (truncatableTables.length === 0) return;

  const sourceTables = new Set(await schemaTables(pool, sourceSchema));
  const copyTables = orderedTables(
    truncatableTables.filter((table) => sourceTables.has(table) && !TEST_DATA_COPY_EXCLUDED_TABLES.has(table))
  );

  await pool.query("BEGIN");
  try {
    await pool.query(`TRUNCATE TABLE ${truncatableTables.map((table) => qualifiedTable(targetSchema, table)).join(", ")} RESTART IDENTITY CASCADE`);
    for (const table of copyTables) {
      const columns = await commonColumns(pool, sourceSchema, targetSchema, table);
      if (columns.length === 0) continue;
      const columnList = columns.map(quoteIdentifier).join(", ");
      await pool.query(`
        INSERT INTO ${qualifiedTable(targetSchema, table)} (${columnList})
        OVERRIDING SYSTEM VALUE
        SELECT ${columnList}
        FROM ${qualifiedTable(sourceSchema, table)}
      `);
    }
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}

async function schemaTables(pool, schema) {
  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, [schema]);
  return result.rows.map((row) => row.table_name);
}

async function commonColumns(pool, sourceSchema, targetSchema, table) {
  const result = await pool.query(`
    SELECT target.column_name
    FROM information_schema.columns target
    JOIN information_schema.columns source
      ON source.table_schema = $1
     AND source.table_name = target.table_name
     AND source.column_name = target.column_name
    WHERE target.table_schema = $2
      AND target.table_name = $3
    ORDER BY target.ordinal_position
  `, [sourceSchema, targetSchema, table]);
  return result.rows.map((row) => row.column_name);
}

function orderedTables(tables) {
  const order = new Map(migrationTableOrder().map((table, index) => [table, index]));
  return [...tables].sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.localeCompare(right);
  });
}

function migrationTableOrder() {
  const migrationsDir = path.join(root, "supabase/migrations");
  const names = [];
  for (const entry of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(migrationsDir, entry), "utf8");
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+("[^"]+"|[a-z_][a-z0-9_]*)/gi)) {
      names.push(match[1].replace(/^"|"$/g, "").replaceAll('""', '"'));
    }
  }
  return names;
}

function searchPathSchema(databaseUrl) {
  const options = new URL(databaseUrl).searchParams.get("options") || "";
  const match = options.match(/search_path=([^,\s]+)/);
  return match?.[1] || "public";
}

function qualifiedTable(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function runSupabase(args, { allowFailure = false } = {}) {
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") {
    if (args.includes("json")) return { status: 0, stdout: JSON.stringify({ id: "dry-run", name: args[2], status: "healthy" }), stderr: "" };
    return { status: 0, stdout: "DATABASE_URL=postgres://dry-run/dry-run\n", stderr: "" };
  }
  const defaultBin = fs.existsSync("/srv/opt/supabase-cli/supabase") ? "/srv/opt/supabase-cli/supabase" : "supabase";
  const bin = process.env.SUPABASE_CLI ?? defaultBin;
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: process.env
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function isSelfHosted() {
  return /^(1|true|yes)$/i.test(String(process.env.SUPABASE_SELF_HOSTED ?? ""));
}

function selfHostedDatabaseUrl() {
  return process.env.SUPABASE_SELF_HOSTED_DATABASE_URL
    || process.env.BRAI_PROD_DATABASE_URL
    || process.env.BRAI_DATABASE_URL
    || requiredEnv("SUPABASE_SELF_HOSTED_DATABASE_URL");
}

function databaseUrlWithSearchPath(databaseUrl, schema) {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  const option = `-c search_path=${schema},public`;
  url.searchParams.set("options", [existing, option].filter(Boolean).join(" "));
  return url.toString();
}

function runSleep(attempt) {
  if (process.env.BRAI_SUPABASE_DRY_RUN === "true") return;
  const seconds = Math.min(10, Math.max(1, attempt));
  spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
}

function parseEnv(raw) {
  const values = {};
  for (const line of String(raw).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw || "").trim());
  } catch {
    return null;
  }
}

function findDatabaseUrl(value) {
  if (!value || typeof value !== "object") return "";
  for (const [key, child] of Object.entries(value)) {
    if (/database.*url|postgres.*url|connection.*string/i.test(key) && /^postgres(?:ql)?:\/\//.test(String(child))) {
      return String(child);
    }
    const nested = findDatabaseUrl(child);
    if (nested) return nested;
  }
  return "";
}

function updatePreviewRegistry(branch, name, details) {
  const script = path.join(import.meta.dirname, "preview-slots.sh");
  if (!fs.existsSync(script)) return;
  const result = spawnSync(script, ["supabase", branch, name, branchId(details), branchStatus(details)], {
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) throw new Error(`preview-slots.sh supabase failed: ${result.stderr || result.stdout}`);
}

function assertBranchReady(name, details, databaseUrl) {
  if (!/^postgres(?:ql)?:\/\//.test(String(databaseUrl ?? ""))) throw new Error(`Supabase branch ${name} did not provide a Postgres database URL`);
  if (!branchId(details)) throw new Error(`Supabase branch ${name} did not provide a branch id`);
  if (!branchStatus(details)) throw new Error(`Supabase branch ${name} did not provide a branch status`);
}

function isMissingBranch(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
  return /not found|does not exist|no branch|404/.test(text);
}

function branchId(details) {
  return String(details?.id ?? details?.branch_id ?? "");
}

function branchStatus(details) {
  return String(details?.status ?? details?.state ?? details?.health ?? "");
}

function upsertEnvFile(filePath, values) {
  if (!values.BRAI_DATABASE_URL) throw new Error("Supabase branch env did not include a database URL");
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split(/\r?\n/) : [];
  const keys = new Set(Object.keys(values));
  const kept = existing.map((line) => normalizeEnvLine(line, keys)).filter(Boolean);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${[...kept, ...Object.entries(values).map(([key, value]) => `${key}=${shellQuote(value)}`)].join("\n")}\n`);
}

function normalizeEnvLine(line, replacedKeys) {
  if (line.trim() === "") return "";
  if (/^\s*#/.test(line)) return line;
  const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
  if (!match) return "";
  const [, key, rawValue] = match;
  if (replacedKeys.has(key) || LEGACY_DATABASE_ENV_KEYS.has(key)) return "";
  return `${key}=${shellQuote(parseEnvValue(rawValue))}`;
}

function parseEnvValue(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return trimmed;
}

function previewBranchName(branch) {
  const slug = branch.replace(/^codex\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 32);
  const hash = crypto.createHash("sha1").update(branch).digest("hex").slice(0, 8);
  return `brai-preview-${slug}-${hash}`;
}

function previewSchemaName(branch) {
  const slug = branch.replace(/^codex\//, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 34);
  const hash = crypto.createHash("sha1").update(branch).digest("hex").slice(0, 8);
  return `brai_preview_${slug || "branch"}_${hash}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error(`invalid argument: ${key}`);
    parsed[key.slice(2)] = values[index + 1] ?? "";
    index += 1;
  }
  return parsed;
}

function required(values, key) {
  if (!values[key]) throw new Error(`missing --${key}`);
  return values[key];
}

function requiredEnv(key) {
  if (!process.env[key]) throw new Error(`${key} is required`);
  return process.env[key];
}
