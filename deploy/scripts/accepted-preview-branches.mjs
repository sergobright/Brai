import { createHash } from "node:crypto";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresNativeApkChange } from "./detect-native-apk-change.mjs";

export const INFRA_DOCS_LABEL = "brai-delivery:infra-docs";
export const TECHNICAL_NO_PREVIEW_LABEL = "brai-delivery:technical-no-preview";
export const CANONICAL_RELEASE_REPOSITORY = "HexaFox-Labs/Brai";
const LEGACY_NO_PREVIEW_LABELS = new Set(["bright-delivery:infra-docs", "bright-delivery:technical-no-preview"]);
const LEGACY_RELEASE_REPOSITORY = "sergobright/Brai";

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const reconcileUnfinalized = args.includes("--reconcile-unfinalized");
  const filtered = args.filter((arg) => !["--json", "--reconcile-unfinalized"].includes(arg));
  const recentMerged = filtered[0] === "--recent-merged";
  const commit = recentMerged ? null : filtered[0] || process.env.BRAI_TARGET_COMMIT || process.env.GITHUB_SHA;
  const targetBranch = process.env.BRAI_TARGET_BRANCH || "main";
  const repository = process.env.GITHUB_REPOSITORY || "sergobright/Brai";
  const supplied = process.env.BRAI_ACCEPTED_PREVIEW_PRS_JSON
    ? JSON.parse(process.env.BRAI_ACCEPTED_PREVIEW_PRS_JSON)
    : null;
  const allPulls = supplied ?? (json || reconcileUnfinalized ? await fetchAllPulls(targetBranch) : null);
  const finalizedWorkKeys = new Set(JSON.parse(process.env.BRAI_FINALIZED_WORK_KEYS_JSON || "[]"));
  const pulls = reconcileUnfinalized
    ? unfinalizedWorkCandidates(allPulls, finalizedWorkKeys, targetBranch, repository)
    : supplied ?? (recentMerged ? await fetchRecentMergedPulls(targetBranch) : await fetchAssociatedPulls(commit));
  if (!supplied) await enrichLegacyNativeBoundaries(pulls, repository);

  if (json) {
    if (!supplied) {
      const nativeByNumber = new Map(pulls.map((pull) => [pull.number, pull.nativeBoundary]));
      for (const pull of allPulls) if (nativeByNumber.has(pull.number)) pull.nativeBoundary = nativeByNumber.get(pull.number);
    }
    console.log(JSON.stringify(acceptedWorkReconciliations(pulls, allPulls, targetBranch, repository), null, 2));
  } else {
    for (const branch of acceptedPreviewBranches(pulls, targetBranch)) console.log(branch);
  }
}

export function unfinalizedWorkCandidates(
  pulls,
  finalizedWorkKeys = new Set(),
  targetBranch = "main",
  repository = "sergobright/Brai",
) {
  if (!Array.isArray(pulls)) throw new Error("GitHub pull request lookup did not return an array");
  const selected = new Map();
  for (const pull of pulls) {
    const branch = pullHead(pull);
    if (pullBase(pull) !== targetBranch || !pullMerged(pull) || !branch?.startsWith("codex/")) continue;
    const work = workFromPull(pull, repository);
    if (!work || finalizedWorkKeys.has(work.key)) continue;
    const current = selected.get(work.key);
    if (!current || (work.role === "owner" && current.work.role !== "owner")) {
      selected.set(work.key, { pull, work });
    }
  }
  return [...selected.values()]
    .sort((left, right) =>
      String(left.pull.merged_at ?? left.pull.mergedAt ?? "").localeCompare(String(right.pull.merged_at ?? right.pull.mergedAt ?? ""))
      || Number(left.pull.number) - Number(right.pull.number))
    .map(({ pull }) => pull);
}

export function acceptedPreviewBranches(pulls, targetBranch = "main") {
  return acceptedPreviewPulls(pulls, targetBranch).map(({ branch }) => branch);
}

export function acceptedPreviewReleaseNotes(pulls, targetBranch = "main") {
  return acceptedPreviewPulls(pulls, targetBranch).map(({ branch, pull }) => {
    const sha = pull?.head?.sha ?? pull?.headRefOid ?? pull?.head_sha ?? "";
    return { branch, ...(sha ? { sha } : {}), releaseNotes: requiredReleaseNotesFromPull(pull, branch) };
  });
}

export function acceptedWorkReconciliations(currentPulls, allPulls = currentPulls, targetBranch = "main", repository = "sergobright/Brai") {
  if (!Array.isArray(currentPulls) || !Array.isArray(allPulls)) throw new Error("GitHub pull request lookup did not return an array");
  const result = [];
  const seen = new Set();
  for (const pull of currentPulls) {
    const branch = pullHead(pull);
    if (pullBase(pull) !== targetBranch || !pullMerged(pull) || !branch?.startsWith("codex/")) continue;
    const work = requiredWorkFromPull(pull, repository);
    if (seen.has(work.key)) continue;
    seen.add(work.key);
    const members = allPulls
      .filter((candidate) => pullBase(candidate) === targetBranch && workFromPull(candidate, repository)?.key === work.key)
      .map((candidate) => snapshotWorkPull(candidate, repository));
    if (!members.some((member) => member.pullNumber === pull.number)) members.push(snapshotWorkPull(pull, repository));
    members.sort(comparePulls);
    const current = members.find((member) => member.pullNumber === pull.number);
    const unresolved = members.filter((member) => !["CLOSED", "MERGED"].includes(member.state));
    if (work.role === "owner" && unresolved.length) {
      throw new Error(`Work ${work.key} has unresolved PRs: ${unresolved.map((member) => `#${member.pullNumber} (${member.state}${member.isDraft ? ", draft" : ""})`).join(", ")}`);
    }
    for (const member of members) {
      if (member.state !== "MERGED") continue;
      member.releaseNotes = normalizedReleaseReceiptFromPull(member.raw, member.headBranch, repository);
      if (member.releaseNotes.work.key !== work.key || member.releaseNotes.work.role !== member.workRole) {
        throw new Error(`PR #${member.pullNumber} release notes do not match ${work.key}/${member.workRole}`);
      }
      delete member.raw;
    }
    for (const member of members) delete member.raw;
    result.push({
      branch,
      sha: pull?.head?.sha ?? pull?.headRefOid ?? pull?.head_sha ?? "",
      noPreview: hasNoPreviewLabel(pull),
      work: { key: work.key, role: work.role },
      pullNumber: current.pullNumber,
      pulls: members,
    });
  }
  return result;
}

export function canonicalReleaseRepository(repository) {
  const value = String(repository ?? "").trim();
  return value.toLowerCase() === LEGACY_RELEASE_REPOSITORY.toLowerCase()
    ? CANONICAL_RELEASE_REPOSITORY
    : value;
}

function snapshotWorkPull(pull, repository) {
  const work = requiredWorkFromPull(pull, repository);
  const snapshotRepository = work.legacy ? repository : canonicalReleaseRepository(repository);
  return snapshotPull(pull, snapshotRepository, work);
}

function acceptedPreviewPulls(pulls, targetBranch = "main") {
  if (!Array.isArray(pulls)) throw new Error("GitHub pull request lookup did not return an array");
  const seen = new Set();
  const accepted = [];
  for (const pull of pulls) {
    const head = pullHead(pull);
    if (pullBase(pull) !== targetBranch || !pullMerged(pull) || !head?.startsWith("codex/") || hasNoPreviewLabel(pull) || seen.has(head)) continue;
    seen.add(head);
    accepted.push({ branch: head, pull });
  }
  return accepted;
}

export function requiredWorkFromPull(pull, repository = "sergobright/Brai") {
  const parsed = workFromPull(pull, repository);
  if (!parsed) throw new Error(`Accepted PR #${pull?.number ?? "?"} has no brai-work-v1 marker`);
  return parsed;
}

function workFromPull(pull, repository) {
  const explicit = explicitWorkFromPull(pull);
  if (explicit) return explicit;
  if (!legacyV1Allowed(pull)) return null;
  return { key: legacyWorkKey(repository, pull.number), role: "owner", nativeBoundary: false, legacy: true };
}

export function explicitWorkFromPull(pull) {
  const body = String(pull?.body ?? "");
  const match = body.match(/<!--\s*brai-work-v1\s*([\s\S]*?)\s*-->/);
  if (match) {
    const marker = JSON.parse(match[1]);
    const key = marker.workKey ?? marker.work?.key;
    const role = marker.workRole ?? marker.work?.role;
    if (!/^work_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(key ?? ""))) {
      throw new Error(`PR #${pull?.number ?? "?"} has invalid work key`);
    }
    if (!["owner", "support"].includes(role)) throw new Error(`PR #${pull?.number ?? "?"} has invalid work role`);
    return { key, role, nativeBoundary: Boolean(marker.nativeBoundary) };
  }
  return null;
}

export function requiredReleaseNotesFromPull(pull, branch = pullHead(pull) ?? "(unknown)") {
  const v2 = parseReceiptComment(pull, "brai-release-notes-v2");
  if (v2) return normalizeV2Receipt(v2, pull, branch).build;
  const v1 = parseReceiptComment(pull, "brai-release-notes-v1");
  if (!v1 || !legacyV1Allowed(pull)) throw new Error(`Accepted preview PR for ${branch} has no allowed brai-release-notes receipt`);
  return {
    short_changes: releaseText(v1.short_changes, branch, "short_changes"),
    detailed_changes: releaseText(v1.detailed_changes, branch, "detailed_changes"),
    reason: releaseText(v1.reason, branch, "reason"),
  };
}

export function normalizedReleaseReceiptFromPull(pull, branch = pullHead(pull) ?? "(unknown)", repository = "sergobright/Brai") {
  const v2 = parseReceiptComment(pull, "brai-release-notes-v2");
  if (v2) return normalizeV2Receipt(v2, pull, branch);
  const v1 = parseReceiptComment(pull, "brai-release-notes-v1");
  if (!v1 || !legacyV1Allowed(pull)) throw new Error(`Accepted PR for ${branch} has no allowed release receipt`);
  const work = workFromPull(pull, repository);
  const detailed = releaseText(v1.detailed_changes, branch, "detailed_changes");
  return {
    receiptType: "brai-release-notes-v1",
    work: { key: work.key, role: work.role },
    build: {
      short_changes: releaseText(v1.short_changes, branch, "short_changes"),
      detailed_changes: detailed,
      reason: releaseText(v1.reason, branch, "reason"),
      details: [{ title: releaseText(v1.short_changes, branch, "short_changes"), description: detailed }],
    },
  };
}

function normalizeV2Receipt(receipt, pull, branch) {
  const work = workFromPull(pull, "sergobright/Brai");
  if (!work || receipt.work?.key !== work.key || receipt.work?.role !== work.role) throw new Error(`PR for ${branch} has mismatched work identity`);
  const build = { details: normalizeDetails(receipt.build?.details, branch, "build.details") };
  if (work.role === "owner") {
    for (const field of ["short_changes", "detailed_changes", "reason"]) build[field] = releaseText(receipt.build?.[field], branch, `build.${field}`);
  } else if ([receipt.build?.short_changes, receipt.build?.detailed_changes, receipt.build?.reason].some((value) => String(value ?? "").trim())) {
    throw new Error(`Support PR for ${branch} cannot replace owner build summary`);
  }
  const apk = receipt.platforms?.apk;
  if (work.nativeBoundary && !apk) throw new Error(`Native PR for ${branch} has no platforms.apk block`);
  if (!work.nativeBoundary && apk) throw new Error(`Non-native PR for ${branch} unexpectedly has platforms.apk`);
  return {
    receiptType: "brai-release-notes-v2",
    work: { key: work.key, role: work.role },
    build,
    ...(apk ? { platforms: { apk: {
      short_changes: releaseText(apk.short_changes, branch, "platforms.apk.short_changes"),
      detailed_changes: releaseText(apk.detailed_changes, branch, "platforms.apk.detailed_changes"),
      reason: releaseText(apk.reason, branch, "platforms.apk.reason"),
      details: normalizeDetails(apk.details, branch, "platforms.apk.details"),
    } } } : {}),
  };
}

export function snapshotPull(pull, repository, workOverride = null) {
  const work = workOverride ?? requiredWorkFromPull(pull, repository);
  const mergedAt = pull.merged_at ?? pull.mergedAt ?? null;
  return {
    repository,
    pullNumber: Number(pull.number),
    url: pull.html_url ?? pull.url,
    title: pull.title || `PR #${pull.number}`,
    body: String(pull.body ?? ""),
    authorLogin: pull.user?.login ?? pull.author?.login ?? pull.authorLogin ?? "unknown",
    state: mergedAt ? "MERGED" : String(pull.state ?? "OPEN").toUpperCase(),
    isDraft: Boolean(pull.draft ?? pull.isDraft),
    headBranch: pullHead(pull),
    baseBranch: pullBase(pull),
    mergeCommitSha: pull.merge_commit_sha ?? pull.mergeCommit?.oid ?? null,
    githubCreatedAtUtc: pull.created_at ?? pull.createdAt,
    githubUpdatedAtUtc: pull.updated_at ?? pull.updatedAt ?? pull.created_at ?? pull.createdAt,
    githubClosedAtUtc: pull.closed_at ?? pull.closedAt ?? null,
    githubMergedAtUtc: mergedAt,
    workKey: work.key,
    workRole: work.role,
    raw: pull,
  };
}

function parseReceiptComment(pull, type) {
  const match = String(pull?.body ?? "").match(new RegExp(`<!--\\s*${type}\\s*([\\s\\S]*?)\\s*-->`));
  return match ? JSON.parse(match[1]) : null;
}

function legacyV1Allowed(pull) {
  const createdAt = Date.parse(pull?.created_at ?? pull?.createdAt ?? "");
  const cutoff = Date.parse(process.env.BRAI_RELEASE_NOTES_V2_CUTOFF ?? "");
  return Number.isFinite(createdAt) && Number.isFinite(cutoff) && createdAt < cutoff && pull?.nativeBoundary === false;
}

function legacyWorkKey(repository, number) {
  const hex = createHash("sha256").update(`${repository}#${number}`).digest("hex").slice(0, 32);
  return `work_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function normalizeDetails(details, branch, field) {
  if (!Array.isArray(details) || !details.length) throw new Error(`PR for ${branch} requires ${field}`);
  return details.map((detail, index) => ({
    title: releaseText(detail?.title, branch, `${field}[${index}].title`),
    description: releaseText(detail?.description, branch, `${field}[${index}].description`),
  }));
}

function releaseText(value, branch, field) {
  const text = String(value ?? "").trim();
  if (!text || !/[А-Яа-яЁё]/.test(text)) throw new Error(`Accepted PR for ${branch} has invalid ${field}`);
  return text;
}

function comparePulls(left, right) {
  return String(left.githubMergedAtUtc ?? "9999").localeCompare(String(right.githubMergedAtUtc ?? "9999")) || left.pullNumber - right.pullNumber;
}

function pullBase(pull) { return pull?.base?.ref ?? pull?.baseRefName ?? pull?.base_ref; }
function pullHead(pull) { return pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref; }
function pullMerged(pull) { return Boolean(pull?.merged_at ?? pull?.mergedAt) || pull?.merged === true || pull?.state === "MERGED"; }

function hasLabel(pull, labelName) {
  const labels = Array.isArray(pull?.labels?.nodes) ? pull.labels.nodes : Array.isArray(pull?.labels) ? pull.labels : [];
  return labels.some((label) => (typeof label === "string" ? label : label?.name) === labelName);
}

function hasNoPreviewLabel(pull) {
  return hasLabel(pull, INFRA_DOCS_LABEL)
    || hasLabel(pull, TECHNICAL_NO_PREVIEW_LABEL)
    || [...LEGACY_NO_PREVIEW_LABELS].some((label) => hasLabel(pull, label));
}

async function githubJson(url, errorLabel) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");
  const response = await fetch(url, { headers: {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "brai-delivery",
    "X-GitHub-Api-Version": "2022-11-28",
  } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${errorLabel}: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function enrichLegacyNativeBoundaries(pulls, repository) {
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  for (const pull of pulls) {
    if (explicitWorkFromPull(pull) || !parseReceiptComment(pull, "brai-release-notes-v1")) continue;
    const files = await githubJson(`${api}/repos/${repository}/pulls/${pull.number}/files?per_page=100`, `GitHub PR #${pull.number} file lookup failed`);
    const names = files.map((file) => file.filename);
    const packageDiff = files.filter((file) => ["apps/brai_app/package.json", "apps/brai_app/package-lock.json"].includes(file.filename)).map((file) => file.patch || "").join("\n");
    const environmentDiff = files.find((file) => file.filename === "deploy/environments.json")?.patch || "";
    pull.nativeBoundary = requiresNativeApkChange(names, packageDiff, environmentDiff);
  }
}

async function fetchAssociatedPulls(commitSha) {
  if (!commitSha) throw new Error("BRAI_TARGET_COMMIT or GITHUB_SHA is required");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  return githubJson(`${api}/repos/${repository}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`, "GitHub commit PR lookup failed");
}

async function fetchAllPulls(targetBranch) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubJson(`${api}/repos/${repository}/pulls?state=all&base=${encodeURIComponent(targetBranch)}&sort=created&direction=desc&per_page=100&page=${page}`, "GitHub PR reconciliation failed");
    pulls.push(...batch);
    if (batch.length < 100) return pulls;
  }
}

async function fetchRecentMergedPulls(targetBranch) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  return githubJson(`${api}/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(targetBranch)}&sort=updated&direction=desc&per_page=100`, "GitHub merged PR lookup failed");
}
