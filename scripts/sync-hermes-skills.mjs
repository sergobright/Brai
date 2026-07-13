#!/usr/bin/env node

import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const OFFICIAL_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";
const TREE_CONFIG = [
  { key: "bundled", sourceDir: "skills", destinationDir: "skills" },
  { key: "official_optional", sourceDir: "optional-skills", destinationDir: "optional-skills" }
];
export const EXCLUDED_SKILL_PATHS = [
  "skills/apple",
  "skills/autonomous-ai-agents/hermes-agent",
  "skills/dogfood",
  "skills/productivity/petdex",
  "skills/software-development/hermes-agent-skill-authoring",
  "skills/software-development/plan",
  "skills/software-development/simplify-code",
  "skills/software-development/test-driven-development",
  "skills/yuanbao",
  "optional-skills/devops/hermes-s6-container-supervision",
  "optional-skills/devops/pinggy-tunnel",
  "optional-skills/gaming",
  "optional-skills/migration/openclaw-migration",
  "optional-skills/research/gitnexus-explorer",
  "optional-skills/security/godmode",
  "optional-skills/security/unbroker",
  "optional-skills/software-development/subagent-driven-development",
  "optional-skills/web-development/cloudflare-temporary-deploy"
];
const BINARY_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp"]);
const SECRET_EXAMPLE_REPLACEMENTS = [
  { pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g, replacement: "<github-pat>" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "<github-pat>" },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: "<llm-api-key>" }
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultDestinationRoot = resolve(repoRoot, "optional-skills", "hermes-agent");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return (result.stdout || "").trim();
}

function parseArgs(argv) {
  const options = {
    source: "",
    repo: OFFICIAL_REPO_URL,
    ref: "",
    destination: defaultDestinationRoot
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      options.source = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--repo") {
      options.repo = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--ref") {
      options.ref = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--destination") {
      options.destination = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.source) {
    options.source = resolve(options.source);
  }
  options.destination = resolve(options.destination);
  return options;
}

function printUsage() {
  console.log(`Usage:
  node scripts/sync-hermes-skills.mjs [--source /path/to/hermes-agent]
                                      [--repo https://github.com/NousResearch/hermes-agent.git]
                                      [--ref main]
                                      [--destination optional-skills/hermes-agent]

Without --source the script clones the official Hermes Agent repo into a temp dir,
mirrors its skills/ and optional-skills/ trees into Brai, and writes manifest.json.`);
}

export function normalizeRepoUrl(remoteUrl) {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return "";
  if (raw.startsWith("git@github.com:")) {
    return `https://github.com/${raw.slice("git@github.com:".length).replace(/\.git$/, "")}`;
  }
  return raw.replace(/\.git$/, "");
}

async function cloneRepo(repoUrl, ref = "") {
  const cloneRoot = await mkdtemp(join(tmpdir(), "hermes-skills-"));
  const args = ["clone", "--depth=1"];
  if (ref) {
    args.push("--branch", ref);
  }
  args.push(repoUrl, cloneRoot);
  run("git", args);
  return cloneRoot;
}

async function countFiles(rootDir) {
  const pending = [rootDir];
  let fileCount = 0;
  let byteCount = 0;
  let skillCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      fileCount += 1;
      const details = await stat(fullPath);
      byteCount += details.size;
      if (entry.name === "SKILL.md") {
        skillCount += 1;
      }
    }
  }

  return { fileCount, byteCount, skillCount };
}

function isProbablyTextFile(filePath, buffer) {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    return false;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  if (sample.includes(0)) {
    return false;
  }

  let controlCount = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte < 32 || byte === 127) {
      controlCount += 1;
    }
  }

  return controlCount <= Math.max(1, Math.floor(sample.length * 0.05));
}

async function sanitizeMirroredTree(rootDir) {
  const pending = [rootDir];
  let sanitizedFileCount = 0;
  let sanitizedReplacementCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const buffer = await readFile(fullPath);
      if (!isProbablyTextFile(fullPath, buffer)) {
        continue;
      }

      let text = buffer.toString("utf8");
      let replacementCount = 0;
      for (const rule of SECRET_EXAMPLE_REPLACEMENTS) {
        text = text.replace(rule.pattern, () => {
          replacementCount += 1;
          return rule.replacement;
        });
      }

      if (replacementCount === 0) {
        continue;
      }

      await writeFile(fullPath, text, "utf8");
      sanitizedFileCount += 1;
      sanitizedReplacementCount += replacementCount;
    }
  }

  return { sanitizedFileCount, sanitizedReplacementCount };
}

async function mirrorTree(sourceDir, destinationDir) {
  await rm(destinationDir, { recursive: true, force: true });
  await mkdir(dirname(destinationDir), { recursive: true });
  await cp(sourceDir, destinationDir, { recursive: true, force: true });
  const sanitized = await sanitizeMirroredTree(destinationDir);
  const counts = await countFiles(destinationDir);
  return { counts, sanitized };
}

function resolveGitMetadata(sourceDir, fallbackRepoUrl) {
  try {
    const commit = run("git", ["-C", sourceDir, "rev-parse", "HEAD"]);
    const remoteUrl = normalizeRepoUrl(
      run("git", ["-C", sourceDir, "config", "--get", "remote.origin.url"])
    );
    return { commit, repoUrl: remoteUrl || normalizeRepoUrl(fallbackRepoUrl) };
  } catch {
    return { commit: "", repoUrl: normalizeRepoUrl(fallbackRepoUrl) };
  }
}

async function pruneExcludedSkills(destinationRoot) {
  const removed = [];
  for (const relativePath of EXCLUDED_SKILL_PATHS) {
    const target = join(destinationRoot, relativePath);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(relativePath);
  }
  return removed;
}

function buildManifest({ destinationRoot, gitMetadata, summary, syncedAtUtc, exclusions }) {
  return {
    mirror: "hermes-agent-skills",
    source: {
      repo_url: gitMetadata.repoUrl,
      commit: gitMetadata.commit
    },
    synced_at_utc: syncedAtUtc,
    destination_root: relative(repoRoot, destinationRoot) || ".",
    excluded_skill_paths: exclusions,
    trees: summary.map((entry) => ({
      kind: entry.kind,
      source_dir: entry.sourceDir,
      destination_dir: relative(repoRoot, entry.destinationDir),
      skill_count: entry.counts.skillCount,
      file_count: entry.counts.fileCount,
      byte_count: entry.counts.byteCount,
      sanitized_file_count: entry.sanitized.sanitizedFileCount,
      sanitized_replacement_count: entry.sanitized.sanitizedReplacementCount
    }))
  };
}

async function writeReadme(destinationRoot) {
  const readmePath = join(destinationRoot, "README.md");
  const text = `# Hermes Agent skill mirror

This directory vendors a Brai-curated subset of the official skill trees from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

- \`skills/\` starts from Hermes bundled skills.
- \`optional-skills/\` starts from Hermes official optional skills.
- Brai-incompatible skills are removed on every sync by \`EXCLUDED_SKILL_PATHS\` in \`scripts/sync-hermes-skills.mjs\`.
- \`manifest.json\` records the upstream repo URL, commit, sync timestamp, and per-tree counts.
- Credential-like example strings are sanitized locally so the mirror can pass Brai public branch guard.

Refresh with:

\`\`\`bash
npm run skills:sync:hermes -- --source /path/to/hermes-agent
\`\`\`

Or let the script clone the official repo itself:

\`\`\`bash
npm run skills:sync:hermes
\`\`\`
`;
  await writeFile(readmePath, text, "utf8");
}

export async function syncHermesSkills({
  source,
  repo = OFFICIAL_REPO_URL,
  ref = "",
  destination = defaultDestinationRoot,
  syncedAtUtc = new Date().toISOString()
} = {}) {
  let workingSource = source ? resolve(source) : "";
  let cleanupSource = "";

  if (!workingSource) {
    workingSource = await cloneRepo(repo, ref);
    cleanupSource = workingSource;
  }

  const gitMetadata = resolveGitMetadata(workingSource, repo);
  const summary = [];

  try {
    await mkdir(destination, { recursive: true });
    for (const tree of TREE_CONFIG) {
      const sourceDir = join(workingSource, tree.sourceDir);
      if (!existsSync(sourceDir)) {
        throw new Error(`Missing upstream tree: ${sourceDir}`);
      }
      const destinationDir = join(destination, tree.destinationDir);
      const { counts, sanitized } = await mirrorTree(sourceDir, destinationDir);
      summary.push({
        kind: tree.key,
        sourceDir: tree.sourceDir,
        destinationDir,
        counts,
        sanitized
      });
    }

    const exclusions = await pruneExcludedSkills(destination);
    for (const entry of summary) {
      entry.counts = await countFiles(entry.destinationDir);
    }

    const manifest = buildManifest({
      destinationRoot: destination,
      gitMetadata,
      summary,
      syncedAtUtc,
      exclusions
    });
    await writeReadme(destination);
    await writeFile(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } finally {
    if (cleanupSource) {
      await rm(cleanupSource, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await syncHermesSkills(options);
  console.log(JSON.stringify(manifest, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
