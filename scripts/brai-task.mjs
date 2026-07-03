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
  "apps/brai_app/node_modules",
  "services/brai_api/node_modules",
  "services/brai_temporal/node_modules",
];
const WORKSPACE_WRITABLE_DIRS = [
  ".brai-task",
  ".cache",
  ".config",
  ".npm",
  ...DEPENDENCY_DIRS,
  ".vite-temp",
  ".next",
  "out",
  "output",
  "output/playwright",
  ".playwright",
  ".playwright-browsers",
  "test-results",
  "landing",
  "apps/brai_app/.next",
  "apps/brai_app/out",
  "apps/brai_app/output",
  "apps/brai_app/output/playwright",
  "apps/brai_app/test-results",
  "apps/brai_app/node_modules/@capacitor/android/capacitor/build",
  "apps/brai_app/android/.gradle",
];

const ZERO_SHA = "0000000000000000000000000000000000000000";
const PREVIEW_SLOT_EMOJI = { A: "🅰️", B: "🅱️", C: "🅲", D: "🅳", E: "🅴" };
const DELIVERY_RECEIPT_VERSION = "brai-delivery-handoff-v1";
const ACCEPTANCE_RECEIPT_VERSION = "brai-acceptance-v1";
const RELEASE_NOTES_VERSION = "brai-release-notes-v1";
const DEFAULT_INFRA_DOCS_HANDOFF_WAIT_MS = 180000;
const DEFAULT_INFRA_DOCS_HANDOFF_POLL_MS = 10000;
const DELIVERY_CLASS = {
  BLOCKED: "blocked",
  INFRA_DOCS: "infra-docs",
  NONE: "none",
  RUNTIME_PREVIEW: "runtime-preview",
  TECHNICAL_NO_PREVIEW: "technical-no-preview",
};
const NO_PREVIEW_DELIVERY_LABELS = new Set(["brai-delivery:infra-docs", "brai-delivery:technical-no-preview"]);
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
  deliveryHandoff,
  deliveryClassForFile,
  dependencySourceRoot,
  deriveTaskState,
  enableGitHooks,
  isManualCodexBranchCommand,
  isManualBranchCommand,
  isTaskBaseRefreshCommand,
  isBlockingAcceptanceReceipt,
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
  validateReleaseNotes,
  validatePushUpdate,
  validatePreviewReceipt,
  accessContract,
  workspacePreflight,
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
      case "acceptance-reconcile":
        acceptanceReconcile(args[0]);
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
      case "release-notes":
        writeReleaseNotesCli(args);
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
      case "preflight":
        preflight(args.includes("--strict"));
        break;
      case "access-contract":
        accessContract(args);
        break;
      default:
        throw new Error("usage: brai-task.mjs start <slug>|follow-up [branch]|acceptance-reconcile [branch]|pre-tool-use|pre-commit|pre-push <remote>|stop|classify [--base <ref>] [--head <ref>] [--github-output]|handoff [branch]|preview [branch]|release-notes --short <text> --details <text> --reason <text>|require-delivery [branch] [sha]|require-preview [branch] [sha]|doctor [--strict]|preflight [--strict]|access-contract --local|--server");
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
  const parent = process.env.BRAI_WORKTREE_ROOT ?? taskWorktreeParent(root);
  const branch = `codex/${slug}`;
  const target = path.join(parent, slug);

  if (fs.existsSync(target)) throw new Error(`Worktree target already exists: ${target}`);
  try {
    ensureTaskWorktreeWritable(parent, target);
  } catch (error) {
    if (isWritePermissionError(error)) {
      throw new Error(`Cannot create Brai task worktree at ${target} from this sandbox.\n\n${taskStartGuidance(parent)}`);
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
      throw new Error(`Cannot create Brai task worktree at ${target} from this sandbox.\n\n${taskStartGuidance(parent)}`);
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
    base: marker.base,
    createdAt: new Date().toISOString(),
  }));
  console.log(`Marked explicit follow-up for ${branch}`);
}

function acceptanceReconcile(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Acceptance reconcile requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) throw new Error(validation.message);
  const markerValidation = validateTaskMarker(readTaskMarker(), branch);
  if (!markerValidation.ok) throw new Error(`${markerValidation.message}\n\n${taskStartGuidance()}`);
  const threadValidation = validateTaskThread(readTaskMarker(), currentThreadId());
  if (!threadValidation.ok) throw new Error(`${threadValidation.message}\n\n${taskStartGuidance()}`);
  if (git("status", "--porcelain").trim()) throw new Error("Working tree must be clean before acceptance reconcile.");

  fetchAcceptedBase();
  fetchTaskBranch(branch);
  const head = git("rev-parse", "HEAD");
  const remoteHead = git("rev-parse", `origin/${branch}`);
  if (head !== remoteHead) throw new Error(`HEAD ${head} is not origin/${branch} (${remoteHead}). Push or reset before acceptance reconcile.`);

  const receipt = readAcceptanceReceipt();
  if (receipt?.receiptType !== ACCEPTANCE_RECEIPT_VERSION || receipt.branch !== branch) {
    throw new Error("Acceptance reconcile requires a local .brai-task/acceptance.json receipt for this branch.");
  }
  if (receipt.status !== "reconcile_required" && receipt.status !== "acceptance_started") {
    throw new Error(`Acceptance receipt status is ${receipt.status || "(missing)"}, not reconcile_required.`);
  }

  const pr = findAcceptancePr(branch, head);
  if (!pr) throw new Error(`No open acceptance PR into ${acceptedBaseBranch()} found for ${branch}@${head}.`);
  if (receipt.prNumber && String(receipt.prNumber) !== String(pr.number)) {
    throw new Error(`Acceptance receipt PR #${receipt.prNumber} does not match open PR #${pr.number}.`);
  }
  if (receipt.status === "acceptance_started" && pr.mergeStateStatus !== "DIRTY" && pr.mergeStateStatus !== "BEHIND") {
    throw new Error(`Acceptance PR #${pr.number} mergeStateStatus is ${pr.mergeStateStatus || "(missing)"}, not DIRTY/BEHIND. Rerun accept-preview instead.`);
  }

  writeAcceptanceReceipt({
    ...receipt,
    branch,
    commit: head,
    baseBranch: acceptedBaseBranch(),
    prNumber: pr.number,
    prUrl: pr.url,
    status: "reconcile_started",
    reconcileStartedAt: new Date().toISOString(),
  });

  const result = spawnGit(["merge", "--no-ff", "--no-edit", acceptedBaseRef()], { stdio: "inherit" });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Acceptance reconcile started for ${branch}, but merge conflicts remain.\n\n` +
        `Resolve conflicts, commit the merge on ${branch}, push origin HEAD, rerun preview handoff, then rerun deploy/scripts/accept-preview.sh ${branch}.`,
    );
  }
  console.log(`Acceptance reconcile merged ${acceptedBaseRef()} into ${branch}.`);
  console.log("Push the same branch, rerun preview handoff, then rerun accept-preview.");
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
    return blockHook("Brai cannot verify the current Codex thread id; blocking project-file writes fail-closed.");
  }
  if (analysis.officialTaskStarter) return allowHook();
  if (analysis.officialAcceptanceReconcile) return allowHook();

  const validation = validateTaskBranch({ requireExpectedUpstream: false });
  if (!validation.ok) {
    return blockHook(`Brai blocks project-file writes before a valid task branch exists.\n\n${validation.message}\n\n${taskStartGuidance()}`);
  }

  const reuse = validateBranchReuse({ allowRemote: false });
  if (!reuse.ok) return blockHook(reuse.message);

  markWriteIntent();
  return allowHook();
}

function preCommit() {
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
  if (remoteName !== "origin") throw new Error(`Brai task branches must push to origin, got: ${remoteName || "(empty)"}`);

  const validation = validateTaskBranch({ requireExpectedUpstream: true });
  if (!validation.ok) throw new Error(validation.message);
  const reuse = validateBranchReuse();
  if (!reuse.ok) throw new Error(reuse.message);

  const branch = currentBranch();
  const updates = readStdin()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of updates) validatePushUpdate(line, branch);

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream && upstream !== `origin/${branch}`) {
    throw new Error(`Wrong upstream: ${upstream}. Expected origin/${branch}. Fix with: git push -u origin HEAD`);
  }
  const baseRef = taskBaseRefForBranch(branch);
  if (!isAncestor(baseRef, "HEAD")) {
    throw new Error(`Task base ${baseRef} is not an ancestor of HEAD. Start a fresh task branch instead of rebasing or merging ${acceptedBaseRef()}.`);
  }

  const changed = diffFromAcceptedBase();
  if (changed.some((file) => file.startsWith("scripts/brai-") || file.startsWith(".codex/") || file.startsWith(".githooks/"))) {
    runRequired(["npm", "run", "task:test"], "Brai task guard changes require passing npm run task:test before push.");
  }
  if (changed.some((file) => file.startsWith("services/brai_temporal/") || file === ".github/workflows/brai-delivery.yml")) {
    runRequired(["npm", "run", "temporal:test"], "Temporal-sensitive changes require passing npm run temporal:test before push.");
  }
  if (changed.some((file) => file.startsWith("openspec/"))) {
    runRequired(["npm", "run", "openspec:validate"], "OpenSpec changes require passing npm run openspec:validate before push.");
  }
  runRequired(["npm", "run", "public:guard"], "Brai public guard must pass before push.");
}

function stopHook() {
  if (!gitMaybe("rev-parse", "--show-toplevel")) return allowHook();

  const state = deriveTaskState();
  if (!state.ok) return blockHook(state.message);
  return allowHook();
}

function previewHandoff(branchArg) {
  const classification = classifyDelivery(diffFromTaskBase());
  if (isNoPreviewDeliveryClass(classification.deliveryClass)) {
    throw new Error(`This branch is ${classification.deliveryClass} and does not use preview handoff. Run: node scripts/brai-task.mjs handoff`);
  }
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    throw new Error(`Blocked delivery paths cannot be handed off:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`);
  }
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Preview handoff requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const head = git("rev-parse", "HEAD");

  fetchTaskBranch(branch);
  const remoteSha = git("rev-parse", `origin/${branch}`);
  if (remoteSha !== head) throw new Error(`HEAD ${head} is not pushed to origin/${branch} (${remoteSha}). Push before handoff.`);
  if (git("status", "--porcelain").trim()) throw new Error("Working tree is not clean. Commit or remove local changes before handoff.");
  const baseRef = taskBaseRefForBranch(branch);
  if (!isAncestor(baseRef, head)) throw new Error(`Task base ${baseRef} is not an ancestor of ${head}.`);

  const run = findSuccessfulDeliveryRun(branch, head, ["public-guard", "checks", "temporal-worker-check", "deploy-preview"]);
  const slot = readPreviewSlot(branch, head);
  const url = previewUrlForSlot(slot);
  const receipt = {
    branch,
    commit: head,
    slot,
    url,
    runId: run.databaseId,
    releaseNotes: readReleaseNotes(),
    verifiedAt: new Date().toISOString(),
    verifiedBy: "brai-task-preview-v1",
  };
  writePreviewReceipt(receipt);

  console.log(`${PREVIEW_SLOT_EMOJI[slot]} Preview`);
  console.log(`Branch: ${branch}`);
  console.log(`Commit: ${head}`);
  console.log(`Preview ${slot}: ${url}`);
  console.log(`GitHub Actions run: ${run.url ?? `https://github.com/sergobright/Brai/actions/runs/${run.databaseId}`}`);
}

function deliveryHandoff(branchArg) {
  const branch = branchArg ?? currentBranch();
  if (!CODEX_BRANCH_RE.test(branch)) throw new Error(`Delivery handoff requires codex/* branch, got: ${branch}`);
  if (branch !== currentBranch()) throw new Error(`Current branch is ${currentBranch()}, not ${branch}`);
  const head = git("rev-parse", "HEAD");
  const acceptance = readAcceptanceReceipt();
  let classification = classifyDelivery(diffFromTaskBase(), { branch, head });
  classification = classifyAcceptedNoPreviewDelivery(classification, acceptance, branch, head);
  if (classification.deliveryClass === DELIVERY_CLASS.RUNTIME_PREVIEW) {
    previewHandoff(branchArg);
    return;
  }
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    throw new Error(`Blocked delivery paths cannot be handed off:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`);
  }
  if (classification.deliveryClass === DELIVERY_CLASS.NONE) {
    console.log("No Brai delivery work to hand off.");
    return;
  }

  fetchTaskBranch(branch);
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
  }
  const run = waitForSuccessfulDeliveryRun(branch, head, ["public-guard", "checks", "temporal-worker-check", "auto-merge-infra-docs"]);
  pr = findInfraDocsPr(branch, head) ?? pr;
  if (pr?.state !== "MERGED" || !pr?.number || !pr?.url || !pr?.mergedAt) throw new Error(infraDocsPrPendingMessage(pr, branch, head, run));
  const receipt = {
    receiptType: DELIVERY_RECEIPT_VERSION,
    branch,
    commit: head,
    deliveryClass: classification.deliveryClass,
    classification,
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    mergedAt: pr.mergedAt,
    runId: run.databaseId,
    runUrl: run.url ?? `https://github.com/sergobright/Brai/actions/runs/${run.databaseId}`,
    verifiedAt: new Date().toISOString(),
    verifiedBy: "brai-task-delivery-v1",
  };
  writeDeliveryReceipt(receipt);

  console.log("No-preview delivery");
  console.log(`Branch: ${branch}`);
  console.log(`Commit: ${head}`);
  console.log(`Delivery class: ${receipt.deliveryClass}`);
  console.log(`PR: #${receipt.prNumber} ${receipt.prUrl}`);
  console.log(`PR state: ${receipt.prState}`);
  console.log(`Merged at: ${receipt.mergedAt}`);
  console.log(`GitHub Actions run: ${receipt.runUrl}`);
}

function infraDocsPrPendingMessage(pr, branch, head, run) {
  const prUrl = pr?.url ?? "(missing)";
  const state = pr?.state ?? "(missing)";
  const mergeStateStatus = pr?.mergeStateStatus ?? "(missing)";
  const autoMerge = pr?.autoMergeRequest ? "enabled" : "disabled";
  const mergedAt = pr?.mergedAt ?? "(missing)";
  const runUrl = run?.url ?? (run?.databaseId ? `https://github.com/sergobright/Brai/actions/runs/${run.databaseId}` : "(missing)");
  return [
    "No-preview delivery is not complete until its PR is merged into main.",
    `Branch: ${branch}`,
    `Commit: ${head}`,
    `PR: ${prUrl}`,
    `PR state: ${state}`,
    `mergeStateStatus: ${mergeStateStatus}`,
    `autoMerge: ${autoMerge}`,
    `mergedAt: ${mergedAt}`,
    `GitHub Actions run: ${runUrl}`,
    "Rerun node scripts/brai-task.mjs handoff after the PR state is MERGED.",
  ].join("\n");
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

function preflight(strict = false) {
  const result = workspacePreflight();
  console.log(JSON.stringify(result, null, 2));
  if (strict && !result.ok) process.exit(1);
}

function accessContract(args = []) {
  const mode = args.includes("--server") ? "server" : "local";
  const result = mode === "server" ? serverAccessContract() : localAccessContract();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  return result;
}

function localAccessContract(root = git("rev-parse", "--show-toplevel")) {
  const checks = [
    commandCheck("guard sync", [path.join(root, "scripts/brai-guard-sync-check.sh"), "--check"], { cwd: root }),
    jsonCheck("workspace preflight", workspacePreflight(root)),
    pathCheck(".git metadata", path.join(root, ".git"), { requireRead: true }),
    pathCheck(".brai-task", path.join(root, ".brai-task"), { requireWrite: fs.existsSync(path.join(root, ".brai-task")) }),
    commandCheck("node", ["node", "--version"], { cwd: root }),
    commandCheck("npm", ["npm", "--version"], { cwd: root }),
  ];
  return summarizeAccessContract("local", root, checks);
}

function serverAccessContract(root = process.env.BRAI_ROOT ?? "/srv/projects/brai") {
  const envsRoot = process.env.BRAI_ENVS_ROOT ?? "/srv/projects/brai-envs";
  const deployRepo = process.env.BRAI_DEPLOY_REPO ?? root;
  const checks = [
    commandCheck("guard sync", [path.join(root, "scripts/brai-guard-sync-check.sh"), "--check"], { cwd: root }),
    commandCheck("preview slots", [path.join(root, "deploy/scripts/preview-slots.sh"), "status"], {
      cwd: root,
      env: { ...process.env, BRAI_ENVS_ROOT: envsRoot },
    }),
    commandCheck("sqlite maintenance", [path.join(root, "deploy/scripts/production-sqlite-maintenance.sh"), "check"], { cwd: root }),
    pathCheck("env roots", envsRoot, { requireWrite: true, expectDirectory: true }),
    pathCheck("prod source", path.join(envsRoot, "prod/source"), { requireRead: true, expectDirectory: true }),
    pathCheck("preview slot registry", path.join(envsRoot, "preview-slots.json"), { requireRead: true }),
    pathCheck("deploy artifacts", path.join(deployRepo, "deploy"), { requireRead: true, expectDirectory: true }),
    pathCheck("main sync script", "/srv/opt/brai-main-sync.sh", { requireRead: true }),
    commandCheck("node", ["node", "--version"], { cwd: root }),
    commandCheck("npm", ["npm", "--version"], { cwd: root }),
  ];
  return summarizeAccessContract("server", root, checks);
}

function summarizeAccessContract(mode, root, checks) {
  const failed = checks.filter((check) => !check.ok);
  return { ok: failed.length === 0, mode, root, checkedAt: new Date().toISOString(), checks, failed };
}

function jsonCheck(name, result) {
  return { name, ok: Boolean(result?.ok), result };
}

function commandCheck(name, command, { cwd, env = process.env } = {}) {
  const result = spawnSync(command[0], command.slice(1), { cwd, env, encoding: "utf8" });
  return {
    name,
    ok: result.status === 0,
    command: command.join(" "),
    status: result.status,
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
  };
}

function pathCheck(name, target, { requireRead = false, requireWrite = false, expectDirectory = false } = {}) {
  const check = { name, ok: true, path: target };
  if (!fs.existsSync(target)) return { ...check, ok: false, reason: "missing" };
  const stats = fs.statSync(target);
  check.mode = (stats.mode & 0o7777).toString(8);
  check.uid = stats.uid;
  check.gid = stats.gid;
  if (expectDirectory && !stats.isDirectory()) return { ...check, ok: false, reason: "not a directory" };
  try {
    if (requireRead) fs.accessSync(target, fs.constants.R_OK);
    if (requireWrite) fs.accessSync(target, fs.constants.W_OK);
  } catch (error) {
    return { ...check, ok: false, reason: error?.code || "access denied" };
  }
  return check;
}

function workspacePreflight(root = git("rev-parse", "--show-toplevel")) {
  const sourceRoot = dependencySourceRoot(root);
  const checked = [];
  const failed = [];
  for (const relativePath of collectWorkspaceWritableDirs(root)) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const check = checkWorkspaceWritablePath(absolutePath, root, sourceRoot);
    const item = { path: relativePath, ...check };
    if (check.ok) checked.push(item);
    else failed.push(item);
  }
  return { ok: failed.length === 0, root, checked, failed };
}

function collectWorkspaceWritableDirs(root) {
  const paths = new Set(WORKSPACE_WRITABLE_DIRS);
  const androidRoot = path.join(root, "apps/brai_app/android");
  if (fs.existsSync(androidRoot)) {
    for (const entry of fs.readdirSync(androidRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.add(`apps/brai_app/android/${entry.name}/build`);
    }
  }
  return [...paths].sort();
}

function checkWorkspaceWritablePath(absolutePath, root, sourceRoot) {
  const stats = fs.lstatSync(absolutePath);
  if (!stats.isDirectory() && !stats.isSymbolicLink()) return { ok: false, reason: "not a directory" };
  const real = fs.realpathSync(absolutePath);
  const allowedRoots = [root, sourceRoot].map((candidate) => fs.realpathSync(candidate));
  if (!allowedRoots.some((candidate) => real === candidate || real.startsWith(`${candidate}${path.sep}`))) {
    return { ok: false, real, reason: "outside workspace roots" };
  }
  try {
    fs.accessSync(real, fs.constants.W_OK);
    return { ok: true, real };
  } catch (error) {
    return { ok: false, real, reason: error?.code || "not writable" };
  }
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
    receipt: isNoPreviewDeliveryClass(classification.deliveryClass) ? deliveryReceipt : previewReceipt,
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
      message: `Brai task is not ready for handoff: working tree is not clean.\n\n${status.trim()}\n\nCommit, push, and verify delivery with: node scripts/brai-task.mjs handoff`,
    };
  }
  if (!hasImplementationWork) return base;
  if (!validation.ok && !completedWithReceipt) return { ...base, ok: false, message: validation.message };
  if (!reuse.ok && !completedWithReceipt) return { ...base, ok: false, message: reuse.message };
  if (classification.deliveryClass === DELIVERY_CLASS.BLOCKED) {
    return {
      ...base,
      ok: false,
      message: `Brai delivery contains blocked paths:\n${classification.paths.blocked.map((file) => `- ${file}`).join("\n")}`,
    };
  }
  if (!receiptValidation.ok) {
    return {
      ...base,
      ok: false,
      message: `Brai implementation work cannot be handed off before delivery verification.\n\n${receiptValidation.message}\n\nRun: node scripts/brai-task.mjs handoff`,
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
  const notes = validateReleaseNotes(receipt.releaseNotes);
  if (!notes.ok) return { ok: false, message: notes.message };
  if (!receipt.verifiedAt) return { ok: false, message: "Preview receipt has no verification timestamp." };
  return { ok: true };
}

function writeReleaseNotesCli(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--")) throw new Error(`invalid release-notes argument: ${key}`);
    values[key.slice(2)] = args[index + 1] ?? "";
  }
  const notes = requireReleaseNotes({
    receiptType: RELEASE_NOTES_VERSION,
    short_changes: values.short,
    detailed_changes: values.details,
    reason: values.reason,
  }, "release-notes arguments");
  writeReleaseNotes(notes);
  console.log("Wrote .brai-task/release-notes.json");
}

function readReleaseNotes() {
  const fromEnv = releaseNotesFromEnv();
  if (fromEnv) return fromEnv;
  const root = git("rev-parse", "--show-toplevel");
  const file = path.join(root, ".brai-task", "release-notes.json");
  return requireReleaseNotes(readJson(file), file);
}

function releaseNotesFromEnv() {
  const values = {
    receiptType: RELEASE_NOTES_VERSION,
    short_changes: process.env.BRAI_RELEASE_SHORT_CHANGES,
    detailed_changes: process.env.BRAI_RELEASE_DETAILED_CHANGES,
    reason: process.env.BRAI_RELEASE_REASON,
  };
  if (!values.short_changes && !values.detailed_changes && !values.reason) return null;
  return requireReleaseNotes(values, "BRAI_RELEASE_*");
}

function validateReleaseNotes(notes) {
  try {
    requireReleaseNotes(notes, "release notes");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function requireReleaseNotes(notes, source) {
  if (!notes || typeof notes !== "object") {
    throw new Error(`${source} missing. Run: node scripts/brai-task.mjs release-notes --short "..." --details "..." --reason "..."`);
  }
  const normalized = { receiptType: RELEASE_NOTES_VERSION };
  for (const field of ["short_changes", "detailed_changes", "reason"]) {
    const text = String(notes[field] ?? "").trim();
    if (!text) throw new Error(`${source}: ${field} is required.`);
    if (!/[А-Яа-яЁё]/.test(text)) throw new Error(`${source}: ${field} must be Russian human-readable text.`);
    if (isGenericReleaseNote(text)) throw new Error(`${source}: ${field} is generic deployment text, not release notes.`);
    normalized[field] = text;
  }
  return normalized;
}

function isGenericReleaseNote(text) {
  const oneLine = text.replace(/\s+/g, " ");
  return /^(Принята сборка|Сборка принята|Деплой ветки|Автоматическая доставка ветки|Нужно перенести принятую preview-сборку)/i.test(oneLine);
}

function writeReleaseNotes(notes) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".brai-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "release-notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
}

function validateHandoffReceipt({ classification, previewReceipt, deliveryReceipt, branch, head }) {
  if (classification.deliveryClass === DELIVERY_CLASS.NONE) return { ok: true };
  if (isNoPreviewDeliveryClass(classification.deliveryClass)) {
    return validateDeliveryReceipt(deliveryReceipt, branch, head, classification.deliveryClass);
  }
  return validatePreviewReceipt(previewReceipt, branch, head);
}

function classifyAcceptedNoPreviewDelivery(classification, acceptance, branch, head) {
  if (classification.deliveryClass !== DELIVERY_CLASS.NONE) return classification;
  if (!isNoPreviewAcceptanceForHead(acceptance, branch, head)) return classification;
  return {
    ...classification,
    deliveryClass: acceptance.deliveryClass,
    requires: {
      preview: false,
      devDeploy: false,
      autoMerge: true,
    },
  };
}

function validateDeliveryReceipt(receipt, branch, head, deliveryClass = null) {
  if (!receipt) return { ok: false, message: "Delivery handoff receipt is missing." };
  if (receipt.receiptType !== DELIVERY_RECEIPT_VERSION) return { ok: false, message: "Delivery receipt type is not valid." };
  if (receipt.branch !== branch) return { ok: false, message: `Delivery receipt is for ${receipt.branch || "(missing)"}, not ${branch}.` };
  if (receipt.commit !== head) return { ok: false, message: `Delivery receipt is for ${receipt.commit || "(missing)"}, not ${head}.` };
  const expectedClass = deliveryClass ?? receipt.deliveryClass;
  if (!isNoPreviewDeliveryClass(expectedClass)) return { ok: false, message: `Delivery receipt class is ${receipt.deliveryClass || "(missing)"}, not a no-preview class.` };
  if (receipt.deliveryClass !== expectedClass) return { ok: false, message: `Delivery receipt class is ${receipt.deliveryClass || "(missing)"}, not ${expectedClass}.` };
  if (!receipt.prNumber) return { ok: false, message: "Delivery receipt has no merged PR number." };
  if (!receipt.prUrl || !String(receipt.prUrl).startsWith("https://")) return { ok: false, message: "Delivery receipt has no merged PR URL." };
  if (receipt.prState !== "MERGED") return { ok: false, message: `Delivery receipt PR state is ${receipt.prState || "(missing)"}, not MERGED.` };
  if (!receipt.mergedAt) return { ok: false, message: "Delivery receipt has no merged PR timestamp." };
  if (!receipt.runId) return { ok: false, message: "Delivery receipt has no GitHub Actions run id." };
  if (!receipt.verifiedAt) return { ok: false, message: "Delivery receipt has no verification timestamp." };
  return { ok: true };
}

function validateTaskBranch({ requireExpectedUpstream }) {
  const branch = currentBranch();
  if (!branch) return { ok: false, message: "Detached HEAD is not allowed for Brai implementation work." };
  if (!CODEX_BRANCH_RE.test(branch)) {
    return { ok: false, message: `Implementation work must run on codex/<task-slug>, got: ${branch}` };
  }
  const baseRef = taskBaseRefForBranch(branch);
  if (!gitMaybe("rev-parse", "--verify", `${baseRef}^{commit}`)) {
    return { ok: false, message: `${baseRef} is missing locally. Start a fresh task branch with scripts/brai-task-start.sh <task-slug>.` };
  }

  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  if (upstream === acceptedBaseRef()) {
    return { ok: false, message: `${branch} tracks ${acceptedBaseRef()}. Recreate it with --no-track and push with: git push -u origin HEAD` };
  }
  if (requireExpectedUpstream && upstream && upstream !== `origin/${branch}`) {
    return { ok: false, message: `${branch} tracks ${upstream}. Expected origin/${branch} or no upstream before first push.` };
  }
  if (!isAncestor(baseRef, "HEAD")) {
    return { ok: false, message: `Task base ${baseRef} is not an ancestor of HEAD. Start a fresh task branch instead of rebasing or merging ${acceptedBaseRef()}.` };
  }

  return { ok: true };
}

function validateBranchReuse({ allowRemote = true } = {}) {
  const branch = currentBranch();
  const upstream = gitMaybe("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const marker = readTaskMarker();
  const branchHead = remoteBranchKnown(branch) ? gitMaybe("rev-parse", `origin/${branch}`) : gitMaybe("rev-parse", "HEAD");
  const acceptance = readAcceptanceReceipt();
  if (
    acceptance?.receiptType === ACCEPTANCE_RECEIPT_VERSION &&
    acceptance.branch === branch &&
    acceptance.commit === branchHead &&
    isBlockingAcceptanceReceipt(acceptance)
  ) {
    return {
      ok: false,
      message:
        `Brai refuses to continue ${branch} because preview acceptance already started${acceptance.prUrl ? `: ${acceptance.prUrl}` : "."}\n\n` +
        taskStartGuidance(),
    };
  }
  const markerValidation = validateTaskMarker(marker, branch);
  if (!markerValidation.ok) {
    return {
      ok: false,
      message:
        `${markerValidation.message}\n\n` +
        `${taskStartGuidance()}\n` +
        `Only for a same-thread follow-up run: node scripts/brai-task.mjs follow-up`,
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
  const acceptedPr = allowRemote ? remoteBranchMergedPr(branch, branchHead) : null;
  if (acceptedPr || remoteBranchAccepted(branch) || (isAncestor("HEAD", acceptedBaseRef()) && !freshStartedBranch)) {
    return {
      ok: false,
      message:
        `Brai refuses to continue ${branch} because it is already accepted${acceptedPr?.url ? `: ${acceptedPr.url}` : ` in ${acceptedBaseRef()}`}.\n\n` +
        taskStartGuidance(),
    };
  }
  if (upstream === `origin/${branch}` && marker?.branch !== branch) {
    return {
      ok: false,
      message:
        `Brai refuses to reuse an existing pushed task branch without an explicit local marker.\n\n` +
        `${taskStartGuidance()}\n` +
        `Only for a same-thread follow-up run: node scripts/brai-task.mjs follow-up`,
    };
  }
  return { ok: true };
}

function validateTaskMarker(marker, branch) {
  if (!marker) return { ok: false, message: "Brai task marker is missing; this checkout was not started with scripts/brai-task-start.sh." };
  if (marker.branch !== branch) return { ok: false, message: `Brai task marker is for ${marker.branch || "(missing)"}, not ${branch}.` };
  if (marker.mode !== "new" && marker.mode !== "follow-up") {
    return { ok: false, message: `Brai task marker mode ${marker.mode || "(missing)"} is not valid for project-file writes.` };
  }
  if (!/^[0-9a-f]{40}$/.test(marker.base ?? "")) {
    return { ok: false, message: `Brai task marker has no valid ${acceptedBaseRef()} base; use the official task starter or follow-up command.` };
  }
  if (!marker.createdAt || Number.isNaN(Date.parse(marker.createdAt))) {
    return { ok: false, message: "Brai task marker has no valid creation timestamp; use the official task starter or follow-up command." };
  }
  return { ok: true };
}

function validateTaskThread(marker, threadId) {
  if (!threadId) return { ok: true };
  if (!marker?.threadId) {
    return { ok: false, message: "Brai task marker has no Codex thread id, so this thread cannot change project files on this branch." };
  }
  if (marker.threadId !== threadId) {
    return { ok: false, message: `Brai task branch belongs to Codex thread ${marker.threadId}, not current thread ${threadId}.` };
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
    `Run the repo starter with escalation: scripts/brai-task-start.sh <task-slug>\n` +
    `In Codex Desktop, request sandbox_permissions=require_escalated because the starter updates Git worktree metadata and creates an isolated worktree under ${parent}.\n` +
    `Do not create or switch to a manual fallback branch, and do not use the installed guard starter as a workaround.`
  );
}

function taskWorktreeParent(root) {
  const parent = path.dirname(root);
  if (path.basename(parent) === ".codex-worktrees" || path.basename(parent) === "brai-worktrees") return parent;
  return path.join(root, ".codex-worktrees");
}

function acceptedBaseBranch() {
  return process.env.BRAI_ACCEPT_BASE || DEFAULT_ACCEPT_BASE_BRANCH;
}

function acceptedBaseRef() {
  return `origin/${acceptedBaseBranch()}`;
}

function acceptedBaseFetchRefspec() {
  const branch = acceptedBaseBranch();
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
}

function taskBaseRefForBranch(branch = currentBranch()) {
  const marker = readTaskMarker();
  return validateTaskMarker(marker, branch).ok ? marker.base : acceptedBaseRef();
}

function dependencySourceRoot(root) {
  const parent = path.dirname(root);
  if (path.basename(parent) === ".codex-worktrees") {
    const canonical = path.dirname(parent);
    if (fs.existsSync(path.join(canonical, "package.json"))) return canonical;
  }
  if (path.basename(parent) === "brai-worktrees") {
    const canonical = path.join(path.dirname(parent), "brai");
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
      marker = readJson(path.join(taskPath, ".brai-task", "task.json"));
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
  const marker = readJson(path.join(taskPath, ".brai-task", "task.json"));
  const acceptance = readJson(path.join(taskPath, ".brai-task", "acceptance.json"));
  if (
    acceptance?.receiptType === ACCEPTANCE_RECEIPT_VERSION &&
    acceptance?.branch === marker?.branch &&
    acceptance?.commit &&
    isBlockingAcceptanceReceipt(acceptance)
  ) {
    return true;
  }
  const receipt = readJson(path.join(taskPath, ".brai-task", "delivery-handoff.json"));
  const head = gitMaybeIn(taskPath, "rev-parse", "HEAD");
  if (head && validateDeliveryReceipt(receipt, marker?.branch, head).ok) return true;
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
    return { ok: false, write: true, reason: "Brai hook input was not recognized; blocking fail-closed." };
  }

  const calls = collectToolCalls(input);
  if (!calls.length) {
    return { ok: false, write: true, reason: "Brai hook tool shape was not recognized; blocking fail-closed." };
  }

  let write = false;
  let officialTaskStarter = false;
  let officialAcceptanceReconcile = false;
  for (const call of calls) {
    const classified = classifyToolCall(call);
    if (!classified.ok) return { ...classified, write: true };
    if (classified.blockedReason) return { ok: true, write: true, blockedReason: classified.blockedReason };
    if (classified.manualCodexBranch) return { ok: true, write: true, manualCodexBranch: true };
    officialTaskStarter ||= Boolean(classified.officialTaskStarter);
    officialAcceptanceReconcile ||= Boolean(classified.officialAcceptanceReconcile);
    write ||= Boolean(classified.write);
  }
  const result = {
    ok: true,
    write,
    officialTaskStarter: officialTaskStarter && !write,
    manualCodexBranch: false,
  };
  if (officialAcceptanceReconcile && !officialTaskStarter) result.officialAcceptanceReconcile = true;
  return result;
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
    if (isTaskBaseRefreshCommand(commandText) && hasActiveTaskMarker()) {
      return {
        ok: true,
        write: true,
        blockedReason:
          `Brai follow-up branches keep their original task base until acceptance.\n\n` +
          `Do not fetch, pull, merge, or rebase ${acceptedBaseRef()} into an active codex/* branch; continue with: node scripts/brai-task.mjs follow-up`,
      };
    }
    if (isManualCodexBranchCommand(commandText)) return { ok: true, write: true, manualCodexBranch: true };
    if (isOfficialTaskStarterCommand(commandText)) return { ok: true, write: false, officialTaskStarter: true };
    if (isOfficialAcceptanceReconcileCommand(commandText)) return { ok: true, write: true, officialAcceptanceReconcile: true };
    return { ok: true, write: isWriteLikeCommand(commandText) };
  }
  return { ok: false, reason: `Brai does not recognize hook tool ${tool}; blocking fail-closed.` };
}

function isPatchTool(tool) {
  return tool === "apply_patch" || tool.endsWith(".apply_patch") || tool === "Edit" || tool === "Write";
}

function isShellTool(tool) {
  return tool === "exec_command" || tool === "Bash" || tool.endsWith(".exec_command");
}

function isWriteLikeCommand(commandText) {
  return !isOfficialTaskStarterCommand(commandText) && !isOfficialAcceptanceReconcileCommand(commandText) && !isReadOnlyShellCommand(commandText);
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

function isOfficialAcceptanceReconcileCommand(commandText) {
  const branchPattern = "(?:\\s+codex/[a-z0-9][a-z0-9._-]*)?";
  const segmentPattern = new RegExp(
    `^(?:node\\s+scripts/brai-task\\.mjs|scripts/use-node22\\.sh\\s+node\\s+scripts/brai-task\\.mjs)\\s+acceptance-reconcile${branchPattern}$`,
  );
  return splitShellSegments(commandText).some((segment) => segmentPattern.test(segment));
}

function isInstalledTaskStarterSegment(segment) {
  return /^\/srv\/opt\/node-v22\.16\.0\/bin\/node\s+\/srv\/opt\/brai-codex-plugins\/plugins\/brai-guard\/hooks\/brai-guard\.mjs\s+start\s+[a-z0-9][a-z0-9._-]*$/.test(segment);
}

function isRepoTaskStarterSegment(segment) {
  return /^(?:scripts\/brai-task-start\.sh|(?:\S+\/)?scripts\/brai-task-start\.sh|scripts\/use-node22\.sh\s+node\s+scripts\/brai-task\.mjs\s+start|node\s+scripts\/brai-task\.mjs\s+start)\s+[a-z0-9][a-z0-9._-]*$/.test(segment);
}

function repoTaskStarterIsStable() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return false;
  const starter = path.join(root, "scripts", "brai-task-start.sh");
  if (!fs.existsSync(starter)) return false;
  return fs.readFileSync(starter, "utf8").includes("/srv/opt/brai-codex-plugins/plugins/brai-guard/hooks/brai-guard.mjs start");
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
  if (/^rg\b/.test(segment) && /(?:^|\s)--pre(?:=|\s|$)/.test(segment)) return false;
  if (/^git\s+diff\b/.test(segment) && /(?:^|\s)--(?:output|ext-diff)(?:=|\s|$)/.test(segment)) return false;
  if (/^find\b/.test(segment) && /(?:^|\s)-(?:exec|delete|ok|fprint)(?:\s|$)/.test(segment)) return false;
  return [
    /^pwd$/,
    /^ls(?:\s+[-A-Za-z0-9_./*=:@]+)*$/,
    /^rg(?:\s+[-A-Za-z0-9_./*=:@]+)*(?:\s+"[^"]*")?(?:\s+'[^']*')?$/,
    /^(?:cat|nl|wc|head|tail)(?:\s+[-A-Za-z0-9_./*=:@]+)*$/,
    /^sed\s+-n\s+(?:"[0-9,$]+p"|'[0-9,$]+p'|[0-9,$]+p)(?:\s+[-A-Za-z0-9_./:=@]+)+$/,
    /^find(?:\s+[-A-Za-z0-9_./*=:@' "%]+)*$/,
    /^stat(?:\s+[-A-Za-z0-9_./%=:@]+)*$/,
    /^git\s+(?:status|diff|log|show|rev-parse|ls-files|merge-base)(?:\s+.+)?$/,
    /^git\s+branch\s+--show-current$/,
    /^git\s+worktree\s+list(?:\s+--porcelain)?$/,
    /^git\s+config\s+(?:--get|get)\s+[A-Za-z0-9_.-]+$/,
    /^node\s+scripts\/brai-task\.mjs\s+classify(?:\s+--(?:base|head)\s+[-A-Za-z0-9_./:@]+|\s+--github-output)*$/,
    /^node\s+scripts\/brai-task\.mjs\s+(?:preflight|access-contract)(?:\s+--(?:strict|local|server))*$/,
    /^scripts\/use-node22\.sh\s+node\s+scripts\/brai-task\.mjs\s+classify(?:\s+--(?:base|head)\s+[-A-Za-z0-9_./:@]+|\s+--github-output)*$/,
    /^node\s+scripts\/brai-task\.mjs\s+doctor(?:\s+--strict)?$/,
    /^scripts\/use-node22\.sh\s+node\s+scripts\/brai-task\.mjs\s+(?:preflight|access-contract)(?:\s+--(?:strict|local|server))*$/,
    /^scripts\/use-node22\.sh\s+node\s+scripts\/brai-task\.mjs\s+doctor(?:\s+--strict)?$/,
    /^scripts\/brai-guard-sync-check\.sh\s+--check$/,
  ].some((pattern) => pattern.test(segment));
}

function isManualCodexBranchCommand(commandText) {
  return isManualBranchCommand(commandText);
}

function isTaskBaseRefreshCommand(commandText) {
  const base = acceptedBaseBranch().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const remoteBase = `origin/${base}`;
  const basePattern = new RegExp(`(?:\\b${base}\\b|refs/heads/${base}|\\b${remoteBase}\\b)`);
  return splitShellSegments(commandText).some((segment) => {
    if (/^git\s+fetch\s+origin(?:\s|$)/.test(segment)) {
      return !/^git\s+fetch\s+origin\s+\+?refs\/heads\/codex\//.test(segment) || basePattern.test(segment);
    }
    return new RegExp(`^git\\s+pull\\b.*\\borigin\\s+${base}\\b`).test(segment) ||
      new RegExp(`^git\\s+(?:merge|rebase)\\b.*(?:\\b${remoteBase}\\b|\\b${base}\\b)`).test(segment);
  });
}

function hasActiveTaskMarker() {
  const branch = currentBranch();
  return CODEX_BRANCH_RE.test(branch) && validateTaskMarker(readTaskMarker(), branch).ok;
}

function isManualBranchCommand(commandText) {
  return splitShellSegments(commandText).some((segment) =>
    /^git\s+(?:switch|checkout)\b/.test(segment) ||
    /^git\s+branch\b(?!\s+--show-current$)/.test(segment) ||
    /^git\s+worktree\b(?!\s+list(?:\s+--porcelain)?$)/.test(segment),
  );
}

function isSensitivePath(file) {
  return PROTECTED_PATH_RE.test(file);
}

function classifyDelivery(files, { base = acceptedBaseRef(), head = "HEAD", branch = currentBranch(), diffs = null } = {}) {
  const paths = { blocked: [], docs: [], infra: [], technical: [], runtime: [], unknown: [] };
  for (const file of files) {
    const category = deliveryClassForFile(file);
    paths[category === "runtime" && isTechnicalRuntimeChange(file, { base, head, diffs }) ? "technical" : category].push(file);
  }

  const deliveryClass = paths.blocked.length
    ? DELIVERY_CLASS.BLOCKED
    : files.length === 0
      ? DELIVERY_CLASS.NONE
      : paths.runtime.length || paths.unknown.length
        ? DELIVERY_CLASS.RUNTIME_PREVIEW
        : paths.technical.length
          ? DELIVERY_CLASS.TECHNICAL_NO_PREVIEW
          : DELIVERY_CLASS.INFRA_DOCS;
  const requiresPreview = deliveryClass === DELIVERY_CLASS.RUNTIME_PREVIEW;
  const requiresDevDeploy = false;
  const autoMerge = isNoPreviewDeliveryClass(deliveryClass);

  return {
    schemaVersion: 1,
    classifier: "brai-delivery-classify-v1",
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
    file === ".github/workflows/brai-delivery.yml" ||
    file === ".codex/hooks.json" ||
    file === "deploy/environments.json" ||
    file === "apps/brai_app/tests/unit/publishScripts.test.ts" ||
    file.startsWith("deploy/ansible/") ||
    file.startsWith(".githooks/") ||
    file.startsWith("scripts/brai-") ||
    file.startsWith("scripts/check-open-openspec-changes") ||
    file.startsWith("services/brai_temporal/") ||
    [
      "deploy/scripts/classify-delivery.mjs",
      "deploy/scripts/accept-preview.sh",
      "deploy/scripts/accepted-preview-branches.mjs",
      "deploy/scripts/apk-release-targets.mjs",
      "deploy/scripts/build-android-env-apk.sh",
      "deploy/scripts/build-nonproduction-apks.sh",
      "deploy/scripts/ci-ssh-complete-accepted-previews.sh",
      "deploy/scripts/ci-ssh-deploy.sh",
      "deploy/scripts/ci-ssh-promote-deployment.sh",
      "deploy/scripts/ci-ssh-release-slot.sh",
      "deploy/scripts/ci-ssh-sync-main-checkout.sh",
      "deploy/scripts/complete-operation-activities.sh",
      "deploy/scripts/deploy-branch.sh",
      "deploy/scripts/detect-native-apk-change.mjs",
      "deploy/scripts/generate-android-preview-icons.sh",
      "deploy/scripts/preview-slots.mjs",
      "deploy/scripts/preview-slots.sh",
      "deploy/scripts/production-sqlite-maintenance.sh",
      "deploy/scripts/permissions.sh",
      "deploy/scripts/publish-capacitor-apk.sh",
      "deploy/scripts/publish-mobile-bundle.sh",
      "deploy/scripts/publish-environment-web-layer.sh",
      "deploy/scripts/publish-web.sh",
      "deploy/scripts/promote-accepted-deployment.sh",
      "deploy/scripts/promote-deployment.mjs",
      "deploy/scripts/resolve-deploy-env.mjs",
      "deploy/scripts/resolve-required-apk-version.mjs",
      "deploy/scripts/sync-local-main-checkout.sh",
      "deploy/scripts/sync-occupied-preview-ota-manifests.sh",
      "deploy/scripts/update-release-index.mjs",
    ].includes(file)
  ) {
    return "infra";
  }
  if (
    file.startsWith("apps/brai_app/tests/") ||
    file.startsWith("services/brai_api/test/") ||
    file.startsWith("services/brai_api/test-support/") ||
    /^apps\/brai_app\/vitest\.config\.[cm]?[jt]s$/.test(file) ||
    /^apps\/brai_app\/playwright\.config\.[cm]?[jt]s$/.test(file) ||
    /^apps\/brai_app\/eslint\.config\.[cm]?[jt]s$/.test(file)
  ) {
    return "technical";
  }
  if (
    file.startsWith("apps/brai_app/") ||
    file.startsWith("services/brai_api/") ||
    file.startsWith("assets/brand/")
  ) {
    return "runtime";
  }
  return "unknown";
}

function isNoPreviewDeliveryClass(deliveryClass) {
  return deliveryClass === DELIVERY_CLASS.INFRA_DOCS || deliveryClass === DELIVERY_CLASS.TECHNICAL_NO_PREVIEW;
}

function isNoPreviewAcceptanceForHead(acceptance, branch, head) {
  return (
    acceptance?.receiptType === ACCEPTANCE_RECEIPT_VERSION &&
    acceptance.branch === branch &&
    acceptance.commit === head &&
    ["acceptance_started", "reconcile_started"].includes(acceptance.status) &&
    isNoPreviewDeliveryClass(acceptance.deliveryClass)
  );
}

function isTechnicalRuntimeChange(file, context) {
  if (file === "apps/brai_app/package.json") return isClientPackageTestScriptDiff(diffForFile(file, context));
  if (file === "services/brai_api/src/store-migrations.js") return isAgentOperationDoneDiff(diffForFile(file, context));
  return false;
}

function diffForFile(file, { base = acceptedBaseRef(), head = "HEAD", diffs = null } = {}) {
  if (diffs && Object.hasOwn(diffs, file)) return String(diffs[file] ?? "");
  return gitMaybe("diff", "--unified=5", `${base}...${head}`, "--", file) ?? "";
}

function changedDiffLines(diff) {
  return String(diff)
    .split("\n")
    .filter((line) => /^[+-](?![+-])/.test(line));
}

function isClientPackageTestScriptDiff(diff) {
  const keys = changedDiffLines(diff)
    .map((line) => line.match(/^[+-]\s*"([^"]+)":/)?.[1])
    .filter(Boolean);
  return keys.length > 0 && keys.every((key) => key === "test" || key === "test:watch");
}

function isAgentOperationDoneDiff(diff) {
  if (!String(diff).includes("operation:agent-task:")) return false;
  const changes = changedDiffLines(diff);
  const removed = changes.filter((line) => line.startsWith("-"));
  const added = changes.filter((line) => line.startsWith("+"));
  return (
    removed.length > 0 &&
    removed.length === added.length &&
    removed.every((line) => /^-\s*done:\s*false,?\s*$/.test(line)) &&
    added.every((line) => /^\+\s*done:\s*true,?\s*$/.test(line))
  );
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
  const runs = runJson(["gh", "run", "list", "--workflow", "Brai delivery", "--branch", branch, "--event", "push", "--limit", "20", "--json", "databaseId,headSha,status,conclusion,url"]);
  const run = runs.find((candidate) => candidate.headSha === sha);
  if (!run) throw new Error(`No Brai delivery push run found for ${branch}@${sha}.`);
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
  const registryPath = process.env.BRAI_PREVIEW_REGISTRY ?? "/srv/projects/brai-envs/preview-slots.json";
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
    env: { ...process.env, BRAI_TEMPORAL_REQUIRED: "true" },
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
  const acceptance = readAcceptanceReceipt();
  const branch = currentBranch();
  const head = gitMaybe("rev-parse", "HEAD");
  if (isNoPreviewAcceptanceForHead(acceptance, branch, head)) {
    if (isAncestor(acceptedBaseRef(), "HEAD")) return diffNames(`${acceptedBaseRef()}...HEAD`);
    const acceptedDiff = diffNames(`${acceptedBaseRef()}..HEAD`);
    if (acceptedDiff.length === 0 || remoteBranchMergedPr(branch, head)) return acceptedDiff;
  }
  if (acceptance?.receiptType === ACCEPTANCE_RECEIPT_VERSION && acceptance.status === "reconcile_started" && isAncestor(acceptedBaseRef(), "HEAD")) {
    return diffNames(`${acceptedBaseRef()}...HEAD`);
  }
  const marker = readTaskMarker();
  const base = marker?.base && gitMaybe("rev-parse", "--verify", `${marker.base}^{commit}`) ? marker.base : acceptedBaseRef();
  return diffNames(`${base}...HEAD`);
}

function diffNames(range) {
  return (gitMaybe("diff", "--name-only", range) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fetchAcceptedBase() {
  git("fetch", "origin", acceptedBaseFetchRefspec());
}

function fetchTaskBranch(branch) {
  git("fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
}

function remoteBranchExists(branch) {
  return spawnGit(["ls-remote", "--exit-code", "--heads", "origin", branch], { stdio: "ignore" }).status === 0;
}

function remoteBranchAccepted(branch) {
  const remote = `origin/${branch}`;
  if (!remoteBranchKnown(branch)) return false;
  return isAncestor(remote, acceptedBaseRef());
}

function remoteBranchMergedPr(branch, head) {
  if (!head || !remoteBranchKnown(branch)) return null;
  if (process.env.BRAI_TEST_MERGED_PRS_JSON) {
    try {
      const prs = JSON.parse(process.env.BRAI_TEST_MERGED_PRS_JSON);
      return Array.isArray(prs) ? prs.find((pr) => pr?.headRefOid === head) ?? null : null;
    } catch {
      return null;
    }
  }
  const prs = runJsonMaybe([
    "gh",
    "pr",
    "list",
    "--base",
    acceptedBaseBranch(),
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number,url,headRefOid,mergedAt",
  ]);
  if (!Array.isArray(prs)) return null;
  return prs.find((pr) => pr?.headRefOid === head) ?? null;
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
  return readJson(path.join(root, ".brai-task", "task.json"));
}

function writeTaskMarker(root, marker) {
  const dir = path.join(root, ".brai-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), `${JSON.stringify(marker, null, 2)}\n`);
}

function readPreviewReceipt() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".brai-task", "preview-handoff.json"));
}

function readDeliveryReceipt() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".brai-task", "delivery-handoff.json"));
}

function readAcceptanceReceipt() {
  const root = gitMaybe("rev-parse", "--show-toplevel");
  if (!root) return null;
  return readJson(path.join(root, ".brai-task", "acceptance.json"));
}

function isBlockingAcceptanceReceipt(receipt) {
  if (receipt?.receiptType !== ACCEPTANCE_RECEIPT_VERSION) return false;
  if (receipt.status === "already_in_base" || receipt.status === "merged") return true;
  if (receipt.status === "reconcile_required") return true;
  if (receipt.status === "reconcile_started") return false;
  return receipt.status === "acceptance_started" && receipt.deliveryClass === DELIVERY_CLASS.RUNTIME_PREVIEW;
}

function writeAcceptanceReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".brai-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "acceptance.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function writePreviewReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".brai-task");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "preview-handoff.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}

function writeDeliveryReceipt(receipt) {
  const root = git("rev-parse", "--show-toplevel");
  const dir = path.join(root, ".brai-task");
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
  const root = git("rev-parse", "--show-toplevel");
  const result = spawnSync("bash", [path.join(root, "deploy/scripts/accept-preview.sh"), branch], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BRAI_ACCEPT_BASE: acceptedBaseBranch(), BRAI_ACCEPT_NO_PREVIEW_ONLY: "true" },
  });
  if (result.status !== 0 || result.error) throw new Error(`Failed to create or enable no-preview PR for ${branch}: ${result.error?.message ?? `exit ${result.status}`}.`);
}

function findInfraDocsPr(branch, head) {
  const prs = runJson(["gh", "pr", "list", "--base", acceptedBaseBranch(), "--head", branch, "--state", "all", "--json", "number,url,state,headRefOid,labels,mergedAt,mergeStateStatus,autoMergeRequest"]);
  return prs.find((pr) =>
    pr.headRefOid === head &&
    Array.isArray(pr.labels) &&
    pr.labels.some((label) => NO_PREVIEW_DELIVERY_LABELS.has(label?.name)),
  ) ?? null;
}

function findAcceptancePr(branch, head) {
  if (process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON) {
    const prs = JSON.parse(process.env.BRAI_TEST_ACCEPTANCE_PRS_JSON);
    return Array.isArray(prs) ? prs.find((pr) => pr?.headRefOid === head && pr?.state === "OPEN") ?? null : null;
  }
  const prs = runJson([
    "gh",
    "pr",
    "list",
    "--base",
    acceptedBaseBranch(),
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number,url,state,headRefOid,mergeStateStatus,autoMergeRequest",
  ]);
  return prs.find((pr) => pr.headRefOid === head) ?? null;
}

function runJson(args) {
  const result = spawnSync(args[0], args.slice(1), { cwd: git("rev-parse", "--show-toplevel"), encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${args.join(" ")} failed:\n${result.stderr || result.stdout || "(no output)"}`);
  }
  return JSON.parse(result.stdout);
}

function runJsonMaybe(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: git("rev-parse", "--show-toplevel"),
    encoding: "utf8",
    env: process.env,
    timeout: 8000,
  });
  if (result.status !== 0 || result.error) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function waitForSuccessfulDeliveryRun(branch, sha, requiredJobs) {
  const waitMs = Number(process.env.BRAI_INFRA_DOCS_HANDOFF_WAIT_MS ?? DEFAULT_INFRA_DOCS_HANDOFF_WAIT_MS);
  const pollMs = Number(process.env.BRAI_INFRA_DOCS_HANDOFF_POLL_MS ?? DEFAULT_INFRA_DOCS_HANDOFF_POLL_MS);
  const deadline = Date.now() + waitMs;
  let lastError;
  do {
    try {
      return findSuccessfulDeliveryRun(branch, sha, requiredJobs);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      spawnSync("sleep", [String(Math.max(1, Math.ceil(pollMs / 1000)))], { stdio: "ignore" });
    }
  } while (Date.now() < deadline);
  throw lastError;
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
