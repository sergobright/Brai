#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PROD_SUPAVISOR_TENANT = "brightos-prod";
export const NONPROD_SUPAVISOR_TENANT = "brightos-nonprod";
const KNOWN_TENANTS = ["brightos", PROD_SUPAVISOR_TENANT, NONPROD_SUPAVISOR_TENANT];

export function tenantIsolationEnabled(env = process.env) {
  return /^(1|true|yes)$/i.test(String(env.BRAI_SUPAVISOR_TENANT_ISOLATION ?? ""));
}

export function expectedSupavisorTenant(environment) {
  if (environment === "prod") return PROD_SUPAVISOR_TENANT;
  if (environment === "dev" || /^preview-[a-e]$/.test(environment)) return NONPROD_SUPAVISOR_TENANT;
  throw new Error(`Unsupported Brai environment: ${environment}`);
}

export function databaseUsernameWithoutKnownTenant(username) {
  const suffix = KNOWN_TENANTS.find((tenant) => username.endsWith(`.${tenant}`));
  return suffix ? username.slice(0, -(suffix.length + 1)) : username;
}

export function databaseUrlForSupavisorTenant(databaseUrl, tenant) {
  if (!KNOWN_TENANTS.includes(tenant)) throw new Error(`Unsupported Supavisor tenant: ${tenant}`);
  const url = postgresUrl(databaseUrl);
  const databaseUser = databaseUsernameWithoutKnownTenant(url.username);
  if (!databaseUser) throw new Error("Postgres URL username is required");
  url.username = `${databaseUser}.${tenant}`;
  return url.toString();
}

export function assertDatabaseUrlTenant(databaseUrl, environment, env = process.env) {
  if (!tenantIsolationEnabled(env)) return;
  const expected = expectedSupavisorTenant(environment);
  const actual = postgresUrl(databaseUrl).username;
  if (!actual.endsWith(`.${expected}`)) {
    throw new Error(`${environment} BRAI_DATABASE_URL must use Supavisor tenant ${expected}`);
  }
}

export function rewriteEnvDatabaseUrl(filePath, { key = "BRAI_DATABASE_URL", tenant, ifPresent = false } = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe environment file: ${filePath}`);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let replacements = 0;
  const updated = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) return line;
    replacements += 1;
    return `${key}=${shellQuote(databaseUrlForSupavisorTenant(parseEnvValue(match[2]), tenant))}`;
  });
  if (replacements > 1) throw new Error(`Duplicate ${key} in ${filePath}`);
  if (replacements === 0) {
    if (ifPresent) return false;
    throw new Error(`${key} is missing in ${filePath}`);
  }
  writeEnvFile(filePath, updated.join("\n"), stat);
  return true;
}

export function upsertEnvValue(filePath, key, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
  if (/[\r\n]/.test(value)) throw new Error("Environment value must be one line");
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe environment file: ${filePath}`);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  let replacements = 0;
  const updated = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) return line;
    replacements += 1;
    return `${key}=${shellQuote(value)}`;
  });
  if (replacements > 1) throw new Error(`Duplicate ${key} in ${filePath}`);
  if (replacements === 0) updated.splice(updated.at(-1) === "" ? -1 : updated.length, 0, `${key}=${shellQuote(value)}`);
  writeEnvFile(filePath, updated.join("\n"), stat);
}

function writeEnvFile(filePath, contents, stat) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempPath, contents, { mode: stat.mode & 0o777 });
    fs.chmodSync(tempPath, stat.mode & 0o777);
    fs.chownSync(tempPath, stat.uid, stat.gid);
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function postgresUrl(value) {
  const url = new URL(String(value ?? ""));
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Expected a Postgres URL");
  }
  return url;
}

function parseEnvValue(value) {
  const trimmed = String(value).trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("'\\''", "'");
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return trimmed;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) values[key] = true;
    else {
      values[key] = value;
      index += 1;
    }
  }
  return values;
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (command === "assert-url") {
    assertDatabaseUrlTenant(process.env.BRAI_DATABASE_URL, String(args.environment ?? ""));
    return;
  }
  if (command === "rewrite-env") {
    rewriteEnvDatabaseUrl(String(args.file ?? ""), {
      key: String(args.key ?? "BRAI_DATABASE_URL"),
      tenant: String(args.tenant ?? ""),
      ifPresent: args["if-present"] === true,
    });
    return;
  }
  if (command === "set-env") {
    upsertEnvValue(String(args.file ?? ""), String(args.key ?? ""), String(args.value ?? ""));
    return;
  }
  throw new Error("usage: supavisor-tenants.mjs assert-url --environment <prod|dev|preview-a..e> | rewrite-env --file <path> [--key KEY] --tenant <tenant> [--if-present] | set-env --file <path> --key KEY --value VALUE");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
