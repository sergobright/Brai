import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INFRA_DOCS_LABEL = "bright-delivery:infra-docs";

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const recentMerged = process.argv[2] === "--recent-merged";
  const commit = recentMerged ? null : process.argv[2] || process.env.BRIGHT_OS_TARGET_COMMIT || process.env.GITHUB_SHA;
  const targetBranch = process.env.BRIGHT_OS_TARGET_BRANCH || "main";
  const pulls = process.env.BRIGHT_OS_ACCEPTED_PREVIEW_PRS_JSON
    ? JSON.parse(process.env.BRIGHT_OS_ACCEPTED_PREVIEW_PRS_JSON)
    : recentMerged
      ? await fetchRecentMergedPulls(targetBranch)
      : await fetchAssociatedPulls(commit);

  for (const branch of acceptedPreviewBranches(pulls, targetBranch)) console.log(branch);
}

export function acceptedPreviewBranches(pulls, targetBranch = "main") {
  if (!Array.isArray(pulls)) throw new Error("GitHub pull request lookup did not return an array");

  const seen = new Set();
  const branches = [];
  for (const pull of pulls) {
    const base = pull?.base?.ref ?? pull?.baseRefName ?? pull?.base_ref;
    const head = pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref;
    const merged = Boolean(pull?.merged_at ?? pull?.mergedAt) || pull?.merged === true || pull?.state === "MERGED";
    if (base !== targetBranch || !merged || !head?.startsWith("codex/") || hasLabel(pull, INFRA_DOCS_LABEL) || seen.has(head)) continue;
    seen.add(head);
    branches.push(head);
  }
  return branches;
}

function hasLabel(pull, labelName) {
  const labels = Array.isArray(pull?.labels?.nodes) ? pull.labels.nodes : Array.isArray(pull?.labels) ? pull.labels : [];
  return labels.some((label) => (typeof label === "string" ? label : label?.name) === labelName);
}

async function fetchAssociatedPulls(commitSha) {
  if (!commitSha) throw new Error("BRIGHT_OS_TARGET_COMMIT or GITHUB_SHA is required");
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const response = await fetch(`${api}/repos/${repository}/commits/${encodeURIComponent(commitSha)}/pulls?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "bright-os-delivery",
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
        "User-Agent": "bright-os-delivery",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub merged PR lookup failed: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}
