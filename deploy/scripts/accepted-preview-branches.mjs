import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INFRA_DOCS_LABEL = "brai-delivery:infra-docs";
export const TECHNICAL_NO_PREVIEW_LABEL = "brai-delivery:technical-no-preview";
const LEGACY_NO_PREVIEW_LABELS = new Set(["bright-delivery:infra-docs", "bright-delivery:technical-no-preview"]);

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json");
  const recentMerged = filtered[0] === "--recent-merged";
  const commit = recentMerged ? null : filtered[0] || process.env.BRAI_TARGET_COMMIT || process.env.GITHUB_SHA;
  const targetBranch = process.env.BRAI_TARGET_BRANCH || "main";
  const pulls = process.env.BRAI_ACCEPTED_PREVIEW_PRS_JSON
    ? JSON.parse(process.env.BRAI_ACCEPTED_PREVIEW_PRS_JSON)
    : recentMerged
      ? await fetchRecentMergedPulls(targetBranch)
      : await fetchAssociatedPulls(commit);

  if (json) {
    console.log(JSON.stringify(acceptedPreviewReleaseNotes(pulls, targetBranch), null, 2));
  } else {
    for (const branch of acceptedPreviewBranches(pulls, targetBranch)) console.log(branch);
  }
}

export function acceptedPreviewBranches(pulls, targetBranch = "main") {
  return acceptedPreviewPulls(pulls, targetBranch).map(({ branch }) => branch);
}

export function acceptedPreviewReleaseNotes(pulls, targetBranch = "main") {
  return acceptedPreviewPulls(pulls, targetBranch).map(({ branch, pull }) => ({
    branch,
    releaseNotes: requiredReleaseNotesFromPull(pull, branch),
  }));
}

function acceptedPreviewPulls(pulls, targetBranch = "main") {
  if (!Array.isArray(pulls)) throw new Error("GitHub pull request lookup did not return an array");

  const seen = new Set();
  const accepted = [];
  for (const pull of pulls) {
    const base = pull?.base?.ref ?? pull?.baseRefName ?? pull?.base_ref;
    const head = pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref;
    const merged = Boolean(pull?.merged_at ?? pull?.mergedAt) || pull?.merged === true || pull?.state === "MERGED";
    if (base !== targetBranch || !merged || !head?.startsWith("codex/") || hasNoPreviewLabel(pull) || seen.has(head)) continue;
    seen.add(head);
    accepted.push({ branch: head, pull });
  }
  return accepted;
}

export function requiredReleaseNotesFromPull(pull, branch = pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref ?? "(unknown)") {
  const body = String(pull?.body ?? "");
  const match = body.match(/<!--\s*brai-release-notes-v1\s*([\s\S]*?)\s*-->/);
  if (!match) throw new Error(`Accepted preview PR for ${branch} has no brai-release-notes-v1 block`);
  const notes = JSON.parse(match[1]);
  for (const field of ["short_changes", "detailed_changes", "reason"]) {
    const text = String(notes[field] ?? "").trim();
    if (!text) throw new Error(`Accepted preview PR for ${branch} is missing ${field}`);
    if (!/[А-Яа-яЁё]/.test(text)) throw new Error(`Accepted preview PR for ${branch} has non-Russian ${field}`);
    notes[field] = text;
  }
  return {
    short_changes: notes.short_changes,
    detailed_changes: notes.detailed_changes,
    reason: notes.reason,
  };
}

function hasLabel(pull, labelName) {
  const labels = Array.isArray(pull?.labels?.nodes) ? pull.labels.nodes : Array.isArray(pull?.labels) ? pull.labels : [];
  return labels.some((label) => (typeof label === "string" ? label : label?.name) === labelName);
}

function hasNoPreviewLabel(pull) {
  return hasLabel(pull, INFRA_DOCS_LABEL)
    || hasLabel(pull, TECHNICAL_NO_PREVIEW_LABEL)
    || [...LEGACY_NO_PREVIEW_LABELS].some((label) => hasLabel(pull, label));
}

async function fetchAssociatedPulls(commitSha) {
  if (!commitSha) throw new Error("BRAI_TARGET_COMMIT or GITHUB_SHA is required");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${api}/repos/${repository}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "brai-delivery",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub commit PR lookup failed: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function fetchRecentMergedPulls(targetBranch) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(
    `${api}/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(targetBranch)}&sort=updated&direction=desc&per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "brai-delivery",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub merged PR lookup failed: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
