import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const sourceBranch = required(args, "source-branch");
const targetEnvironment = required(args, "target-environment");
const targetBranch = required(args, "target-branch");
const targetCommit = required(args, "target-commit");
const deployedAtUtc = args["deployed-at"] || new Date().toISOString();
const ledgerOnly = args["ledger-only"] === "true";
const targetDb = databaseTarget(args, "target");
if (!isPostgresUrl(targetDb)) fs.mkdirSync(path.dirname(targetDb), { recursive: true });
const target = new BraiStore(targetDb);
let source = null;

try {
  source = openSourceStore(args, targetEnvironment);
  const fallbackRecord = fallbackSourceRecord(args, sourceBranch, targetEnvironment);
  const sourceRecord = normalizeSourceRecord(
    source?.listDeploymentRecords().find((record) => record.branch === sourceBranch) ?? fallbackRecord,
    fallbackRecord,
  );
  if (!sourceRecord) throw new Error(`no deployment metadata for ${sourceBranch}`);

  target.db.transaction(() => {
    const acceptedBuild = target.recordAcceptedBuildVersion({
      sourceBranch,
      sourceCommit: args["source-commit"] || sourceRecord.commit_sha,
      sourceShortChanges: sourceRecord.short_changes,
      sourceDetails: sourceRecord.detailed_changes,
      sourceReason: sourceRecord.reason,
      targetBranch,
      targetCommit,
      releasedAtUtc: deployedAtUtc,
    });
    if (!ledgerOnly) {
      target.recordDeployment({
        environment: targetEnvironment,
        slot: args["target-slot"] || null,
        branch: targetBranch,
        commit: targetCommit,
        domain: required(args, "target-domain"),
        webOtaVersion: args["web-ota-version"] || `0.0.${acceptedBuild.version}`,
        apkVersion: args["apk-version"] || sourceRecord.apk_version,
        shortChanges: sourceRecord.short_changes,
        detailedChanges: `Повышено из ${sourceRecord.environment}${sourceRecord.slot ? ` ${sourceRecord.slot}` : ""} (${sourceRecord.branch}@${sourceRecord.commit_sha}). ${sourceRecord.detailed_changes}`,
        reason: args.reason || sourceRecord.reason,
        deployedAtUtc,
      });
    }
  })();
} finally {
  source?.close();
  target.close();
}

function openSourceStore(values, targetEnvironment) {
  const sourceDb = databaseTarget(values, "source");
  try {
    return new BraiStore(sourceDb);
  } catch (error) {
    if (canUseSourceFallback(values, targetEnvironment)) {
      console.error(`Warning: preview deployment metadata is unavailable; using branch and commit fallback. ${error.message}`);
      return null;
    }
    throw error;
  }
}

function fallbackSourceRecord(values, sourceBranch, targetEnvironment) {
  if (!canUseSourceFallback(values, targetEnvironment)) return null;
  return {
    environment: "preview",
    slot: values["source-slot"] || null,
    branch: sourceBranch,
    commit_sha: values["source-commit"],
    web_ota_version: values["web-ota-version"] || null,
    apk_version: values["apk-version"] || null,
    short_changes: values["source-short-changes"] || 'Принята сборка Brai.',
    reason: values["source-reason"] || values.reason || '',
    detailed_changes:
      values["source-details"] || 'Сборка принята; технические branch/commit-данные сохранены отдельно.',
  };
}

function normalizeSourceRecord(record, fallbackRecord) {
  if (!record) return null;
  const shortChanges = usefulChanges(record.short_changes) || usefulChanges(fallbackRecord?.short_changes);
  const detailedChanges = usefulChanges(record.detailed_changes) || usefulChanges(fallbackRecord?.detailed_changes) || shortChanges;
  const reason = usefulChanges(record.reason) || usefulChanges(fallbackRecord?.reason);
  if (!shortChanges) throw new Error('missing Russian source short_changes for accepted build version');
  if (!detailedChanges) throw new Error('missing Russian source detailed_changes for accepted build version');
  if (!reason) throw new Error('missing Russian source reason for accepted build version');
  return {
    ...record,
    short_changes: shortChanges,
    detailed_changes: detailedChanges,
    reason,
  };
}

function usefulChanges(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ');
  if (oneLine === 'Branch deployment') return '';
  if (/^Merge branch .+ into codex\/\S+$/i.test(oneLine)) return '';
  if (/^Merge remote-tracking branch .+ into codex\/\S+$/i.test(oneLine)) return '';
  if (/^Automated deployment from \S+@\S+ to \S+\.?$/i.test(oneLine)) return '';
  if (/^Automated dev deployment from \S+@\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted preview branch \S+@\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted dev build (?:\d|0\.)/i.test(oneLine)) return '';
  if (/^Accepted codex\/\S+\.?$/i.test(oneLine)) return '';
  if (/^Accepted \S+@\S+ without preview deployment metadata\.?$/i.test(oneLine)) return '';
  if (/^Accepted preview changes without authored release notes\.?$/i.test(oneLine)) return '';
  if (/^No authored preview release notes were available; audit metadata is stored separately\.?$/i.test(oneLine)) return '';
  if (oneLine === 'Автоматическая доставка ветки') return '';
  if (!/[А-Яа-яЁё]/.test(oneLine)) return '';
  return text;
}

function canUseSourceFallback(values, targetEnvironment) {
  return Boolean(values["source-commit"] && (targetEnvironment === "dev" || (targetEnvironment === "prod" && values["source-branch"]?.startsWith("codex/"))));
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

function databaseTarget(values, prefix) {
  const arg = values[`${prefix}-postgres-url`] || values[`${prefix}-db`];
  if (arg) return arg;
  if (prefix === "target" && process.env.BRAI_DATABASE_URL) return process.env.BRAI_DATABASE_URL;
  if (prefix === "source" && process.env.BRAI_SOURCE_DATABASE_URL) return process.env.BRAI_SOURCE_DATABASE_URL;
  return required(values, `${prefix}-db`);
}

function isPostgresUrl(value) {
  return /^postgres(?:ql)?:\/\//.test(String(value ?? ""));
}
