#!/usr/bin/env node

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export const SKILLS = [
  ["one-three-one-rule", "optional-skills/hermes-agent/optional-skills/communication/one-three-one-rule"],
  ["baoyu-article-illustrator", "optional-skills/hermes-agent/optional-skills/creative/baoyu-article-illustrator"],
  ["concept-diagrams", "optional-skills/hermes-agent/optional-skills/creative/concept-diagrams"],
  ["creative-ideation", "optional-skills/hermes-agent/optional-skills/creative/creative-ideation"],
  ["docker-management", "optional-skills/hermes-agent/optional-skills/devops/docker-management"],
  ["watchers", "optional-skills/hermes-agent/optional-skills/devops/watchers"],
  ["fastmcp", "optional-skills/hermes-agent/optional-skills/mcp/fastmcp"],
  ["mcporter", "optional-skills/hermes-agent/optional-skills/mcp/mcporter"],
  ["qdrant-vector-search", "optional-skills/hermes-agent/optional-skills/mlops/qdrant"],
  ["whisper", "optional-skills/hermes-agent/optional-skills/mlops/whisper"],
  ["domain-intel", "optional-skills/hermes-agent/optional-skills/research/domain-intel"],
  ["architecture-diagram", "optional-skills/hermes-agent/skills/creative/architecture-diagram"],
  ["baoyu-infographic", "optional-skills/hermes-agent/skills/creative/baoyu-infographic"],
  ["humanizer", "optional-skills/hermes-agent/skills/creative/humanizer"],
  ["sketch", "optional-skills/hermes-agent/skills/creative/sketch"],
  ["youtube-content", "optional-skills/hermes-agent/skills/media/youtube-content"],
  ["evaluating-llms-harness", "optional-skills/hermes-agent/skills/mlops/evaluation/lm-evaluation-harness"],
  ["huggingface-hub", "optional-skills/hermes-agent/skills/mlops/huggingface-hub"],
  ["maps", "optional-skills/hermes-agent/skills/productivity/maps"],
  ["ocr-and-documents", "optional-skills/hermes-agent/skills/productivity/ocr-and-documents"],
  ["powerpoint", "optional-skills/hermes-agent/skills/productivity/powerpoint"],
  ["arxiv", "optional-skills/hermes-agent/skills/research/arxiv"],
  ["grill-me", "optional-skills/mattpocock/grill-me"],
  ["grilling", "optional-skills/mattpocock/grilling"],
  ["brai-debugging", "agent-skills/brai-debugging"],
  ["brai-spike", "agent-skills/brai-spike"],
  ["brai-adversarial-ux", "agent-skills/brai-adversarial-ux"]
];

const TEXT_EXTENSIONS = new Set([".md", ".py", ".js", ".mjs", ".json", ".yaml", ".yml", ".txt"]);

function parseDestination(argv) {
  const index = argv.indexOf("--dest");
  return resolve(index >= 0 ? argv[index + 1] : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"));
}

async function adaptFiles(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await adaptFiles(path);
      continue;
    }
    const extension = entry.name.includes(".") ? `.${entry.name.split(".").pop()}` : "";
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const original = await readFile(path, "utf8");
    const adapted = original
      .replaceAll("$HERMES_HOME/skills/devops/watchers", "${CODEX_HOME:-$HOME/.codex}/skills/watchers")
      .replaceAll("~/.hermes/skills/mcp/fastmcp", "${CODEX_HOME:-$HOME/.codex}/skills/fastmcp")
      .replaceAll("~/.hermes/skills/maps", "${CODEX_HOME:-$HOME/.codex}/skills/maps");
    if (adapted !== original) await writeFile(path, adapted, "utf8");
  }
}

export async function installSkills(destination) {
  await mkdir(destination, { recursive: true });
  const installed = [];
  for (const [name, source] of SKILLS) {
    const sourcePath = join(repoRoot, source);
    if (!(await stat(sourcePath)).isDirectory()) throw new Error(`Missing skill source: ${source}`);
    const target = join(destination, name);
    await rm(target, { recursive: true, force: true });
    await cp(sourcePath, target, { recursive: true, force: true });
    await adaptFiles(target);
    installed.push({ name, source });
  }
  await writeFile(join(destination, ".brai-installed.json"), `${JSON.stringify({ installed }, null, 2)}\n`, "utf8");
  return installed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = parseDestination(process.argv.slice(2));
  const installed = await installSkills(destination);
  console.log(`Installed ${installed.length} Brai skills into ${destination}`);
  console.log(installed.map(({ name }) => name).join("\n"));
}
