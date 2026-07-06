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
  validateReleaseNotes,
  workspacePreflight,
} from "./brai-task.mjs";
import { acceptedPreviewBranches } from "../deploy/scripts/accepted-preview-branches.mjs";
import { classifyDeployDelivery } from "../deploy/scripts/classify-delivery.mjs";
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
  assert.equal(isReadOnlyShellCommand("sed -n '1,20p' scripts/brai-task.mjs"), true);
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
  assert.equal(isManualBranchCommand("git worktree list"), false);
  assert.equal(isManualBranchCommand("git worktree list --porcelain"), false);
});

test("read-only classifier allows diagnostics and rejects disguised writes", () => {
  assert.equal(isReadOnlyShellCommand("find . -maxdepth 1 -type f -print"), true);
  assert.equal(isReadOnlyShellCommand("stat -c %U:%G:%a deploy/scripts/preview-slots.sh"), true);
  assert.equal(isReadOnlyShellCommand("git worktree list --porcelain"), true);
  assert.equal(isReadOnlyShellCommand("node scripts/brai-task.mjs access-contract --local"), true);
  assert.equal(isReadOnlyShellCommand("scripts/brai-guard-sync-check.sh --check"), true);
  assert.equal(isReadOnlyShellCommand("git diff --output=/tmp/diff.txt"), false);
  assert.equal(isReadOnlyShellCommand("rg --pre cat TODO"), false);
  assert.equal(isReadOnlyShellCommand("find . -exec chmod 755 {} +"), false);
});

test("server access contract checks deploy ownership instead of agent write access", () => {
  const script = fs.readFileSync(new URL("./brai-task.mjs", import.meta.url), "utf8");
  assert.match(script, /contractPathCheck\("env roots", envsRoot, \{/);
  assert.match(script, /owner: deployOwner/);
  assert.match(script, /group: deployGroup/);
  assert.match(script, /requiredModeBits: 0o2770/);
  assert.match(script, /contractPathCheck\("preview slot registry", path\.join\(envsRoot, "preview-slots\.json"\), \{/);
  assert.match(script, /requiredModeBits: 0o660/);
  assert.doesNotMatch(script, /pathCheck\("env roots", envsRoot, \{ requireWrite: true/);
});

test("server access contract checks operation helper sudo boundary", () => {
  const script = fs.readFileSync(new URL("./brai-task.mjs", import.meta.url), "utf8");
  const sudoers = fs.readFileSync(new URL("../deploy/ansible/templates/brai-deploy-sudoers.j2", import.meta.url), "utf8");
  assert.match(script, /commandCheck\("operation helper host-local sudo"/);
  assert.match(script, /commandCheck\("accepted preview OTA sync access"/);
  assert.match(script, /sync-occupied-preview-ota-manifests\.sh/);
  assert.match(script, /BRAI_PROD_SOURCE_ROOT: path\.join\(envsRoot, "prod\/source"\)/);
  assert.match(script, /operationHelperRemoteAccessCheck/);
  assert.match(script, /BRAI_DEPLOY_SSH_KEY_FILE/);
  assert.match(sudoers, /ALL=\(\{\{ brai_service_user \}\}\) NOPASSWD:/);
  assert.match(sudoers, /complete-operation-activities\.sh --local \*/);
  assert.match(sudoers, /brai_operation_maintainers/);
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-base-refresh-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
    tool_input: { cmd: "node scripts/brai-task.mjs acceptance-reconcile codex/foo" },
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
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /\/srv\/opt\/brai-codex-plugins\/plugins\/brai-guard\/hooks\/brai-guard\.mjs pre-tool-use/);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /\/srv\/opt\/brai-codex-plugins\/plugins\/brai-guard\/hooks\/brai-guard\.mjs stop/);
});

test("main checkout lock preserves agent worktrees by default", () => {
  const script = fs.readFileSync(new URL("./brai-main-checkout-lock.sh", import.meta.url), "utf8");
  assert.match(script, /git -C "\$root" worktree list --porcelain/);
  assert.match(script, /brai-worktrees/);
  assert.match(script, /BRAI_LOCK_STALE_WORKTREES:-0/);
  assert.match(script, /BRAI_LOCK_CURRENT_WORKTREE/);
  assert.match(script, /restore_task_state_access\(\)/);
  assert.match(script, /restore_task_state_access "\$worktree_path"/);
  assert.match(script, /sudo chown mark:mark "\$task_state"/);
  assert.match(script, /sudo chmod 0770 "\$task_state"/);
  assert.match(script, /source_group="\$\{BRAI_MAIN_SOURCE_GROUP:-mark\}"/);
  assert.match(script, /sudo chown "root:\$source_group" "\$root"/);
  assert.match(script, /sudo chown -R mark:mark "\$root\/\.git"/);
  assert.match(script, /sudo chown mark:mark "\$worktrees"/);
  assert.match(script, /-maxdepth 1 -type f -name '\*\.json'/);
  assert.match(script, /sudo chmod 0751 "\$root"/);
  assert.match(script, /sudo chmod u=rwx,g=rx,o=x "\$root\/deploy"/);
  assert.match(script, /complete-operation-activities\.sh/);
  assert.match(script, /sync-occupied-preview-ota-manifests\.sh/);
  assert.match(script, /sudo chmod u=rwx,g=rx,o=x "\$root\/deploy\/scripts"/);
  assert.match(script, /sudo chgrp brai-deploy "\$deploy_tool"/);
  assert.match(script, /sudo chmod u=rwx,g=rx,o=rx "\$deploy_tool"/);
  assert.match(script, /preserve_agent_dependency_paths/);
  assert.match(script, /apps\/brai_app\/node_modules/);
  assert.match(script, /Writable task worktree parent/);
});

test("local main sync preserves runtime dirs and hard resets to origin main", () => {
  const script = fs.readFileSync(new URL("../deploy/scripts/sync-local-main-checkout.sh", import.meta.url), "utf8");
  const ciScript = fs.readFileSync(new URL("../deploy/scripts/ci-ssh-sync-main-checkout.sh", import.meta.url), "utf8");
  const playbook = fs.readFileSync(new URL("../deploy/ansible/brai.yml", import.meta.url), "utf8");
  assert.match(script, /REPO="\/srv\/projects\/brai"/);
  assert.match(script, /SOURCE_GROUP="\$\{BRAI_MAIN_SOURCE_GROUP:-mark\}"/);
  assert.match(script, /Usage: \$0 \[expected-main-commit\]/);
  assert.match(script, /runuser -u "\$GIT_USER"/);
  assert.match(script, /core\.hooksPath=\/dev\/null/);
  assert.match(script, /git_cmd checkout -f -B "\$BRANCH" "origin\/\$BRANCH"/);
  assert.match(script, /git_cmd reset --hard "origin\/\$BRANCH"/);
  assert.match(script, /-e data\//);
  assert.match(script, /-e deploy\/web\//);
  assert.match(script, /-e deploy\/releases\//);
  assert.match(script, /brai-rescue/);
  assert.match(script, /chmod 0751 "\$REPO"/);
  assert.match(script, /chown "root:\$SOURCE_GROUP" "\$REPO"/);
  assert.match(script, /chown -R mark:mark \.git/);
  assert.match(script, /chown mark:mark \.codex-worktrees/);
  assert.match(script, /BRAI_LOCK_STALE_WORKTREES:-0/);
  assert.match(script, /chmod u=rwx,g=rx,o=x deploy/);
  assert.match(script, /complete-operation-activities\.sh/);
  assert.match(script, /sync-occupied-preview-ota-manifests\.sh/);
  assert.match(script, /preserve_agent_dependency_paths/);
  assert.match(script, /apps\/brai_app\/node_modules/);
  assert.match(script, /chmod u=rwx,g=rx,o=x deploy\/scripts/);
  assert.match(script, /chgrp brai-deploy "\$deploy_tool"/);
  assert.match(script, /chmod u=rwx,g=rx,o=rx "\$deploy_tool"/);
  assert.doesNotMatch(script, /BRAI_LOCK_STALE_WORKTREES:-1/);
  assert.match(script, /git_cmd worktree list --porcelain/);
  assert.match(script, /chown -R root:mark "\$worktree_path"/);
  assert.match(script, /restore_task_state_access\(\)/);
  assert.match(script, /restore_task_state_access "\$worktree_path"/);
  assert.match(script, /chown "\$GIT_USER:mark" "\$task_state"/);
  assert.match(script, /chmod 0770 "\$task_state"/);
  assert.match(ciScript, /sudo -n \/srv\/opt\/brai-main-sync\.sh "\$BRAI_COMMIT"/);
  assert.match(playbook, /Create production source checkout path/);
  assert.doesNotMatch(playbook, /state: link/);
  assert.doesNotMatch(ciScript, /DEPLOY_REPO/);
  assert.doesNotMatch(ciScript, /sudo BRAI_DEPLOY_REPO=/);
  assert.match(playbook, /brai_repo }}\/deploy\/releases/);
  assert.match(playbook, /dest: \/srv\/opt\/brai-main-sync\.sh/);
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
      cmd: "/srv/opt/node-v22.16.0/bin/node /srv/opt/brai-codex-plugins/plugins/brai-guard/hooks/brai-guard.mjs start guard-task",
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-stale-starter-"));
  const previous = process.cwd();
  try {
    git(["init"], tmp);
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.writeFileSync(path.join(tmp, "scripts", "brai-task-start.sh"), "#!/usr/bin/env bash\nnode scripts/brai-task.mjs start \"$@\"\n");
    process.chdir(tmp);

    const result = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "scripts/brai-task-start.sh guard-task" } }));
    assert.equal(result.ok, true);
    assert.match(result.blockedReason, /stale/);
  } finally {
    process.chdir(previous);
  }
});

test("sensitive paths are rejected for commits", () => {
  assert.equal(isSensitivePath("apps/brai_app/src/main.ts"), false);
  assert.equal(isSensitivePath("deploy/web/index.html"), true);
  assert.equal(isSensitivePath("data/brai.sqlite"), true);
  assert.equal(isSensitivePath(".env.local"), true);
  assert.equal(isSensitivePath("android/release.keystore"), true);
});

test("delivery classifier separates infra-docs from runtime preview", () => {
  assert.equal(deliveryClassForFile("apps/brai_app/src/app/page.tsx"), "runtime");
  assert.equal(deliveryClassForFile("services/brai_api/src/server.js"), "runtime");
  assert.equal(deliveryClassForFile("docs/operations/branch-preview-environments.md"), "docs");
  assert.equal(deliveryClassForFile("openspec/specs/repository-operations/spec.md"), "docs");
  assert.equal(deliveryClassForFile(".github/workflows/brai-delivery.yml"), "infra");
  assert.equal(deliveryClassForFile(".gitignore"), "infra");
  assert.equal(deliveryClassForFile("apps/brai_app/tests/unit/publishScripts.test.ts"), "infra");
  assert.equal(deliveryClassForFile("apps/brai_app/tests/unit/activityStore.test.ts"), "technical");
  assert.equal(deliveryClassForFile("apps/brai_app/vitest.config.mts"), "technical");
  assert.equal(deliveryClassForFile("services/brai_api/test/api.auth-migrations.test.js"), "technical");
  assert.equal(deliveryClassForFile("deploy/environments.json"), "infra");
  assert.equal(deliveryClassForFile("deploy/ansible/brai.yml"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/apk-release-targets.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/build-nonproduction-apks.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/resolve-deploy-env.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/classify-delivery.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/preview-slots.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/preview-slots.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/permissions.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/postgres-smoke.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/supabase-branch.test.mjs"), "technical");
  assert.equal(deliveryClassForFile("deploy/scripts/prune-caddy-site-blocks.mjs"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/publish-web.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/publish-client-web-layer.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/publish-mobile-bundle.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/publish-capacitor-apk.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/complete-operation-activities.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/sync-local-main-checkout.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/sync-occupied-preview-ota-manifests.sh"), "infra");
  assert.equal(deliveryClassForFile("deploy/scripts/ci-ssh-sync-main-checkout.sh"), "infra");
  assert.equal(deliveryClassForFile("scripts/caddy-prune-managed-sites.test.mjs"), "infra");
  assert.equal(deliveryClassForFile("scripts/brai-task.mjs"), "infra");
  assert.equal(deliveryClassForFile("scripts/check-open-openspec-changes.mjs"), "infra");
  assert.equal(deliveryClassForFile("services/brai_temporal/src/state.mjs"), "infra");
  assert.equal(deliveryClassForFile("supabase/migrations/0002_enable_rls_public_tables.sql"), "infra");
  assert.equal(deliveryClassForFile("supabase/migrations/0003_fix_rls_function_search_path.sql"), "infra");
  assert.equal(deliveryClassForFile("supabase/migrations/0004_empty_rls_function_search_path.sql"), "infra");
  assert.equal(deliveryClassForFile("deploy/web/index.html"), "blocked");
  assert.equal(deliveryClassForFile("package.json"), "unknown");

  assert.equal(classifyDelivery(["docs/foo.md"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery([".github/workflows/brai-delivery.yml"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery(["deploy/scripts/complete-operation-activities.sh"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery(["supabase/migrations/0002_enable_rls_public_tables.sql"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery(["supabase/migrations/0003_fix_rls_function_search_path.sql"]).deliveryClass, "infra-docs");
  assert.equal(classifyDelivery(["supabase/migrations/0004_empty_rls_function_search_path.sql"]).deliveryClass, "infra-docs");
  assert.deepEqual(classifyDeployDelivery(["deploy/scripts/complete-operation-activities.sh"], {
    eventName: "push",
    ref: "refs/heads/codex/operation-done-helper",
  }), {
    delivery_class: "infra-docs",
    requires_preview: false,
    requires_dev_deploy: false,
    auto_merge: true,
  });
  assert.equal(classifyDelivery(["apps/brai_app/vitest.config.mts"]).deliveryClass, "technical-no-preview");
  assert.equal(classifyDelivery(["services/brai_api/test/api.auth-migrations.test.js"]).deliveryClass, "technical-no-preview");
  assert.equal(classifyDelivery(["deploy/scripts/supabase-branch.test.mjs"]).deliveryClass, "technical-no-preview");
  assert.equal(
    classifyDelivery(["apps/brai_app/package.json"], {
      diffs: {
        "apps/brai_app/package.json": [
          '-    "test": "vitest run",',
          '+    "test": "vitest run --configLoader runner",',
          '-    "test:watch": "vitest",',
          '+    "test:watch": "vitest --configLoader runner",',
        ].join("\n"),
      },
    }).deliveryClass,
    "technical-no-preview",
  );
  assert.equal(
    classifyDelivery(["apps/brai_app/package.json"], {
      diffs: {
        "apps/brai_app/package.json": [
          '-    "next": "16.2.9",',
          '+    "next": "16.2.10",',
        ].join("\n"),
      },
    }).deliveryClass,
    "runtime-preview",
  );
  assert.equal(classifyDelivery(["apps/brai_app/src/app/page.tsx"]).deliveryClass, "runtime-preview");
  assert.equal(classifyDelivery(["docs/foo.md", "apps/brai_app/src/app/page.tsx"]).deliveryClass, "runtime-preview");
  assert.equal(classifyDelivery(["package.json"]).fallback, "unknown_path");
  assert.equal(classifyDelivery(["deploy/web/index.html"]).deliveryClass, "blocked");
});

test("operation activity completion helper has a narrow shell contract", () => {
  const helper = fs.readFileSync(path.resolve(import.meta.dirname, "../deploy/scripts/complete-operation-activities.sh"), "utf8");
  assert.match(helper, /set -euo pipefail/);
  assert.match(helper, /DEPLOY_REPO="\$\{BRAI_DEPLOY_REPO:-\/srv\/projects\/brai-envs\/prod\/source\}"/);
  assert.match(helper, /--host-local/);
  assert.match(helper, /sudo -n -u "\$SERVICE_USER"/);
  assert.match(helper, /BRAI_DATABASE_URL is required/);
  assert.match(helper, /new Pool/);
  assert.match(helper, /\^operation\[:\._-\]/);
  assert.match(helper, /activity_type_id = 'operation'/);
  assert.match(helper, /author = 'Codex'/);
  assert.match(helper, /deleted_at_utc IS NULL/);
  assert.match(helper, /status IN \('New', 'Done'\)/);
  assert.match(helper, /await client\.query\("BEGIN"\)/);
  assert.match(helper, /completed_at_utc = COALESCE/);
  assert.doesNotMatch(helper, /activity_type_id = 'action'/);
  assert.doesNotMatch(helper, /SQLite|sqlite|BRAI_DB|\.backup/);
});

test("production client publish also refreshes the public landing", () => {
  const script = fs.readFileSync(path.resolve(import.meta.dirname, "../deploy/scripts/publish-client-web-layer.sh"), "utf8");
  assert.match(script, /if \[\[ "\$ENVIRONMENT" == "prod" \]\]; then/);
  assert.match(script, /BRAI_WEB_SOURCE="\$ROOT\/landing\/public"/);
  assert.match(script, /BRAI_PUBLIC_SITE_TARGET:-\$ROOT\/deploy\/site/);
  assert.match(script, /"\$SCRIPT_DIR\/publish-web\.sh"/);
});

test("operation activity completion helper rejects unsafe ids", () => {
  const result = spawnSync("bash", [
    "deploy/scripts/complete-operation-activities.sh",
    "--local",
    "action-1",
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid operation activity id/);
});

test("native APK detector ignores OTA web-layer changes", () => {
  assert.equal(requiresNativeApkChange(["apps/brai_app/android/app/build.gradle"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/ci-ssh-deploy.sh"]), false);
  assert.equal(requiresNativeApkChange(["deploy/scripts/ci-ssh-release-slot.sh"]), false);
  assert.equal(requiresNativeApkChange(["deploy/scripts/detect-native-apk-change.mjs"]), false);
  assert.equal(requiresNativeApkChange(["deploy/scripts/apk-release-targets.mjs"]), true);
  assert.equal(requiresNativeApkChange(["deploy/scripts/resolve-app-version.mjs"]), false);
  assert.equal(requiresNativeApkChange(["apps/brai_app/src/shared/platform/ota.ts"]), false);
  assert.equal(requiresNativeApkChange(["apps/brai_app/src/shared/platform/androidTimerNotification.ts"]), false);
  assert.equal(
    requiresNativeApkChange(["apps/brai_app/package.json"], '+    "next": "16.0.0",\n'),
    false,
  );
  assert.equal(
    requiresNativeApkChange(["apps/brai_app/package.json"], '+    "@capacitor/app": "7.0.0",\n'),
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

test("preview deploy requires Postgres and preserves artifact setgid", () => {
  const script = fs.readFileSync(new URL("../deploy/scripts/deploy-branch.sh", import.meta.url), "utf8");
  const playbook = fs.readFileSync(new URL("../deploy/ansible/brai.yml", import.meta.url), "utf8");
  const unit = fs.readFileSync(new URL("../deploy/ansible/templates/brai-api.service.j2", import.meta.url), "utf8");
  assert.match(script, /umask 0002/);
  assert.match(script, /BRAI_DATABASE_URL is required/);
  assert.match(script, /wait_for_preview_api/);
  assert.match(script, /Preview API health check failed/);
  const recordIndex = script.indexOf("record-deployment.mjs");
  const restartIndex = script.indexOf("systemctl restart");
  const readyIndex = script.indexOf("preview-slots.sh\" ready");
  assert.ok(recordIndex > 0);
  assert.ok(restartIndex > recordIndex);
  assert.ok(readyIndex > restartIndex);
  assert.ok(script.includes('normalize_public_tree "$WEB_TARGET"'));
  assert.ok(script.includes('normalize_public_tree "$MOBILE_TARGET"'));
  assert.doesNotMatch(script, /normalize_public_tree "\$TARGET_ROOT"/);
  assert.match(playbook, /Ensure non-production data directories keep deploy setgid/);
  assert.match(playbook, /Ensure nested non-production data directories keep deploy setgid/);
  assert.doesNotMatch(playbook, /SQLite|sqlite|brai\.sqlite/);
  assert.match(playbook, /mode: "2775"/);
  assert.match(unit, /EnvironmentFile={{ brai_env_root }}\/{{ item.value.path }}\/brai-api.env/);
  assert.doesNotMatch(unit, /BRAI_LEGACY_SQLITE_PATH|EnvironmentFile=-/);
  assert.match(unit, /Group={{ brai_deploy_user }}/);
  assert.match(unit, /SupplementaryGroups={{ brai_deploy_user }}/);
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-follow-up-base-"));
  const script = path.resolve(process.cwd(), "scripts/brai-task.mjs");
  git(["init"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "user.name", "Brai Test"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(["add", ".gitignore", "base.txt"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["update-ref", "refs/remotes/origin/main", base], repo);
  git(["checkout", "-b", "codex/foo"], repo);
  fs.mkdirSync(path.join(repo, ".brai-task"));
  fs.writeFileSync(
    path.join(repo, ".brai-task", "task.json"),
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
  const marker = JSON.parse(fs.readFileSync(path.join(repo, ".brai-task", "task.json"), "utf8"));
  assert.equal(marker.mode, "follow-up");
  assert.equal(marker.base, base);
});

test("task state rejects a branch with another task marker", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-wrong-marker-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/current-task"], repo);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-frozen-base-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
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
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
  const message = taskStartGuidance("/srv/projects/brai/.codex-worktrees");
  assert.match(message, /sandbox_permissions=require_escalated/);
  assert.match(message, /scripts\/brai-task-start\.sh <task-slug>/);
  assert.match(message, /Do not create or switch to a manual fallback branch/);
  assert.match(message, /installed guard starter/);
});

test("task permission repair script is scoped to one registered worktree", () => {
  const script = fs.readFileSync(new URL("./brai-task-repair-permissions.sh", import.meta.url), "utf8");
  assert.match(script, /usage: scripts\/brai-task-repair-permissions\.sh \[--workspace\]/);
  assert.match(script, /Refusing to repair path outside/);
  assert.match(script, /Refusing to repair git metadata outside/);
  assert.match(script, /Refusing to repair workspace path outside/);
  assert.match(script, /apps\/brai_app\/node_modules\/@capacitor\/android\/capacitor\/build/);
  assert.match(script, /\.playwright-browsers/);
  assert.match(script, /apps\/brai_app\/android\/\*\/build/);
  assert.ok(script.includes('sudo chown -R "$OWNER" "$TARGET_REAL" "$GIT_DIR_REAL"'));
  assert.ok(script.includes('sudo chmod -R u=rwX,g=rwX,o= "$TARGET_REAL" "$GIT_DIR_REAL"'));
  assert.ok(script.includes("sudo find \"$task_state\" -maxdepth 1 -type f -name '*.json' -exec chmod 0640 {} +"));
});

test("task starter runs scoped repair and preflight after installed guard", () => {
  const script = fs.readFileSync(new URL("./brai-task-start.sh", import.meta.url), "utf8");
  assert.match(script, /brai-guard\.mjs start "\$@"/);
  assert.match(script, /brai-task-repair-permissions\.sh" "\$TASK"/);
  assert.match(script, /brai-task\.mjs" preflight --strict/);
});

test("task starter creates writable nested worktrees from repo and supports legacy task roots", () => {
  assert.equal(taskWorktreeParent("/srv/projects/brai"), "/srv/projects/brai/.codex-worktrees");
  assert.equal(taskWorktreeParent("/srv/projects/brai/.codex-worktrees/existing-task"), "/srv/projects/brai/.codex-worktrees");
  assert.equal(taskWorktreeParent("/srv/projects/brai-worktrees/existing-task"), "/srv/projects/brai-worktrees");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-source-"));
  const canonical = path.join(tmp, "brai");
  const worktree = path.join(tmp, "brai-worktrees", "existing-task");
  const nestedWorktree = path.join(canonical, ".codex-worktrees", "nested-task");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "package.json"), "{}\n");
  assert.equal(dependencySourceRoot(worktree), canonical);
  assert.equal(dependencySourceRoot(nestedWorktree), canonical);
});

test("task starter blocks another open branch in the same Codex thread", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-thread-"));
  const open = path.join(parent, "public-site-live");
  const accepted = path.join(parent, "accepted-task");
  for (const [taskPath, branch] of [
    [open, "codex/public-site-live"],
    [accepted, "codex/accepted-task"],
  ]) {
    fs.mkdirSync(path.join(taskPath, ".brai-task"), { recursive: true });
    fs.writeFileSync(
      path.join(taskPath, ".brai-task", "task.json"),
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
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-control-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-squash-"));
  const merged = path.join(parent, "merged-task");
  const open = path.join(parent, "open-task");
  const previous = process.cwd();
  try {
    git(["init"], control);
    git(["config", "user.email", "test@example.invalid"], control);
    git(["config", "user.name", "Brai Test"], control);
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
      git(["config", "user.name", "Brai Test"], taskPath);
      fs.writeFileSync(path.join(taskPath, "change.txt"), branch);
      git(["add", "change.txt"], taskPath);
      git(["commit", "-m", branch], taskPath);
      fs.mkdirSync(path.join(taskPath, ".brai-task"));
      fs.writeFileSync(
        path.join(taskPath, ".brai-task", "task.json"),
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
          path.join(taskPath, ".brai-task", "delivery-handoff.json"),
          `${JSON.stringify({
            receiptType: "brai-delivery-handoff-v1",
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
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-control-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-wrong-receipt-"));
  const taskPath = path.join(parent, "wrong-receipt-task");
  const previous = process.cwd();
  try {
    git(["init"], control);
    git(["config", "user.email", "test@example.invalid"], control);
    git(["config", "user.name", "Brai Test"], control);
    fs.writeFileSync(path.join(control, "base.txt"), "base\n");
    git(["add", "base.txt"], control);
    git(["commit", "-m", "base"], control);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], control);

    fs.mkdirSync(taskPath, { recursive: true });
    git(["init"], taskPath);
    git(["config", "user.email", "test@example.invalid"], taskPath);
    git(["config", "user.name", "Brai Test"], taskPath);
    fs.writeFileSync(path.join(taskPath, "change.txt"), "change\n");
    git(["add", "change.txt"], taskPath);
    git(["commit", "-m", "change"], taskPath);
    fs.mkdirSync(path.join(taskPath, ".brai-task"));
    fs.writeFileSync(
      path.join(taskPath, ".brai-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/wrong-receipt",
        mode: "new",
        base: "1111111111111111111111111111111111111111",
        createdAt: "2026-06-26T00:00:00.000Z",
        threadId: "thread-a",
      })}\n`,
    );
    fs.writeFileSync(
      path.join(taskPath, ".brai-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "brai-delivery-handoff-v1",
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-"));
  const source = path.join(tmp, "source");
  const target = path.join(tmp, "target");
  fs.mkdirSync(path.join(source, "services/brai_api/node_modules"), { recursive: true });
  fs.mkdirSync(target);

  assert.deepEqual(linkDependencyDirs(source, target, ["services/brai_api/node_modules"]), ["services/brai_api/node_modules"]);
  assert.equal(fs.lstatSync(path.join(target, "services/brai_api/node_modules")).isSymbolicLink(), true);
});

test("workspace preflight checks allowlisted dirs and rejects symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preflight-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preflight-outside-"));
  fs.mkdirSync(path.join(root, ".brai-task"));
  fs.mkdirSync(path.join(root, "apps/brai_app/android/app/build"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "node_modules"), "dir");

  const result = workspacePreflight(root);
  assert.equal(result.ok, false);
  assert.ok(result.checked.some((entry) => entry.path === ".brai-task"));
  assert.ok(result.checked.some((entry) => entry.path === "apps/brai_app/android/app/build"));
  assert.match(result.failed.find((entry) => entry.path === "node_modules")?.reason ?? "", /outside workspace roots/);
});

test("workspace preflight fails task worktrees with non-writable tracked source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preflight-source-"));
  fs.mkdirSync(path.join(root, ".brai-task"));
  fs.writeFileSync(path.join(root, ".brai-task", "task.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n", { mode: 0o444 });
  try {
    fs.chmodSync(root, 0o555);
    const result = workspacePreflight(root);
    assert.equal(result.ok, false);
    assert.equal(result.failed.find((entry) => entry.path === "tracked source")?.reason, "EACCES");
  } finally {
    fs.chmodSync(root, 0o755);
    fs.chmodSync(path.join(root, "package.json"), 0o644);
  }
});

test("preview slot status is shared-lock read-only", () => {
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), "brai-preview-slots-"));
  const registry = path.join(envRoot, "preview-slots.json");
  const statusDir = path.join(envRoot, "preview-status");
  const result = spawnSync("bash", ["deploy/scripts/preview-slots.sh", "status"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_BIN: process.execPath,
      BRAI_ENVS_ROOT: envRoot,
      BRAI_PREVIEW_REGISTRY: registry,
      BRAI_PREVIEW_LOCK: path.join(envRoot, "preview-slots.lock"),
      BRAI_PREVIEW_STATUS_DIR: statusDir,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(registry), false);
  assert.equal(fs.existsSync(path.join(envRoot, "preview-slots.lock")), false);
  assert.equal(fs.existsSync(path.join(statusDir, "index.html")), false);
  assert.match(fs.readFileSync(new URL("../deploy/scripts/preview-slots.sh", import.meta.url), "utf8"), /flock -s 9/);
});

test("task starter can enable checked-in git hooks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-hooks-"));
  git(["init"], tmp);
  enableGitHooks(tmp);
  assert.equal(git(["config", "core.hooksPath"], tmp).stdout.trim(), ".githooks");
});

test("hook input parser is tolerant", () => {
  assert.deepEqual(parseHookInput("{\"tool_name\":\"exec_command\"}"), { tool_name: "exec_command" });
  assert.equal(parseHookInput("not-json"), null);
});

test("preview receipts must match exact branch and head", () => {
  const releaseNotes = {
    receiptType: "brai-release-notes-v1",
    short_changes: "Исправлен рабочий процесс версий.",
    detailed_changes: "Release notes передаются через preview handoff и acceptance PR.",
    reason: "Нужно не терять описания принятых сборок.",
  };
  const receipt = {
    branch: "codex/foo",
    commit: "1111111111111111111111111111111111111111",
    slot: "A",
    url: "https://a.test.brightos.world",
    runId: 123,
    releaseNotes,
    verifiedAt: "2026-06-26T00:00:00.000Z",
  };
  assert.deepEqual(validatePreviewReceipt(receipt, "codex/foo", receipt.commit), { ok: true });
  assert.match(validatePreviewReceipt(null, "codex/foo", receipt.commit).message, /missing/);
  assert.match(validatePreviewReceipt({ ...receipt, commit: "2222" }, "codex/foo", receipt.commit).message, /2222/);
  assert.match(validatePreviewReceipt({ ...receipt, runId: "" }, "codex/foo", receipt.commit).message, /run id/);
  assert.match(validatePreviewReceipt({ ...receipt, releaseNotes: null }, "codex/foo", receipt.commit).message, /release notes/);
  assert.deepEqual(validateReleaseNotes(releaseNotes), { ok: true });
  assert.match(validateReleaseNotes({ ...releaseNotes, short_changes: "Принята сборка Brai." }).message, /generic/);
});

test("delivery receipts must match exact branch, head, and class", () => {
  const receipt = {
    receiptType: "brai-delivery-handoff-v1",
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
  assert.deepEqual(validateDeliveryReceipt({ ...receipt, deliveryClass: "technical-no-preview" }, "codex/foo", receipt.commit), { ok: true });
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
    receiptType: "brai-acceptance-v1",
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-state-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
      path.join(repo, ".brai-task", "preview-handoff.json"),
      `${JSON.stringify({ branch: "codex/foo", commit: base, slot: "A", url: "https://a.test.brightos.world", runId: 123, releaseNotes: { short_changes: "Исправлен тест.", detailed_changes: "Детали теста.", reason: "Нужно проверить receipt." }, verifiedAt: "2026-06-26T00:00:00.000Z" })}\n`,
    );
    assert.equal(deriveTaskState().ok, false);

    fs.writeFileSync(
      path.join(repo, ".brai-task", "preview-handoff.json"),
      `${JSON.stringify({ branch: "codex/foo", commit: head, slot: "A", url: "https://a.test.brightos.world", runId: 123, releaseNotes: { short_changes: "Исправлен тест.", detailed_changes: "Детали теста.", reason: "Нужно проверить receipt." }, verifiedAt: "2026-06-26T00:00:00.000Z" })}\n`,
    );
    assert.equal(deriveTaskState().ok, true);

    fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty\n");
    assert.equal(deriveTaskState().ok, false);
  } finally {
    process.chdir(previous);
  }
});

test("task state allows infra-docs work with exact delivery receipt", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-docs-state-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
      path.join(repo, ".brai-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "brai-delivery-handoff-v1",
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
      path.join(repo, ".brai-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "brai-delivery-handoff-v1",
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
    assert.equal(fs.existsSync(path.join(fixture.repo, ".brai-task", "delivery-handoff.json")), false);
  }
});

test("delivery handoff blocks merged infra-docs PRs without merged timestamp", () => {
  const fixture = setupInfraDocsHandoffFixture({ prState: "MERGED" });
  const result = runDeliveryHandoffFixture(fixture);
  const output = result.stderr || result.stdout;

  assert.notEqual(result.status, 0);
  assert.match(output, /PR state: MERGED/);
  assert.match(output, /mergedAt: \(missing\)/);
  assert.equal(fs.existsSync(path.join(fixture.repo, ".brai-task", "delivery-handoff.json")), false);
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
  assert.equal(fs.existsSync(path.join(fixture.repo, ".brai-task", "delivery-handoff.json")), false);
});

test("infra docs workflow marks handoff passed only from the PR merge job", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/brai-delivery.yml", import.meta.url), "utf8");
  const autoMergeJob = workflow.slice(workflow.indexOf("auto-merge-infra-docs:"), workflow.indexOf("deploy-prod:"));
  const recordMergeJob = workflow.slice(workflow.indexOf("record-infra-docs-merge:"), workflow.indexOf("release-preview-slot:"));
  assert.doesNotMatch(autoMergeJob, /event delivery_handoff_passed/);
  assert.match(autoMergeJob, /BRAI_ACCEPT_NO_PREVIEW_ONLY/);
  assert.match(recordMergeJob, /event delivery_handoff_passed/);
  assert.match(recordMergeJob, /event pr_merged/);
  assert.match(recordMergeJob, /brai-delivery:technical-no-preview/);
  assert.ok(recordMergeJob.indexOf("event delivery_handoff_passed") < recordMergeJob.indexOf("event pr_merged"));
  assert.match(recordMergeJob, /BRAI_PR_MERGED_AT/);
});

test("delivery workflow serializes main sync after prod deploy", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/brai-delivery.yml", import.meta.url), "utf8");
  const deployProdJob = workflow.slice(workflow.indexOf("deploy-prod:"), workflow.indexOf("sync-local-main-checkout:"));
  const syncJob = workflow.slice(workflow.indexOf("sync-local-main-checkout:"), workflow.indexOf("record-infra-docs-merge:"));

  assert.match(deployProdJob, /id: deploy_prod/);
  assert.match(deployProdJob, /Temporal prod deploy failed\n\s+if: failure\(\) && steps\.deploy_prod\.outcome == 'failure'/);
  assert.match(syncJob, /needs: deploy-prod/);
});

test("delivery workflow releases preview slots for unmerged closed codex PRs", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/brai-delivery.yml", import.meta.url), "utf8");
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
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.repo, ".brai-task", "delivery-handoff.json"), "utf8"));
  assert.equal(receipt.prNumber, 7);
  assert.equal(receipt.prUrl, "https://github.example/pr/7");
  assert.equal(receipt.prState, "MERGED");
  assert.equal(receipt.mergedAt, "2026-06-26T00:00:00Z");
  assert.equal(receipt.runId, 42);
});

test("preview handoff waits for an in-progress delivery run before writing a receipt", () => {
  const fixture = setupPreviewHandoffFixture();
  const result = runPreviewHandoffFixture(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Preview C: https:\/\/c\.test\.example/);
  assert.equal(fs.readFileSync(fixture.runListCountFile, "utf8").trim(), "2");

  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.repo, ".brai-task", "preview-handoff.json"), "utf8"));
  assert.equal(receipt.branch, "codex/foo");
  assert.equal(receipt.slot, "C");
  assert.equal(receipt.url, "https://c.test.example");
  assert.equal(receipt.runId, 42);
});

test("no-preview acceptance diffs ignore reconciled main-only runtime paths", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-no-preview-reconcile-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["branch", "-M", "main"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);

    git(["checkout", "-b", "codex/foo"], repo);
    fs.mkdirSync(path.join(repo, "apps/brai_app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/brai_app/vitest.config.mts"), "export default {};\n");
    git(["add", "apps/brai_app/vitest.config.mts"], repo);
    git(["commit", "-m", "technical change"], repo);

    git(["checkout", "main"], repo);
    fs.mkdirSync(path.join(repo, "assets/brand"), { recursive: true });
    fs.writeFileSync(path.join(repo, "assets/brand/logo.png"), "png\n");
    git(["add", "assets/brand/logo.png"], repo);
    git(["commit", "-m", "main asset"], repo);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"], repo);

    git(["checkout", "codex/foo"], repo);
    git(["merge", "--no-edit", "origin/main"], repo);
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/codex/foo", head], repo);

    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".brai-task", "acceptance.json"),
      `${JSON.stringify({
        receiptType: "brai-acceptance-v1",
        branch: "codex/foo",
        commit: head,
        baseBranch: "main",
        status: "acceptance_started",
        deliveryClass: "technical-no-preview",
        acceptedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );

    process.chdir(repo);
    const state = deriveTaskState();
    assert.equal(state.classification.deliveryClass, "technical-no-preview");
    assert.deepEqual(state.changedFiles, ["apps/brai_app/vitest.config.mts"]);
  } finally {
    process.chdir(previous);
  }
});

test("delivery handoff preserves accepted no-preview class after squash merge", () => {
  const fixture = setupInfraDocsHandoffFixture({
    prState: "MERGED",
    mergedAt: "2026-06-26T00:00:00Z",
    label: "brai-delivery:technical-no-preview",
  });
  const head = git(["rev-parse", "HEAD"], fixture.repo).stdout.trim();
  git(["checkout", "--detach", "origin/main"], fixture.repo);
  fs.mkdirSync(path.join(fixture.repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(fixture.repo, "docs/change.md"), "change\n");
  git(["add", "docs/change.md"], fixture.repo);
  git(["commit", "-m", "squash no-preview"], fixture.repo);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"], fixture.repo);
  git(["checkout", "codex/foo"], fixture.repo);
  git(["update-ref", "refs/remotes/origin/codex/foo", head], fixture.repo);
  fs.writeFileSync(
    path.join(fixture.repo, ".brai-task", "acceptance.json"),
    `${JSON.stringify({
      receiptType: "brai-acceptance-v1",
      branch: "codex/foo",
      commit: head,
      baseBranch: "main",
      status: "acceptance_started",
      deliveryClass: "technical-no-preview",
      acceptedAt: "2026-06-26T00:00:00.000Z",
    })}\n`,
  );

  const result = runDeliveryHandoffFixture(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Delivery class: technical-no-preview/);
  const receipt = JSON.parse(fs.readFileSync(path.join(fixture.repo, ".brai-task", "delivery-handoff.json"), "utf8"));
  assert.equal(receipt.deliveryClass, "technical-no-preview");
});

test("task state allows exact delivery receipt after infra-docs branch was squash-merged", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-docs-accepted-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", ".gitignore", "base.txt"], repo);
    git(["commit", "-m", "base"], repo);
    git(["checkout", "-b", "codex/foo"], repo);
    const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", base], repo);
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
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
      path.join(repo, ".brai-task", "delivery-handoff.json"),
      `${JSON.stringify({
        receiptType: "brai-delivery-handoff-v1",
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-accepted-marker-"));
  const previous = process.cwd();
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
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
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".brai-task", "acceptance.json"),
      `${JSON.stringify({
        receiptType: "brai-acceptance-v1",
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

    const acceptancePath = path.join(repo, ".brai-task", "acceptance.json");
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-reconcile-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const script = path.join(process.cwd(), "scripts/brai-task.mjs");
  const previousPrs = process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON;
  try {
    git(["init", "--bare", remote], root);
    fs.mkdirSync(repo);
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
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
    fs.mkdirSync(path.join(repo, "apps/brai_app/src/features/app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "apps/brai_app/src/features/app/BraiApp.tsx"), "main\n");
    git(["add", "apps/brai_app/src/features/app/BraiApp.tsx"], repo);
    git(["commit", "-m", "main change"], repo);
    git(["push", "origin", "HEAD:main"], repo);
    git(["checkout", "codex/foo"], repo);

    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(repo, ".brai-task", "acceptance.json"),
      `${JSON.stringify({
        receiptType: "brai-acceptance-v1",
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
    process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON = JSON.stringify([
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
    const receipt = JSON.parse(fs.readFileSync(path.join(repo, ".brai-task", "acceptance.json"), "utf8"));
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
    if (previousPrs == null) delete process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON;
    else process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON = previousPrs;
  }
});

test("task state rejects squash-merged branch by merged PR head oid", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-merged-pr-"));
  const previousCwd = process.cwd();
  const previousMergedPrs = process.env.BRAI_TEST_MERGED_PRS_JSON;
  try {
    git(["init"], repo);
    git(["config", "user.email", "test@example.invalid"], repo);
    git(["config", "user.name", "Brai Test"], repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
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
    fs.mkdirSync(path.join(repo, ".brai-task"));
    fs.writeFileSync(
      path.join(repo, ".brai-task", "task.json"),
      `${JSON.stringify({
        branch: "codex/foo",
        mode: "new",
        base,
        createdAt: "2026-06-26T00:00:00.000Z",
        ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
      })}\n`,
    );
    process.env.BRAI_TEST_MERGED_PRS_JSON = JSON.stringify([
      { number: 7, url: "https://github.example/pr/7", headRefOid: head, mergedAt: "2026-06-26T00:00:00Z" },
    ]);
    process.chdir(repo);

    const state = deriveTaskState();
    assert.equal(state.reuse.ok, false);
    assert.match(state.reuse.message, /github\.example\/pr\/7/);
  } finally {
    if (previousMergedPrs == null) delete process.env.BRAI_TEST_MERGED_PRS_JSON;
    else process.env.BRAI_TEST_MERGED_PRS_JSON = previousMergedPrs;
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
  assert.match(script, /Brai task state must not be a symlink/);
  assert.match(script, /mktemp "\$dir\/\.acceptance-write\.XXXXXX"/);
  assert.match(script, /write_acceptance_marker/);
  assert.match(script, /acceptance\.json/);
  assert.match(script, /deliveryClass/);
  assert.match(script, /CALL_ROOT="\$\(git rev-parse --show-toplevel\)"/);
  assert.match(script, /git -C "\$CALL_ROOT" worktree list --porcelain/);
  assert.match(script, /ROOT="\$\(find_acceptance_root\)"/);
  assert.match(script, /cd "\$ROOT"/);
  assert.ok(script.indexOf('ROOT="$(find_acceptance_root)"') < script.indexOf("ensure_acceptance_marker_writable"));
  assert.ok(script.indexOf('cd "$ROOT"') < script.indexOf("ensure_acceptance_marker_writable"));
});

test("accepted preview stale cleanup is best effort", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "deploy/scripts/ci-ssh-complete-accepted-previews.sh"), "utf8");
  const promoteScript = fs.readFileSync(path.join(process.cwd(), "deploy/scripts/ci-ssh-promote-deployment.sh"), "utf8");
  const otaSyncScript = fs.readFileSync(path.join(process.cwd(), "deploy/scripts/sync-occupied-preview-ota-manifests.sh"), "utf8");
  const requiredLoop = script.slice(script.indexOf('for index in "${!REQUIRED_BRANCHES[@]}"'), script.indexOf('if [[ "$MODE" == "promote" ]]'));
  const cleanupStart = script.indexOf("cleanup_previously_accepted_preview()");
  const cleanupLoop = script.slice(script.indexOf('for branch in "${CLEANUP_BRANCHES[@]}"', cleanupStart));

  assert.match(promoteScript, /accepted_build_recorded\(\)/);
  assert.match(promoteScript, /target_commit = \$3/);
  assert.match(promoteScript, /already promoted for/);
  assert.match(requiredLoop, /exit 1/);
  assert.match(requiredLoop, /BRAI_REQUIRE_PREVIEW_SLOT_RELEASE=true/);
  assert.match(requiredLoop, /slot_released/);
  assert.match(script, /filter_cleanup_branches_to_active_previews/);
  assert.match(script, /Skipping \$skipped previously accepted previews with no active preview slot or queue entry/);
  assert.match(cleanupLoop, /cleanup_previously_accepted_preview/);
  assert.match(cleanupLoop, /Best-effort cleanup failed/);
  assert.doesNotMatch(cleanupLoop, /exit 1/);
  assert.match(otaSyncScript, /PROD_SOURCE_ROOT="\$\{BRAI_PROD_SOURCE_ROOT:-\$ENVS_ROOT\/prod\/source\}"/);
  assert.match(otaSyncScript, /check_access\(\) \{/);
  assert.match(otaSyncScript, /\( "\$MODE" != "--local" \|\| "\$CHECK_ACCESS" == "true" \) && -n "\$\{BRAI_DEPLOY_HOST:-\}"/);
  assert.match(otaSyncScript, /BRAI_SKIP_DEPLOY_USER_REENTRY/);
  assert.match(otaSyncScript, /sudo -n -u "\$deploy_user"/);
  assert.match(otaSyncScript, /check_access "\$PROD_SOURCE_ROOT"/);
  assert.match(otaSyncScript, /\$PROD_SOURCE_ROOT\/deploy\/scripts\/sync-occupied-preview-ota-manifests\.sh/);
  assert.match(otaSyncScript, /--check-access/);
  assert.match(otaSyncScript, /resolve-app-version\.mjs/);
  assert.match(otaSyncScript, /accepted preview OTA sync access ok/);
});

test("accepted preview branch lookup skips no-preview delivery PRs", () => {
  assert.deepEqual(acceptedPreviewBranches([
    {
      base: { ref: "main" },
      head: { ref: "codex/infra-docs" },
      merged_at: "2026-06-25T10:00:00Z",
      labels: [{ name: "brai-delivery:infra-docs" }],
    },
    {
      base: { ref: "main" },
      head: { ref: "codex/technical" },
      merged_at: "2026-06-25T10:00:00Z",
      labels: [{ name: "brai-delivery:technical-no-preview" }],
    },
    {
      base: { ref: "main" },
      head: { ref: "codex/runtime" },
      merged_at: "2026-06-25T10:00:00Z",
      labels: [],
    },
  ]), ["codex/runtime"]);
});

function setupInfraDocsHandoffFixture({ prState, mergeStateStatus = "CLEAN", autoMerge = false, mergedAt = null, jobConclusions = {}, label = "brai-delivery:infra-docs" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-handoff-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");

  git(["init", "--bare", remote], root);
  fs.mkdirSync(repo);
  git(["init"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "user.name", "Brai Test"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
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

  fs.mkdirSync(path.join(repo, ".brai-task"));
  fs.writeFileSync(
    path.join(repo, ".brai-task", "task.json"),
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
    labels: [{ name: label }],
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

function setupPreviewHandoffFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-task-preview-handoff-"));
  const remote = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const registry = path.join(root, "preview-slots.json");
  const runListCountFile = path.join(root, "gh-run-list-count.txt");

  git(["init", "--bare", remote], root);
  fs.mkdirSync(repo);
  git(["init"], repo);
  git(["config", "user.email", "test@example.invalid"], repo);
  git(["config", "user.name", "Brai Test"], repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".brai-task/\n");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  fs.mkdirSync(path.join(repo, "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "deploy", "environments.json"),
    `${JSON.stringify({ environments: { "preview-c": { domain: "c.test.example" } } }, null, 2)}\n`,
  );
  git(["add", ".gitignore", "base.txt", "deploy/environments.json"], repo);
  git(["commit", "-m", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["remote", "add", "origin", remote], repo);
  git(["push", "origin", "HEAD:main"], repo);
  git(["checkout", "-b", "codex/foo"], repo);
  fs.mkdirSync(path.join(repo, "apps", "brai_app", "src", "app"), { recursive: true });
  fs.writeFileSync(path.join(repo, "apps", "brai_app", "src", "app", "page.tsx"), "export default function Page() { return null; }\n");
  git(["add", "apps/brai_app/src/app/page.tsx"], repo);
  git(["commit", "-m", "runtime change"], repo);
  const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
  git(["push", "origin", "HEAD:codex/foo"], repo);

  fs.mkdirSync(path.join(repo, ".brai-task"));
  fs.writeFileSync(
    path.join(repo, ".brai-task", "task.json"),
    `${JSON.stringify({
      branch: "codex/foo",
      mode: "new",
      base,
      createdAt: "2026-06-26T00:00:00.000Z",
      ...(process.env.CODEX_THREAD_ID ? { threadId: process.env.CODEX_THREAD_ID } : {}),
    })}\n`,
  );
  fs.writeFileSync(
    path.join(repo, ".brai-task", "release-notes.json"),
    `${JSON.stringify({
      receiptType: "brai-release-notes-v1",
      short_changes: "Подготовлен preview handoff.",
      detailed_changes: "Runtime ветка ждёт успешный delivery run и готовый preview slot.",
      reason: "Нужно проверить, что handoff не бросает активную доставку.",
    })}\n`,
  );
  fs.writeFileSync(
    registry,
    `${JSON.stringify({
      C: {
        branch: "codex/foo",
        commit: head,
        status: "ready",
      },
    })}\n`,
  );

  const pendingRun = {
    databaseId: 42,
    headSha: head,
    status: "in_progress",
    conclusion: "",
    url: "https://github.example/actions/runs/42",
  };
  const successfulRun = {
    ...pendingRun,
    status: "completed",
    conclusion: "success",
  };
  const jobs = {
    jobs: ["public-guard", "checks", "temporal-worker-check", "deploy-preview"].map((name) => ({ name, conclusion: "success" })),
  };

  fs.mkdirSync(bin);
  const gh = path.join(bin, "gh");
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env bash
count_file="${runListCountFile}"
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count="$((count + 1))"
  printf '%s' "$count" > "$count_file"
  if [ "$count" -eq 1 ]; then
    printf '%s' '${JSON.stringify([pendingRun])}'
  else
    printf '%s' '${JSON.stringify([successfulRun])}'
  fi
elif [ "$1" = "run" ] && [ "$2" = "view" ]; then
  printf '%s' '${JSON.stringify(jobs)}'
else
  echo "unexpected gh $*" >&2
  exit 1
fi
`,
  );
  fs.chmodSync(gh, 0o755);

  return { repo, bin, registry, runListCountFile };
}

function runDeliveryHandoffFixture({ repo, bin }) {
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const previousWait = process.env.BRAI_INFRA_DOCS_HANDOFF_WAIT_MS;
  const previousPoll = process.env.BRAI_INFRA_DOCS_HANDOFF_POLL_MS;
  const previousLog = console.log;
  const logs = [];
  try {
    process.chdir(repo);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.BRAI_INFRA_DOCS_HANDOFF_WAIT_MS = "1";
    process.env.BRAI_INFRA_DOCS_HANDOFF_POLL_MS = "1";
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
    if (previousWait == null) delete process.env.BRAI_INFRA_DOCS_HANDOFF_WAIT_MS;
    else process.env.BRAI_INFRA_DOCS_HANDOFF_WAIT_MS = previousWait;
    if (previousPoll == null) delete process.env.BRAI_INFRA_DOCS_HANDOFF_POLL_MS;
    else process.env.BRAI_INFRA_DOCS_HANDOFF_POLL_MS = previousPoll;
  }
}

function runPreviewHandoffFixture({ repo, bin, registry }) {
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const previousRegistry = process.env.BRAI_PREVIEW_REGISTRY;
  const previousWait = process.env.BRAI_PREVIEW_HANDOFF_WAIT_MS;
  const previousPoll = process.env.BRAI_PREVIEW_HANDOFF_POLL_MS;
  const previousLog = console.log;
  const logs = [];
  try {
    process.chdir(repo);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    process.env.BRAI_PREVIEW_REGISTRY = registry;
    process.env.BRAI_PREVIEW_HANDOFF_WAIT_MS = "2000";
    process.env.BRAI_PREVIEW_HANDOFF_POLL_MS = "1";
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
    if (previousRegistry == null) delete process.env.BRAI_PREVIEW_REGISTRY;
    else process.env.BRAI_PREVIEW_REGISTRY = previousRegistry;
    if (previousWait == null) delete process.env.BRAI_PREVIEW_HANDOFF_WAIT_MS;
    else process.env.BRAI_PREVIEW_HANDOFF_WAIT_MS = previousWait;
    if (previousPoll == null) delete process.env.BRAI_PREVIEW_HANDOFF_POLL_MS;
    else process.env.BRAI_PREVIEW_HANDOFF_POLL_MS = previousPoll;
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
