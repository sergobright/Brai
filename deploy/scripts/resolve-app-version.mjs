#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const requireFromApi = createRequire(path.join(repoRoot, "services/brai_api/package.json"));

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
    ancestorCommits: args["ancestor-commits"],
    baseCommit: args["base-commit"] || process.env.BRAI_BASE_COMMIT || "",
    clientArtifactChanged: args["client-artifact-changed"] || process.env.BRAI_CLIENT_ARTIFACT_CHANGE || "",
  };
  const value = await resolveAppVersionAsync(options);
  console.log(value);
}

export function resolveAppVersion({
  kind = "ota",
  explicit = kind === "apk"
    ? process.env.BRAI_APK_VERSION || ""
    : kind === "product"
      ? process.env.BRAI_PRODUCT_VERSION || ""
      : process.env.BRAI_APP_VERSION || "",
} = {}) {
  if (kind === "apk" && explicit) return validApkVersion(explicit);
  if (kind === "product") return explicit ? validProductVersion(explicit) : "";
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
    explicit = kind === "apk"
      ? process.env.BRAI_APK_VERSION || ""
      : kind === "product"
        ? process.env.BRAI_PRODUCT_VERSION || ""
        : process.env.BRAI_APP_VERSION || "",
    nextOta = false,
    nextApk = false,
    targetBranch = "",
    targetCommit = process.env.BRAI_PRODUCT_BASE_COMMIT || "",
    ancestorCommits = process.env.BRAI_PRODUCT_ANCESTOR_COMMITS || "",
    prodWebVersionJson = "",
    mobileTarget = "",
    root = repoRoot,
    baseCommit = process.env.BRAI_BASE_COMMIT || "",
    clientArtifactChanged: changedHint = process.env.BRAI_CLIENT_ARTIFACT_CHANGE || "",
  } = options;

  if (kind === "apk") {
    return validApkVersion(explicit || await resolveApkVersionPg(postgresUrl || prodPostgresUrl, { nextApk, targetBranch, targetCommit }));
  }
  if (kind === "product") {
    if (explicit) return validProductVersion(explicit);
    return resolveProductVersionPg(postgresUrl || prodPostgresUrl, { targetCommit, ancestorCommits });
  }
  if (explicit) return validOtaVersion(explicit);
  const productVersion = await resolveProductVersionPg(prodPostgresUrl || postgresUrl, { targetCommit, ancestorCommits });
  const deployedVersions = [
    prodWebVersionJson && readVersionJson(prodWebVersionJson),
    mobileTarget && latestMobileTargetVersion(mobileTarget),
    productVersion && `0.0.${productVersion}`,
  ];
  if (changedHint && !["true", "false"].includes(changedHint)) throw new Error(`invalid client artifact change hint: ${changedHint}`);
  const shouldIncrement = nextOta || (environment === "prod" && (changedHint === "true" || clientArtifactChanged({ root, baseCommit })));
  if (shouldIncrement) return nextPatchVersion(latestOtaVersion(deployedVersions) || "0.0.0");

  const deployedVersion = latestOtaVersion(deployedVersions);
  if (deployedVersion) return validOtaVersion(deployedVersion);
  throw new Error("Unable to resolve Brai X.Y.Z OTA version; set BRAI_APP_VERSION or provide published web/mobile metadata");
}

async function resolveProductVersionPg(databaseUrl, { targetCommit = "", ancestorCommits = "" } = {}) {
  const commits = targetCommit ? [targetCommit] : productAncestorCommits(ancestorCommits);
  if (!databaseUrl || !commits.length) return "";
  const { Pool } = requireFromApi("pg");
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresSsl(databaseUrl) });
  try {
    const result = await pool.query(`
      SELECT version
      FROM build_version_refs
      WHERE version_type_id = 'build'
        AND LOWER(target_commit) = ANY($1::text[])
      ORDER BY version DESC
      LIMIT 1
    `, [commits.map((commit) => commit.toLowerCase())]);
    const version = Number(result.rows[0]?.version || 0);
    return version > 0 ? validProductVersion(version) : "";
  } finally {
    await pool.end();
  }
}

export function productAncestorCommits(value) {
  if (!value) return [];
  const commits = String(value).split(",");
  if (commits.some((commit) => !/^[0-9a-f]{40}$/i.test(commit))) {
    throw new Error("Invalid Brai Product ancestor commits");
  }
  return commits;
}

async function resolveApkVersionPg(databaseUrl, { nextApk = false, targetBranch = "", targetCommit = "" } = {}) {
  if (!databaseUrl) throw new Error("BRAI_DATABASE_URL is required to resolve Brai APK version");
  const { Pool } = requireFromApi("pg");
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
      const existingVersion = Number(existing?.rows[0]?.version || 0);
      if (existingVersion) apk = existingVersion;
      else if (targetBranch === "main" && process.env.BRAI_NATIVE_APK_CHANGE !== "true" && !await targetWorkHasApkBlock(pool, targetBranch, targetCommit)) apk = apk || 1;
      else apk += 1;
    }
    return String(apk || 1);
  } finally {
    await pool.end();
  }
}

async function targetWorkHasApkBlock(pool, targetBranch, targetCommit) {
  if (!targetCommit) return false;
  const result = await pool.query(`
    SELECT pulls.body
    FROM build_version_refs AS refs
    JOIN build_versions AS versions
      ON versions.version_type_id = refs.version_type_id AND versions.version = refs.version
    JOIN github_pull_requests AS pulls ON pulls.release_works_id = versions.release_works_id
    WHERE refs.version_type_id = 'build'
      AND refs.target_branch = $1
      AND refs.target_commit = $2
      AND (pulls.state = 'MERGED' OR pulls.github_merged_at_utc IS NOT NULL)
  `, [targetBranch || "", targetCommit]);
  return result.rows.some((row) => /<!--\s*brai-release-notes-v2[\s\S]*?"platforms"\s*:\s*\{[\s\S]*?"apk"\s*:/m.test(String(row.body ?? "")));
}

export function clientArtifactChanged({ root = repoRoot, baseCommit = "" } = {}) {
  if (!baseCommit || /^0{40}$/.test(baseCommit)) return false;
  let files;
  try {
    files = execFileSync("git", ["-C", root, "diff", "--name-only", `${baseCommit}..HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return false;
  }
  return files.some((file) => {
    if (!file.startsWith("apps/brai_app/")) return false;
    if (file.startsWith("apps/brai_app/android/") || file.startsWith("apps/brai_app/tests/") || file.includes("/__tests__/")) return false;
    return !/(?:^|\/)(?:README|.*\.md)$/.test(file);
  });
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

function validProductVersion(version) {
  const value = Number(version);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid Brai Product version: ${version}`);
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
