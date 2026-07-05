#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOCRATICODE_DIST = "/srv/opt/socraticode/node_modules/socraticode/dist";
export const REQUIRED_FILES = [
  ".socraticode.json",
  ".socraticodecontextartifacts.json",
  "docs/guidelines/10-agent-tools-openspec.md",
  "openspec/specs/project-governance/spec.md",
];
const EXPECTED_ARTIFACT_PATHS = ["./docs", "./openspec", "./memory-bank"];
const WATCHER_WAIT_ATTEMPTS = 20;
const WATCHER_WAIT_DELAY_MS = 250;

export function parseCliArgs(argv = process.argv.slice(2)) {
  return {
    mode: argv.includes("--ensure") ? "ensure" : "preflight",
  };
}

export function parseCommittedProjectId(configText) {
  let parsed;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    throw new Error(`.socraticode.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const projectId = typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
  if (!projectId) throw new Error(".socraticode.json must define a non-empty string projectId.");
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`.socraticode.json projectId is invalid: ${projectId}`);
  }
  return projectId;
}

export async function waitForWatcherActive(projectPath, isWatchedByAnyProcess, options = {}) {
  const attempts = options.attempts ?? WATCHER_WAIT_ATTEMPTS;
  const delayMs = options.delayMs ?? WATCHER_WAIT_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isWatchedByAnyProcess(projectPath)) return true;
    if (attempt + 1 < attempts) await delay(delayMs);
  }

  return false;
}

export function validateProjectFiles(root) {
  const missing = REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length) {
    throw new Error(`Missing SocratiCode project files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
  }

  const projectId = parseCommittedProjectId(fs.readFileSync(path.join(root, ".socraticode.json"), "utf8"));
  const artifacts = JSON.parse(fs.readFileSync(path.join(root, ".socraticodecontextartifacts.json"), "utf8"));
  const artifactPaths = (artifacts.artifacts ?? []).map((artifact) => artifact.path);
  for (const expected of EXPECTED_ARTIFACT_PATHS) {
    if (!artifactPaths.includes(expected)) {
      throw new Error(`.socraticodecontextartifacts.json does not include ${expected}`);
    }
  }

  return { projectId };
}

export function validateCodexConfig() {
  const codexConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (!fs.existsSync(codexConfig)) throw new Error(`Codex config not found: ${codexConfig}`);
  const configText = fs.readFileSync(codexConfig, "utf8");
  if (!/\[mcp_servers\.socraticode\]/.test(configText)) {
    throw new Error("Codex MCP config has no [mcp_servers.socraticode] section");
  }
}

async function loadSocraticodeModules() {
  const importFromDist = (file) => import(pathToFileURL(path.join(SOCRATICODE_DIST, file)).href);
  const [
    config,
    docker,
    embeddingConfig,
    embeddingProvider,
    indexer,
    ollama,
    qdrant,
    watcher,
  ] = await Promise.all([
    importFromDist("config.js"),
    importFromDist("services/docker.js"),
    importFromDist("services/embedding-config.js"),
    importFromDist("services/embedding-provider.js"),
    importFromDist("services/indexer.js"),
    importFromDist("services/ollama.js"),
    importFromDist("services/qdrant.js"),
    importFromDist("services/watcher.js"),
  ]);

  return {
    collectionName: config.collectionName,
    ensureOllamaReady: ollama.ensureOllamaReady,
    ensureQdrantReady: docker.ensureQdrantReady,
    getCollectionInfo: qdrant.getCollectionInfo,
    getEmbeddingConfig: embeddingConfig.getEmbeddingConfig,
    getEmbeddingProvider: embeddingProvider.getEmbeddingProvider,
    getPersistedIndexingStatus: indexer.getPersistedIndexingStatus,
    indexProject: indexer.indexProject,
    isWatchedByAnyProcess: watcher.isWatchedByAnyProcess,
    projectIdFromPath: config.projectIdFromPath,
    startWatching: watcher.startWatching,
    updateProjectIndex: indexer.updateProjectIndex,
  };
}

async function ensureEmbeddingReady(socraticode, report) {
  await socraticode.ensureQdrantReady(report);
  if (socraticode.getEmbeddingConfig().embeddingProvider === "ollama") {
    await socraticode.ensureOllamaReady();
    return;
  }
  await socraticode.getEmbeddingProvider();
}

async function ensureWatcherFresh(root, socraticode, report) {
  if (await socraticode.isWatchedByAnyProcess(root)) return;

  await socraticode.updateProjectIndex(root, report);
  await socraticode.startWatching(root, report);

  const active = await waitForWatcherActive(root, socraticode.isWatchedByAnyProcess);
  if (!active) {
    throw new Error(
      `SocratiCode watcher is inactive for ${root}.\n` +
        "Run npm run socraticode:ensure or start it through SocratiCode codebase_watch.",
    );
  }
}

export async function runSocraticodeCheck(options = {}) {
  const mode = options.mode ?? "preflight";
  const root = path.resolve(options.root ?? process.cwd());
  const report = options.report ?? ((message) => console.log(message));

  const { projectId: committedProjectId } = validateProjectFiles(root);
  validateCodexConfig();

  const socraticode = await loadSocraticodeModules();
  const effectiveProjectId = socraticode.projectIdFromPath(root);
  const collection = socraticode.collectionName(effectiveProjectId);

  if (mode === "ensure") {
    await ensureEmbeddingReady(socraticode, report);
    const info = await socraticode.getCollectionInfo(collection);
    const persistedStatus = await socraticode.getPersistedIndexingStatus(root);

    if (!info || info.pointsCount === 0 || persistedStatus !== "completed") {
      report(`SocratiCode: running full index for ${root} (projectId=${effectiveProjectId})`);
      const result = await socraticode.indexProject(root, report);
      if (result.cancelled) {
        throw new Error(`SocratiCode indexing was cancelled for ${root}. Re-run npm run socraticode:ensure.`);
      }
    } else {
      report(`SocratiCode: running incremental catch-up for ${root} (projectId=${effectiveProjectId})`);
      await socraticode.updateProjectIndex(root, report);
    }

    const finalInfo = await socraticode.getCollectionInfo(collection);
    const finalStatus = await socraticode.getPersistedIndexingStatus(root);
    if (!finalInfo || finalInfo.pointsCount === 0 || finalStatus !== "completed") {
      throw new Error(
        `SocratiCode did not produce a complete shared index for ${root}.\n` +
          `projectId=${effectiveProjectId} committedProjectId=${committedProjectId} collection=${collection}`,
      );
    }

    await ensureWatcherFresh(root, socraticode, report);
    console.log(
      `SocratiCode ensure OK for ${root} ` +
        `(projectId=${effectiveProjectId}, committedProjectId=${committedProjectId}, collection=${collection})`,
    );
    return;
  }

  let info;
  let persistedStatus;
  try {
    info = await socraticode.getCollectionInfo(collection);
    persistedStatus = await socraticode.getPersistedIndexingStatus(root);
  } catch (error) {
    throw new Error(
      `SocratiCode preflight could not read shared index state for ${root}.\n` +
        `projectId=${effectiveProjectId} collection=${collection}\n` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!info || info.pointsCount === 0 || persistedStatus === "unknown") {
    throw new Error(
      `No shared SocratiCode index found for ${root}.\n` +
        `projectId=${effectiveProjectId} committedProjectId=${committedProjectId} collection=${collection}\n` +
        "Run npm run socraticode:ensure.",
    );
  }

  if (persistedStatus !== "completed") {
    throw new Error(
      `SocratiCode index is incomplete for ${root}.\n` +
        `projectId=${effectiveProjectId} collection=${collection}\n` +
        "Run npm run socraticode:ensure to resume and finish indexing.",
    );
  }

  await ensureWatcherFresh(root, socraticode, () => {});
  console.log(
    `SocratiCode preflight OK for ${root} ` +
      `(projectId=${effectiveProjectId}, committedProjectId=${committedProjectId}, collection=${collection})`,
  );
}

async function main() {
  const { mode } = parseCliArgs();
  try {
    await runSocraticodeCheck({ mode });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
