#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CODEX_BRANCH_RE = /^codex\/[a-z0-9][a-z0-9._-]*$/;
const PROTECTED_PATH_RE =
  /(^|\/)(\.env(\.|$)|.*\.(sqlite|sqlite3|db|jks|keystore|pem|key|p12|pfx|apk|aab|zip)$|google-services\.json|.*(service-account|credentials|secrets).*\.json$)|^(data\/|deploy\/(site|web|mobile-update|releases)\/)/;
const DEPENDENCY_DIRS = [
  "node_modules",
  "apps/bright_os_app/node_modules",
  "services/bright_os_api/node_modules",
  "services/bright_os_temporal/node_modules",
];

const ZERO_SHA = "0000000000000000000000000000000000000000";
const PREVIEW_SLOT_EMOJI = { A: "🅰️", B: "🅱️", C: "🅲", D: "🅳", E: "🅴" };
const DELIVERY_RECEIPT_VERSION = "bright-delivery-handoff-v1";
const DELIVERY_CLASS = {
  BLOCKED: "blocked",
  INFRA_DOCS: "infra-docs",
  NONE: "none",
  RUNTIME_PREVIEW: "runtime-preview",
};
const DEFAULT_ACCEPT_BASE_BRANCH = "main";

if (isMainModule()) {
  runCli(process.argv.slice(2));
}

export {
  CODEX_BRANCH_RE,
  DEPENDENCY_DIRS,
  PROTECTED_PATH_RE,
  analyzeHookInput,
  classifyDelivery,
  deliveryClassForFile,
  dependencySourceRoot,
  deriveTaskState,
  enableGitHooks,
  isManualCodexBranchCommand,
  isManualBranchCommand,
  isReadOnlyShellCommand,
  isSensitivePath,
  isWriteLikeCommand,
  linkDependencyDirs,
  findOpenTaskForThread,
  parseHookInput,
  taskStartGuidance,
  taskWorktreeParent,
  validateTaskMarker,
  validateTaskThread,
  validateDeliveryReceipt,
  validatePushUpdate,
  validatePreviewReceipt,
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
      case "classify":
        classifyCli(args);
        break;
      case "handoff":
        deliveryHandoff(args[0]);
        break;
      case "preview":
        previewHandoff(args[0]);
        break;
      case "require-delivery":
        requireDeliveryVerification(args[0], args[1]);
        break;
      case "require-preview":
        requirePreviewVerification(args[0], args[1]);
        break;
      case "doctor":
        doctor(args.includes("--strict"));
        break;
      default:
        throw new Error("usage: bright-task.mjs start <slug>|follow-up [branch]|pre-tool-use|pre-commit|pre-push <remote>|stop|classify [--base <ref>] [--head <ref>] [--github-output]|handoff [branch]|preview [branch]|require-delivery [branch] [sha]|require-preview [branch] [sha]|doctor [--strict]");
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
  const parent = process.env.BRIGHT_OS_WORKTREE_ROOT ?? taskWorktreeParent(root);
  const branch = `codex/${slug}`;
  const target = path.join(parent, slug);

  if (fs.existsSync(target)) throw new Error(`Worktree target already exists: ${target}`);
  try {
    ensureTaskWorktreeWritable(parent, target);
  } catch (error) {
    if (isWritePermissionError(error)) {
      throw new Error(`Cannot create Bright OS task worktree at ${target} from this sandbox.\n\n${taskStartGuidance(parent)}`);
    }
    throw error;
  }

  fetchAcceptedBase();
  const openTask = findOpenTaskForThread(parent, currentThreadId(), branch);
  if (openTask) {
    throw new Error(
      `This Codex thread already has open task branch ${openTask.branch} at ${openTask.path}.\n\n` +
        `Continue that worktree instead of starting ${branch}. A new task branch is allowed only after the existing branch is accepted into ${acceptedBaseRef()}.`,
    );
  }
  if (remoteBranchExists(branch)) {
    throw new Error(`Remote branch already exists: ${branch}. Use a new slug unless the project owner explicitly said this is a follow-up.`);
  }

  try {
    fs.mkdirSync(parent, { recursive: true });
    git("worktree", "add", "--no-track", "-b", branch, target, acceptedBaseRef());
    enableGitHooks(target);
    writeTaskMarker(target, withThreadId({ branch, mode: "new", base: git("rev-parse", acceptedBaseRef()), createdAt: new Date().toISOString() }));
    const linked = linkDependencyDirs(dependencySourceRoot(root), target);
    if (linked.length) console.log(`Linked dependency dirs: ${linked.join(", ")}`);
  } catch (error) {
    if (isWritePermissionError(error)) {
      throw new Error(`Cannot create Bright OS task worktree at ${target} from this sandbox.\n\n${taskStartGuidance(parent)}`);
    }
    throw error;
  }
  console.log(`Created ${branch} at ${target}`);
}

function markFollowUp(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Follow-up marker requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) throw new Error(validation.message);
  const marker = readTaskMarker();
  const markerValidation = validateTaskMarker(marker, branch);
  if (!markerValidation.ok) {
    throw new Error(`${markerValidation.message}\n\n${taskStartGuidance()}`);
  }
  const threadValidation = validateTaskThread(marker, currentThreadId());
  if (!threadValidation.ok) {
    throw new Error(`${threadValidation.message}\n\n${taskStartGuidance()}`);
  }
  writeTaskMarker(git("rev-parse", "--show-toplevel"), withThreadId({
    branch,
    mode: "follow-up",
    base: git("rev-parse", acceptedBaseRef()),
    createdAt: new Date().toISOString(),
  }));
  console.log(`Marked explicit follow-up for ${branch}`);
}

function preToolUse() {
  const analysis = analyzeHookInput(readStdin());
  if (!analysis.ok) return blockHook(analysis.reason);
  if (analysis.manualCodexBranch) {
    return blockHook(`Manual branch or worktree commands are blocked.\n\n${taskStartGuidance()}`);
  }
  if (analysis.blockedReason) return blockHook(analysis.blockedReason);
  if (!analysis.write && !analysis.officialTaskStarter) return allowHook();
  if (!currentThreadId()) {
    return blockHook("Bright OS cannot verify the current Codex thread id; blocking project-file writes fail-closed.");
  }
  if (analysis.officialTaskStarter) return allowHook();

  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) {
    return blockHook(`Bright OS blocks project-file writes before a valid task branch exists.\n\n${validation.message}\n\n${taskStartGuidance()}`);
  }

  const reuse = validateBranchReuse();
  if (!reuse.ok) return blockHook(reuse.message);

  markWriteIntent();
  return allowHook();
}

function preCommit() {
  fetchAcceptedBase();
  const validation = validateTaskBranch({ requireExpectedUpstream: true });
  if (!validation.ok) throw new Error(validation.message);
  const reuse = validateBranchReuse();
  if (!reuse.ok) throw new Error(reuse.message);

  const staged = git("diff", "--cached", "--name-only")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocked = staged.filter(isSensitivePath);
  if (blocked.length) {
    throw new Error(`Refusing to commit generated/runtime/secret-like files:\n${blocked.map((file) => `- ${file}`).join("\n")}`);
  }
  markWriteIntent();
}

function prePush(remoteName) {
  if (remoteName !== "origin") throw new Error(`Bright OS task branches must push to origin, got: ${remoteName || "(empty)"}`);

  fetchAcceptedBase();
  const validation = validateTaskBranch({ requireExpectedUpstream: true });
  if (!validation.ok) throw new Error(validation.message);
  const reuse = validateBranchReuse();
  if (!reuse.ok) throw new Error(reuse.message);

  const branch = currentBranch();
  const updates = readStdin()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of updates) validatePushUpdate(line, branch, { isAcceptedRemote: (sha) => isAncestor(sha, acceptedBaseRef()) });

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream && upstream !== `origin/${branch}`) {
    throw new Error(`Wrong upstream: ${upstream}. Expected origin/${branch}. Fix with: git push -u origin HEAD`);
  }
  if (!isAncestor(acceptedBaseRef(), "HEAD")) {
    throw new Error(`${acceptedBaseRef()} is not an ancestor of HEAD. Start from current ${acceptedBaseRef()} or rebase intentionally before pushing.`);
  }

  const changed = diffFromAcceptedBase();
  if (changed.some((file) => file.startsWith("scripts/bright-") || file.startsWith(".codex/") || file.startsWith(".githooks/"))) {
    runRequired(["npm", "run", "task:test"], "Bright OS task guard changes require passing npm run task:test before push.");
  }
  if (changed.some((file) => file.startsWith("services/bright_os_temporal/") || file === ".github/workflows/bright-os-delivery.yml")) {
    runRequired(["npm", "run", "temporal:test"], "Temporal-sensitive changes require passing npm run temporal:test before push.");
  }
  if (changed.some((file) => file.startsWith("openspec/"))) {
    runRequired(["npm", "run", "openspec:validate"], "OpenSpec changes require passing npm run openspec:validate before push.");
  }
  runRequired(["npm", "run", "public:guard"], "Bright OS public guard must pass before push.");
}

function stopHook() {
  if (!gitMaybe("rev-parse", "--show-toplevel")) return allowHook();

  const state = deriveTaskState();
  if (!state.ok) return blockHook(state.message);
  return allowHook();
}

function previewHandoff(branchArg) {
  const classification = classifyDelivery(diffFromTaskBase());
  if (classification.deliveryClass === DELIVERY_CLASS.INFRA_DOCS) {
    throw new Error("This branch is infra-docs and does not use preview handoff. Run: node scripts/bright-task.mjs handoff");
  }
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    throw new Error(`Blocked delivery paths cannot be handed off:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`);
  }
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Preview handoff requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const head = git("rev-parse", "HEAD");

  fetchAcceptedBaseAndBranch(branch);
  const remoteSha = git("rev-parse", `origin/${branch}`);
  if (remoteSha !== head) throw new Error(`HEAD ${head} is not pushed to origin/${branch} (${remoteSha}). Push before handoff.`);
  if (git("status", "--porcelain").trim()) throw new Error("Working tree is not clean. Commit or remove local changes before handoff.");
  if (!isAncestor(acceptedBaseRef(), head)) throw new Error(`${acceptedBaseRef()} is not an ancestor of ${head}.`);

  const run = findSuccessfulDeliveryRun(branch, head, ["public-guard", "checks", "temporal-worker-check", "deploy-preview"]);
  const slot = readPreviewSlot(branch, head);
  const url = previewUrlForSlot(slot);
  const receipt = { branch, commit: head, slot, url, runId: run.databaseId, verifiedAt: new Date().toISOString(), verifiedBy: "bright-task-preview-v1" };
  writePreviewReceipt(receipt);

  console.log(`${PREVIEW_SLOT_EMOJI[slot]} Preview`);
  console.log(`Branch: ${branch}`);
  console.log(`Commit: ${head}`);
  console.log(`Preview ${slot}: ${url}`);
  console.log(`GitHub Actions run: ${run.url ?? `https://github.com/sergobright/Bright-OS/actions/runs/${run.databaseId}`}`);
}

function deliveryHandoff(branchArg) {
  const classification = classifyDelivery(diffFromTaskBase());
  if (classification.deliveryClass === DELIVERY_CLASS.RUNTIME_PREVIEW) {
    previewHandoff(branchArg);
    return;
  }
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    throw new Error(`Blocked delivery paths cannot be handed off:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`);
  }
  if (classification.deliveryClass === DELIVERY_CLASS.NONE) {
    console.log("No Bright OS delivery work to hand off.");
    return;
  }

  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Delivery handoff requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const head = git("rev-parse", "HEAD");

  fetchAcceptedBaseAndBranch(branch);
  const remoteSha = git("rev-parse", `origin/${branch}`);
  if (remoteSha !== head) throw new Error(`HEAD ${head} is not pushed to origin/${branch} (${remoteSha}). Push before handoff.`);
  if (git("status", "--porcelain").trim()) throw new Error("Working tree is not clean. Commit or remove local changes before handoff.");
  const marker = readTaskMarker();
  if (marker?.base && !isAncestor(marker.base, head)) {
    throw new Error(`Task base ${marker.base} is not an ancestor of ${head}. Start a fresh task branch from ${acceptedBaseRef()}.`);
  }

  let pr = findInfraDocsPr(branch, head);
  if (pr?.state !== "MERGED") {
    ensureInfraDocsPr(branch);
    pr = findInfraDocsPr(branch, head) ?? pr;
  }
  const run = findSuccessfulDeliveryRun(branch, head, ["public-guard", "checks", "temporal-worker-check", "auto-merge-infra-docs"]);
  const receipt = {
    receiptType: DELIVERY_RECEIPT_VERSION,
    branch,
    commit: head,
    deliveryClass: classification.deliveryClass,
    classification,
    prNumber: pr?.number,
    prUrl: pr?.url,
    prState: pr?.state,
    runId: run.databaseId,
    runUrl: run.url ?? `https://github.com/sergobright/Bright-OS/actions/runs/${run.databaseId}`,
    verifiedAt: new Date().toISOString(),
    verifiedBy: "bright-task-delivery-v1",
  };
  writeDeliveryReceipt(receipt);

  console.log("Infra/docs delivery");
  console.log(`Branch: ${branch}`);
  console.log(`Commit: ${head}`);
  console.log(`GitHub Actions run: ${receipt.runUrl}`);
}

function classifyCli(args) {
  let base = acceptedBaseRef();
  let head = "HEAD";
  let githubOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--base") base = args[++index] ?? base;
    else if (args[index] === "--head") head = args[++index] ?? head;
    else if (args[index] === "--github-output") githubOutput = true;
  }
  const files = git("diff", "--name-only", `${base}...${head}`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const result = classifyDelivery(files, { base, head: git("rev-parse", head), branch: currentBranch() });
  if (githubOutput) writeGithubOutput(result);
  console.log(JSON.stringify(result, null, 2));
}

function requireDeliveryVerification(branchArg, shaArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Delivery verification requires codex/* branch, got: ${branch}`);
  const sha = shaArg ?? git("rev-parse", `origin/${branch}`);
  const receipt = readDeliveryReceipt();
  const validation = validateDeliveryReceipt(receipt, branch, sha);
  if (!validation.ok) throw new Error(validation.message);
  findSuccessfulDeliveryRun(branch, sha, ["public-guard", "checks", "temporal-worker-check", "auto-merge-infra-docs"]);
}

function requirePreviewVerification(branchArg, shaArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Preview verification requires codex/* branch, got: ${branch}`);
  const sha = shaArg ?? git("rev-parse", `origin/${branch}`);
  const receipt = readPreviewReceipt();
  const validation = validatePreviewReceipt(receipt, branch, sha);
  if (!validation.ok) throw new Error(validation.message);
}

function doctor(strict = false) {
  const state = deriveTaskState();
  console.log(JSON.stringify(state, null, 2));
  if (strict && !state.ok) process.exit(1);
}

function deriveTaskState() {
  const branch = currentBranch();
  const head = gitMaybe("rev-parse", "HEAD") ?? "";
  const status = gitMaybe("status", "--porcelain") ?? "";
  const marker = readTaskMarker();
  const previewReceipt = readPreviewReceipt();
  const deliveryReceipt = readDeliveryReceipt();
  const changedFiles = diffFromTaskBase();
  const commitsAhead = Number(gitMaybe("rev-list", "--count", `${acceptedBaseRef()}..HEAD`) ?? 0);
  const validation = CODEX_BRANCH_RE.test(branch)
    ? validateTaskBranch({ requireExpectedUpstream: false })
    : { ok: false, message: `Implementation work must run on codex/<task-slug>, got: ${branch || "(none)"}` };
  const reuse = validation.ok ? validateBranchReuse() : { ok: false, message: validation.message };
  const classification = classifyDelivery(changedFiles);
  const receiptValidation = validateHandoffReceipt({ classification, previewReceipt, deliveryReceipt, branch, head });
  const markerValid = validateTaskMarker(marker, branch).ok && validateTaskThread(marker, currentThreadId()).ok;
  const completedWithReceipt = Boolean(
    head &&
      markerValid &&
      receiptValidation.ok &&
      CODEX_BRANCH_RE.test(branch),
  );
  const hasImplementationWork = Boolean(status.trim() || marker?.writeIntentAt || changedFiles.length || commitsAhead > 0);
  const remoteSha = CODEX_BRANCH_RE.test(branch) ? gitMaybe("rev-parse", `origin/${branch}`) : "";
  const pushed = Boolean(remoteSha && remoteSha === head);
  const phase = deriveTaskPhase({ markerValid, marker, status, commitsAhead, changedFiles, pushed, receiptValidation });
  const base = {
    ok: true,
    phase,
    branch,
    head,
    validation,
    reuse,
    marker,
    markerValid,
    classification,
    receipt: classification.deliveryClass === DELIVERY_CLASS.INFRA_DOCS ? deliveryReceipt : previewReceipt,
    receiptValidation,
    status,
    changedFiles,
    commitsAhead,
    pushed,
    hasImplementationWork,
  };

  if (status.trim()) {
    return {
      ...base,
      ok: false,
      message: `Bright OS task is not ready for handoff: working tree is not clean.\n\n${status.trim()}\n\nCommit, push, and verify delivery with: node scripts/bright-task.mjs handoff`,
    };
  }
  if (!hasImplementationWork) return base;
  if (!validation.ok && !completedWithReceipt) return { ...base, ok: false, message: validation.message };
  if (!reuse.ok && !completedWithReceipt) return { ...base, ok: false, message: reuse.message };
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    return {
      ...base,
      ok: false,
      message: `Bright OS delivery contains blocked paths:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`,
    };
  }
  if (!receiptValidation.ok) {
    return {
      ...base,
      ok: false,
      message: `Bright OS implementation work cannot be handed off before delivery verification.\n\n${receiptValidation.message}\n\nRun: node scripts/bright-task.mjs handoff`,
    };
  }
  return base;
}

function deriveTaskPhase({ markerValid, marker, status, commitsAhead, changedFiles, pushed, receiptValidation }) {
  if (receiptValidation.ok) return "handoff-receipt";
  if (pushed) return "pushed";
  if (!status.trim() && commitsAhead > 0) return "committed";
  if (status.trim() || marker?.writeIntentAt || changedFiles.length) return "write-intent";
  if (markerValid) return "task-started";
  return "no-task";
}

function validatePreviewReceipt(receipt, branch, head) {
  if (!receipt) return { ok: false, message: "Preview handoff receipt is missing." };
  if (receipt.branch !== branch) return { ok: false, message: `Preview receipt is for ${receipt.branch || "(missing)"}, not ${branch}.` };
  if (receipt.commit !== head) return { ok: false, message: `Preview receipt is for ${receipt.commit || "(missing)"}, not ${head}.` };
  if (!/^[A-E]$/.test(receipt.slot ?? "")) return { ok: false, message: "Preview receipt has no valid slot." };
  if (!receipt.url || !String(receipt.url).startsWith("https://")) return { ok: false, message: "Preview receipt has no valid URL." };
  if (!receipt.runId) return { ok: false, message: "Preview receipt has no GitHub Actions run id." };
  if (!receipt.verifiedAt) return { ok: false, message: "Preview receipt has no verification timestamp." };
  return { ok: true };
}

function validateHandoffReceipt({ classification, previewReceipt, deliveryReceipt, branch, head }) {
  if (classification.deliveryClass === DELIVERY_CLASS.NONE) return { ok: true };
  if (classification.deliveryClass === DELIVERY_CLASS.INFRA_DOCS) {
    return validateDeliveryReceipt(deliveryReceipt, branch, head, classification.deliveryClass);
  }
  return validatePreviewReceipt(previewReceipt, branch, head);
}

function validateDeliveryReceipt(receipt, branch, head, deliveryClass = DELIVERY_CLASS.INFRA_DOCS) {
  if (!receipt) return { ok: false, message: "Delivery handoff receipt is missing." };
  if (receipt.receiptType !== DELIVERY_RECEIPT_VERSION) return { ok: false, message: "Delivery receipt type is not valid." };
  if (receipt.branch !== branch) return { ok: false, message: `Delivery receipt is for ${receipt.branch || "(missing)"}, not ${branch}.` };
  if (receipt.commit !== head) return { ok: false, message: `Delivery receipt is for ${receipt.commit || "(missing)"}, not ${head}.` };
  if (receipt.deliveryClass !== deliveryClass) return { ok: false, message: `Delivery receipt class is ${receipt.deliveryClass || "(missing)"}, not ${deliveryClass}.` };
  if (!receipt.runId) return { ok: false, message: "Delivery receipt has no GitHub Actions run id." };
  if (!receipt.verifiedAt) return { ok: false, message: "Delivery receipt has no verification timestamp." };
  return { ok: true };
}

function validateTaskBranch({ requireExpectedUpstream }) {
  const branch = currentBranch();
  if (!branch) return { ok: false, message: "Detached HEAD is not allowed for Bright OS implementation work." };
  if (!CODEX_BRANCH_RE.test(branch)) {
    return { ok: false, message: `Implementation work must run on codex/<task-slug>, got: ${branch}` };
  }
  if (!gitMaybe("rev-parse", "--verify", acceptedBaseRef())) {
    return { ok: false, message: `${acceptedBaseRef()} is missing locally. Run: git fetch origin ${acceptedBaseBranch()}` };
  }

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream === acceptedBaseRef()) {
    return { ok: false, message: `${branch} tracks ${acceptedBaseRef()}. Recreate it with --no-track and push with: git push -u origin HEAD` };
  }
  if (requireExpectedUpstream && upstream && upstream !== `origin/${branch}`) {
    return { ok: false, message: `${branch} tracks ${upstream}. Expected origin/${branch} or no upstream before first push.` };
  }
  if (!isAncestor(acceptedBaseRef(), "HEAD")) {
    return { ok: false, message: `${acceptedBaseRef()} is not an ancestor of HEAD. Start the task from ${acceptedBaseRef()}.` };
  }

  return { ok: true };
}

function validateBranchReuse() {
  const branch = currentBranch();
  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const marker = readTaskMarker();
  const markerValidation = validateTaskMarker(marker, branch);
  if (!markerValidation.ok) {
    return {
      ok: false,
      message:
        `${markerValidation.message}\n\n` +
        `${taskStartGuidance()}\n` +
        `Only for a same-thread follow-up run: node scripts/bright-task.mjs follow-up`,
    };
  }
  const threadValidation = validateTaskThread(marker, currentThreadId());
  if (!threadValidation.ok) {
    return {
      ok: false,
      message:
        `${threadValidation.message}\n\n` +
        taskStartGuidance(),
    };
  }
  const currentAcceptedBase = git("rev-parse", acceptedBaseRef());
  const freshStartedBranch =
    marker?.mode === "new" &&
    marker?.base &&
    isAncestor(marker.base, currentAcceptedBase) &&
    !upstream &&
    !remoteBranchKnown(branch);
  if (remoteBranchAccepted(branch) || (isAncestor("HEAD", acceptedBaseRef()) && !freshStartedBranch)) {
    return {
      ok: false,
      message:
        `Bright OS refuses to continue ${branch} because it is already included in ${acceptedBaseRef()}.\n\n` +
        taskStartGuidance(),
    };
  }
  if (upstream === `origin/${branch}` && marker?.branch !== branch) {
    return {
      ok: false,
      message:
        `Bright OS refuses to reuse an existing pushed task branch without an explicit local marker.\n\n` +
        `${taskStartGuidance()}\n` +
        `Only for a same-thread follow-up run: node scripts/bright-task.mjs follow-up`,
    };
  }
  return { ok: true };
}

function validateTaskMarker(marker, branch) {
  if (!marker) return { ok: false, message: "Bright OS task marker is missing; this checkout was not started with scripts/bright-task-start.sh." };
  if (marker.branch !== branch) return { ok: false, message: `Bright OS task marker is for ${marker.branch || "(missing)"}, not ${branch}.` };
  if (marker.mode !== "new" && marker.mode !== "follow-up") {
    return { ok: false, message: `Bright OS task marker mode ${marker.mode || "(missing)"} is not valid for project-file writes.` };
  }
  if (!/^[0-9a-f]{40}$/.test(marker.base ?? "")) {
    return { ok: false, message: `Bright OS task marker has no valid ${acceptedBaseRef()} base; use the official task starter or follow-up command.` };
  }
  if (!marker.createdAt || Number.isNaN(Date.parse(marker.createdAt))) {
    return { ok: false, message: "Bright OS task marker has no valid creation timestamp; use the official task starter or follow-up command." };
  }
  return { ok: true };
}

function validateTaskThread(marker, threadId) {
  if (!threadId) return { ok: true };
  if (!marker?.threadId) {
    return { ok: false, message: "Bright OS task marker has no Codex thread id, so this thread cannot change project files on this branch." };
  }
  if (marker.threadId !== threadId) {
    return { ok: false, message: `Bright OS task branch belongs to Codex thread ${marker.threadId}, not current thread ${threadId}.` };
  }
  return { ok: true };
}

function validatePushUpdate(line, currentBranchName = "", { isAcceptedRemote = () => false } = {}) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
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
  if (remoteSha && remoteSha !== ZERO_SHA && isAcceptedRemote(remoteSha)) {
    throw new Error(`${remoteRef} is already included in ${acceptedBaseRef()}. Start a new task branch instead of reusing an accepted branch.`);
  }
}

function taskStartGuidance(parent = ".codex-worktrees") {
  return (
    `Run the installed starter with escalation: /srv/opt/node-v22.16.0/bin/node /srv/opt/bright-os-codex-plugins/plugins/bright-os-guard/hooks/bright-os-guard.mjs start <task-slug>\n` +
    `In Codex Desktop, request sandbox_permissions=require_escalated because the starter updates Git worktree metadata and creates an isolated worktree under ${parent}.\n` +
    `Do not create or switch to a manual fallback branch, and do not use a repo-local starter from a stale checkout.`
  );
}

function taskWorktreeParent(root) {
  const parent = path.dirname(root);
  if (path.basename(parent) === ".codex-worktrees" || path.basename(parent) === "bright-os-worktrees") return parent;
  return path.join(root, ".codex-worktrees");
}

function acceptedBaseBranch() {
  return process.env.BRIGHT_OS_ACCEPT_BASE || DEFAULT_ACCEPT_BASE_BRANCH;
}

function acceptedBaseRef() {
  return `origin/${acceptedBaseBranch()}`;
}

function acceptedBaseFetchRefspec() {
  const branch = acceptedBaseBranch();
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

function dependencySourceRoot(root) {
  const parent = path.dirname(root);
  if (path.basename(parent) === ".codex-worktrees") {
    const canonical = path.dirname(parent);
    if (fs.existsSync(path.join(canonical, "package.json"))) return canonical;
  }
  if (path.basename(parent) === "bright-os-worktrees") {
    const canonical = path.join(path.dirname(parent), "bright-os");
    if (fs.existsSync(path.join(canonical, "package.json"))) return canonical;
  }
  return root;
}

function findOpenTaskForThread(parent, threadId, branchToCreate, isAccepted = taskPathAccepted) {
  if (!threadId || !fs.existsSync(parent)) return null;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskPath = path.join(parent, entry.name);
    let marker;
    try {
      marker = readJson(path.join(taskPath, ".bright-task", "task.json"));
    } catch {
      continue;
    }
    if (marker?.threadId !== threadId) continue;
    if (!CODEX_BRANCH_RE.test(marker.branch ?? "") || marker.branch === branchToCreate) continue;
    if (isAccepted(taskPath, marker)) continue;
    return { branch: marker.branch, path: taskPath };
  }
  return null;
}

function taskPathAccepted(taskPath) {
  const marker = readJson(path.join(taskPath, ".bright-task", "task.json"));
  const receipt = readJson(path.join(taskPath, ".bright-task", "delivery-handoff.json"));
  if (
    receipt?.receiptType === DELIVERY_RECEIPT_VERSION &&
    receipt?.branch === marker?.branch &&
    receipt?.prState === "MERGED"
  ) {
    return true;
  }
  const head = gitMaybeIn(taskPath, "rev-parse", "HEAD");
  return head ? isAncestor(head, acceptedBaseRef()) : true;
}

function linkDependencyDirs(sourceRoot, targetRoot, dependencyDirs = DEPENDENCY_DIRS) {
  const linked = [];
  for (const relativePath of dependencyDirs) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetRoot, relativePath);
    if (!fs.existsSync(source) || fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, "dir");
    linked.push(relativePath);
  }
  return linked;
}

function enableGitHooks(root) {
  const result = spawnSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"], { encoding: "utf8", env: gitEnv() });
  if (result.status !== 0) throw new Error(`git config core.hooksPath failed:\n${result.stderr || result.stdout || "(no output)"}`);
}

function ensureTaskWorktreeWritable(parent, target) {
  const probe = fs.existsSync(parent) ? parent : path.dirname(parent);
  fs.accessSync(probe, fs.constants.W_OK);
  if (fs.existsSync(target)) throw new Error(`Worktree target already exists: ${target}`);
}

function isWritePermissionError(error) {
  return ["EACCES", "EPERM", "EROFS"].includes(error?.code);
}

function parseHookInput(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function analyzeHookInput(source) {
  const input = typeof source === "string" ? parseHookInput(source) : source;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, write: true, reason: "Bright OS hook input was not recognized; blocking fail-closed." };
  }

  const calls = collectToolCalls(input);
  if (!calls.length) {
    return { ok: false, write: true, reason: "Bright OS hook tool shape was not recognized; blocking fail-closed." };
  }

  let write = false;
  let officialTaskStarter = false;
  for (const call of calls) {
    const classified = classifyToolCall(call);
    if (!classified.ok) return { ...classified, write: true };
    if (classified.blockedReason) return { ok: true, write: true, blockedReason: classified.blockedReason };
    if (classified.manualCodexBranch) return { ok: true, write: true, manualCodexBranch: true };
    officialTaskStarter ||= Boolean(classified.officialTaskStarter);
    write ||= Boolean(classified.write);
  }
  return { ok: true, write, officialTaskStarter: officialTaskStarter && !write, manualCodexBranch: false };
}

function collectToolCalls(input) {
  const tool = toolNameFrom(input);
  const toolInput = toolInputFrom(input);
  if (tool === "multi_tool_use.parallel" || tool.endsWith(".multi_tool_use.parallel")) {
    const nested = Array.isArray(toolInput?.tool_uses) ? toolInput.tool_uses : Array.isArray(input?.tool_uses) ? input.tool_uses : [];
    return nested.flatMap((call) => collectToolCalls(call));
  }
  return tool ? [{ tool, input: toolInput }] : [];
}

function toolNameFrom(input) {
  for (const key of ["tool_name", "toolName", "tool", "name", "recipient_name"]) {
    if (typeof input?.[key] === "string" && input[key].trim()) return input[key].trim();
  }
  return "";
}

function toolInputFrom(input) {
  for (const key of ["tool_input", "toolInput", "input", "parameters", "arguments", "args"]) {
    if (input && typeof input[key] === "object" && input[key]) return input[key];
  }
  return input && typeof input === "object" ? input : {};
}

function classifyToolCall({ tool, input }) {
  const nestedName = typeof input?.name === "string" ? input.name : "";
  const effectiveTool = tool === "custom_tool_call" && nestedName ? nestedName : tool;
  if (isPatchTool(effectiveTool)) return { ok: true, write: true };
  if (isShellTool(effectiveTool)) {
    const commandText = String(input?.cmd ?? input?.command ?? "");
    if (!commandText.trim()) return { ok: false, reason: `Shell tool ${effectiveTool} did not include a command; blocking fail-closed.` };
    if (isUnsafeRepoTaskStarterCommand(commandText)) {
      return { ok: true, write: true, blockedReason: `Repo-local task starter is stale in this checkout.\n\n${taskStartGuidance()}` };
    }
    if (isManualCodexBranchCommand(commandText)) return { ok: true, write: true, manualCodexBranch: true };
    if (isOfficialTaskStarterCommand(commandText)) return { ok: true, write: false, officialTaskStarter: true };
    return { ok: true, write: isWriteLikeCommand(commandText) };
  }
  return { ok: false, reason: `Bright OS does not recognize hook tool ${tool}; blocking fail-closed.` };
}

function isPatchTool(tool) {
  return tool === "apply_patch" || tool.endsWith(".apply_patch") || tool === "Edit" || tool === "Write";
}

function isShellTool(tool) {
  return tool === "exec_command" || tool === "Bash" || tool.endsWith(".exec_command");
}

function isWriteLikeCommand(commandText) {
  return !isOfficialTaskStarterCommand(commandText) && !isReadOnlyShellCommand(commandText);
}

function isOfficialTaskStarterCommand(commandText) {
  const segments = splitShellSegments(commandText);
  return segments.length > 0 && segments.every((segment) =>
    isInstalledTaskStarterSegment(segment) ||
      (isRepoTaskStarterSegment(segment) && repoTaskStarterIsStable()),
  );
}

function isUnsafeRepoTaskStarterCommand(commandText) {
  return splitShellSegments(commandText).some((segment) => isRepoTaskStarterSegment(segment) && !repoTaskStarterIsStable());
}

function isInstalledTaskStarterSegment(segment) {
  return /^\/srv\/opt\/node-v22\.16\.0\/bin\/node\s+\/srv\/opt\/bright-os-codex-plugins\/plugins\/bright-os-guard\/hooks\/bright-os-guard\.mjs\s+start\s+[a-z0-9][a-z0-9._-]*$/.test(segment);
}

function isRepoTaskStarterSegment(segment) {
  return /^(?:scripts\/bright-task-start\.sh|(?:\S+\/)?scripts\/bright-task-start\.sh|scripts\/use-node22\.sh\s+node\s+scripts\/bright-task\.mjs\s+start|node\s+scripts\/bright-task\.mjs\s+start)\s+[a-z0-9][a-z0-9._-]*$/.test(segment);
}

function repoTaskStarterIsStable() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return false;
  const starter = path.join(root, "scripts", "bright-task-start.sh");
  if (!fs.existsSync(starter)) return false;
  return fs.readFileSync(starter, "utf8").includes("/srv/opt/bright-os-codex-plugins/plugins/bright-os-guard/hooks/bright-os-guard.mjs start");
}

function isReadOnlyShellCommand(commandText) {
  const segments = splitShellSegments(commandText);
  return segments.length > 0 && segments.every(isReadOnlyShellSegment);
}

function splitShellSegments(commandText) {
  const text = String(commandText ?? "").trim();
  if (!text) return [];
  if (/[<>`$]/.test(text)) return [text];
  return text
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isReadOnlyShellSegment(segment) {
  if (/[<>`$]/.test(segment)) return false;
  return [
    /^pwd$/,
    /^ls(?:\s+[-A-Za-z0-9_./*=:@]+)*$/,
    /^rg(?:\s+[-A-Za-z0-9_./*=:@]+)*(?:\s+"[^"]*")?(?:\s+'[^']*')?$/,
    /^(?:cat|nl|wc|head|tail)(?:\s+[-A-Za-z0-9_./*=:@]+)*$/,
    /^sed\s+-n\b.+$/,
    /^git\s+(?:status|diff|log|show|rev-parse|ls-files|merge-base)(?:\s+.+)?$/,
    /^git\s+branch\s+--show-current$/,
    /^git\s+config\s+(?:--get|get)\s+[A-Za-z0-9_.-]+$/,
    /^node\s+scripts\/bright-task\.mjs\s+classify(?:\s+--(?:base|head)\s+[-A-Za-z0-9_./:@]+|\s+--github-output)*$/,
    /^scripts\/use-node22\.sh\s+node\s+scripts\/bright-task\.mjs\s+classify(?:\s+--(?:base|head)\s+[-A-Za-z0-9_./:@]+|\s+--github-output)*$/,
    /^node\s+scripts\/bright-task\.mjs\s+doctor(?:\s+--strict)?$/,
    /^scripts\/use-node22\.sh\s+node\s+scripts\/bright-task\.mjs\s+doctor(?:\s+--strict)?$/,
  ].some((pattern) => pattern.test(segment));
}

function isManualCodexBranchCommand(commandText) {
  return isManualBranchCommand(commandText);
}

function isManualBranchCommand(commandText) {
  return splitShellSegments(commandText).some((segment) =>
    /^git\s+(?:switch|checkout)\b/.test(segment) ||
    /^git\s+branch\b(?!\s+--show-current$)/.test(segment) ||
    /^git\s+worktree\b/.test(segment),
  );
}

function isSensitivePath(file) {
  return PROTECTED_PATH_RE.test(file);
}

function classifyDelivery(files, { base = acceptedBaseRef(), head = "HEAD", branch = currentBranch() } = {}) {
  const paths = { blocked: [], docs: [], infra: [], runtime: [], unknown: [] };
  for (const file of files) paths[deliveryClassForFile(file)].push(file);

  const deliveryClass = paths.blocked.length
    ? DELIVERY_CLASS.BLOCKED
    : files.length === 0
      ? DELIVERY_CLASS.NONE
      : paths.runtime.length || paths.unknown.length
        ? DELIVERY_CLASS.RUNTIME_PREVIEW
        : DELIVERY_CLASS.INFRA_DOCS;
  const requiresPreview = deliveryClass === DELIVERY_CLASS.RUNTIME_PREVIEW;
  const requiresDevDeploy = false;
  const autoMerge = deliveryClass === DELIVERY_CLASS.INFRA_DOCS;

  return {
    schemaVersion: 1,
    classifier: "bright-delivery-classify-v1",
    branch,
    base,
    head,
    deliveryClass,
    requires: {
      preview: requiresPreview,
      devDeploy: requiresDevDeploy,
      autoMerge,
    },
    mixed: paths.runtime.length > 0 && (paths.docs.length > 0 || paths.infra.length > 0),
    fallback: paths.unknown.length ? "unknown_path" : null,
    paths,
  };
}

function deliveryClassForFile(file) {
  if (isSensitivePath(file)) return "blocked";
  if (
    file === "README.md" ||
    file === "AGENTS.md" ||
    file.endsWith(".md") ||
    file.startsWith("docs/") ||
    file.startsWith("memory-bank/") ||
    file.startsWith("openspec/")
  ) {
    return "docs";
  }
  if (
    file === ".gitignore" ||
    file === ".github/workflows/bright-os-delivery.yml" ||
    file === ".codex/hooks.json" ||
    file.startsWith("deploy/ansible/") ||
    file.startsWith(".githooks/") ||
    file.startsWith("scripts/bright-") ||
    file.startsWith("services/bright_os_temporal/") ||
    [
      "deploy/scripts/classify-delivery.mjs",
      "deploy/scripts/accept-preview.sh",
      "deploy/scripts/accepted-preview-branches.mjs",
      "deploy/scripts/ci-ssh-complete-accepted-previews.sh",
      "deploy/scripts/ci-ssh-deploy.sh",
      "deploy/scripts/ci-ssh-promote-deployment.sh",
      "deploy/scripts/ci-ssh-release-slot.sh",
      "deploy/scripts/ci-ssh-sync-main-checkout.sh",
      "deploy/scripts/deploy-branch.sh",
      "deploy/scripts/detect-native-apk-change.mjs",
      "deploy/scripts/promote-accepted-deployment.sh",
      "deploy/scripts/promote-deployment.mjs",
      "deploy/scripts/sync-local-main-checkout.sh",
    ].includes(file)
  ) {
    return "infra";
  }
  if (
    file.startsWith("apps/bright_os_app/") ||
    file.startsWith("apps/bright_os_site/") ||
    file.startsWith("services/bright_os_api/") ||
    file.startsWith("assets/brand/")
  ) {
    return "runtime";
  }
  return "unknown";
}

function writeGithubOutput(classification) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(
    outputPath,
    [
      `delivery_class=${classification.deliveryClass}`,
      `requires_preview=${classification.requires.preview ? "true" : "false"}`,
      `requires_dev_deploy=${classification.requires.devDeploy ? "true" : "false"}`,
      `auto_merge=${classification.requires.autoMerge ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
}

function findSuccessfulDeliveryRun(branch, sha, requiredJobs = ["public-guard", "checks", "temporal-worker-check", "deploy-preview"]) {
  const runs = runJson(["gh", "run", "list", "--workflow", "Bright OS delivery", "--branch", branch, "--event", "push", "--limit", "20", "--json", "databaseId,headSha,status,conclusion,url"]);
  const run = runs.find((candidate) => candidate.headSha === sha);
  if (!run) throw new Error(`No Bright OS delivery push run found for ${branch}@${sha}.`);
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`Delivery run ${run.databaseId} is ${run.status}/${run.conclusion}. Wait or fix CI before handoff.`);
  }

  const details = runJson(["gh", "run", "view", String(run.databaseId), "--json", "jobs"]);
  const jobs = new Map((details.jobs ?? []).map((job) => [job.name, job.conclusion]));
  for (const job of requiredJobs) {
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

function diffFromAcceptedBase() {
  return git("diff", "--name-only", `${acceptedBaseRef()}...HEAD`)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function diffFromTaskBase() {
  const marker = readTaskMarker();
  const base = marker?.base && gitMaybe("rev-parse", "--verify", `${marker.base}^{commit}`) ? marker.base : acceptedBaseRef();
  return (gitMaybe("diff", "--name-only", `${base}...HEAD`) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchAcceptedBase() {
  git("fetch", "origin", acceptedBaseFetchRefspec());
}

function fetchAcceptedBaseAndBranch(branch) {
  git("fetch", "origin", acceptedBaseFetchRefspec(), `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
}

function remoteBranchExists(branch) {
  return spawnGit(["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" }).status === 0;
}

function remoteBranchAccepted(branch) {
  const remote = `origin/${branch}`;
  if (!remoteBranchKnown(branch)) return false;
  return isAncestor(remote, acceptedBaseRef());
}

function remoteBranchKnown(branch) {
  return Boolean(gitMaybe("rev-parse", "--verify", `origin/${branch}`));
}

function markWriteIntent() {
  const root = git("rev-parse", "--show-toplevel");
  const marker = readTaskMarker();
  writeTaskMarker(root, withThreadId({ ...marker, branch: currentBranch(), writeIntentAt: new Date().toISOString() }));
}

function withThreadId(marker) {
  const threadId = currentThreadId();
  return threadId ? { ...marker, threadId } : marker;
}

function currentThreadId() {
  return process.env.CODEX_THREAD_ID || "";
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

function readDeliveryReceipt() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".bright-task", "delivery-handoff.json"));
}

function writePreviewReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".bright-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview-handoff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function writeDeliveryReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".bright-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "delivery-handoff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runRequired(args, message) {
  const result = spawnSync(args[0], args.slice(1), { cwd: git("rev-parse", "--show-toplevel"), stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(message);
}

function ensureInfraDocsPr(branch) {
  const result = spawnSync("deploy/scripts/accept-preview.sh", [branch], {
    cwd: git("rev-parse", "--show-toplevel"),
    stdio: "inherit",
    env: { ...process.env, BRIGHT_OS_ACCEPT_BASE: acceptedBaseBranch(), BRIGHT_OS_ACCEPT_INFRA_DOCS_ONLY: "true" },
  });
  if (result.status !== 0) throw new Error(`Failed to create or enable infra/docs PR for ${branch}.`);
}

function findInfraDocsPr(branch, head) {
  const prs = runJson(["gh", "pr", "list", "--base", acceptedBaseBranch(), "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid,labels,mergedAt"]);
  return prs.find((pr) =>
    pr.headRefOid === head &&
    Array.isArray(pr.labels) &&
    pr.labels.some((label) => label?.name === "bright-delivery:infra-docs"),
  ) ?? null;
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

function gitMaybeIn(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  return result.status === 0 ? result.stdout.trim() : null;
}

function spawnGit(args, options = {}) {
  return spawnSync("git", args, { cwd: process.cwd(), env: gitEnv(), ...options });
}

function gitEnv() {
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...env } = process.env;
  return env;
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
