import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("late commit A cannot mutate or complete commit B preview lease", (context) => {
  const { envsRoot, run } = runner(context);

  assert.equal(run("allocate", "codex/race", "commit-a", "10").status, 0);
  assert.equal(run("assert-owned", "codex/race", "commit-a").status, 0);
  assert.equal(run("allocate", "codex/race", "commit-b", "20").status, 0);
  const registryPath = path.join(envsRoot, "preview-slots.json");
  const beforeAssert = fs.readFileSync(registryPath, "utf8");

  const staleAssert = run("assert-owned", "codex/race", "commit-a");
  assert.equal(staleAssert.status, 1);
  assert.match(staleAssert.stderr, /belongs to commit-b, not commit-a/);
  assert.equal(run("assert-owned", "codex/race", "commit-b").status, 0);
  assert.equal(fs.readFileSync(registryPath, "utf8"), beforeAssert);

  for (const args of [
    ["allocate", "codex/race", "commit-a", "10"],
    ["allocate", "codex/race", "commit-c", "20"],
    ["allocate", "codex/race", "commit-c"]
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly superseded generation 20`);
  }

  for (const args of [
    ["ready", "codex/race", "commit-a"],
    ["failed", "codex/race", "commit-a"],
    ["clear-apk", "codex/race", "commit-a"],
    ["supabase", "codex/race", "commit-a", "stale-branch", "stale-id", "ACTIVE_HEALTHY"],
    ["next-apk-preview", "codex/race", "commit-a", "1"],
    ["apk", "codex/race", "commit-a", "10001", "brai.apk", "1", "1", "preview"]
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(result.stderr, /belongs to commit-b, not commit-a/);
  }

  const beforeReady = JSON.parse(run("status").stdout).registry.A;
  assert.equal(beforeReady.commit, "commit-b");
  assert.equal(beforeReady.lease_generation, 20);
  assert.equal(beforeReady.status, "deploying");

  assert.equal(run("ready", "codex/race", "commit-b").status, 0);
  const ready = JSON.parse(run("status").stdout).registry.A;
  assert.equal(ready.commit, "commit-b");
  assert.equal(ready.status, "ready");
  assert.equal(run("supabase", "codex/race", "commit-b", "current-branch", "current-id", "ACTIVE_HEALTHY").status, 0);
  const withSupabase = JSON.parse(run("status").stdout).registry.A;
  assert.equal(withSupabase.supabase_branch_name, "current-branch");
  assert.equal(withSupabase.supabase_branch_id, "current-id");
});

test("queued preview lease also rejects a lower generation", (context) => {
  const { run } = runner(context);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(run("allocate", `codex/owner-${index}`, `owner-${index}`, String(index + 1)).status, 0);
  }
  assert.equal(run("allocate", "codex/queued", "commit-b", "20").status, 0);
  const stale = run("allocate", "codex/queued", "commit-a", "10");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale preview lease generation 10; current generation is 20/);

  const queued = JSON.parse(run("status").stdout).registry.queue.find((entry) => entry.branch === "codex/queued");
  assert.equal(queued.commit, "commit-b");
  assert.equal(queued.lease_generation, 20);
});

test("allocation distinguishes exact failed-deploy recovery from a missing ready source", (context) => {
  const { run } = runner(context);

  const initial = JSON.parse(run("allocate", "codex/retry", "commit-a", "10").stdout);
  assert.equal(initial.allocatedNew, true);
  assert.equal(initial.recoveringFailed, false);

  assert.equal(run("failed", "codex/retry", "commit-a").status, 0);
  const retry = JSON.parse(run("allocate", "codex/retry", "commit-b", "20").stdout);
  assert.equal(retry.allocatedNew, false);
  assert.equal(retry.recoveringFailed, true);

  assert.equal(run("ready", "codex/retry", "commit-b").status, 0);
  const readyUpdate = JSON.parse(run("allocate", "codex/retry", "commit-c", "30").stdout);
  assert.equal(readyUpdate.allocatedNew, false);
  assert.equal(readyUpdate.recoveringFailed, false);
});

test("deploy permits missing source only for a new slot or exact failed recovery", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const deploy = fs.readFileSync(path.join(root, "deploy/scripts/ci-ssh-deploy.sh"), "utf8");
  assert.match(deploy, /BRAI_PREVIEW_RECOVERING_FAILED=.*allocation_field recoveringFailed/);
  assert.match(deploy, /SOURCE_PRESENT.*preview-\*[\s\S]*BRAI_PREVIEW_ALLOCATED_NEW[\s\S]*BRAI_PREVIEW_RECOVERING_FAILED/);
  assert.match(deploy, /Missing Preview source is safe only for a new slot or exact failed-deploy recovery/);
});

test("follow-up allocation reports the failed preview APK state", (context) => {
  const { run } = runner(context);
  assert.equal(run("allocate", "codex/native-revert", "commit-a", "10").status, 0);
  assert.equal(run("apk", "codex/native-revert", "commit-a", "120002", "brai-b-v12-preview2.apk", "12", "2", "preview").status, 0);
  assert.equal(run("failed", "codex/native-revert", "commit-a").status, 0);

  const followUp = JSON.parse(run("allocate", "codex/native-revert", "commit-b", "20").stdout);
  assert.equal(followUp.previousStatus, "failed");
  assert.equal(followUp.previousApkBuildKind, "preview");
  assert.equal(followUp.entry.status, "deploying");
  assert.equal(followUp.entry.commit, "commit-b");
});

function runner(context) {
  const envsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preview-cas-"));
  context.after(() => fs.rmSync(envsRoot, { recursive: true, force: true }));
  const run = (...args) => spawnSync("bash", ["deploy/scripts/preview-slots.sh", ...args], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_BIN: process.execPath,
      BRAI_ENVS_ROOT: envsRoot,
      BRAI_PREVIEW_REGISTRY: path.join(envsRoot, "preview-slots.json"),
      BRAI_PREVIEW_LOCK: path.join(envsRoot, "preview-slots.lock")
    }
  });
  return { envsRoot, run };
}

test("Preview note is revision-bound and cleared by a new commit", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const envs = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preview-note-"));
  const registry = path.join(envs, "preview-slots.json");
  const env = { ...process.env, BRAI_ROOT: root, BRAI_ENVS_ROOT: envs, BRAI_PREVIEW_REGISTRY: registry };
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "deploy/scripts/preview-slots.mjs"), ...args], { cwd: root, env, encoding: "utf8" });
  const note = Buffer.from(JSON.stringify({
    short_changes: "Добавлена панель.",
    detailed_changes: "Контекстная панель доступна на основных страницах.",
    reason: "Нужно проверить новый способ навигации.",
    testing: "Открыть и закрыть панель, изменить ширину и перезагрузить страницу.",
  })).toString("base64");

  assert.equal(run("allocate", "codex/test-note", "commit-one").status, 0);
  assert.equal(run("ready", "codex/test-note", "commit-one").status, 0);
  assert.equal(run("note", "codex/test-note", "commit-one", note).status, 0);
  let saved = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(saved.A.review_note.commit, "commit-one");
  assert.match(saved.A.review_note.testing, /изменить ширину/);

  assert.notEqual(run("note", "codex/test-note", "wrong-commit", note).status, 0);
  assert.equal(run("allocate", "codex/test-note", "commit-two").status, 0);
  saved = JSON.parse(fs.readFileSync(registry, "utf8"));
  assert.equal(saved.A.review_note, null);
});
