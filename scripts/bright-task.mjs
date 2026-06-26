#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CODEX_BRANCH_RE = /^codex\/[a-z0-9][a-z0-9._-]*$/;
const PROTECTED_PATH_RE =
  /(^|\/)(\.env(\.|$)|.*\.(sqlite|sqlite3|db|jks|keystore|pem|key|p12|pfx|apk|aab|zip)$|google-services\.json|.*(service-account|credentials|secrets).*\.json$)|^(data\/|deploy\/(web|mobile-update|releases)\/)/;
const WRITE_COMMAND_RE =
  /(^|[;&|]\s*)(apply_patch|git\s+(add|branch|checkout|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|stash|switch|tag|worktree)|npm\s+(ci|install|i|run\s+(android:|app:cap|publish:))|pnpm\s+(install|i)|yarn\s+(install|add)|rm\s|mv\s|cp\s|mkdir\s|touch\s|chmod\s|chown\s|ln\s|tee\s|sed\s+-i|perl\s+-pi|python3?\s+.*(write|open\(|Path\().*['"]w|node\s+.*(writeFile|appendFile|rmSync|mkdirSync)|cat\s+[^|]*>|printf\s+[^|]*>|>\s*[^&]|>>\s*)/s;

const ZERO_SHA = "0000000000000000000000000000000000000000";
const PREVIEW_SLOT_EMOJI = { A: "🅰️", B: "🅱️", C: "🅲", D: "🅳", E: "🅴" };

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

export {
  CODEX_BRANCH_RE,
  PROTECTED_PATH_RE,
  WRITE_COMMAND_RE,
  isSensitivePath,
  isWriteLikeCommand,
  parseHookInput,
  validatePushUpdate,
};

function runCli([command, ...args]) {
  try {
    switch (command) {
      case "start":
        startTask(args[0]);
        break;
      case "follow-up":
        markFollowUp(args[0]);
        break;
      case "pre-tool-use":
        preToolUse();
        break;
      case "pre-commit":
        preCommit();
        break;
      case "pre-push":
        prePush(args[0] ?? "");
        break;
      case "stop":
        stopHook();
        break;
      case "preview":
        previewHandoff(args[0]);
        break;
      case "doctor":
        doctor();
        break;
      default:
        throw new Error("usage: bright-task.mjs start <slug>|follow-up [branch]|pre-tool-use|pre-commit|pre-push <remote>|stop|preview [branch]|doctor");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command === "pre-tool-use" || command === "stop") {
      blockHook(message);
      return;
    }
    console.error(message);
    process.exit(1);
  }
}

function startTask(slug) {
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    throw new Error("Task slug must match [a-z0-9][a-z0-9._-]*");
  }

  const root = git("rev-parse", "--show-toplevel");
  const parent = process.env.BRIGHT_OS_WORKTREE_ROOT ?? path.resolve(root, "..", "bright-os-worktrees");
  const branch = `codex/${slug}`;
  const target = path.join(parent, slug);

  if (fs.existsSync(target)) throw new Error(`Worktree target already exists: ${target}`);
  fetchDev();
  if (remoteBranchExists(branch)) {
    throw new Error(`Remote branch already exists: ${branch}. Use a new slug unless the project owner explicitly said this is a follow-up.`);
  }

  fs.mkdirSync(parent, { recursive: true });
  git("worktree", "add", "--no-track", "-b", branch, target, "origin/dev");
  writeTaskMarker(target, { branch, mode: "new", base: git("rev-parse", "origin/dev"), createdAt: new Date().toISOString() });
  console.log(`Created ${branch} at ${target}`);
}

function markFollowUp(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Follow-up marker requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) throw new Error(validation.message);
  writeTaskMarker(git("rev-parse", "--show-toplevel"), {
    branch,
    mode: "follow-up",
    base: git("rev-parse", "origin/dev"),
    createdAt: new Date().toISOString(),
  });
  console.log(`Marked explicit follow-up for ${branch}`);
}

function preToolUse() {
  const input = parseHookInput(readStdin());
  const tool = input.tool_name ?? input.toolName ?? input.tool ?? "";
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? {};

  const isPatchTool = /(^apply_patch$|^Edit$|^Write$)/.test(tool);
  const commandText = typeof toolInput === "object" && toolInput ? String(toolInput.cmd ?? toolInput.command ?? "") : "";
  const isShellTool = tool === "exec_command" || tool === "Bash" || tool.endsWith(".exec_command");
  const isWrite = isPatchTool || (isShellTool && isWriteLikeCommand(commandText));

  if (!isWrite) return allowHook();

  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) {
    return blockHook(`Bright OS blocks project-file writes before a valid task branch exists.\n\n${validation.message}\n\nRun: scripts/bright-task-start.sh <task-slug>`);
  }

  const reuse = validateBranchReuse();
  if (!reuse.ok) return blockHook(reuse.message);

  markWriteIntent();
  return allowHook();
}

function preCommit() {
  const validation = validateTaskBranch({ requireExpectedUpstream: true });
  if (!validation.ok) throw new Error(validation.message);

  const staged = git("diff", "--cached", "--name-only")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocked = staged.filter(isSensitivePath);
  if (blocked.length) {
    throw new Error(`Refusing to commit generated/runtime/secret-like files:\n${blocked.map((file) => `- ${file}`).join("\n")}`);
  }
}

function prePush(remoteName) {
  if (remoteName !== "origin") throw new Error(`Bright OS task branches must push to origin, got: ${remoteName || "(empty)"}`);

  const validation = validateTaskBranch({ requireExpectedUpstream: true });
  if (!validation.ok) throw new Error(validation.message);

  const branch = currentBranch();
  fetchDev();
  const updates = readStdin()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of updates) validatePushUpdate(line, branch);

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream && upstream !== `origin/${branch}`) {
    throw new Error(`Wrong upstream: ${upstream}. Expected origin/${branch}. Fix with: git push -u origin HEAD`);
  }
  if (!isAncestor("origin/dev", "HEAD")) {
    throw new Error("origin/dev is not an ancestor of HEAD. Start from current origin/dev or rebase intentionally before pushing.");
  }

  const changed = diffFromDev();
  if (changed.some((file) => file.startsWith("services/bright_os_temporal/") || file === ".github/workflows/bright-os-delivery.yml")) {
    runRequired(["npm", "run", "temporal:test"], "Temporal-sensitive changes require passing npm run temporal:test before push.");
  }
  runRequired(["npm", "run", "public:guard"], "Bright OS public guard must pass before push.");
}

function stopHook() {
  if (!gitMaybe("rev-parse", "--show-toplevel")) return allowHook();

  const status = git("status", "--porcelain");
  if (status.trim()) {
    return blockHook(`Bright OS task is not ready for handoff: working tree is not clean.\n\n${status.trim()}\n\nCommit, push, and verify preview with: scripts/bright-preview-handoff.sh`);
  }

  const marker = readTaskMarker();
  if (!marker?.writeIntentAt) return allowHook();

  const branch = currentBranch();
  const head = git("rev-parse", "HEAD");
  const receipt = readPreviewReceipt();
  if (!receipt || receipt.branch !== branch || receipt.commit !== head) {
    return blockHook(`Bright OS implementation work cannot be handed off before preview verification.\n\nRun: scripts/bright-preview-handoff.sh`);
  }
  return allowHook();
}

function previewHandoff(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Preview handoff requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const head = git("rev-parse", "HEAD");

  fetchDevAndBranch(branch);
  const remoteSha = git("rev-parse", `origin/${branch}`);
  if (remoteSha !== head) throw new Error(`HEAD ${head} is not pushed to origin/${branch} (${remoteSha}). Push before handoff.`);
  if (git("status", "--porcelain").trim()) throw new Error("Working tree is not clean. Commit or remove local changes before handoff.");
  if (!isAncestor("origin/dev", head)) throw new Error(`origin/dev is not an ancestor of ${head}.`);

  const run = findSuccessfulDeliveryRun(branch, head);
  const slot = readPreviewSlot(branch, head);
  const url = previewUrlForSlot(slot);
  const receipt = { branch, commit: head, slot, url, runId: run.databaseId, verifiedAt: new Date().toISOString() };
  writePreviewReceipt(receipt);

  console.log(`${PREVIEW_SLOT_EMOJI[slot]} Preview`);
  console.log(`Branch: ${branch}`);
  console.log(`Commit: ${head}`);
  console.log(`Preview ${slot}: ${url}`);
  console.log(`GitHub Actions run: ${run.url ?? `https://github.com/sergobright/Bright-OS/actions/runs/${run.databaseId}`}`);
}

function doctor() {
  console.log(
    JSON.stringify(
      {
        branch: currentBranch(),
        validation: validateTaskBranch({ requireExpectedUpstream: true }),
        reuse: validateBranchReuse(),
        marker: readTaskMarker(),
        receipt: readPreviewReceipt(),
      },
      null,
      2,
    ),
  );
}

function validateTaskBranch({ requireExpectedUpstream }) {
  const branch = currentBranch();
  if (!branch) return { ok: false, message: "Detached HEAD is not allowed for Bright OS implementation work." };
  if (!CODEX_BRANCH_RE.test(branch)) {
    return { ok: false, message: `Implementation work must run on codex/<task-slug>, got: ${branch}` };
  }
  if (!gitMaybe("rev-parse", "--verify", "origin/dev")) {
    return { ok: false, message: "origin/dev is missing locally. Run: git fetch origin dev" };
  }

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream === "origin/dev") {
    return { ok: false, message: `${branch} tracks origin/dev. Recreate it with --no-track and push with: git push -u origin HEAD` };
  }
  if (requireExpectedUpstream && upstream && upstream !== `origin/${branch}`) {
    return { ok: false, message: `${branch} tracks ${upstream}. Expected origin/${branch} or no upstream before first push.` };
  }
  if (!isAncestor("origin/dev", "HEAD")) {
    return { ok: false, message: "origin/dev is not an ancestor of HEAD. Start the task from origin/dev." };
  }

  return { ok: true };
}

function validateBranchReuse() {
  const branch = currentBranch();
  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const marker = readTaskMarker();
  if (upstream === `origin/${branch}` && marker?.branch !== branch) {
    return {
      ok: false,
      message:
        `Bright OS refuses to reuse an existing pushed task branch without an explicit local marker.\n\n` +
        `For new work run: scripts/bright-task-start.sh <task-slug>\n` +
        `Only for an explicit project-owner-approved follow-up run: node scripts/bright-task.mjs follow-up`,
    };
  }
  return { ok: true };
}

function validatePushUpdate(line, currentBranchName = "") {
  const [localRef, localSha, remoteRef] = line.split(/\s+/);
  if (!localRef || !localSha || !remoteRef) throw new Error(`Cannot parse pre-push update: ${line}`);
  if (remoteRef === "refs/heads/main" || remoteRef === "refs/heads/dev") {
    throw new Error(`Direct push to ${remoteRef} is blocked. Use PR/accepted preview flow.`);
  }
  if (localSha === ZERO_SHA) {
    if (!remoteRef.startsWith("refs/heads/codex/")) throw new Error(`Only codex/* branch deletion is allowed, got: ${remoteRef}`);
    return;
  }
  if (!localRef.startsWith("refs/heads/codex/")) {
    if (localRef === "HEAD" && remoteRef === `refs/heads/${currentBranchName}`) return;
    throw new Error(`Only codex/* task branches may be pushed from this checkout, got: ${localRef}`);
  }
  if (remoteRef !== localRef) {
    throw new Error(`Push ref mismatch: ${localRef} must push to the same remote ref, got ${remoteRef}`);
  }
}

function parseHookInput(text) {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function isWriteLikeCommand(commandText) {
  return WRITE_COMMAND_RE.test(commandText);
}

function isSensitivePath(file) {
  return PROTECTED_PATH_RE.test(file);
}

function findSuccessfulDeliveryRun(branch, sha) {
  const runs = runJson(["gh", "run", "list", "--workflow", "Bright OS delivery", "--branch", branch, "--event", "push", "--limit", "20", "--json", "databaseId,headSha,status,conclusion,url"]);
  const run = runs.find((candidate) => candidate.headSha === sha);
  if (!run) throw new Error(`No Bright OS delivery push run found for ${branch}@${sha}.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Delivery run ${run.databaseId} is ${run.status}/${run.conclusion}. Wait or fix CI before handoff.`);
  }

  const details = runJson(["gh", "run", "view", String(run.databaseId), "--json", "jobs"]);
  const jobs = new Map((details.jobs ?? []).map((job) => [job.name, job.conclusion]));
  for (const job of ["public-guard", "checks", "temporal-worker-check", "deploy-preview"]) {
    if (jobs.get(job) !== "success") throw new Error(`Delivery job ${job} is ${jobs.get(job) ?? "missing"} for run ${run.databaseId}.`);
  }
  return run;
}

function readPreviewSlot(branch, sha) {
  const registryPath = process.env.BRIGHT_OS_PREVIEW_REGISTRY ?? "/srv/projects/bright-os-envs/preview-slots.json";
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    for (const slot of ["A", "B", "C", "D", "E"]) {
      const entry = registry[slot] ?? {};
      if (entry.branch === branch && entry.commit === sha && entry.status === "ready") return slot;
    }
    const queuedIndex = Array.isArray(registry.queue) ? registry.queue.findIndex((entry) => entry?.branch === branch && entry?.commit === sha) : -1;
    if (queuedIndex >= 0) throw new Error(`${branch}@${sha} is queued for preview at position ${queuedIndex + 1}.`);
  }

  const temporal = queryTemporalPreview(branch);
  const slot = temporal.slot ?? temporal.tasks?.slot?.slot ?? temporal.previewSlot;
  const status = temporal.status ?? temporal.state?.status;
  const blocker = temporal.blocker ?? temporal.state?.blocker;
  if (!slot || !/^[A-E]$/.test(slot)) throw new Error(`Temporal did not report a preview slot for ${branch}@${sha}.`);
  if (blocker) throw new Error(`Temporal preview blocker: ${typeof blocker === "string" ? blocker : JSON.stringify(blocker)}`);
  if (status && !["ready_for_review", "ready"].includes(status)) throw new Error(`Temporal preview state is ${status}, not ready_for_review.`);
  return slot;
}

function queryTemporalPreview(branch) {
  const result = spawnSync("deploy/scripts/ci-temporal-signal.sh", ["query-preview", "--branch", branch], {
    cwd: git("rev-parse", "--show-toplevel"),
    encoding: "utf8",
    env: { ...process.env, BRIGHT_TEMPORAL_REQUIRED: "true" },
  });
  if (result.status !== 0) {
    throw new Error(`Temporal query failed:\n${result.stderr || result.stdout || "(no output)"}`);
  }
  const text = result.stdout.trim();
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) throw new Error(`Temporal query did not return JSON:\n${text}`);
  return JSON.parse(text.slice(jsonStart));
}

function previewUrlForSlot(slot) {
  const root = git("rev-parse", "--show-toplevel");
  const environments = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8")).environments;
  const env = environments[`preview-${slot.toLowerCase()}`];
  if (!env?.domain) throw new Error(`No domain configured for preview slot ${slot}`);
  return `https://${env.domain}`;
}

function diffFromDev() {
  return git("diff", "--name-only", "origin/dev...HEAD")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchDev() {
  git("fetch", "origin", "+refs/heads/dev:refs/remotes/origin/dev");
}

function fetchDevAndBranch(branch) {
  git("fetch", "origin", "+refs/heads/dev:refs/remotes/origin/dev", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
}

function remoteBranchExists(branch) {
  return spawnGit(["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" }).status === 0;
}

function markWriteIntent() {
  const root = git("rev-parse", "--show-toplevel");
  const marker = readTaskMarker() ?? { branch: currentBranch(), mode: "manual", createdAt: new Date().toISOString() };
  writeTaskMarker(root, { ...marker, branch: currentBranch(), writeIntentAt: new Date().toISOString() });
}

function readTaskMarker() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".bright-task", "task.json"));
}

function writeTaskMarker(root, marker) {
  const dir = path.join(root, ".bright-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify(marker, null, 2)}\n`);
}

function readPreviewReceipt() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".bright-task", "preview-handoff.json"));
}

function writePreviewReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".bright-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview-handoff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runRequired(args, message) {
  const result = spawnSync(args[0], args.slice(1), { cwd: git("rev-parse", "--show-toplevel"), stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(message);
}

function runJson(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: git("rev-parse", "--show-toplevel"), encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${result.stderr || result.stdout || "(no output)"}`);
  }
  return JSON.parse(result.stdout);
}

function currentBranch() {
  return gitMaybe("branch", "--show-current") ?? "";
}

function isAncestor(base, ref) {
  return spawnGit(["merge-base", "--is-ancestor", base, ref], { stdio: "ignore" }).status === 0;
}

function git(...args) {
  const result = spawnGit(args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout || "(no output)"}`);
  return result.stdout.trim();
}

function gitMaybe(...args) {
  const result = spawnGit(args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function spawnGit(args, options = {}) {
  return spawnSync("git", args, { cwd: process.cwd(), env: process.env, ...options });
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allowHook() {
  console.log("{}");
}

function blockHook(reason) {
  console.log(JSON.stringify({ decision: "block", reason, permissionDecision: "deny", message: reason }));
  process.exit(0);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
