#!/usr/bin/env node
// File-size exception: destructive selection and final identity revalidation stay together so their fail-closed allowlists cannot drift.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GIB = 1024 ** 3;
const ENVIRONMENT_NAMES = ["prod", "dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"];
const DEPLOY_ATTEMPT_SUFFIX = /^(?:[0-9]{14}-[0-9]+|(?:local|[0-9]+)-[0-9]+-[A-Za-z0-9._-]+-[0-9]+-[0-9]+)$/;
const MAINTENANCE_LOCKS_HELD_ENV = "BRAI_STORAGE_MAINTENANCE_LOCKS_HELD";
const LOCKED_ENVIRONMENTS_ENV = "BRAI_STORAGE_LOCKED_ENVIRONMENTS";
const DEFAULT_CONFIG = Object.freeze({
  repo: "/srv/projects/brai",
  envsRoot: "/srv/projects/brai-envs",
  uploadRoot: "/srv/projects/brai-envs/ci-uploads",
  releaseDir: "/srv/projects/brai/deploy/releases",
  ciRetentionMs: DAY_MS,
  previousRetentionMs: DAY_MS,
  apkGraceMs: DAY_MS,
  pressureBytes: 30 * GIB,
});

export function parseArgs(args = process.argv.slice(2)) {
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (arg !== "--dry-run") throw new Error(`Unknown argument: ${arg}`);
  }
  if (apply && args.includes("--dry-run")) throw new Error("Choose either --apply or --dry-run");
  return { apply };
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertPlainDirectory(root) {
  const stat = lstatOrNull(root);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory maintenance root: ${root}`);
  return true;
}

function directChildren(root) {
  if (!assertPlainDirectory(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).map((entry) => ({ entry, filePath: path.join(root, entry.name) }));
}

function newestMtimeMs(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  if (!stat.isDirectory()) return newest;
  for (const name of fs.readdirSync(filePath)) newest = Math.max(newest, newestMtimeMs(path.join(filePath, name)));
  return newest;
}

function diskUsageBytes(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) return stat.blocks * 512;
  let bytes = stat.blocks * 512;
  if (!stat.isDirectory()) return bytes;
  for (const name of fs.readdirSync(filePath)) bytes += diskUsageBytes(path.join(filePath, name));
  return bytes;
}

function isPathBusy(candidate, busyPaths) {
  const exact = path.resolve(candidate);
  const prefix = `${exact}${path.sep}`;
  return busyPaths.some((item) => {
    const busy = path.resolve(item);
    return busy === exact || busy.startsWith(prefix);
  });
}

function parseUtcIso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  const canonical = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
  return new Date(parsed).toISOString() === canonical ? parsed : Number.NaN;
}

function transientProcError(error) {
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

export function collectBusyPathSnapshot(procRoot = "/proc", io = fs) {
  const paths = [];
  let complete = true;
  for (const processEntry of io.readdirSync(procRoot, { withFileTypes: true })) {
    if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) continue;
    const processRoot = path.join(procRoot, processEntry.name);
    for (const link of ["cwd", "exe", "root"].map((name) => path.join(processRoot, name))) {
      try {
        const target = io.readlinkSync(link);
        if (target.startsWith("/")) paths.push(target.replace(/ \(deleted\)$/, ""));
      } catch (error) {
        if (!transientProcError(error)) complete = false;
      }
    }
    try {
      for (const fd of io.readdirSync(path.join(processRoot, "fd"))) {
        try {
          const target = io.readlinkSync(path.join(processRoot, "fd", fd));
          if (target.startsWith("/")) paths.push(target.replace(/ \(deleted\)$/, ""));
        } catch (error) {
          if (!transientProcError(error)) complete = false;
        }
      }
    } catch (error) {
      if (!transientProcError(error)) complete = false;
    }
  }
  return { paths, complete };
}

export function collectMountPaths(mountInfoPath = "/proc/self/mountinfo") {
  return fs.readFileSync(mountInfoPath, "utf8").split("\n").flatMap((line) => {
    if (!line) return [];
    const mountPoint = line.split(" - ", 1)[0]?.split(" ")[4];
    if (!mountPoint?.startsWith("/")) throw new Error(`Invalid mountinfo entry: ${line}`);
    return [mountPoint.replace(/\\(040|011|012|134)/g, (_, code) => ({
      "040": " ",
      "011": "\t",
      "012": "\n",
      "134": "\\",
    })[code])];
  });
}

function lockedEnvironmentRoots(envsRoot, environmentNames = ENVIRONMENT_NAMES) {
  if (!assertPlainDirectory(envsRoot)) return [];
  return environmentNames.flatMap((name) => {
    if (!ENVIRONMENT_NAMES.includes(name)) throw new Error(`Invalid maintenance environment: ${name}`);
    const environmentRoot = path.join(envsRoot, name);
    const rootStat = lstatOrNull(environmentRoot);
    if (!rootStat) return [];
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Refusing non-directory environment root: ${environmentRoot}`);
    }
    const lockPath = path.join(environmentRoot, ".source-operation.lock");
    const lockStat = lstatOrNull(lockPath);
    if (!lockStat) return [];
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      throw new Error(`Refusing non-regular source operation lock: ${lockPath}`);
    }
    return [{ name, environmentRoot, lockPath }];
  });
}

function deploySourceIdentity(candidate, environmentName) {
  const commitPath = path.join(candidate, ".brai-deploy-commit");
  const branchPath = path.join(candidate, ".brai-deploy-branch");
  const commitStat = lstatOrNull(commitPath);
  const branchStat = lstatOrNull(branchPath);
  if (!commitStat?.isFile() || commitStat.isSymbolicLink() || !branchStat?.isFile() || branchStat.isSymbolicLink()) return null;
  const commit = fs.readFileSync(commitPath, "utf8").trim();
  const branch = fs.readFileSync(branchPath, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) return null;
  if (environmentName === "prod" && branch !== "main") return null;
  if (environmentName === "dev" && branch !== "dev") return null;
  if (environmentName.startsWith("preview-") && !/^codex\/.+/.test(branch)) return null;
  return { branch, commit };
}

function readyDeployment(environmentRoot, environmentName) {
  const sourceRoot = path.join(environmentRoot, "source");
  const sourceStat = lstatOrNull(sourceRoot);
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) return null;
  const identity = deploySourceIdentity(sourceRoot, environmentName);
  if (!identity) return null;
  const attemptPath = path.join(sourceRoot, ".brai-deploy-attempt");
  const readyPath = path.join(sourceRoot, ".brai-goal-agent-ready.json");
  const attemptStat = lstatOrNull(attemptPath);
  const readyStat = lstatOrNull(readyPath);
  if (!attemptStat?.isFile() || attemptStat.isSymbolicLink() || !readyStat?.isFile() || readyStat.isSymbolicLink()) return null;
  const attempt = fs.readFileSync(attemptPath, "utf8").trim();
  let ready;
  try {
    ready = JSON.parse(fs.readFileSync(readyPath, "utf8"));
  } catch {
    return null;
  }
  return DEPLOY_ATTEMPT_SUFFIX.test(attempt)
    && ready?.attempt === attempt && ready?.branch === identity.branch && ready?.commit === identity.commit
    ? { attempt, ...identity }
    : null;
}

function previousSourceOwnership(candidate, environmentName, suffix) {
  const markerPath = path.join(candidate, ".brai-previous-source.json");
  const markerStat = lstatOrNull(markerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  const createdAt = parseUtcIso(marker?.createdAt);
  if (marker?.attempt !== suffix || !/^[0-9a-f]{40}$/.test(marker?.replacedByCommit ?? "") || !Number.isFinite(createdAt)) return null;
  if (environmentName === "prod" && marker.replacedByBranch !== "main") return null;
  if (environmentName === "dev" && marker.replacedByBranch !== "dev") return null;
  if (environmentName.startsWith("preview-") && !/^codex\/.+/.test(marker.replacedByBranch ?? "")) return null;
  return { branch: marker.replacedByBranch, commit: marker.replacedByCommit, createdAt };
}

function stalePreviousSourceCandidate({
  environmentRoot,
  environmentName,
  filePath,
  ready,
  now,
  retentionMs,
  busyPaths,
  mountPaths,
}) {
  const cutoff = now - retentionMs;
  const root = path.resolve(environmentRoot);
  const exactPath = path.resolve(filePath);
  if (path.dirname(exactPath) !== root || exactPath !== path.join(root, path.basename(exactPath))) return null;
  const stat = lstatOrNull(exactPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || !path.basename(exactPath).startsWith("source.previous-")) return null;
  const suffix = path.basename(exactPath).slice("source.previous-".length);
  if (!DEPLOY_ATTEMPT_SUFFIX.test(suffix) || isPathBusy(exactPath, busyPaths) || isPathBusy(exactPath, mountPaths)) return null;
  const ownership = previousSourceOwnership(exactPath, environmentName, suffix);
  if (!ownership) return null;
  const readyForExactCleanup = ready?.attempt === suffix
    && ready.branch === ownership.branch && ready.commit === ownership.commit;
  if (!readyForExactCleanup && (ownership.createdAt >= cutoff || Math.max(stat.ctimeMs, newestMtimeMs(exactPath)) >= cutoff)) return null;
  return {
    filePath: exactPath,
    bytes: diskUsageBytes(exactPath),
    recursive: true,
    environmentName,
    suffix,
    ownership,
    device: stat.dev,
    inode: stat.ino,
  };
}

export function stalePreviousSourceCandidates({
  envsRoot,
  now = Date.now(),
  retentionMs = DAY_MS,
  busyPaths = [],
  mountPaths = [],
  environmentNames = ENVIRONMENT_NAMES,
}) {
  return lockedEnvironmentRoots(envsRoot, environmentNames).flatMap(({ name, environmentRoot }) => {
    const ready = readyDeployment(environmentRoot, name);
    return directChildren(environmentRoot).flatMap(({ filePath }) => {
      const candidate = stalePreviousSourceCandidate({
        environmentRoot,
        environmentName: name,
        filePath,
        ready,
        now,
        retentionMs,
        busyPaths,
        mountPaths,
      });
      return candidate ? [candidate] : [];
    });
  });
}

function staleCiUploadCandidate({ uploadRoot, filePath, now, retentionMs, busyPaths, mountPaths }) {
  const cutoff = now - retentionMs;
  const root = path.resolve(uploadRoot);
  const exactPath = path.resolve(filePath);
  if (path.dirname(exactPath) !== root || exactPath !== path.join(root, path.basename(exactPath))) return null;
  const stat = lstatOrNull(exactPath);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  const match = path.basename(exactPath).match(/^[A-Za-z0-9._-]+-([0-9a-f]{40})\.attempt-[A-Za-z0-9._-]+$/);
  if (!match || isPathBusy(exactPath, busyPaths) || isPathBusy(exactPath, mountPaths)) return null;
  const markerPath = path.join(exactPath, ".brai-upload-terminal.json");
  const markerStat = lstatOrNull(markerPath);
  if (!markerStat?.isFile() || markerStat.isSymbolicLink()) return null;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
  const finishedAt = parseUtcIso(marker.finishedAt);
  const terminal = ["failed", "cancelled", "succeeded"].includes(marker.status);
  const abandonedActive = marker.status === "active" && marker.finishedAt === null && markerStat.mtimeMs < cutoff;
  if (marker.commit !== match[1] || (!terminal && !abandonedActive)) return null;
  if (terminal && (!Number.isFinite(finishedAt) || finishedAt >= cutoff)) return null;
  if (newestMtimeMs(exactPath) >= cutoff) return null;
  return { filePath: exactPath, bytes: diskUsageBytes(exactPath), recursive: true, device: stat.dev, inode: stat.ino };
}

export function staleCiUploadCandidates({ uploadRoot, now = Date.now(), retentionMs = DAY_MS, busyPaths = [], mountPaths = [] }) {
  return directChildren(uploadRoot).flatMap(({ filePath }) => {
    const candidate = staleCiUploadCandidate({ uploadRoot, filePath, now, retentionMs, busyPaths, mountPaths });
    return candidate ? [candidate] : [];
  });
}

export function unreferencedApkCandidates({ releaseDir, now = Date.now(), graceMs = DAY_MS, busyPaths = [] }) {
  if (!assertPlainDirectory(releaseDir)) return [];
  const indexPath = path.join(releaseDir, "releases.json");
  const indexStat = lstatOrNull(indexPath);
  if (!indexStat?.isFile() || indexStat.isSymbolicLink()) throw new Error(`Refusing non-regular release index: ${indexPath}`);
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  if (!index.sections || typeof index.sections !== "object") throw new Error(`Invalid release index: ${indexPath}`);
  const referenced = new Set();
  for (const section of Object.values(index.sections)) {
    if (section?.file == null) continue;
    if (typeof section.file !== "string" || path.basename(section.file) !== section.file || !section.file.endsWith(".apk")) {
      throw new Error(`Invalid APK reference in ${indexPath}`);
    }
    referenced.add(section.file);
  }
  const cutoff = now - graceMs;
  return directChildren(releaseDir).flatMap(({ entry, filePath }) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".apk") || referenced.has(entry.name)) return [];
    const stat = fs.lstatSync(filePath);
    if (stat.mtimeMs >= cutoff || isPathBusy(filePath, busyPaths)) return [];
    return [{ filePath, bytes: stat.blocks * 512, recursive: false }];
  });
}

export function removeCandidates(candidates, apply) {
  const result = {
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    removed: 0,
    removedBytes: 0,
    errors: 0,
  };
  if (!apply) return result;
  for (const candidate of candidates) {
    try {
      const stat = lstatOrNull(candidate.filePath);
      if (!stat || stat.isSymbolicLink()) continue;
      fs.rmSync(candidate.filePath, { recursive: candidate.recursive, force: false });
      result.removed += 1;
      result.removedBytes += candidate.bytes;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

function samePreviousCandidate(left, right) {
  return left.filePath === right.filePath
    && left.environmentName === right.environmentName
    && left.suffix === right.suffix
    && left.device === right.device
    && left.inode === right.inode
    && left.ownership.branch === right.ownership.branch
    && left.ownership.commit === right.ownership.commit
    && left.ownership.createdAt === right.ownership.createdAt;
}

export function removePreviousSourceCandidates(candidates, apply, {
  envsRoot,
  now = Date.now(),
  retentionMs = DAY_MS,
  environmentNames = ENVIRONMENT_NAMES,
  busySnapshotProvider = collectBusyPathSnapshot,
  mountPathsProvider = collectMountPaths,
} = {}) {
  const result = {
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    removed: 0,
    removedBytes: 0,
    errors: 0,
  };
  if (!apply) return result;
  for (const candidate of candidates) {
    try {
      if (!environmentNames.includes(candidate.environmentName)) throw new Error("Candidate environment was not locked");
      const finalBusySnapshot = busySnapshotProvider();
      if (!finalBusySnapshot.complete) throw new Error("Incomplete final /proc scan");
      const lockedEnvironment = lockedEnvironmentRoots(envsRoot, [candidate.environmentName])[0];
      if (!lockedEnvironment) throw new Error("Candidate source lock disappeared");
      const finalCandidate = stalePreviousSourceCandidate({
        environmentRoot: lockedEnvironment.environmentRoot,
        environmentName: candidate.environmentName,
        filePath: candidate.filePath,
        ready: readyDeployment(lockedEnvironment.environmentRoot, candidate.environmentName),
        now,
        retentionMs,
        busyPaths: finalBusySnapshot.paths,
        mountPaths: mountPathsProvider(),
      });
      if (!finalCandidate || !samePreviousCandidate(candidate, finalCandidate)) continue;
      const stat = fs.lstatSync(candidate.filePath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== candidate.device || stat.ino !== candidate.inode) continue;
      fs.rmSync(candidate.filePath, { recursive: true, force: false });
      result.removed += 1;
      result.removedBytes += candidate.bytes;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

export function removeCiUploadCandidates(candidates, apply, {
  uploadRoot,
  now = Date.now(),
  retentionMs = DAY_MS,
  busySnapshotProvider = collectBusyPathSnapshot,
  mountPathsProvider = collectMountPaths,
} = {}) {
  const result = {
    candidates: candidates.length,
    candidateBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
    removed: 0,
    removedBytes: 0,
    errors: 0,
  };
  if (!apply) return result;
  for (const candidate of candidates) {
    try {
      const finalBusySnapshot = busySnapshotProvider();
      if (!finalBusySnapshot.complete) throw new Error("Incomplete final /proc scan");
      const finalCandidate = staleCiUploadCandidate({
        uploadRoot,
        filePath: candidate.filePath,
        now,
        retentionMs,
        busyPaths: finalBusySnapshot.paths,
        mountPaths: mountPathsProvider(),
      });
      if (!finalCandidate || finalCandidate.device !== candidate.device || finalCandidate.inode !== candidate.inode) continue;
      const stat = fs.lstatSync(candidate.filePath);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== candidate.device || stat.ino !== candidate.inode) continue;
      fs.rmSync(candidate.filePath, { recursive: true, force: false });
      result.removed += 1;
      result.removedBytes += candidate.bytes;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

function availableBytes(filePath) {
  const stat = fs.statfsSync(filePath, { bigint: true });
  return Number(stat.bavail * stat.bsize);
}

function category(run) {
  try {
    return run();
  } catch (error) {
    return { candidates: 0, candidateBytes: 0, removed: 0, removedBytes: 0, errors: 1, error: error instanceof Error ? error.message : String(error) };
  }
}

export function runMaintenance({
  apply = false,
  config = DEFAULT_CONFIG,
  now = Date.now(),
  busySnapshot = collectBusyPathSnapshot(),
  busyPaths = busySnapshot.paths,
  mountPaths = collectMountPaths(),
  lockedEnvironmentNames = process.env[LOCKED_ENVIRONMENTS_ENV]?.split(",").filter(Boolean) ?? ENVIRONMENT_NAMES,
} = {}) {
  if (apply && typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("--apply must run as root");
  }
  const freeBeforeBytes = availableBytes(config.repo);
  const categories = {
    previousSources: busySnapshot.complete
      ? category(() => removePreviousSourceCandidates(
        stalePreviousSourceCandidates({
          envsRoot: config.envsRoot,
          now,
          retentionMs: config.previousRetentionMs,
          busyPaths,
          mountPaths,
          environmentNames: lockedEnvironmentNames,
        }),
        apply,
        {
          envsRoot: config.envsRoot,
          now,
          retentionMs: config.previousRetentionMs,
          environmentNames: lockedEnvironmentNames,
        },
      ))
      : { candidates: 0, candidateBytes: 0, removed: 0, removedBytes: 0, errors: 1, error: "Incomplete /proc scan; previous-source cleanup skipped" },
    ciUploads: category(() => removeCiUploadCandidates(
      staleCiUploadCandidates({
        uploadRoot: config.uploadRoot,
        now,
        retentionMs: config.ciRetentionMs,
        busyPaths,
        mountPaths,
      }),
      apply,
      { uploadRoot: config.uploadRoot, now, retentionMs: config.ciRetentionMs },
    )),
    apks: category(() => removeCandidates(unreferencedApkCandidates({ releaseDir: config.releaseDir, now, graceMs: config.apkGraceMs, busyPaths }), apply)),
  };
  const freeAfterBytes = availableBytes(config.repo);
  return {
    event: "brai_storage_maintenance",
    mode: apply ? "apply" : "dry-run",
    checkedAt: new Date(now).toISOString(),
    freeBeforeBytes,
    freeAfterBytes,
    pressureThresholdBytes: config.pressureBytes,
    underPressure: freeBeforeBytes < config.pressureBytes,
    candidateBytes: Object.values(categories).reduce((sum, item) => sum + item.candidateBytes, 0),
    removedBytes: Object.values(categories).reduce((sum, item) => sum + item.removedBytes, 0),
    errors: Object.values(categories).reduce((sum, item) => sum + item.errors, 0),
    categories,
    protected: ["sessions", "databases", "docker-volumes", "docker-images", "source.orphan", "backups", "worktrees", "dependency-caches"],
  };
}

export function runApplyUnderMaintenanceLocks({
  options,
  config = DEFAULT_CONFIG,
  env = process.env,
  scriptPath = fileURLToPath(import.meta.url),
  nodePath = process.execPath,
  spawn = spawnSync,
} = {}) {
  if (!options?.apply || env[MAINTENANCE_LOCKS_HELD_ENV] === "1") return null;
  if (!assertPlainDirectory(config.releaseDir)) throw new Error(`Release directory is missing: ${config.releaseDir}`);
  const lockedEnvironments = lockedEnvironmentRoots(config.envsRoot);
  if (!assertPlainDirectory(config.uploadRoot)) throw new Error(`CI upload root is missing: ${config.uploadRoot}`);
  const stagingLockPath = path.join(config.uploadRoot, ".staging-operation.lock");
  const stagingLockStat = lstatOrNull(stagingLockPath);
  if (!stagingLockStat?.isFile() || stagingLockStat.isSymbolicLink()) {
    throw new Error(`Refusing missing or unsafe staging operation lock: ${stagingLockPath}`);
  }
  const lockPaths = [
    ...lockedEnvironments.map(({ lockPath }) => lockPath),
    stagingLockPath,
    config.releaseDir,
  ];
  let command = [nodePath, scriptPath, "--apply"];
  for (let index = lockPaths.length - 1; index >= 0; index -= 1) {
    command = ["/usr/bin/flock", "--exclusive", lockPaths[index], ...command];
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: {
      ...env,
      [MAINTENANCE_LOCKS_HELD_ENV]: "1",
      [LOCKED_ENVIRONMENTS_ENV]: lockedEnvironments.map(({ name }) => name).join(","),
    },
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

async function main() {
  try {
    const options = parseArgs();
    const lockedExitCode = runApplyUnderMaintenanceLocks({ options });
    if (lockedExitCode !== null) {
      process.exitCode = lockedExitCode;
      return;
    }
    const summary = runMaintenance(options);
    console.log(JSON.stringify(summary));
    if (summary.errors) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: "brai_storage_maintenance", status: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
