#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BraiStore } from "../../services/brai_api/src/store.js";
import { normalizedReleaseReceiptFromPull } from "./accepted-preview-branches.mjs";

const RECEIPT_TYPE = "brai-work-recovery-v1";
const FINALIZE_ACTIONS = new Set(["support-only-finalize", "transfer-and-finalize"]);
const DRY_RUN = Symbol("dry-run");

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) run(process.argv.slice(2));

export function normalizeRecoveryReceipt(value) {
  if (value?.receiptType !== RECEIPT_TYPE) throw new Error(`expected ${RECEIPT_TYPE}`);
  const action = requiredText(value.action, "action");
  if (![...FINALIZE_ACTIONS, "cancel"].includes(action)) throw new Error(`invalid recovery action: ${action}`);
  const workKey = requiredWorkKey(value.workKey);
  const recoveryReason = boundedRussianText(value.recovery_reason, "recovery_reason", 2_000);
  if (action === "cancel") return { receiptType: RECEIPT_TYPE, action, workKey, recoveryReason };
  const build = value.build ?? {};
  const normalized = {
    receiptType: RECEIPT_TYPE,
    action,
    workKey,
    recoveryReason,
    build: {
      shortChanges: boundedRussianText(build.short_changes, "build.short_changes", 240),
      detailedChanges: boundedRussianText(build.detailed_changes, "build.detailed_changes", 4_000),
      reason: boundedRussianText(build.reason, "build.reason", 2_000),
    },
    targetBranch: requiredText(value.target_branch, "target_branch"),
    targetCommit: requiredCommit(value.target_commit),
    releasedAtUtc: requiredTimestamp(value.released_at_utc, "released_at_utc"),
  };
  if (normalized.targetBranch !== "main") throw new Error("target_branch must be main");
  if (action === "transfer-and-finalize") {
    normalized.repository = requiredText(value.repository, "repository");
    normalized.fromPullNumber = positiveInteger(value.from_pull_number, "from_pull_number");
    normalized.toPullNumber = positiveInteger(value.to_pull_number, "to_pull_number");
    if (normalized.fromPullNumber === normalized.toPullNumber) throw new Error("ownership transfer requires two different PRs");
  }
  return normalized;
}

export function recoverVersionWork(store, receipt) {
  const work = store.releaseWork(receipt.workKey);
  if (!work) throw new Error(`unknown release work: ${receipt.workKey}`);
  if (receipt.action === "cancel") {
    if (work.status === "cancelled") return { action: receipt.action, workKey: receipt.workKey, changed: false };
    store.cancelReleaseWork({ workKey: receipt.workKey });
    return { action: receipt.action, workKey: receipt.workKey, changed: true };
  }
  const existing = store.db.prepare("SELECT * FROM build_versions WHERE release_works_id = ? AND version_type_id = 'build'").get(work.id);
  const pulls = store.db.prepare("SELECT * FROM github_pull_requests WHERE release_works_id = ? ORDER BY pull_number").all(work.id);
  if (receipt.action === "transfer-and-finalize") {
    if (existing) validateCompletedTransfer(pulls, receipt);
    else transferForImmediateFinalization(store, work, pulls, receipt);
  }
  const refreshedPulls = store.db.prepare("SELECT * FROM github_pull_requests WHERE release_works_id = ? ORDER BY pull_number").all(work.id);
  const merged = refreshedPulls.filter((pull) => pull.state === "MERGED" || pull.github_merged_at_utc);
  const result = store.finalizeVersionWork({
    workKey: receipt.workKey,
    versionTypeId: "build",
    allowSupportOnly: receipt.action === "support-only-finalize",
    shortChanges: receipt.build.shortChanges,
    detailedChanges: receipt.build.detailedChanges,
    reason: receipt.build.reason,
    details: merged.flatMap((pull) => recoveryDetails(pull, receipt.workKey)),
    pullNumbers: merged.map((pull) => pull.pull_number),
    sourceBranch: merged.find((pull) => pull.work_role === "owner")?.head_branch ?? null,
    sourceCommit: merged.find((pull) => pull.work_role === "owner")?.merge_commit_sha ?? null,
    targetBranch: receipt.targetBranch,
    targetCommit: receipt.targetCommit,
    releasedAtUtc: receipt.releasedAtUtc,
  });
  return { action: receipt.action, workKey: receipt.workKey, version: result.version, changed: result.created };
}

function run(args) {
  const parsed = parseArgs(args);
  const receipt = normalizeRecoveryReceipt(JSON.parse(parsed["receipt-json"] ?? process.env.BRAI_WORK_RECOVERY_JSON ?? "{}"));
  const apply = parsed.apply;
  if (apply && apply !== receipt.workKey) throw new Error("--apply must equal the exact recovery work key");
  const store = new BraiStore(requiredText(process.env.BRAI_DATABASE_URL, "BRAI_DATABASE_URL"));
  let result;
  try {
    try {
      store.db.transaction(() => {
        result = recoverVersionWork(store, receipt);
        if (result.changed) recordRecoveryLog(store, receipt, result);
        if (!apply) throw DRY_RUN;
      })();
    } catch (error) {
      if (error !== DRY_RUN) throw error;
    }
    console.log(`${apply ? "Applied" : "Dry run"}: ${receipt.action} ${receipt.workKey}${result?.version ? ` build ${result.version}` : ""}${result?.changed === false ? " (already complete)" : ""}`);
  } finally {
    store.close();
  }
}

function transferForImmediateFinalization(store, work, pulls, receipt) {
  const from = pulls.find((pull) => pull.repository === receipt.repository && pull.pull_number === receipt.fromPullNumber);
  const to = pulls.find((pull) => pull.repository === receipt.repository && pull.pull_number === receipt.toPullNumber);
  if (!from || !to) throw new Error("ownership transfer PRs must already belong to the recovery work");
  if (from.work_role !== "owner" || from.state !== "CLOSED" || from.github_merged_at_utc) {
    throw new Error("transfer-and-finalize requires a closed-unmerged current owner");
  }
  if (to.work_role !== "support" || (to.state !== "MERGED" && !to.github_merged_at_utc)) {
    throw new Error("transfer-and-finalize requires a merged support replacement");
  }
  store.transferReleaseWorkOwnership({
    workKey: work.work_key,
    repository: receipt.repository,
    fromPullNumber: receipt.fromPullNumber,
    toPullNumber: receipt.toPullNumber,
  });
}

function validateCompletedTransfer(pulls, receipt) {
  const from = pulls.find((pull) => pull.repository === receipt.repository && pull.pull_number === receipt.fromPullNumber);
  const to = pulls.find((pull) => pull.repository === receipt.repository && pull.pull_number === receipt.toPullNumber);
  if (!from || from.work_role !== "support" || from.state !== "CLOSED" || from.github_merged_at_utc) {
    throw new Error("existing recovery build does not match the demoted closed owner receipt");
  }
  if (!to || to.work_role !== "owner" || (to.state !== "MERGED" && !to.github_merged_at_utc)) {
    throw new Error("existing recovery build does not match the promoted merged owner receipt");
  }
}

function recoveryDetails(pull, workKey) {
  const notes = normalizedReleaseReceiptFromPull(githubPull(pull), pull.head_branch, pull.repository);
  if (notes.work.key !== workKey) throw new Error(`PR #${pull.pull_number} release notes belong to another work`);
  return notes.build.details.map((detail) => ({ ...detail, pullNumber: pull.pull_number }));
}

function githubPull(row) {
  return {
    number: row.pull_number,
    html_url: row.url,
    title: row.title,
    body: row.body,
    user: { login: row.author_login },
    state: row.state,
    draft: row.is_draft,
    head: { ref: row.head_branch },
    base: { ref: row.base_branch },
    merge_commit_sha: row.merge_commit_sha,
    created_at: row.github_created_at_utc,
    updated_at: row.github_updated_at_utc,
    closed_at: row.github_closed_at_utc,
    merged_at: row.github_merged_at_utc,
  };
}

function recordRecoveryLog(store, receipt, result) {
  store.recordLog({
    service: "brai-deploy",
    source: "version-history-recovery",
    operation: `version_history.${receipt.action}`,
    status: "done",
    reason: receipt.recoveryReason,
    message: `${receipt.action} ${receipt.workKey}`,
    jsonData: {
      receipt_type: receipt.receiptType,
      work_key: receipt.workKey,
      action: receipt.action,
      version: result.version ?? null,
      from_pull_number: receipt.fromPullNumber ?? null,
      to_pull_number: receipt.toPullNumber ?? null,
    },
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

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`missing ${name}`);
  return text;
}

function requiredRussianText(value, name) {
  const text = requiredText(value, name);
  if (!/[А-Яа-яЁё]/.test(text)) throw new Error(`${name} must be Russian human-readable text`);
  return text;
}

function boundedRussianText(value, name, maxLength) {
  const text = requiredRussianText(value, name);
  if (text.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`);
  return text;
}

function requiredWorkKey(value) {
  const key = requiredText(value, "workKey");
  if (!/^work_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new Error("invalid work key");
  }
  return key;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function requiredTimestamp(value, name) {
  const text = requiredText(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || new Date(text).toISOString() !== text) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
  return text;
}

function requiredCommit(value) {
  const commit = requiredText(value, "target_commit");
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("target_commit must be a full Git SHA");
  return commit;
}
