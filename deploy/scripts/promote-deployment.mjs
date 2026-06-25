import process from "node:process";
import { BrightOsStore } from "../../services/bright_os_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const source = new BrightOsStore(required(args, "source-db"));
const target = new BrightOsStore(required(args, "target-db"));

try {
  const sourceBranch = required(args, "source-branch");
  const targetEnvironment = required(args, "target-environment");
  const targetBranch = required(args, "target-branch");
  const targetCommit = required(args, "target-commit");
  const deployedAtUtc = args["deployed-at"] || new Date().toISOString();
  const sourceRecord = source
    .listDeploymentRecords()
    .find((record) => record.branch === sourceBranch);
  if (!sourceRecord) throw new Error(`no deployment metadata for ${sourceBranch}`);

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
  recordAcceptedBuildVersion(target, {
    prNumber: args["accepted-pr-number"],
    sourceBranch,
    sourceCommit: sourceRecord.commit_sha,
    sourceDetails: sourceRecord.detailed_changes,
    targetBranch,
    targetCommit,
    targetEnvironment,
    releasedAtUtc: deployedAtUtc,
  });
} finally {
  source.close();
  target.close();
}

function recordAcceptedBuildVersion(
  target,
  { prNumber, sourceBranch, sourceCommit, sourceDetails, targetBranch, targetCommit, targetEnvironment, releasedAtUtc },
) {
  if (targetEnvironment !== "dev" || !prNumber) return;
  target.recordAcceptedBuildVersion({
    prNumber,
    sourceBranch,
    sourceCommit,
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
