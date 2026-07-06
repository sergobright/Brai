#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const requireFromApi = createRequire(path.join(repoRoot, "services/brai_api/package.json"));
const { Pool } = requireFromApi("pg");

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const options = {
    kind: args.kind,
    root: args.root,
    environment: args.environment,
    postgresUrl: args["postgres-url"] || process.env.BRAI_DATABASE_URL || "",
    prodPostgresUrl: args["prod-postgres-url"] || process.env.BRAI_PROD_DATABASE_URL || "",
    prodWebVersionJson: args["prod-web-version-json"],
    mobileTarget: args["mobile-target"],
    nextOta: args["next-ota"] === "true",
    nextApk: args["next-apk"] === "true",
    targetBranch: args["target-branch"],
    targetCommit: args["target-commit"],
  };
  const value = await resolveAppVersionAsync(options);
  console.log(value);
}

export function resolveAppVersion({
  kind = "ota",
  explicit = kind === "apk" ? process.env.BRAI_APK_VERSION || "" : process.env.BRAI_APP_VERSION || "",
} = {}) {
  if (kind === "apk" && explicit) return validApkVersion(explicit);
  if (explicit) return validOtaVersion(explicit);
  if (kind === "apk") throw new Error("Unable to resolve Brai APK version; set BRAI_APK_VERSION or provide BRAI_DATABASE_URL");
  throw new Error("Unable to resolve Brai X.Y.Z OTA version; set BRAI_APP_VERSION or provide BRAI_DATABASE_URL");
}

export async function resolveAppVersionAsync(options = {}) {
  const {
    kind = "ota",
    environment = process.env.NEXT_PUBLIC_BRAI_ENVIRONMENT || "",
    postgresUrl = process.env.BRAI_DATABASE_URL || "",
    prodPostgresUrl = process.env.BRAI_PROD_DATABASE_URL || "",
    explicit = kind === "apk" ? process.env.BRAI_APK_VERSION || "" : process.env.BRAI_APP_VERSION || "",
    nextOta = false,
    nextApk = false,
    targetBranch = "",
    targetCommit = "",
    prodWebVersionJson = "",
    mobileTarget = "",
  } = options;

  if (kind === "apk") {
    return validApkVersion(explicit || await resolveApkVersionPg(postgresUrl || prodPostgresUrl, { nextApk, targetBranch, targetCommit }));
  }
  if (explicit) return validOtaVersion(explicit);
  if (!postgresUrl && !prodPostgresUrl) {
    throw new Error("BRAI_DATABASE_URL or BRAI_PROD_DATABASE_URL is required to resolve Brai OTA version");
  }

  const ledgerVersions = [
    postgresUrl && await latestBuildOtaVersionPg(postgresUrl),
    prodPostgresUrl && await latestBuildOtaVersionPg(prodPostgresUrl),
  ];
  const deployedVersions = [
    environment !== "prod" && prodWebVersionJson && readVersionJson(prodWebVersionJson),
    mobileTarget && latestMobileTargetVersion(mobileTarget),
  ];
  if (nextOta) return nextPatchVersion(latestOtaVersion([...ledgerVersions, ...deployedVersions]));

  const ledgerVersion = latestOtaVersion(ledgerVersions);
  if (ledgerVersion) return validOtaVersion(ledgerVersion);

  const deployedVersion = latestOtaVersion(deployedVersions);
  if (deployedVersion) return validOtaVersion(deployedVersion);
  throw new Error("Unable to resolve Brai X.Y.Z OTA version; set BRAI_APP_VERSION or provide build ledger/deployed mobile metadata");
}

async function resolveApkVersionPg(databaseUrl, { nextApk = false, targetBranch = "", targetCommit = "" } = {}) {
  if (!databaseUrl) throw new Error("BRAI_DATABASE_URL is required to resolve Brai APK version");
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    const latest = await pool.query("SELECT COALESCE(MAX(version), 0) AS apk FROM build_versions WHERE version_type_id = 'apk'");
    let apk = Number(latest.rows[0]?.apk || 0);
    if (nextApk) {
      const existing = targetCommit
        ? await pool.query(`
            SELECT version
            FROM build_version_refs
            WHERE version_type_id = 'apk'
              AND target_branch = $1
              AND target_commit = $2
            ORDER BY version DESC
            LIMIT 1
          `, [targetBranch || "", targetCommit])
        : null;
      apk = Number(existing?.rows[0]?.version || 0) || apk + 1;
    }
    return String(apk || 1);
  } finally {
    await pool.end();
  }
}

async function latestBuildOtaVersionPg(databaseUrl) {
  if (!databaseUrl) return "";
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    const build = await pool.query("SELECT COALESCE(MAX(version), 0) AS build FROM build_versions WHERE version_type_id = 'build'");
    const value = Number(build.rows[0]?.build || 0);
    return value > 0 ? `0.0.${value}` : "";
  } finally {
    await pool.end();
  }
}

function readVersionJson(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return parsed.otaVersion || parsed.version || "";
}

function latestMobileTargetVersion(mobileTarget) {
  const versions = [];
  const manifestPath = path.join(mobileTarget, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    versions.push(manifest.otaVersion || "");
  }

  const bundlesPath = path.join(mobileTarget, "bundles");
  if (fs.existsSync(bundlesPath)) {
    for (const entry of fs.readdirSync(bundlesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      versions.push(entry.name);
      const metadataPath = path.join(bundlesPath, entry.name, "metadata.json");
      if (fs.existsSync(metadataPath)) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        versions.push(metadata.otaVersion || "");
      }
    }
  }

  return latestOtaVersion(versions);
}

function latestOtaVersion(values) {
  return values.reduce((latest, value) => {
    const version = normalizeOtaVersion(value);
    if (!version) return latest;
    return compareOtaVersions(version, latest) > 0 ? version : latest;
  }, "");
}

function normalizeOtaVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)(?:$|[._+-].*)/);
  return match ? match.slice(1, 4).join(".") : "";
}

function compareOtaVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = (right || "0.0.0").split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function validOtaVersion(version) {
  const normalized = normalizeOtaVersion(version);
  if (!normalized) throw new Error(`Invalid Brai X.Y.Z OTA version: ${version}`);
  return normalized;
}

function nextPatchVersion(version) {
  const normalized = validOtaVersion(version);
  const parts = normalized.split(".").map(Number);
  parts[2] += 1;
  return parts.join(".");
}

function validApkVersion(version) {
  const value = Number(version);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid Brai APK version: ${version}`);
  return String(value);
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

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl) ? { rejectUnauthorized: false } : false;
}
