import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectBusyPathSnapshot,
  collectMountPaths,
  parseArgs,
  removeCiUploadCandidates,
  removeCandidates,
  removePreviousSourceCandidates,
  runApplyUnderMaintenanceLocks,
  runMaintenance,
  staleCiUploadCandidates,
  stalePreviousSourceCandidates,
  unreferencedApkCandidates,
} from "./storage-maintenance.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "brai-storage-maintenance-"));
}

function makeOld(filePath, now) {
  const old = new Date(now - 40 * DAY_MS);
  fs.utimesSync(filePath, old, old);
}

function writeDeployIdentity(directory, branch) {
  fs.writeFileSync(path.join(directory, ".brai-deploy-commit"), `${"a".repeat(40)}\n`);
  fs.writeFileSync(path.join(directory, ".brai-deploy-branch"), `${branch}\n`);
}

function writePreviousOwnership(directory, branch, attempt, createdAt = new Date().toISOString()) {
  fs.writeFileSync(path.join(directory, ".brai-previous-source.json"), JSON.stringify({
    attempt,
    replacedByBranch: branch,
    replacedByCommit: "a".repeat(40),
    createdAt,
  }));
}

test("storage maintenance is dry-run unless --apply is explicit", () => {
  assert.deepEqual(parseArgs([]), { apply: false });
  assert.deepEqual(parseArgs(["--dry-run"]), { apply: false });
  assert.deepEqual(parseArgs(["--apply"]), { apply: true });
  assert.throws(() => parseArgs(["--apply", "--dry-run"]), /either/);
  assert.throws(() => parseArgs(["--all"]), /Unknown argument/);
});

test("storage maintenance takes existing source locks before the release lock without creating missing locks", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envsRoot = path.join(root, "envs");
  const uploadRoot = path.join(envsRoot, "ci-uploads");
  const stagingLock = path.join(uploadRoot, ".staging-operation.lock");
  const releaseDir = path.join(root, "releases");
  const prodLock = path.join(envsRoot, "prod", ".source-operation.lock");
  const devLock = path.join(envsRoot, "dev", ".source-operation.lock");
  const missingLock = path.join(envsRoot, "preview-a", ".source-operation.lock");
  for (const environment of ["prod", "dev", "preview-a"]) fs.mkdirSync(path.join(envsRoot, environment), { recursive: true });
  fs.mkdirSync(uploadRoot);
  fs.writeFileSync(prodLock, "");
  fs.writeFileSync(devLock, "");
  fs.writeFileSync(stagingLock, "");
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0 };
  };

  assert.equal(runApplyUnderMaintenanceLocks({
    options: { apply: false },
    config: { envsRoot, uploadRoot, releaseDir },
    spawn,
  }), null);
  assert.equal(fs.existsSync(releaseDir), false);
  fs.mkdirSync(releaseDir);
  assert.equal(runApplyUnderMaintenanceLocks({
    options: { apply: true },
    config: { envsRoot, uploadRoot, releaseDir },
    env: { TEST_ENV: "kept" },
    scriptPath: "/srv/opt/brai-storage-maintenance.mjs",
    nodePath: "/srv/opt/node/bin/node",
    spawn,
  }), 0);

  assert.equal(fs.statSync(releaseDir).isDirectory(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/flock");
  assert.deepEqual(calls[0][1], [
    "--exclusive",
    prodLock,
    "/usr/bin/flock", "--exclusive", devLock,
    "/usr/bin/flock", "--exclusive", stagingLock,
    "/usr/bin/flock", "--exclusive", releaseDir,
    "/srv/opt/node/bin/node", "/srv/opt/brai-storage-maintenance.mjs", "--apply",
  ]);
  assert.equal(fs.existsSync(missingLock), false);
  assert.equal(calls[0][2].env.TEST_ENV, "kept");
  assert.equal(calls[0][2].env.BRAI_STORAGE_MAINTENANCE_LOCKS_HELD, "1");
  assert.equal(calls[0][2].env.BRAI_STORAGE_LOCKED_ENVIRONMENTS, "prod,dev");
  fs.writeFileSync(missingLock, "");
  const latePrevious = path.join(envsRoot, "preview-a", "source.previous-20260714010101-1001");
  fs.mkdirSync(latePrevious);
  writePreviousOwnership(latePrevious, "codex/late-lock", "20260714010101-1001");
  assert.deepEqual(stalePreviousSourceCandidates({
    envsRoot,
    now: Date.now() + 40 * DAY_MS,
    environmentNames: calls[0][2].env.BRAI_STORAGE_LOCKED_ENVIRONMENTS.split(","),
  }), []);
  assert.equal(runApplyUnderMaintenanceLocks({
    options: { apply: true },
    config: { envsRoot, uploadRoot, releaseDir },
    env: { BRAI_STORAGE_MAINTENANCE_LOCKS_HELD: "1" },
    spawn,
  }), null);
  assert.equal(calls.length, 1);
});

test("busy-path collection fails closed on unreadable proc links and decodes mount points", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const procRoot = path.join(root, "proc");
  fs.mkdirSync(path.join(procRoot, "123", "fd"), { recursive: true });
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const snapshot = collectBusyPathSnapshot(procRoot, {
    readdirSync: (...args) => fs.readdirSync(...args),
    readlinkSync: () => { throw denied; },
  });
  assert.deepEqual(snapshot, { paths: [], complete: false });

  const mountInfo = path.join(root, "mountinfo");
  fs.writeFileSync(mountInfo, "36 25 0:32 / /srv/example\\040mount rw,relatime - ext4 /dev/root rw\n");
  assert.deepEqual(collectMountPaths(mountInfo), ["/srv/example mount"]);
});

test("root previous-source cleanup requires ownership, age, idle paths, no mounts, and an existing lock", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envsRoot = path.join(root, "envs");
  const prod = path.join(envsRoot, "prod");
  const dev = path.join(envsRoot, "dev");
  fs.mkdirSync(prod, { recursive: true });
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(prod, ".source-operation.lock"), "");

  const idle = path.join(prod, "source.previous-20260714010101-1001");
  const busy = path.join(prod, "source.previous-20260714010102-1002");
  const mounted = path.join(prod, "source.previous-local-0-deploy-1003-2003");
  const wrongBranch = path.join(prod, "source.previous-20260714010104-1004");
  const manual = path.join(prod, "source.previous-manual-backup");
  const noLock = path.join(dev, "source.previous-20260714010105-1005");
  const outside = path.join(root, "outside");
  const linked = path.join(prod, "source.previous-20260714010106-1006");
  for (const directory of [idle, busy, mounted, wrongBranch, manual, noLock, outside]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  for (const directory of [idle, busy, mounted]) writePreviousOwnership(directory, "main", directory.slice(directory.lastIndexOf("source.previous-") + "source.previous-".length));
  writePreviousOwnership(wrongBranch, "dev", "20260714010104-1004");
  writePreviousOwnership(noLock, "dev", "20260714010105-1005");
  fs.symlinkSync(outside, linked);

  const futureNow = Date.now() + 40 * DAY_MS;
  const candidates = stalePreviousSourceCandidates({
    envsRoot,
    now: futureNow,
    busyPaths: [path.join(busy, "services", "worker.js")],
    mountPaths: [path.join(mounted, "bound-data")],
  });
  assert.deepEqual(candidates.map((item) => item.filePath), [idle]);
  assert.deepEqual(removePreviousSourceCandidates(candidates, true, {
    envsRoot,
    now: futureNow,
    busySnapshotProvider: () => ({ paths: [], complete: true }),
    mountPathsProvider: () => [],
  }), {
    candidates: 1,
    candidateBytes: candidates[0].bytes,
    removed: 1,
    removedBytes: candidates[0].bytes,
    errors: 0,
  });
  assert.equal(fs.existsSync(idle), false);
  for (const kept of [busy, mounted, wrongBranch, manual, noLock, linked, outside]) assert.equal(fs.existsSync(kept), true);

  const freshSource = path.join(prod, "source");
  fs.mkdirSync(freshSource);
  fs.writeFileSync(path.join(freshSource, "old-file"), "old");
  writeDeployIdentity(freshSource, "main");
  const beforeRename = Date.now();
  makeOld(path.join(freshSource, "old-file"), beforeRename);
  makeOld(path.join(freshSource, ".brai-deploy-commit"), beforeRename);
  makeOld(path.join(freshSource, ".brai-deploy-branch"), beforeRename);
  makeOld(freshSource, beforeRename);
  const freshlyRenamed = path.join(prod, "source.previous-20260714010107-1007");
  fs.renameSync(freshSource, freshlyRenamed);
  writePreviousOwnership(freshlyRenamed, "main", "20260714010107-1007");
  assert.equal(stalePreviousSourceCandidates({ envsRoot, now: Date.now(), retentionMs: DAY_MS }).some((item) => item.filePath === freshlyRenamed), false);

  const readySuffix = "local-0-deploy-1008-2008";
  const readyPrevious = path.join(prod, `source.previous-${readySuffix}`);
  const currentSource = path.join(prod, "source");
  fs.mkdirSync(readyPrevious);
  fs.mkdirSync(currentSource);
  writePreviousOwnership(readyPrevious, "main", readySuffix);
  writeDeployIdentity(currentSource, "main");
  fs.writeFileSync(path.join(currentSource, ".brai-deploy-attempt"), `${readySuffix}\n`);
  fs.writeFileSync(path.join(currentSource, ".brai-goal-agent-ready.json"), JSON.stringify({
    attempt: readySuffix,
    branch: "main",
    commit: "a".repeat(40),
  }));
  assert.deepEqual(
    stalePreviousSourceCandidates({ envsRoot, now: Date.now(), retentionMs: DAY_MS }).map((item) => item.filePath),
    [readyPrevious],
  );
});

test("recursive cleanup rechecks proc, mounts, ownership, and age immediately before each removal", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const maintenanceNow = now + 40 * DAY_MS;
  const envsRoot = path.join(root, "envs");
  const prod = path.join(envsRoot, "prod");
  const previous = path.join(prod, "source.previous-20260714020202-2002");
  const uploadRoot = path.join(envsRoot, "ci-uploads");
  const upload = path.join(uploadRoot, `main-${"b".repeat(40)}.attempt-old`);
  fs.mkdirSync(previous, { recursive: true });
  fs.mkdirSync(upload, { recursive: true });
  fs.writeFileSync(path.join(prod, ".source-operation.lock"), "");
  writePreviousOwnership(previous, "main", "20260714020202-2002", new Date(now - 40 * DAY_MS).toISOString());
  fs.writeFileSync(path.join(upload, "file"), "old");
  fs.writeFileSync(path.join(upload, ".brai-upload-terminal.json"), JSON.stringify({
    status: "failed",
    commit: "b".repeat(40),
    finishedAt: new Date(now - 40 * DAY_MS).toISOString(),
  }));
  for (const filePath of [
    path.join(previous, ".brai-previous-source.json"),
    previous,
    path.join(upload, "file"),
    path.join(upload, ".brai-upload-terminal.json"),
    upload,
  ]) makeOld(filePath, now);

  const previousCandidates = stalePreviousSourceCandidates({ envsRoot, now: maintenanceNow });
  const uploadCandidates = staleCiUploadCandidates({ uploadRoot, now: maintenanceNow });
  assert.equal(previousCandidates.length, 1);
  assert.equal(uploadCandidates.length, 1);

  const skippedPrevious = removePreviousSourceCandidates(previousCandidates, true, {
    envsRoot,
    now: maintenanceNow,
    busySnapshotProvider: () => ({ paths: [path.join(previous, "services", "worker.js")], complete: true }),
    mountPathsProvider: () => [],
  });
  const skippedUpload = removeCiUploadCandidates(uploadCandidates, true, {
    uploadRoot,
    now: maintenanceNow,
    busySnapshotProvider: () => ({ paths: [], complete: true }),
    mountPathsProvider: () => [path.join(upload, "bound-data")],
  });
  assert.equal(skippedPrevious.removed, 0);
  assert.equal(skippedPrevious.errors, 0);
  assert.equal(skippedUpload.removed, 0);
  assert.equal(skippedUpload.errors, 0);
  assert.equal(fs.existsSync(previous), true);
  assert.equal(fs.existsSync(upload), true);

  const removedUpload = removeCiUploadCandidates(uploadCandidates, true, {
    uploadRoot,
    now: maintenanceNow,
    busySnapshotProvider: () => ({ paths: [], complete: true }),
    mountPathsProvider: () => [],
  });
  assert.equal(removedUpload.removed, 1);
  assert.equal(removedUpload.errors, 0);
  assert.equal(fs.existsSync(upload), false);

  const incomplete = removePreviousSourceCandidates(previousCandidates, true, {
    envsRoot,
    now: maintenanceNow,
    busySnapshotProvider: () => ({ paths: [], complete: false }),
    mountPathsProvider: () => [],
  });
  assert.equal(incomplete.errors, 1);
  assert.equal(fs.existsSync(previous), true);
});

test("incomplete root proc scan skips previous-source cleanup with an error", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envsRoot = path.join(root, "envs");
  const prod = path.join(envsRoot, "prod");
  const uploadRoot = path.join(envsRoot, "ci-uploads");
  const releaseDir = path.join(root, "releases");
  const previous = path.join(prod, "source.previous-20260714010101-1001");
  for (const directory of [prod, uploadRoot, releaseDir, previous]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(prod, ".source-operation.lock"), "");
  fs.writeFileSync(path.join(releaseDir, "releases.json"), JSON.stringify({ sections: {} }));
  writePreviousOwnership(previous, "main", "20260714010101-1001");

  const summary = runMaintenance({
    config: {
      repo: root,
      envsRoot,
      uploadRoot,
      releaseDir,
      ciRetentionMs: DAY_MS,
      previousRetentionMs: DAY_MS,
      apkGraceMs: DAY_MS,
      pressureBytes: 0,
    },
    now: Date.now() + 40 * DAY_MS,
    busySnapshot: { paths: [], complete: false },
    mountPaths: [],
  });
  assert.equal(summary.categories.previousSources.errors, 1);
  assert.match(summary.categories.previousSources.error, /Incomplete \/proc scan/);
  assert.equal(fs.existsSync(previous), true);
});

test("stale CI cleanup accepts only old terminal or abandoned active SHA staging directories", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const old = path.join(root, `codex-safe-${"a".repeat(40)}.attempt-10`);
  const succeeded = path.join(root, `codex-succeeded-${"d".repeat(40)}.attempt-10b`);
  const busy = path.join(root, `codex-busy-${"b".repeat(40)}.attempt-11`);
  const recent = path.join(root, `main-${"c".repeat(40)}.attempt-12`);
  const active = path.join(root, `main-${"e".repeat(40)}.attempt-13`);
  const mismatched = path.join(root, `main-${"f".repeat(40)}.attempt-14`);
  const unknown = path.join(root, `main-${"1".repeat(40)}.attempt-15`);
  const badTimestamp = path.join(root, `main-${"2".repeat(40)}.attempt-16`);
  const mounted = path.join(root, `main-${"3".repeat(40)}.attempt-17`);
  const invalid = path.join(root, "source.orphan-legacy");
  for (const item of [old, succeeded, busy, recent, active, mismatched, unknown, badTimestamp, mounted, invalid]) {
    fs.mkdirSync(item);
    fs.writeFileSync(path.join(item, "file"), "data");
  }
  for (const item of [old, succeeded, busy, active, mismatched, unknown, badTimestamp, mounted, invalid]) {
    makeOld(path.join(item, "file"), now);
  }
  for (const [item, status, commit, finishedAt] of [
    [old, "failed", "a".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
    [succeeded, "succeeded", "d".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
    [busy, "cancelled", "b".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
    [recent, "active", "c".repeat(40), null],
    [active, "active", "e".repeat(40), null],
    [mismatched, "failed", "0".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
    [unknown, "unknown", "1".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
    [badTimestamp, "failed", "2".repeat(40), "2020-01-01"],
    [mounted, "failed", "3".repeat(40), new Date(now - 40 * DAY_MS).toISOString()],
  ]) fs.writeFileSync(path.join(item, ".brai-upload-terminal.json"), JSON.stringify({ status, commit, finishedAt }));
  for (const item of [old, succeeded, busy, active, mismatched, unknown, badTimestamp, mounted]) {
    makeOld(path.join(item, ".brai-upload-terminal.json"), now);
    makeOld(item, now);
  }

  assert.deepEqual(
    staleCiUploadCandidates({
      uploadRoot: root,
      now,
      busyPaths: [path.join(busy, "node_modules")],
      mountPaths: [path.join(mounted, "bound-data")],
    }).map((item) => item.filePath),
    [old, succeeded, active],
  );
});

test("APK cleanup preserves the release index, fresh files, and symlinks", (t) => {
  const root = tempRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  fs.writeFileSync(path.join(root, "releases.json"), JSON.stringify({ sections: { production: { file: "current.apk" } } }));
  fs.writeFileSync(path.join(root, "current.apk"), "current");
  fs.writeFileSync(path.join(root, "old.apk"), "old");
  fs.writeFileSync(path.join(root, "fresh.apk"), "fresh");
  fs.symlinkSync(path.join(root, "old.apk"), path.join(root, "linked.apk"));
  makeOld(path.join(root, "current.apk"), now);
  makeOld(path.join(root, "old.apk"), now);

  assert.deepEqual(unreferencedApkCandidates({ releaseDir: root, now }).map((item) => path.basename(item.filePath)), ["old.apk"]);

  fs.writeFileSync(path.join(root, "alternate-releases.json"), JSON.stringify({ sections: {} }));
  fs.rmSync(path.join(root, "releases.json"));
  fs.symlinkSync(path.join(root, "alternate-releases.json"), path.join(root, "releases.json"));
  assert.throws(() => unreferencedApkCandidates({ releaseDir: root, now }), /non-regular release index/);
});
