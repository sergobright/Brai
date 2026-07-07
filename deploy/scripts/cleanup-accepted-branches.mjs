#!/usr/bin/env node
import process from "node:process";

const API_VERSION = "2022-11-28";

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required");

  const pulls = await fetchPulls({ repository, token, state: "closed", targetBranch: options.targetBranch });
  const openPulls = await fetchPulls({ repository, token, state: "open", targetBranch: options.targetBranch });
  const candidates = cleanupCandidates({
    pulls,
    openPulls,
    activeBranches: JSON.parse(process.env.BRAI_ACTIVE_PREVIEW_BRANCHES_JSON || "[]"),
    branches: options.branches,
    targetBranch: options.targetBranch,
  });

  for (const branch of candidates) {
    if (!options.dryRun) await deleteRemoteBranch({ repository, token, branch });
    console.log(branch);
  }
}

export function cleanupCandidates({ pulls, openPulls = [], activeBranches = [], branches = [], targetBranch = "main" }) {
  const requested = new Set(branches);
  const open = new Set(openPulls.map((pull) => pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref).filter(Boolean));
  const active = new Set(activeBranches);
  const seen = new Set();
  const candidates = [];

  for (const pull of pulls) {
    const base = pull?.base?.ref ?? pull?.baseRefName ?? pull?.base_ref;
    const head = pull?.head?.ref ?? pull?.headRefName ?? pull?.head_ref;
    const merged = Boolean(pull?.merged_at ?? pull?.mergedAt) || pull?.merged === true || pull?.state === "MERGED";
    if (base !== targetBranch || !merged || !head?.startsWith("codex/") || seen.has(head)) continue;
    if (requested.size > 0 && !requested.has(head)) continue;
    if (open.has(head) || active.has(head)) continue;
    seen.add(head);
    candidates.push(head);
  }
  return candidates;
}

export async function deleteRemoteBranch({ repository, token, branch, api = process.env.GITHUB_API_URL || "https://api.github.com" }) {
  const response = await fetch(`${api.replace(/\/$/, "")}/repos/${repository}/git/refs/heads/${branch}`, {
    method: "DELETE",
    headers: githubHeaders(token),
  });
  if (response.status === 204 || response.status === 404) return { deleted: response.status === 204 };
  const body = await response.text();
  if (response.status === 422 && /Reference does not exist/i.test(body)) return { deleted: false };
  throw new Error(`GitHub branch delete failed for ${branch}: ${response.status} ${body.slice(0, 300)}`);
}

async function fetchPulls({ repository, token, state, targetBranch, api = process.env.GITHUB_API_URL || "https://api.github.com" }) {
  const response = await fetch(
    `${api.replace(/\/$/, "")}/repos/${repository}/pulls?state=${state}&base=${encodeURIComponent(targetBranch)}&sort=updated&direction=desc&per_page=100`,
    { headers: githubHeaders(token) },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub ${state} PR lookup failed: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "brai-delivery",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

function parseArgs(args) {
  const options = { branches: [], dryRun: false, targetBranch: process.env.BRAI_TARGET_BRANCH || "main" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--branch") {
      const branch = args[++index];
      if (!/^codex\/[A-Za-z0-9._-]+$/.test(branch || "")) throw new Error(`Invalid cleanup branch: ${branch || ""}`);
      options.branches.push(branch);
    } else if (arg === "--target-branch") {
      options.targetBranch = args[++index] || "";
    } else if (arg === "--recent-merged") {
      continue;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.targetBranch) throw new Error("target branch is required");
  return options;
}
