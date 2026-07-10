#!/usr/bin/env node
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const branch = required(args, "branch");
  const runId = args.run || "";
  const legacyBeforeHours = Number(args["legacy-before-hours"] || 0);
  if (!Number.isFinite(legacyBeforeHours) || legacyBeforeHours < 0) throw new Error("legacy-before-hours must be a non-negative number");
  const databaseUrl = process.env.BRAI_TEST_DATABASE_URL
    || process.env.SUPABASE_SELF_HOSTED_DATABASE_URL
    || process.env.BRAI_PROD_DATABASE_URL
    || process.env.BRAI_DATABASE_URL;
  if (!databaseUrl) throw new Error("A Postgres database URL is required to clean test schemas");

  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    const result = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'brai_test_%'");
    const schemas = selectTestSchemas(result.rows.map((row) => row.nspname), {
      branch,
      runId,
      legacyBeforeMs: legacyBeforeHours * 60 * 60 * 1000
    });
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    console.log(JSON.stringify({ ok: true, branch, runId: runId || null, deleted: schemas }));
  } finally {
    await pool.end();
  }
}

export function selectTestSchemas(names, { branch, runId = "", legacyBeforeMs = 0, now = Date.now() }) {
  const prefix = `brai_test_${scopeHash(branch)}_${runId ? `${scopeHash(runId)}_` : ""}`;
  const legacyCutoff = now - legacyBeforeMs;
  return names.filter((name) => {
    if (name.startsWith(prefix)) return true;
    if (!legacyBeforeMs || runId) return false;
    const legacy = name.match(/^brai_test_\d+_(\d{13})_[a-f0-9]+$/);
    return legacy ? Number(legacy[1]) <= legacyCutoff : false;
  }).sort();
}

export function scopeHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 12);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] == null) throw new Error(`invalid argument: ${key || "<empty>"}`);
    parsed[key.slice(2)] = values[index + 1];
  }
  return parsed;
}

function required(args, key) {
  const value = String(args[key] || "").trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
