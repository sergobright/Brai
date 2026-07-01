import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_BRANCH_RE,
  analyzeHookInput,
  classifyDelivery,
  deliveryHandoff,
  deliveryClassForFile,
  dependencySourceRoot,
  deriveTaskState,
  enableGitHooks,
  findOpenTaskForThread,
  isBlockingAcceptanceReceipt,
  isManualBranchCommand,
  isManualCodexBranchCommand,
  isReadOnlyShellCommand,
  isSensitivePath,
  isTaskBaseRefreshCommand,
  isWriteLikeCommand,
  linkDependencyDirs,
  parseHookInput,
  taskStartGuidance,
  taskWorktreeParent,
  validateTaskMarker,
  validateTaskThread,
  validateDeliveryReceipt,
  validatePreviewReceipt,
  validatePushUpdate,
} from "./bright-task.mjs";
import { acceptedPreviewBranches } from "../deploy/scripts/accepted-preview-branches.mjs";
import { requiresNativeApkChange } from "../deploy/scripts/detect-native-apk-change.mjs";

test("valid codex task branch names are strict", () => {
  assert.equal(CODEX_BRANCH_RE.test("codex/enforce-branch-preview-guards"), true);
  assert.equal(CODEX_BRANCH_RE.test("codex/Focus"), false);
  assert.equal(CODEX_BRANCH_RE.test("dev"), false);
  assert.equal(CODEX_BRANCH_RE.test("codex/"), false);
});

test("write-like shell commands are detected", () => {
  assert.equal(isReadOnlyShellCommand("git status --short"), true);
  assert.equal(isReadOnlyShellCommand("rg Preview docs"), true);
  assert.equal(isReadOnlyShellCommand("sed -n '1,20p' scripts/bright-task.mjs"), true);
  assert.equal(isWriteLikeCommand("git status --short"), false);
  assert.equal(isWriteLikeCommand("rg Preview docs"), false);
  assert.equal(isWriteLikeCommand("git commit -m guard"), true);
  assert.equal(isWriteLikeCommand("sed -i 's/a/b/' file"), true);
  assert.equal(isWriteLikeCommand("node -e \"fs.writeFileSync('x','y')\""), true);
  assert.equal(isWriteLikeCommand("some-new-cli --maybe-write"), true);
});

test("manual branch commands are hard blocked", () => {
  assert.equal(isManualCodexBranchCommand("git switch -c codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git checkout -b codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git branch codex/foo"), true);
  assert.equal(isManualCodexBranchCommand("git worktree add ../foo -b codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git branch --show-current"), false);
  assert.equal(isManualBranchCommand("git switch -c feature/foo origin/main"), true);
  assert.equal(isManualBranchCommand("git checkout main"), true);
  assert.equal(isManualBranchCommand("git branch"), true);
  assert.equal(isManualBranchCommand("git worktree list"), true);
});

test("task base refresh commands are hard blocked", () => {
  assert.equal(isTaskBaseRefreshCommand("git fetch origin"), true);
  assert.equal(isTaskBaseRefreshCommand("git fetch origin --prune"), true);
  assert.equal(isTaskBaseRefreshCommand("git fetch origin main"), true);
  assert.equal(isTaskBaseRefreshCommand("git fetch origin +refs/heads/main:refs/remotes/origin/main"), true);
  assert.equal(isTaskBaseRefreshCommand("git pull origin main"), true);
  assert.equal(isTaskBaseRefreshCommand("git merge origin/main"), true);
  assert.equal(isTaskBaseRefreshCommand("git rebase origin/main"), true);
  assert.equal(isTaskBaseRefreshCommand("git fetch origin +refs/heads/codex/foo:refs/remotes/origin/codex/foo"), false);
});

test("hook analysis detects namespaced custom and nested write tools", () => {
  for (const input of [
    { tool_name: "functions.apply_patch", tool_input: { patch: "*** Begin Patch" } },
    { tool: "custom_tool_call", name: "apply_patch" },
    {
      tool_name: "multi_tool_use.parallel",
      tool_input: {
        tool_uses: [{ recipient_name: "functions.exec_command", parameters: { cmd: "touch x" } }],
      },
    },
  ]) {
    const result = analyzeHookInput(JSON.stringify(input));
    assert.equal(result.ok, true);
    assert.equal(result.write, true);
  }
});

test("hook analysis blocks base refresh inside an active task branch", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-base-refresh-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    process.chdir(repo);

    const result = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "git merge origin/main" } }));
    assert.equal(result.ok, true);
    assert.match(result.blockedReason, /original task base/);
  } finally {
    process.chdir(previous);
  }
});

test("hook analysis allows official acceptance reconcile command", () => {
  const result = analyzeHookInput(JSON.stringify({
    tool_name: "functions.exec_command",
    tool_input: { cmd: "node scripts/bright-task.mjs acceptance-reconcile codex/foo" },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.write, true);
  assert.equal(result.officialAcceptanceReconcile, true);
  assert.equal(result.blockedReason, undefined);
});

test("codex project pre-tool hook is unconditional and uses the installed guard", () => {
  const hooks = JSON.parse(fs.readFileSync(new URL("../.codex/hooks.json", import.meta.url), "utf8"));
  assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.equal(Object.hasOwn(hooks.hooks.PreToolUse[0], "matcher"), false);
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /\/srv\/opt\/bright-os-codex-plugins\/plugins\/bright-os-guard\/hooks\/bright-os-guard\.mjs pre-tool-use/);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /\/srv\/opt\/bright-os-codex-plugins\/plugins\/bright-os-guard\/hooks\/bright-os-guard\.mjs stop/);
});

test("main checkout lock locks non-current worktrees by default", () => {
  const script = fs.readFileSync(new URL("./bright-main-checkout-lock.sh", import.meta.url), "utf8");
  assert.match(script, /git -C "\$root" worktree list --porcelain/);
  assert.match(script, /bright-os-worktrees/);
  assert.match(script, /BRIGHT_OS_LOCK_STALE_WORKTREES:-1/);
  assert.match(script, /BRIGHT_OS_LOCK_CURRENT_WORKTREE/);
  assert.match(script, /restore_task_state_access\(\)/);
  assert.match(script, /restore_task_state_access "\$worktree_path"/);
  assert.match(script, /sudo chown mark:mark "\$task_state"/);
  assert.match(script, /sudo chmod 0770 "\$task_state"/);
  assert.match(script, /-maxdepth 1 -type f -name '\*\.json'/);
  assert.match(script, /sudo chmod 0751 "\$root"/);
  assert.match(script, /sudo chmod u=rwx,g=rx,o=x "\$root\/deploy"/);
  assert.match(script, /Writable task worktree parent/);
});

test("local main sync preserves runtime dirs and hard resets to origin main", () => {
  const script = fs.readFileSync(new URL("../deploy/scripts/sync-local-main-checkout.sh", import.meta.url), "utf8");
  const ciScript = fs.readFileSync(new URL("../deploy/scripts/ci-ssh-sync-main-checkout.sh", import.meta.url), "utf8");
  const playbook = fs.readFileSync(new URL("../deploy/ansible/bright-os.yml", import.meta.url), "utf8");
  assert.match(script, /REPO="\/srv\/projects\/bright-os"/);
  assert.match(script, /Usage: \$0 \[expected-main-commit\]/);
  assert.match(script, /runuser -u "\$GIT_USER"/);
  assert.match(script, /core\.hooksPath=\/dev\/null/);
  assert.match(script, /git_cmd checkout -f -B "\$BRANCH" "origin\/\$BRANCH"/);
  assert.match(script, /git_cmd reset --hard "origin\/\$BRANCH"/);
  assert.match(script, /-e data\//);
  assert.match(script, /-e deploy\/web\//);
  assert.match(script, /-e deploy\/releases\//);
  assert.match(script, /bright-os-rescue/);
  assert.match(script, /chmod 0751 "\$REPO"/);
  assert.match(script, /chmod u=rwx,g=rx,o=x deploy/);
  assert.match(script, /BRIGHT_OS_LOCK_STALE_WORKTREES:-1/);
  assert.match(script, /git_cmd worktree list --porcelain/);
  assert.match(script, /chown -R root:mark "\$worktree_path"/);
  assert.match(script, /restore_task_state_access\(\)/);
  assert.match(script, /restore_task_state_access "\$worktree_path"/);
  assert.match(script, /chown "\$GIT_USER:mark" "\$task_state"/);
  assert.match(script, /chmod 0770 "\$task_state"/);
  assert.match(ciScript, /sudo -n \/srv\/opt\/bright-os-main-sync\.sh "\$BRIGHT_OS_COMMIT"/);
  assert.doesNotMatch(ciScript, /DEPLOY_REPO/);
  assert.doesNotMatch(ciScript, /sudo BRIGHT_DEPLOY_REPO=/);
  assert.match(playbook, /bright_os_repo }}\/deploy\/releases/);
  assert.match(playbook, /dest: \/srv\/opt\/bright-os-main-sync\.sh/);
  assert.match(playbook, /owner: root/);
});

test("hook analysis fails closed for bad input and unknown tool shapes", () => {
  assert.equal(analyzeHookInput("not-json").ok, false);
  assert.equal(analyzeHookInput(JSON.stringify({ tool_name: "mystery_writer", tool_input: {} })).ok, false);
  assert.equal(analyzeHookInput(JSON.stringify({ tool_name: "multi_tool_use.parallel", tool_input: { tool_uses: [] } })).ok, false);
});

test("hook analysis allows read-only shell and official task starter", () => {
  assert.deepEqual(analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "git status --short" } })), {
    ok: true,
    write: false,
    officialTaskStarter: false,
    manualCodexBranch: false,
  });

  const starter = analyzeHookInput(JSON.stringify({
    tool_name: "functions.exec_command",
    tool_input: {
      cmd: "/srv/opt/node-v22.16.0/bin/node /srv/opt/bright-os-codex-plugins/plugins/bright-os-guard/hooks/bright-os-guard.mjs start guard-task",
    },
  }));
  assert.equal(starter.ok, true);
  assert.equal(starter.write, false);
  assert.equal(starter.officialTaskStarter, true);

  const manual = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "git switch -c codex/foo origin/main" } }));
  assert.equal(manual.manualCodexBranch, true);

  const nonCodexManual = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "git switch main" } }));
  assert.equal(nonCodexManual.manualCodexBranch, true);
});

test("hook analysis blocks stale repo-local task starter", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-stale-starter-"));
  const previous = process.cwd();
  try {
    git(["init"], tmp);
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.writeFileSync(path.join(tmp, "scripts", "bright-task-start.sh"), "#!/usr/bin/env bash\nnode scripts/bright-task.mjs start \"$@\"\n");
    process.chdir(tmp);

    const result = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "scripts/bright-task-start.sh guard-task" } }));
    assert.equal(result.ok, true);
    assert.match(result.blockedReason, /stale/);
  } finally {
    process.chdir(previous);
  }
});

test("sensitive paths are rejected for commits", () => {
  assert.equal(isSensitivePath("apps/bright_os_app/src/main.ts"), false);
  assert.equal(isSensitivePath("deploy/web/index.html"), true);
  assert.equal(isSensitivePath("data/bright_os.sqlite"), true);
  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath("android/release.keystore"), true);
});

test("delivery classifier separates infra-docs from runtime preview", () => {
  assert.equal(deliveryClassForFile("apps/bright_os_app/src/app/page.tsx"), "runtime");
  assert.equal(deliveryClassForFile("services/bright_os_api/src/server.js"), "runtime");
  assert.equal(deliveryClassForFile("docs/operations/branch-preview-environments.md"), "docs");
  assert.equal(deliveryClassForFile("openspec/specs/repository-operations/spec.md"), "docs");
  assert.equal(deliveryClassForFile(".github/workflows/bright-os-delivery.yml"), "infra");
  assert.equal(deliveryClassForFile(".gitignore"), "infra");
  assert.equal(deliveryClassForFile("apps/bright_os_app/tests/unit/publishScripts.test.ts"), "infra");
  assert.equal(deliveryClassForFile("deploy/environments.json"), "infra");
  assert.equal(deliveryClassForFile("deploy/ansible/bright-os.yml"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/build-nonproduction-apks.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/resolve-deploy-env.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/classify-delivery.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/sync-local-main-checkout.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/ci-ssh-sync-main-checkout.sh"), "infra");
  assert.equal(deliveryClassForFile("scripts/bright-task.mjs"), "infra");
  assert.equal(deliveryClassForFile("scripts/check-open-openspec-changes.mjs"), "infra");
  assert.equal(deliveryClassForFile("services/bright_os_temporal/src/state.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/web/index.html"), "blocked");
  assert.equal(deliveryClassForFile("package.json"), "unknown");

  assert.equal(classifyDelivery(["docs/foo.md"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery([".github/workflows/bright-os-delivery.yml"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery(["apps/bright_os_app/src/app/page.tsx"]).deliveryClass, "runtime-preview");
  assert.equal(classifyDelivery(["docs/foo.md", "apps/bright_os_app/src/app/page.tsx"]).deliveryClass, "runtime-preview");
  assert.equal(classifyDelivery(["package.json"]).fallback, "unknown_path");
  assert.equal(classifyDelivery(["deploy/web/index.html"]).deliveryClass, "blocked");
});

test("native APK detector ignores OTA web-layer changes", () => {
  assert.equal(requiresNativeApkChange(["apps/bright_os_app/android/app/build.gradle"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/ci-ssh-deploy.sh"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/ci-ssh-release-slot.sh"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/detect-native-apk-change.mjs"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/resolve-app-version.mjs"]), true);
  assert.equal(requiresNativeApkChange(["apps/bright_os_app/src/shared/platform/ota.ts"]), false);
  assert.equal(requiresNativeApkChange(["apps/bright_os_app/src/shared/platform/androidTimerNotification.ts"]), false);
  assert.equal(
    requiresNativeApkChange(["apps/bright_os_app/package.json"], '+    "next": "16.0.0",\n'),
    false,
  );
  assert.equal(
    requiresNativeApkChange(["apps/bright_os_app/package.json"], '+    "@capacitor/app": "7.0.0",\n'),
    true,
  );
});

test("production deploy resolves ledger version through the shared resolver", () => {
  const script = fs.readFileSync(new URL("../deploy/scripts/deploy-branch.sh", import.meta.url), "utf8");
  assert.match(script, /resolve-app-version\.mjs/);
  assert.doesNotMatch(script, /version_type_id = 'canon'/);
  assert.doesNotMatch(script, /version_type_id = 'release'/);
  assert.doesNotMatch(script, /version_type_id = 'build'/);
  assert.doesNotMatch(script, /version_type_id = 'apk'/);
});

test("preview deploy reset reports permission recovery and preserves setgid", () => {
  const script = fs.readFileSync(new URL("../deploy/scripts/deploy-branch.sh", import.meta.url), "utf8");
  const playbook = fs.readFileSync(new URL("../deploy/ansible/bright-os.yml", import.meta.url), "utf8");
  const unit = fs.readFileSync(new URL("../deploy/ansible/templates/brightos-api.service.j2", import.meta.url), "utf8");
  assert.match(script, /umask 0002/);
  assert.match(script, /Preview SQLite reset failed/);
  assert.match(script, /bright-deploy:bright-deploy 2775/);
  assert.ok(script.includes('find "$TARGET_ROOT" -type d -user "$(id -u)" -exec chmod g+s {} +'));
  assert.match(playbook, /Ensure non-production data directories keep deploy setgid/);
  assert.match(playbook, /Ensure nested non-production data directories keep deploy setgid/);
  assert.match(playbook, /mode: "2775"/);
  assert.match(unit, /Group={{ bright_os_deploy_user }}/);
  assert.match(unit, /SupplementaryGroups={{ bright_os_deploy_user }}/);
  assert.match(unit, /UMask=0002/);
});

test("pre-push ref updates must stay on matching codex ref", () => {
  assert.doesNotThrow(() =>
    validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/codex/foo 0000000000000000000000000000000000000000"),
  );
  assert.doesNotThrow(() =>
    validatePushUpdate("HEAD 1111111111111111111111111111111111111111 refs/heads/codex/foo 0000000000000000000000000000000000000000", "codex/foo"),
  );
  assert.doesNotThrow(() =>
    validatePushUpdate("(delete) 0000000000000000000000000000000000000000 refs/heads/codex/foo 1111111111111111111111111111111111111111"),
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/dev 0000000000000000000000000000000000000000"),
    /Direct push/,
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/dev 1111111111111111111111111111111111111111 refs/heads/dev 0000000000000000000000000000000000000000"),
    /Direct push/,
  );
  assert.throws(
    () =>
      validatePushUpdate("refs/heads/codex/foo 1111111111111111111111111111111111111111 refs/heads/codex/bar 0000000000000000000000000000000000000000"),
    /ref mismatch/,
  );
  assert.throws(
    () =>
      validatePushUpdate(
        "refs/heads/codex/foo 2222222222222222222222222222222222222222 refs/heads/codex/foo 1111111111111111111111111111111111111111",
        "codex/foo",
        { isAcceptedRemote: (sha) => sha.startsWith("1111") },
      ),
    /already included in origin\/main/,
  );
});

test("task marker must come from task start or explicit follow-up", () => {
  const marker = {
    branch: "codex/foo",
    mode: "new",
    base: "1111111111111111111111111111111111111111",
    createdAt: "2026-06-26T00:00:00.000Z",
  };
  assert.deepEqual(validateTaskMarker(marker, "codex/foo"), { ok: true });
  assert.deepEqual(validateTaskMarker({ ...marker, mode: "follow-up" }, "codex/foo"), { ok: true });
  assert.match(validateTaskMarker(null, "codex/foo").message, /marker is missing/);
  assert.match(validateTaskMarker({ branch: "codex/foo", mode: "manual" }, "codex/foo").message, /mode manual/);
  assert.match(validateTaskMarker({ ...marker, branch: "codex/bar" }, "codex/foo").message, /codex\/bar/);
  assert.match(validateTaskMarker({ ...marker, base: "" }, "codex/foo").message, /base/);
  assert.match(validateTaskMarker({ ...marker, createdAt: "" }, "codex/foo").message, /timestamp/);
});

test("task marker is bound to the current Codex thread when one exists", () => {
  assert.deepEqual(validateTaskThread({ threadId: "thread-a" }, ""), { ok: true });
  assert.deepEqual(validateTaskThread({ threadId: "thread-a" }, "thread-a"), { ok: true });
  assert.match(validateTaskThread({}, "thread-a").message, /no Codex thread id/);
  assert.match(validateTaskThread({ threadId: "thread-b" }, "thread-a").message, /thread-b/);
});

test("follow-up keeps the original task base after origin-main advances", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-follow-up-base-"));
  const script = path.resolve(process.cwd(), "scripts/bright-task.mjs");
  git(["init"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "user.name", "Bright Test"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(["add", ".gitignore", "base.txt"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["update-ref", "refs/remotes/origin/main", base], repo);
  git(["checkout", "-b", "codex/foo"], repo);
  fs.mkdirSync(path.join(repo, ".bright-task"));
  fs.writeFileSync(
    path.join(repo, ".bright-task", "task.json"),
    `${JSON.stringify({
      branch: "codex/foo",
      mode: "new",
      base,
      createdAt: "2026-06-26T00:00:00.000Z",
    })}\n`,
  );
  git(["checkout", "-b", "main", base], repo);
  fs.writeFileSync(path.join(repo, "main.txt"), "main\n");
  git(["add", "main.txt"], repo);
  git(["commit", "-m", "advance main"], repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
  git(["checkout", "codex/foo"], repo);

  const result = spawnSync(process.execPath, [script, "follow-up"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CODEX_THREAD_ID: "" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const marker = JSON.parse(fs.readFileSync(path.join(repo, ".bright-task", "task.json"), "utf8"));
  assert.equal(marker.mode, "follow-up");
  assert.equal(marker.base, base);
});

test("task state rejects a branch with another task marker", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-wrong-marker-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/current-task"], repo);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/old-task",
        mode: "new",
        base: git(["rev-parse", "HEAD"], repo).stdout.trim(),
        createdAt: "2026-06-26T00:00:00.000Z",
        writeIntentAt: "2026-06-26T00:01:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.ok, false);
    assert.match(state.reuse.message, /codex\/old-task/);
  } finally {
    process.chdir(previous);
  }
});

test("task state keeps the original task base when origin-main advances", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-frozen-base-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    git(["checkout", "-b", "codex/frozen-base"], repo);
    fs.writeFileSync(path.join(repo, "branch.txt"), "branch\n");
    git(["add", "branch.txt"], repo);
    git(["commit", "-m", "branch change"], repo);
    const branchHead = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/codex/frozen-base", branchHead], repo);
    git(["checkout", "-b", "main", base], repo);
    fs.writeFileSync(path.join(repo, "main.txt"), "main\n");
    git(["add", "main.txt"], repo);
    git(["commit", "-m", "current main"], repo);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
    git(["checkout", "codex/frozen-base"], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/frozen-base",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        writeIntentAt: "2026-06-26T00:01:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.validation.ok, true);
    assert.equal(state.ok, false);
    assert.match(state.message, /delivery verification/);
  } finally {
    process.chdir(previous);
  }
});

test("task start guidance requires escalation and forbids manual branch fallback", () => {
  const message = taskStartGuidance("/srv/projects/bright-os/.codex-worktrees");
  assert.match(message, /sandbox_permissions=require_escalated/);
  assert.match(message, /bright-os-guard\.mjs start <task-slug>/);
  assert.match(message, /Do not create or switch to a manual fallback branch/);
  assert.match(message, /stale checkout/);
});

test("task permission repair script is scoped to one registered worktree", () => {
  const script = fs.readFileSync(new URL("./bright-task-repair-permissions.sh", import.meta.url), "utf8");
  assert.match(script, /usage: scripts\/bright-task-repair-permissions\.sh/);
  assert.match(script, /Refusing to repair path outside/);
  assert.match(script, /Refusing to repair git metadata outside/);
  assert.ok(script.includes('sudo chown -R "$OWNER" "$TARGET_REAL" "$GIT_DIR_REAL"'));
  assert.ok(script.includes('sudo chmod -R u=rwX,g=rwX,o= "$TARGET_REAL" "$GIT_DIR_REAL"'));
  assert.ok(script.includes("sudo find \"$TASK_STATE\" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +"));
});

test("task starter creates writable nested worktrees from repo and supports legacy task roots", () => {
  assert.equal(taskWorktreeParent("/srv/projects/bright-os"), "/srv/projects/bright-os/.codex-worktrees");
  assert.equal(taskWorktreeParent("/srv/projects/bright-os/.codex-worktrees/existing-task"), "/srv/projects/bright-os/.codex-worktrees");
  assert.equal(taskWorktreeParent("/srv/projects/bright-os-worktrees/existing-task"), "/srv/projects/bright-os-worktrees");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-source-"));
  const canonical = path.join(tmp, "bright-os");
  const worktree = path.join(tmp, "bright-os-worktrees", "existing-task");
  const nestedWorktree = path.join(canonical, ".codex-worktrees", "nested-task");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "package.json"), "{}\n");
  assert.equal(dependencySourceRoot(worktree), canonical);
  assert.equal(dependencySourceRoot(nestedWorktree), canonical);
});

test("task starter blocks another open branch in the same Codex thread", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-thread-"));
  const open = path.join(parent, "public-site-live");
  const accepted = path.join(parent, "accepted-task");
  for (const [taskPath, branch] of [
    [open, "codex/public-site-live"],
    [accepted, "codex/accepted-task"],
  ]) {
    fs.mkdirSync(path.join(taskPath, ".bright-task"), { recursive: true });
    fs.writeFileSync(
      path.join(taskPath, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch,
        mode: "new",
        base: "1111111111111111111111111111111111111111",
        createdAt: "2026-06-26T00:00:00.000Z",
        threadId: "thread-a",
      })}\n`,
    );
  }

  assert.deepEqual(findOpenTaskForThread(parent, "thread-a", "codex/new-task", (taskPath) => taskPath === accepted), {
    branch: "codex/public-site-live",
    path: open,
  });
  assert.equal(findOpenTaskForThread(parent, "thread-b", "codex/new-task", () => false), null);
  assert.equal(findOpenTaskForThread(parent, "thread-a", "codex/public-site-live", (taskPath) => taskPath === accepted), null);
});

test("task starter ignores squash-merged infra docs branches with delivery receipt", () => {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-control-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-squash-"));
  const merged = path.join(parent, "merged-task");
  const open = path.join(parent, "open-task");
  const previous = process.cwd();
  try {
    git(["init"], control);
    git(["config", "user.email", "test@example.invalid"], control);
    git(["config", "user.name", "Bright Test"], control);
    fs.writeFileSync(path.join(control, "base.txt"), "base\n");
    git(["add", "base.txt"], control);
    git(["commit", "-m", "base"], control);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], control);

    for (const [taskPath, branch, withReceipt] of [
      [merged, "codex/merged-task", true],
      [open, "codex/open-task", false],
    ]) {
      fs.mkdirSync(taskPath, { recursive: true });
      git(["init"], taskPath);
      git(["config", "user.email", "test@example.invalid"], taskPath);
      git(["config", "user.name", "Bright Test"], taskPath);
      fs.writeFileSync(path.join(taskPath, "change.txt"), branch);
      git(["add", "change.txt"], taskPath);
      git(["commit", "-m", branch], taskPath);
      fs.mkdirSync(path.join(taskPath, ".bright-task"));
      fs.writeFileSync(
        path.join(taskPath, ".bright-task", "task.json"),
        `${JSON.stringify({
          branch,
          mode: "new",
          base: "1111111111111111111111111111111111111111",
          createdAt: "2026-06-26T00:00:00.000Z",
          threadId: "thread-a",
        })}\n`,
      );
      if (withReceipt) {
        fs.writeFileSync(
          path.join(taskPath, ".bright-task", "delivery-handoff.json"),
          `${JSON.stringify({
            receiptType: "bright-delivery-handoff-v1",
            branch,
            commit: git(["rev-parse", "HEAD"], taskPath).stdout.trim(),
            deliveryClass: "infra-docs",
            prNumber: 7,
            prUrl: "https://github.example/pr/7",
            prState: "MERGED",
            mergedAt: "2026-06-26T00:00:00Z",
            runId: 123,
            verifiedAt: "2026-06-26T00:00:00.000Z",
          })}\n`,
        );
      }
    }

    process.chdir(control);
    assert.deepEqual(findOpenTaskForThread(parent, "thread-a", "codex/new-task"), {
      branch: "codex/open-task",
      path: open,
    });
  } finally {
    process.chdir(previous);
  }
});

test("task starter does not ignore infra docs delivery receipt for the wrong commit", () => {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-control-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-wrong-receipt-"));
  const taskPath = path.join(parent, "wrong-receipt-task");
  const previous = process.cwd();
  try {
    git(["init"], control);
    git(["config", "user.email", "test@example.invalid"], control);
    git(["config", "user.name", "Bright Test"], control);
    fs.writeFileSync(path.join(control, "base.txt"), "base\n");
    git(["add", "base.txt"], control);
    git(["commit", "-m", "base"], control);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], control);

    fs.mkdirSync(taskPath, { recursive: true });
    git(["init"], taskPath);
    git(["config", "user.email", "test@example.invalid"], taskPath);
    git(["config", "user.name", "Bright Test"], taskPath);
    fs.writeFileSync(path.join(taskPath, "change.txt"), "change\n");
    git(["add", "change.txt"], taskPath);
    git(["commit", "-m", "change"], taskPath);
    fs.mkdirSync(path.join(taskPath, ".bright-task"));
    fs.writeFileSync(
      path.join(taskPath, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/wrong-receipt",
        mode: "new",
        base: "1111111111111111111111111111111111111111",
        createdAt: "2026-06-26T00:00:00.000Z",
        threadId: "thread-a",
      })}\n`,
    );
    fs.writeFileSync(
      path.join(taskPath, ".bright-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "bright-delivery-handoff-v1",
        branch: "codex/wrong-receipt",
        commit: "2222222222222222222222222222222222222222",
        deliveryClass: "infra-docs",
        prNumber: 7,
        prUrl: "https://github.example/pr/7",
        prState: "MERGED",
        mergedAt: "2026-06-26T00:00:00Z",
        runId: 123,
        verifiedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );

    process.chdir(control);
    assert.deepEqual(findOpenTaskForThread(parent, "thread-a", "codex/new-task"), {
      branch: "codex/wrong-receipt",
      path: taskPath,
    });
  } finally {
    process.chdir(previous);
  }
});

test("task starter links existing dependency dirs into new worktrees", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-"));
  const source = path.join(tmp, "source");
  const target = path.join(tmp, "target");
  fs.mkdirSync(path.join(source, "services/bright_os_api/node_modules"), { recursive: true });
  fs.mkdirSync(target);

  assert.deepEqual(linkDependencyDirs(source, target, ["services/bright_os_api/node_modules"]), ["services/bright_os_api/node_modules"]);
  assert.equal(fs.lstatSync(path.join(target, "services/bright_os_api/node_modules")).isSymbolicLink(), true);
});

test("task starter can enable checked-in git hooks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-hooks-"));
  git(["init"], tmp);
  enableGitHooks(tmp);
  assert.equal(git(["config", "core.hooksPath"], tmp).stdout.trim(), ".githooks");
});

test("hook input parser is tolerant", () => {
  assert.deepEqual(parseHookInput("{\"tool_name\":\"exec_command\"}"), { tool_name: "exec_command" });
  assert.equal(parseHookInput("not-json"), null);
});

test("preview receipts must match exact branch and head", () => {
  const receipt = {
    branch: "codex/foo",
    commit: "1111111111111111111111111111111111111111",
    slot: "A",
    url: "https://a.test.brightos.world",
    runId: 123,
    verifiedAt: "2026-06-26T00:00:00.000Z",
  };
  assert.deepEqual(validatePreviewReceipt(receipt, "codex/foo", receipt.commit), { ok: true });
  assert.match(validatePreviewReceipt(null, "codex/foo", receipt.commit).message, /missing/);
  assert.match(validatePreviewReceipt({ ...receipt, commit: "2222" }, "codex/foo", receipt.commit).message, /2222/);
  assert.match(validatePreviewReceipt({ ...receipt, runId: "" }, "codex/foo", receipt.commit).message, /run id/);
});

test("delivery receipts must match exact branch, head, and class", () => {
  const receipt = {
    receiptType: "bright-delivery-handoff-v1",
    branch: "codex/foo",
    commit: "1111111111111111111111111111111111111111",
    deliveryClass: "infra-docs",
    prNumber: 7,
    prUrl: "https://github.example/pr/7",
    prState: "MERGED",
    mergedAt: "2026-06-26T00:00:00Z",
    runId: 123,
    verifiedAt: "2026-06-26T00:00:00.000Z",
  };
  assert.deepEqual(validateDeliveryReceipt(receipt, "codex/foo", receipt.commit), { ok: true });
  assert.match(validateDeliveryReceipt(null, "codex/foo", receipt.commit).message, /missing/);
  assert.match(validateDeliveryReceipt({ ...receipt, branch: "codex/bar" }, "codex/foo", receipt.commit).message, /codex\/bar/);
  assert.match(validateDeliveryReceipt({ ...receipt, commit: "2222" }, "codex/foo", receipt.commit).message, /2222/);
  assert.match(validateDeliveryReceipt({ ...receipt, deliveryClass: "runtime-preview" }, "codex/foo", receipt.commit).message, /runtime-preview/);
  assert.match(validateDeliveryReceipt({ ...receipt, prNumber: "" }, "codex/foo", receipt.commit).message, /PR number/);
  assert.match(validateDeliveryReceipt({ ...receipt, prUrl: "" }, "codex/foo", receipt.commit).message, /PR URL/);
  assert.match(validateDeliveryReceipt({ ...receipt, prState: "OPEN" }, "codex/foo", receipt.commit).message, /not MERGED/);
  assert.match(validateDeliveryReceipt({ ...receipt, mergedAt: "" }, "codex/foo", receipt.commit).message, /timestamp/);
});

test("acceptance markers block preview acceptance but not infra docs CI fixes", () => {
  const base = {
    receiptType: "bright-acceptance-v1",
    branch: "codex/foo",
    commit: "1111111111111111111111111111111111111111",
    baseBranch: "main",
  };
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "acceptance_started", deliveryClass: "runtime-preview" }), true);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "acceptance_started", deliveryClass: "infra-docs" }), false);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "acceptance_started" }), false);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "reconcile_required", deliveryClass: "runtime-preview" }), true);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "reconcile_started", deliveryClass: "runtime-preview" }), false);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "merged", deliveryClass: "infra-docs" }), true);
  assert.equal(isBlockingAcceptanceReceipt({ ...base, status: "already_in_base" }), true);
});

test("task state blocks local implementation work without exact preview receipt", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-state-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(path.join(repo, "change.txt"), "change\n");
    git(["add", "change.txt"], repo);
    git(["commit", "-m", "change"], repo);
    process.chdir(repo);

    const blocked = deriveTaskState();
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /delivery verification/);

    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    fs.writeFileSync(
      path.join(repo, ".bright-task", "preview-handoff.json"),
      `${JSON.stringify({ branch: "codex/foo", commit: base, slot: "A", url: "https://a.test.brightos.world", runId: 123, verifiedAt: "2026-06-26T00:00:00.000Z" })}\n`,
    );
    assert.equal(deriveTaskState().ok, false);

    fs.writeFileSync(
      path.join(repo, ".bright-task", "preview-handoff.json"),
      `${JSON.stringify({ branch: "codex/foo", commit: head, slot: "A", url: "https://a.test.brightos.world", runId: 123, verifiedAt: "2026-06-26T00:00:00.000Z" })}\n`,
    );
    assert.equal(deriveTaskState().ok, true);

    fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
    assert.equal(deriveTaskState().ok, false);
  } finally {
    process.chdir(previous);
  }
});

test("task state allows infra-docs work with exact delivery receipt", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-docs-state-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "change.md"), "change\n");
    git(["add", "docs/change.md"], repo);
    git(["commit", "-m", "docs change"], repo);
    process.chdir(repo);

    const blocked = deriveTaskState();
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Delivery handoff receipt/);

    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    fs.writeFileSync(
      path.join(repo, ".bright-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "bright-delivery-handoff-v1",
        branch: "codex/foo",
        commit: head,
        deliveryClass: "infra-docs",
        prNumber: 7,
        prUrl: "https://github.example/pr/7",
        prState: "OPEN",
        mergedAt: "2026-06-26T00:00:00Z",
        runId: 123,
        verifiedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    assert.equal(deriveTaskState().ok, false);

    fs.writeFileSync(
      path.join(repo, ".bright-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "bright-delivery-handoff-v1",
        branch: "codex/foo",
        commit: head,
        deliveryClass: "infra-docs",
        prNumber: 7,
        prUrl: "https://github.example/pr/7",
        prState: "MERGED",
        mergedAt: "2026-06-26T00:00:00Z",
        runId: 123,
        verifiedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    assert.equal(deriveTaskState().ok, true);
  } finally {
    process.chdir(previous);
  }
});

test("delivery handoff blocks open infra-docs PRs without writing a receipt", () => {
  for (const mergeStateStatus of ["BEHIND", "BLOCKED", "DIRTY"]) {
    const fixture = setupInfraDocsHandoffFixture({ prState: "OPEN", mergeStateStatus, autoMerge: true });
    const result = runDeliveryHandoffFixture(fixture);
    const output = result.stderr || result.stdout;

    assert.notEqual(result.status, 0);
    assert.match(output, /not complete until its PR is merged/, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
    assert.match(output, /PR state: OPEN/);
    assert.match(output, new RegExp(`mergeStateStatus: ${mergeStateStatus}`));
    assert.match(output, /autoMerge: enabled/);
    assert.equal(fs.existsSync(path.join(fixture.repo, ".bright-task", "delivery-handoff.json")), false);
  }
});

test("delivery handoff blocks merged infra-docs PRs without merged timestamp", () => {
  const fixture = setupInfraDocsHandoffFixture({ prState: "MERGED" });
  const result = runDeliveryHandoffFixture(fixture);
  const output = result.stderr || result.stdout;

  assert.notEqual(result.status, 0);
  assert.match(output, /PR state: MERGED/);
  assert.match(output, /mergedAt: \(missing\)/);
  assert.equal(fs.existsSync(path.join(fixture.repo, ".bright-task", "delivery-handoff.json")), false);
});

test("delivery handoff does not write a receipt when a required delivery job fails", () => {
  const fixture = setupInfraDocsHandoffFixture({
    prState: "MERGED",
    mergedAt: "2026-06-26T00:00:00Z",
    jobConclusions: { checks: "failure" },
  });
  const result = runDeliveryHandoffFixture(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Delivery job checks is failure/);
  assert.equal(fs.existsSync(path.join(fixture.repo, ".bright-task", "delivery-handoff.json")), false);
});

test("infra docs workflow marks handoff passed only from the PR merge job", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/bright-os-delivery.yml", import.meta.url), "utf8");
  const autoMergeJob = workflow.slice(workflow.indexOf("auto-merge-infra-docs:"), workflow.indexOf("deploy-prod:"));
  const recordMergeJob = workflow.slice(workflow.indexOf("record-infra-docs-merge:"), workflow.indexOf("release-preview-slot:"));
  assert.doesNotMatch(autoMergeJob, /event delivery_handoff_passed/);
  assert.match(recordMergeJob, /event delivery_handoff_passed/);
  assert.match(recordMergeJob, /event pr_merged/);
  assert.ok(recordMergeJob.indexOf("event delivery_handoff_passed") < recordMergeJob.indexOf("event pr_merged"));
  assert.match(recordMergeJob, /BRIGHT_OS_PR_MERGED_AT/);
});

test("delivery workflow releases preview slots for unmerged closed codex PRs", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/bright-os-delivery.yml", import.meta.url), "utf8");
  const releaseJob = workflow.slice(workflow.indexOf("release-preview-slot:"));

  assert.match(releaseJob, /github\.event\.pull_request\.merged == false/);
  assert.match(releaseJob, /github\.event\.pull_request\.head\.ref/);
  assert.match(releaseJob, /github\.event\.pull_request\.head\.sha/);
  assert.match(releaseJob, /steps\.release_slot\.outputs\.released == 'true' \|\| github\.event_name == 'pull_request'/);
});

test("delivery handoff writes infra-docs receipt only for merged PRs", () => {
  const fixture = setupInfraDocsHandoffFixture({ prState: "MERGED", mergedAt: "2026-06-26T00:00:00Z" });
  const result = runDeliveryHandoffFixture(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Delivery class: infra-docs/);
  assert.match(result.stdout, /PR: #7 https:\/\/github\.example\/pr\/7/);
  assert.match(result.stdout, /PR state: MERGED/);
  assert.match(result.stdout, /Merged at: 2026-06-26T00:00:00Z/);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.repo, ".bright-task", "delivery-handoff.json"), "utf8"));
  assert.equal(receipt.prNumber, 7);
  assert.equal(receipt.prUrl, "https://github.example/pr/7");
  assert.equal(receipt.prState, "MERGED");
  assert.equal(receipt.mergedAt, "2026-06-26T00:00:00Z");
  assert.equal(receipt.runId, 42);
});

test("task state allows exact delivery receipt after infra-docs branch was squash-merged", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-docs-accepted-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "change.md"), "change\n");
    git(["add", "docs/change.md"], repo);
    git(["commit", "-m", "docs change"], repo);
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["checkout", "-b", "main", base], repo);
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "change.md"), "change\n");
    git(["add", "docs/change.md"], repo);
    git(["commit", "-m", "squash infra docs"], repo);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
    git(["update-ref", "refs/remotes/origin/codex/foo", head], repo);
    git(["checkout", "codex/foo"], repo);
    assert.notEqual(gitStatus(["merge-base", "--is-ancestor", head, "origin/main"], repo), 0);
    fs.writeFileSync(
      path.join(repo, ".bright-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "bright-delivery-handoff-v1",
        branch: "codex/foo",
        commit: head,
        deliveryClass: "infra-docs",
        prNumber: 7,
        prUrl: "https://github.example/pr/7",
        prState: "MERGED",
        mergedAt: "2026-06-26T00:00:00Z",
        runId: 123,
        verifiedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.ok, true);
    assert.equal(state.classification.deliveryClass, "infra-docs");
  } finally {
    process.chdir(previous);
  }
});

test("task state rejects same-thread writes after local acceptance marker", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-accepted-marker-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    fs.writeFileSync(path.join(repo, "change.txt"), "change\n");
    git(["add", "change.txt"], repo);
    git(["commit", "-m", "change"], repo);
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/codex/foo", head], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".bright-task", "acceptance.json"),
      `${JSON.stringify({
        receiptType: "bright-acceptance-v1",
        branch: "codex/foo",
        commit: head,
        baseBranch: "main",
        status: "acceptance_started",
        deliveryClass: "runtime-preview",
        acceptedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.reuse.ok, false);
    assert.match(state.reuse.message, /acceptance already started/);

    const acceptancePath = path.join(repo, ".bright-task", "acceptance.json");
    const receipt = JSON.parse(fs.readFileSync(acceptancePath, "utf8"));
    fs.writeFileSync(acceptancePath, `${JSON.stringify({ ...receipt, status: "reconcile_required" })}\n`);
    const requiredState = deriveTaskState();
    assert.equal(requiredState.reuse.ok, false);

    fs.writeFileSync(acceptancePath, `${JSON.stringify({ ...receipt, status: "reconcile_started" })}\n`);
    const reconcileState = deriveTaskState();
    assert.equal(reconcileState.reuse.ok, true);

    fs.writeFileSync(acceptancePath, `${JSON.stringify({ ...receipt, status: "merged" })}\n`);
    const mergedState = deriveTaskState();
    assert.equal(mergedState.reuse.ok, false);
  } finally {
    process.chdir(previous);
  }
});

test("acceptance reconcile merges current main into the same accepted branch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-reconcile-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const script = path.join(process.cwd(), "scripts/bright-task.mjs");
  const previousPrs = process.env.BRIGHT_OS_TEST_ACCEPTANCE_PRS_JSON;
  try {
    git(["init", "--bare", remote], root);
    fs.mkdirSync(repo);
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["branch", "-M", "main"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["remote", "add", "origin", remote], repo);
    git(["push", "origin", "HEAD:main"], repo);

    git(["checkout", "-b", "codex/foo"], repo);
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/branch.md"), "branch\n");
    git(["add", "docs/branch.md"], repo);
    git(["commit", "-m", "branch change"], repo);
    const branchHead = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["push", "origin", "HEAD:codex/foo"], repo);

    git(["checkout", "main"], repo);
    fs.mkdirSync(path.join(repo, "apps/bright_os_app/src/features/app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/bright_os_app/src/features/app/BrightOsApp.tsx"), "main\n");
    git(["add", "apps/bright_os_app/src/features/app/BrightOsApp.tsx"], repo);
    git(["commit", "-m", "main change"], repo);
    git(["push", "origin", "HEAD:main"], repo);
    git(["checkout", "codex/foo"], repo);

    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".bright-task", "acceptance.json"),
      `${JSON.stringify({
        receiptType: "bright-acceptance-v1",
        branch: "codex/foo",
        commit: branchHead,
        baseBranch: "main",
        prNumber: 7,
        prUrl: "https://github.example/pr/7",
        mergeMethod: "squash",
        status: "reconcile_required",
        deliveryClass: "runtime-preview",
        acceptedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    process.env.BRIGHT_OS_TEST_ACCEPTANCE_PRS_JSON = JSON.stringify([
      {
        number: 7,
        url: "https://github.example/pr/7",
        state: "OPEN",
        headRefOid: branchHead,
        mergeStateStatus: "BEHIND",
      },
    ]);

    const result = spawnSync(process.execPath, [script, "acceptance-reconcile", "codex/foo"], {
      cwd: repo,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(gitStatus(["merge-base", "--is-ancestor", "origin/main", "HEAD"], repo), 0);
    const receipt = JSON.parse(fs.readFileSync(path.join(repo, ".bright-task", "acceptance.json"), "utf8"));
    assert.equal(receipt.status, "reconcile_started");
    assert.equal(receipt.prNumber, 7);
    const previousCwd = process.cwd();
    try {
      process.chdir(repo);
      const state = deriveTaskState();
      assert.equal(state.classification.deliveryClass, "infra-docs");
      assert.deepEqual(state.changedFiles, ["docs/branch.md"]);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    if (previousPrs == null) delete process.env.BRIGHT_OS_TEST_ACCEPTANCE_PRS_JSON;
    else process.env.BRIGHT_OS_TEST_ACCEPTANCE_PRS_JSON = previousPrs;
  }
});

test("task state rejects squash-merged branch by merged PR head oid", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-merged-pr-"));
  const previousCwd = process.cwd();
  const previousMergedPrs = process.env.BRIGHT_OS_TEST_MERGED_PRS_JSON;
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Bright Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    fs.writeFileSync(path.join(repo, "change.txt"), "change\n");
    git(["add", "change.txt"], repo);
    git(["commit", "-m", "change"], repo);
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/codex/foo", head], repo);
    fs.mkdirSync(path.join(repo, ".bright-task"));
    fs.writeFileSync(
      path.join(repo, ".bright-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    process.env.BRIGHT_OS_TEST_MERGED_PRS_JSON = JSON.stringify([
      { number: 7, url: "https://github.example/pr/7", headRefOid: head, mergedAt: "2026-06-26T00:00:00Z" },
    ]);
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.reuse.ok, false);
    assert.match(state.reuse.message, /github\.example\/pr\/7/);
  } finally {
    if (previousMergedPrs == null) delete process.env.BRIGHT_OS_TEST_MERGED_PRS_JSON;
    else process.env.BRIGHT_OS_TEST_MERGED_PRS_JSON = previousMergedPrs;
    process.chdir(previousCwd);
  }
});

test("accept preview checks verified preview before PR actions", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "deploy/scripts/accept-preview.sh"), "utf8");
  const acceptancePreflightCall = script.indexOf("\nensure_acceptance_marker_writable\n");
  assert.ok(script.indexOf("require-preview") > 0);
  assert.ok(script.indexOf("require-preview") < script.indexOf("gh pr list"));
  assert.ok(script.indexOf("require-preview") < script.indexOf("gh pr merge"));
  assert.ok(acceptancePreflightCall > 0);
  assert.ok(acceptancePreflightCall < script.indexOf("gh pr list"));
  assert.ok(acceptancePreflightCall < script.indexOf("gh pr merge"));
  assert.match(script, /mergeStateStatus/);
  assert.match(script, /reconcile_required/);
  assert.match(script, /acceptance-reconcile/);
  assert.match(script, /BEHIND/);
  assert.match(script, /Bright OS task state must not be a symlink/);
  assert.match(script, /mktemp "\$dir\/\.acceptance-write\.XXXXXX"/);
  assert.match(script, /write_acceptance_marker/);
  assert.match(script, /acceptance\.json/);
  assert.match(script, /deliveryClass/);
});

test("accepted preview branch lookup skips infra docs delivery PRs", () => {
  assert.deepEqual(acceptedPreviewBranches([
    {
      base: { ref: "main" },
      head: { ref: "codex/infra-docs" },
      merged_at: "2026-06-25T10:00:00Z",
      labels: [{ name: "bright-delivery:infra-docs" }],
    },
    {
      base: { ref: "main" },
      head: { ref: "codex/runtime" },
      merged_at: "2026-06-25T10:00:00Z",
      labels: [],
    },
  ]), ["codex/runtime"]);
});

function setupInfraDocsHandoffFixture({ prState, mergeStateStatus = "CLEAN", autoMerge = false, mergedAt = null, jobConclusions = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-handoff-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");

  git(["init", "--bare", remote], root);
  fs.mkdirSync(repo);
  git(["init"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "user.name", "Bright Test"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".bright-task/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  const acceptScript = path.join(repo, "deploy/scripts/accept-preview.sh");
  fs.mkdirSync(path.dirname(acceptScript), { recursive: true });
  fs.writeFileSync(acceptScript, "#!/usr/bin/env bash\nexit 0\n");
  git(["add", ".gitignore", "base.txt", "deploy/scripts/accept-preview.sh"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "HEAD:main"], repo);
  git(["checkout", "-b", "codex/foo"], repo);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "change.md"), "change\n");
  git(["add", "docs/change.md"], repo);
  git(["commit", "-m", "docs change"], repo);
  const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["push", "origin", "HEAD:codex/foo"], repo);

  fs.mkdirSync(path.join(repo, ".bright-task"));
  fs.writeFileSync(
    path.join(repo, ".bright-task", "task.json"),
    `${JSON.stringify({
      branch: "codex/foo",
      mode: "new",
      base,
      createdAt: "2026-06-26T00:00:00.000Z",
      ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
    })}\n`,
  );

  const pr = {
    number: 7,
    url: "https://github.example/pr/7",
    state: prState,
    headRefOid: head,
    labels: [{ name: "bright-delivery:infra-docs" }],
    mergedAt,
    mergeStateStatus,
    autoMergeRequest: autoMerge ? { enabledAt: "2026-06-26T00:00:00Z" } : null,
  };
  const run = {
    databaseId: 42,
    headSha: head,
    status: "completed",
    conclusion: "success",
    url: "https://github.example/actions/runs/42",
  };
  const jobs = {
    jobs: ["public-guard", "checks", "temporal-worker-check", "auto-merge-infra-docs"].map((name) => ({ name, conclusion: jobConclusions[name] ?? "success" })),
  };

  fs.mkdirSync(bin);
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s' '${JSON.stringify([pr])}'
elif [ "$1" = "run" ] && [ "$2" = "list" ]; then
  printf '%s' '${JSON.stringify([run])}'
elif [ "$1" = "run" ] && [ "$2" = "view" ]; then
  printf '%s' '${JSON.stringify(jobs)}'
else
  echo "unexpected gh $*" >&2
  exit 1
fi
`,
  );
  fs.chmodSync(gh, 0o755);

  return { repo, bin };
}

function runDeliveryHandoffFixture({ repo, bin }) {
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const previousWait = process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_WAIT_MS;
  const previousPoll = process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_POLL_MS;
  const previousLog = console.log;
  const logs = [];
  try {
    process.chdir(repo);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_WAIT_MS = "1";
    process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_POLL_MS = "1";
    console.log = (...args) => logs.push(args.join(" "));
    deliveryHandoff("codex/foo");
    return { status: 0, stdout: logs.join("\n"), stderr: "" };
  } catch (error) {
    return { status: 1, stdout: logs.join("\n"), stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousPath == null) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousWait == null) delete process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_WAIT_MS;
    else process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_WAIT_MS = previousWait;
    if (previousPoll == null) delete process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_POLL_MS;
    else process.env.BRIGHT_OS_INFRA_DOCS_HANDOFF_POLL_MS = previousPoll;
  }
}

function git(args, cwd) {
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...env } = process.env;
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout || "(no output)"}`);
  }
  return result;
}

function gitStatus(args, cwd) {
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...env } = process.env;
  return spawnSync("git", args, { cwd, encoding: "utf8", env }).status;
}
