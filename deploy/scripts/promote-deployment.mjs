import process from "node:process";
import { BrightOsStore } from "../../services/bright_os_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const sourceBranch = required(args, "source-branch");
const targetEnvironment = required(args, "target-environment");
const targetBranch = required(args, "target-branch");
const targetCommit = required(args, "target-commit");
const deployedAtUtc = args["deployed-at"] || new Date().toISOString();
const ledgerOnly = args["ledger-only"] === "true";
const target = new BrightOsStore(required(args, "target-db"));
let source = null;

try {
  source = openSourceStore(args, targetEnvironment);
  const sourceRecord = source?.listDeploymentRecords().find((record) => record.branch === sourceBranch)
    ?? fallbackSourceRecord(args, sourceBranch, targetEnvironment);
  if (!sourceRecord) throw new Error(`no deployment metadata for ${sourceBranch}`);

  if (targetEnvironment === "prod") {
    if (!source) throw new Error("production promotion requires readable source deployment metadata");
    promoteBuildVersions(source, target);
  }

  if (!ledgerOnly) {
    target.recordDeployment({
      environment: targetEnvironment,
      slot: args["target-slot"] || null,
      branch: targetBranch,
      commit: targetCommit,
      domain: required(args, "target-domain"),
      webOtaVersion: args["web-ota-version"] || sourceRecord.web_ota_version,
      apkVersion: args["apk-version"] || sourceRecord.apk_version,
      shortChanges: sourceRecord.short_changes,
      detailedChanges: `Promoted from ${sourceRecord.environment}${sourceRecord.slot ? ` ${sourceRecord.slot}` : ""} (${sourceRecord.branch}@${sourceRecord.commit_sha}). ${sourceRecord.detailed_changes}`,
      reason: args.reason || `Promoted accepted deployment from ${sourceBranch}`,
      deployedAtUtc,
    });
  }
  recordAcceptedBuildVersion(target, {
    sourceBranch,
    sourceCommit: sourceRecord.commit_sha,
    sourceShortChanges: sourceRecord.short_changes,
    sourceDetails: sourceRecord.detailed_changes,
    targetBranch,
    targetCommit,
    targetEnvironment,
    releasedAtUtc: deployedAtUtc,
  });
  recordProductionReleaseVersion(target, {
    sourceBranch,
    sourceCommit: sourceRecord.commit_sha,
    sourceShortChanges: sourceRecord.short_changes,
    sourceDetails: sourceRecord.detailed_changes,
    targetBranch,
    targetCommit,
    targetEnvironment,
    releasedAtUtc: deployedAtUtc,
  });
} finally {
  source?.close();
  target.close();
}

function openSourceStore(values, targetEnvironment) {
  const sourceDb = required(values, "source-db");
  try {
    return new BrightOsStore(sourceDb);
  } catch (error) {
    if (targetEnvironment === "dev" && values["source-commit"]) {
      console.error(`Warning: preview deployment metadata is unavailable; using branch and commit fallback. ${error.message}`);
      return null;
    }
    throw error;
  }
}

function fallbackSourceRecord(values, sourceBranch, targetEnvironment) {
  if (targetEnvironment !== "dev" || !values["source-commit"]) return null;
  return {
    environment: "preview",
    slot: values["source-slot"] || null,
    branch: sourceBranch,
    commit_sha: values["source-commit"],
    web_ota_version: values["web-ota-version"] || null,
    apk_version: values["apk-version"] || null,
    short_changes: values["source-short-changes"] || `Accepted ${sourceBranch}.`,
    detailed_changes:
      values["source-details"] || `Accepted ${sourceBranch}@${values["source-commit"]} without preview deployment metadata.`,
  };
}

function promoteBuildVersions(source, target) {
  const rows = source.db
    .prepare("SELECT * FROM build_versions WHERE version_type_id = ? AND release_version = 0 ORDER BY build_version")
    .all("build");
  const insert = target.db.prepare(`
    INSERT INTO build_versions (
      version_type_id,
      major_version,
      release_version,
      build_version,
      apk_version,
      version,
      short_changes,
      detailed_changes,
      reason,
      released_at_utc,
      created_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(version_type_id, version) DO UPDATE SET
      short_changes = excluded.short_changes,
      detailed_changes = excluded.detailed_changes,
      reason = excluded.reason,
      released_at_utc = excluded.released_at_utc
  `);
  const copy = target.db.transaction(() => {
    for (const row of rows) {
      insert.run(
        row.version_type_id,
        row.major_version,
        row.release_version,
        row.build_version,
        row.apk_version,
        row.version,
        row.short_changes,
        row.detailed_changes,
        row.reason,
        row.released_at_utc,
        row.created_at_utc,
      );
    }
  });
  copy();
}

function recordAcceptedBuildVersion(
  target,
  { sourceBranch, sourceCommit, sourceShortChanges, sourceDetails, targetBranch, targetCommit, targetEnvironment, releasedAtUtc },
) {
  if (targetEnvironment !== "dev") return;
  target.recordAcceptedBuildVersion({
    sourceBranch,
    sourceCommit,
    sourceShortChanges,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  });
}

function recordProductionReleaseVersion(
  target,
  { sourceBranch, sourceCommit, sourceShortChanges, sourceDetails, targetBranch, targetCommit, targetEnvironment, releasedAtUtc },
) {
  if (targetEnvironment !== "prod") return;
  target.recordProductionReleaseVersion({
    sourceBranch,
    sourceCommit,
    sourceShortChanges,
    sourceDetails,
    targetBranch,
    targetCommit,
    releasedAtUtc,
  });
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

function required(values, key) {
  const value = values[key];
  if (!value) throw new Error(`missing --${key}`);
  return value;
}
