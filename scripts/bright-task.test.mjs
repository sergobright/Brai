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
  deliveryClassForFile,
  dependencySourceRoot,
  deriveTaskState,
  enableGitHooks,
  findOpenTaskForThread,
  isManualCodexBranchCommand,
  isReadOnlyShellCommand,
  isSensitivePath,
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

test("manual codex branch commands are hard blocked", () => {
  assert.equal(isManualCodexBranchCommand("git switch -c codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git checkout -b codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git branch codex/foo"), true);
  assert.equal(isManualCodexBranchCommand("git worktree add ../foo -b codex/foo origin/main"), true);
  assert.equal(isManualCodexBranchCommand("git branch --show-current"), false);
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

  const starter = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "scripts/bright-task-start.sh guard-task" } }));
  assert.equal(starter.ok, true);
  assert.equal(starter.write, false);
  assert.equal(starter.officialTaskStarter, true);

  const manual = analyzeHookInput(JSON.stringify({ tool_name: "functions.exec_command", tool_input: { cmd: "git switch -c codex/foo origin/main" } }));
  assert.equal(manual.manualCodexBranch, true);
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
  assert.equal(deliveryClassForFile("deploy/scripts/classify-delivery.mjs"), "infra");
  assert.equal(deliveryClassForFile("scripts/bright-task.mjs"), "infra");
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

test("task start guidance requires escalation and forbids manual branch fallback", () => {
  const message = taskStartGuidance("/srv/projects/bright-os-worktrees");
  assert.match(message, /sandbox_permissions=require_escalated/);
  assert.match(message, /scripts\/bright-task-start\.sh <task-slug>/);
  assert.match(message, /Do not create or switch to a manual fallback branch/);
});

test("task starter creates sibling worktrees from repo and task worktree roots", () => {
  assert.equal(taskWorktreeParent("/srv/projects/bright-os"), "/srv/projects/bright-os-worktrees");
  assert.equal(taskWorktreeParent("/srv/projects/bright-os-worktrees/existing-task"), "/srv/projects/bright-os-worktrees");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bright-task-source-"));
  const canonical = path.join(tmp, "bright-os");
  const worktree = path.join(tmp, "bright-os-worktrees", "existing-task");
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, "package.json"), "{}\n");
  assert.equal(dependencySourceRoot(worktree), canonical);
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
    runId: 123,
    verifiedAt: "2026-06-26T00:00:00.000Z",
  };
  assert.deepEqual(validateDeliveryReceipt(receipt, "codex/foo", receipt.commit), { ok: true });
  assert.match(validateDeliveryReceipt(null, "codex/foo", receipt.commit).message, /missing/);
  assert.match(validateDeliveryReceipt({ ...receipt, branch: "codex/bar" }, "codex/foo", receipt.commit).message, /codex\/bar/);
  assert.match(validateDeliveryReceipt({ ...receipt, commit: "2222" }, "codex/foo", receipt.commit).message, /2222/);
  assert.match(validateDeliveryReceipt({ ...receipt, deliveryClass: "runtime-preview" }, "codex/foo", receipt.commit).message, /runtime-preview/);
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
        runId: 123,
        verifiedAt: "2026-06-26T00:00:00.000Z",
      })}\n`,
    );
    assert.equal(deriveTaskState().ok, true);
  } finally {
    process.chdir(previous);
  }
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

test("accept preview checks verified preview before PR actions", () => {
  const script = fs.readFileSync(path.join(process.cwd(), "deploy/scripts/accept-preview.sh"), "utf8");
  assert.ok(script.indexOf("require-preview") > 0);
  assert.ok(script.indexOf("require-preview") < script.indexOf("gh pr list"));
  assert.ok(script.indexOf("require-preview") < script.indexOf("gh pr merge"));
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
