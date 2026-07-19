import process from "node:process";
import { BraiStore } from "../../services/brai_api/src/store.js";

const args = parseArgs(process.argv.slice(2));
const sourceBranch = required(args, "source-branch");
required(args, "target-environment");
const targetBranch = required(args, "target-branch");
const targetCommit = required(args, "target-commit");
const deployedAtUtc = args["deployed-at"] || new Date().toISOString();
const targetDb = databaseTarget(args, "target");
const target = new BraiStore(targetDb);

try {
  if (args["work-json"]) {
    reconcileVersionWork(target, JSON.parse(args["work-json"]), { sourceBranch, targetBranch, targetCommit, deployedAtUtc });
  } else {
    throw new Error("accepted promotion requires --work-json; unscoped build creation is disabled");
  }
} finally {
  target.close();
}

export function reconcileVersionWork(target, payload, { sourceBranch, targetBranch, targetCommit, deployedAtUtc }) {
  const workKey = requiredNested(payload?.work?.key, "work.key");
  const workRole = requiredNested(payload?.work?.role, "work.role");
  if (!["owner", "support"].includes(workRole)) throw new Error(`invalid work role: ${workRole}`);
  if (!Array.isArray(payload.pulls) || !payload.pulls.length) throw new Error(`work ${workKey} has no PR snapshots`);
  for (const pull of payload.pulls) {
    target.upsertGithubPullRequest({
      workKey,
      workRole: pull.workRole,
      repository: pull.repository,
      pullNumber: pull.pullNumber,
      url: pull.url,
      title: pull.title,
      body: pull.body,
      authorLogin: pull.authorLogin,
      state: pull.state,
      isDraft: pull.isDraft,
      headBranch: pull.headBranch,
      baseBranch: pull.baseBranch,
      mergeCommitSha: pull.mergeCommitSha,
      githubCreatedAtUtc: pull.githubCreatedAtUtc,
      githubUpdatedAtUtc: pull.githubUpdatedAtUtc,
      githubClosedAtUtc: pull.githubClosedAtUtc,
      githubMergedAtUtc: pull.githubMergedAtUtc,
      updatedAtUtc: deployedAtUtc,
    });
  }
  if (workRole === "support") return { workKey, finalized: false };
  const merged = payload.pulls.filter((pull) => pull.state === "MERGED" || pull.githubMergedAtUtc);
  const owner = merged.find((pull) => pull.workRole === "owner");
  if (!owner?.releaseNotes?.build) throw new Error(`work ${workKey} has no merged owner release metadata`);
  const details = merged
    .sort(compareMergedPulls)
    .flatMap((pull) => pull.releaseNotes?.build?.details?.map((detail) => ({ ...detail, pullNumber: pull.pullNumber })) ?? []);
  const work = target.releaseWork(workKey);
  const existingBuild = target.db.prepare(`
    SELECT id FROM build_versions WHERE release_works_id = ? AND version_type_id = 'build'
  `).get(work?.id);
  const result = target.finalizeVersionWork({
    workKey,
    versionTypeId: "build",
    shortChanges: requiredNested(owner.releaseNotes.build.short_changes, "owner build.short_changes"),
    detailedChanges: requiredNested(owner.releaseNotes.build.detailed_changes, "owner build.detailed_changes"),
    reason: requiredNested(owner.releaseNotes.build.reason, "owner build.reason"),
    details,
    pullNumbers: merged.map((pull) => pull.pullNumber),
    sourceBranch: owner.headBranch || sourceBranch,
    sourceCommit: owner.mergeCommitSha || payload.sha || null,
    // A missing native APK may be reconciled long after its Product build was
    // recorded. That build's historic target ref is valid evidence; do not
    // manufacture a second build ref for the later APK-only promotion.
    targetBranch: existingBuild ? null : targetBranch,
    targetCommit: existingBuild ? null : targetCommit,
    releasedAtUtc: deployedAtUtc,
  });
  console.log(`Finalized ${workKey} as build ${result.version}`);
  return { workKey, finalized: true, ...result };
}

function compareMergedPulls(left, right) {
  return String(left.githubMergedAtUtc ?? "").localeCompare(String(right.githubMergedAtUtc ?? "")) || Number(left.pullNumber) - Number(right.pullNumber);
}

function requiredNested(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`missing ${name}`);
  return text;
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
  const arg = values[`${prefix}-postgres-url`];
  if (arg) return arg;
  if (prefix === "target" && process.env.BRAI_DATABASE_URL) return process.env.BRAI_DATABASE_URL;
  return required(values, `${prefix}-postgres-url`);
}
