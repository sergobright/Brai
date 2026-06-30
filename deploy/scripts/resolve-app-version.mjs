#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const requireFromApi = createRequire(path.join(repoRoot, "services/bright_os_api/package.json"));
const Database = requireFromApi("better-sqlite3");
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  console.log(resolveAppVersion({
    root: args.root,
    environment: args.environment,
    db: args.db,
    prodDb: args["prod-db"],
    prodWebVersionJson: args["prod-web-version-json"],
    mobileTarget: args["mobile-target"],
    nextApk: args["next-apk"] === "true",
    targetBranch: args["target-branch"],
    targetCommit: args["target-commit"],
  }));
}

export function resolveAppVersion({
  root = process.env.BRIGHT_OS_ROOT || path.resolve(import.meta.dirname, "../.."),
  environment = process.env.NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT || "",
  db = "",
  prodDb = process.env.BRIGHT_OS_PROD_DB || "",
  prodWebVersionJson = "",
  mobileTarget = "",
  explicit = process.env.BRIGHT_OS_APP_VERSION || "",
  nextApk = false,
  targetBranch = "",
  targetCommit = "",
} = {}) {
  if (explicit) return validVersion(explicit);

  if (environment === "prod" && db) {
    const ledgerVersion = latestProductionVersion(db, { nextApk, targetBranch, targetCommit });
    if (ledgerVersion) return validVersion(ledgerVersion);
  }

  const resolvedVersion = latestBrightVersion([
    environment !== "prod" && prodDb && latestProductionVersion(prodDb),
    environment !== "prod" && db && latestProductionVersion(db),
    prodWebVersionJson && readVersionJson(prodWebVersionJson),
    mobileTarget && latestMobileTargetVersion(mobileTarget),
  ]);
  if (resolvedVersion) return validVersion(resolvedVersion);

  return validVersion(readVersionJson(path.join(root, "apps/bright_os_app/public/version.json")));
}

function validVersion(version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Bright OS X.Y.Z.S version: ${version}`);
  return version;
}

function latestProductionVersion(dbPath, { nextApk = false, targetBranch = "", targetCommit = "" } = {}) {
  if (!fs.existsSync(dbPath)) return "";
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`
        SELECT
          COALESCE(MAX(CASE WHEN version_type_id = 'canon' THEN version END), 0) AS canon,
          COALESCE(MAX(CASE WHEN version_type_id = 'release' THEN version END), 0) AS release,
          COALESCE(MAX(CASE WHEN version_type_id = 'build' THEN version END), 0) AS build,
          COALESCE(MAX(CASE WHEN version_type_id = 'apk' THEN version END), 0) AS apk
        FROM build_versions
      `)
      .get();
    const parts = ["canon", "release", "build"].map((key) => numericPart(row?.[key]));
    let apk = Number(row?.apk || 0);
    if (nextApk) {
      const existing = targetCommit
        ? db
          .prepare(`
            SELECT version
            FROM build_version_refs
            WHERE version_type_id = 'apk'
              AND target_branch = ?
              AND target_commit = ?
            ORDER BY version DESC
            LIMIT 1
          `)
          .get(targetBranch || "", targetCommit)
        : null;
      apk = numericPart(existing?.version) ?? apk + 1;
    }
    if (parts.some((part) => part == null) || !parts[2] || !apk) return "";
    return `${parts[0]}.${parts[1]}.${parts[2]}.${apk}`;
  } finally {
    db.close();
  }
}

function readVersionJson(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return JSON.parse(fs.readFileSync(filePath, "utf8")).version || "";
}

function latestMobileTargetVersion(mobileTarget) {
  const versions = [];
  const manifestPath = path.join(mobileTarget, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    versions.push(JSON.parse(fs.readFileSync(manifestPath, "utf8")).bundleVersion || "");
  }

  const bundlesPath = path.join(mobileTarget, "bundles");
  if (fs.existsSync(bundlesPath)) {
    for (const entry of fs.readdirSync(bundlesPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      versions.push(entry.name);
      const metadataPath = path.join(bundlesPath, entry.name, "metadata.json");
      if (fs.existsSync(metadataPath)) {
        versions.push(JSON.parse(fs.readFileSync(metadataPath, "utf8")).bundleVersion || "");
      }
    }
  }

  return latestBrightVersion(versions);
}

function latestBrightVersion(values) {
  return values.reduce((latest, value) => {
    const version = normalizeBrightVersion(value);
    if (!version) return latest;
    return compareBrightVersions(version, latest) > 0 ? version : latest;
  }, "");
}

function normalizeBrightVersion(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:[._+-].*)?$/);
  return match ? match.slice(1, 5).join(".") : "";
}

function compareBrightVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = (right || "0.0.0.0").split(".").map(Number);
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function numericPart(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
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
