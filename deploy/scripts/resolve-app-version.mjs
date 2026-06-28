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
    prodWebVersionJson: args["prod-web-version-json"],
  }));
}

export function resolveAppVersion({
  root = process.env.BRIGHT_OS_ROOT || path.resolve(import.meta.dirname, "../.."),
  environment = process.env.NEXT_PUBLIC_BRIGHT_OS_ENVIRONMENT || "",
  db = "",
  prodWebVersionJson = "",
  explicit = process.env.BRIGHT_OS_APP_VERSION || "",
} = {}) {
  if (explicit) return validVersion(explicit);

  if (environment === "prod" && db) {
    const ledgerVersion = latestProductionVersion(db);
    if (ledgerVersion) return validVersion(ledgerVersion);
  }

  if (environment !== "prod" && prodWebVersionJson && fs.existsSync(prodWebVersionJson)) {
    return validVersion(readVersionJson(prodWebVersionJson));
  }

  return validVersion(readVersionJson(path.join(root, "apps/bright_os_app/public/version.json")));
}

function validVersion(version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid Bright OS X.Y.Z.S version: ${version}`);
  return version;
}

function latestProductionVersion(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`
        SELECT version
        FROM build_versions
        WHERE version_type_id = ? AND release_version > 0
        ORDER BY release_version DESC, build_version DESC
        LIMIT 1
      `)
      .get("build");
    return row?.version || "";
  } finally {
    db.close();
  }
}

function readVersionJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).version || "";
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
