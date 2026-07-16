import { spawn } from "node:child_process";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ROOT = process.env.BRAI_ROOT ?? DEFAULT_ROOT;

export async function deployBranch({ branch, sha, baseSha = "", productBaseSha = "" }) {
  assertSafeBranch(branch);
  assertSafeSha(sha);

  return withSourceCheckout({ branch, sha }, async (cwd, gitEnv) => {
    const result = await runExistingScript("deploy/scripts/ci-ssh-deploy.sh", [], {
      cwd,
      env: await deployEnv({
        ...gitEnv,
        BRAI_BRANCH: branch,
        BRAI_COMMIT: sha,
        BRAI_BASE_COMMIT: baseSha,
        BRAI_PRODUCT_BASE_COMMIT: productBaseSha
      })
    });
    return {
      ...result,
      previewSlot: parsePreviewSlot(result.stdout)
    };
  });
}

export async function verifyGoalAgentDeployment({ branch, sha, baseSha = "" }) {
  assertSafeBranch(branch);
  assertSafeSha(sha);

  return withSourceCheckout({ branch, sha }, async (cwd, gitEnv) => {
    const result = await runExistingScript("deploy/scripts/ci-ssh-deploy-goal-agents.sh", [], {
      cwd,
      env: await deployEnv({
        ...gitEnv,
        BRAI_BRANCH: branch,
        BRAI_COMMIT: sha,
        BRAI_BASE_COMMIT: baseSha
      })
    });
    return {
      ...result,
      previewSlot: parsePreviewSlot(result.stdout)
    };
  });
}

export async function enableNoPreviewAutoMerge({ branch, sha }) {
  assertSafeBranch(branch);
  assertSafeSha(sha);

  const mergedPull = await mergedPullForHead(branch, sha);
  if (mergedPull) {
    return {
      code: 0,
      stdout: `Already merged exact head ${sha} in PR #${mergedPull.number}: ${mergedPull.url}\n`,
      stderr: ""
    };
  }
  const openPull = await openPullForHead(branch, sha);
  return {
    code: 0,
    awaitingOwnerHandoff: true,
    stdout: openPull
      ? `No-preview PR #${openPull.number} already exists; task-owner handoff carries release metadata.\n`
      : `Awaiting task-owner no-preview handoff for ${branch}@${sha}; ignored work metadata is not synthesized in CI.\n`,
    stderr: ""
  };
}

async function mergedPullForHead(branch, sha) {
  const result = await runCommand("gh", [
    "pr",
    "list",
    "--base",
    "main",
    "--head",
    branch,
    "--state",
    "merged",
    "--limit",
    "100",
    "--json",
    "number,url,headRefOid,mergedAt"
  ], { cwd: ROOT, env: await deployEnv(), allowFailure: true });
  if (result.code !== 0) return null;
  try {
    return exactMergedPull(JSON.parse(result.stdout), sha);
  } catch {
    return null;
  }
}

async function openPullForHead(branch, sha) {
  const result = await runCommand("gh", [
    "pr", "list", "--base", "main", "--head", branch, "--state", "open", "--limit", "100",
    "--json", "number,url,headRefOid"
  ], { cwd: ROOT, env: await deployEnv(), allowFailure: true });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout).find((pull) => pull?.headRefOid === sha && pull?.number && pull?.url) ?? null;
  } catch {
    return null;
  }
}

export function exactMergedPull(pulls, sha) {
  return Array.isArray(pulls)
    ? pulls.find((pull) => pull?.headRefOid === sha && pull?.mergedAt && pull?.number && pull?.url) ?? null
    : null;
}

export async function completeAcceptedPreviews({ targetBranch = "main", targetEnvironment = "prod", targetCommit, mode }) {
  assertSafeBranch(targetBranch);
  assertSafeSha(targetCommit);
  if (!["all", "validate", "promote", "release"].includes(mode)) throw new Error(`Unsupported accepted preview mode: ${mode}`);

  return withSourceCheckout({ branch: targetBranch, sha: targetCommit }, async (cwd, gitEnv) =>
    runExistingScript("deploy/scripts/ci-ssh-complete-accepted-previews.sh", [], {
      cwd,
      env: await deployEnv({
        ...gitEnv,
        BRAI_TARGET_BRANCH: targetBranch,
        BRAI_TARGET_ENVIRONMENT: targetEnvironment,
        BRAI_TARGET_COMMIT: targetCommit,
        BRAI_ACCEPTED_PREVIEWS_MODE: mode,
        BRAI_TEMPORAL_REQUIRED: process.env.BRAI_TEMPORAL_REQUIRED ?? "true"
      })
    })
  );
}

export async function releasePreviewSlot({ branch, requireRelease = false, acceptedPreview = false }) {
  assertSafeBranch(branch);

  const result = await runExistingScript("deploy/scripts/ci-ssh-release-slot.sh", [], {
    cwd: ROOT,
    env: await deployEnv({
      BRAI_BRANCH: branch,
      BRAI_REQUIRE_PREVIEW_SLOT_RELEASE: requireRelease ? "true" : "false",
      BRAI_ACCEPTED_PREVIEW: acceptedPreview ? "true" : "false"
    })
  });
  return {
    ...result,
    released: parseReleased(result.stdout)
  };
}

export async function cleanupAcceptedBranches({ branch = "", recentMerged = false } = {}) {
  const args = [];
  if (branch) {
    assertSafeBranch(branch);
    args.push("--branch", branch);
  } else if (recentMerged) {
    args.push("--recent-merged");
  }

  return runExistingScript("deploy/scripts/ci-cleanup-accepted-branches.sh", args, {
    cwd: ROOT,
    env: await deployEnv({ BRAI_TARGET_BRANCH: "main" })
  });
}

export async function syncMainCheckout({ sha, restartTemporalWorker = false }) {
  assertSafeSha(sha);
  return runExistingScript("deploy/scripts/ci-ssh-sync-main-checkout.sh", [], {
    cwd: ROOT,
    env: await deployEnv({
      BRAI_COMMIT: sha,
      BRAI_RESTART_TEMPORAL_WORKER: restartTemporalWorker ? "true" : "false"
    })
  });
}

async function withSourceCheckout({ branch, sha }, callback) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "brai-temporal-source-"));
  const checkout = path.join(tempRoot, "source");
  try {
    const origin = await runCommand("git", ["-C", ROOT, "remote", "get-url", "origin"]);
    const remote = await fetchRemote(origin.stdout.trim(), tempRoot);
    await runCommand("git", ["clone", "--no-checkout", cloneSourceForRemote(remote), checkout], {
      env: { ...process.env, ...remote.env }
    });
    await fetchAcceptedBaseFromRoot(checkout);
    await runCommand("git", ["-C", checkout, "remote", "set-url", "origin", remote.url]);
    const directCheckout = await runCommand("git", ["-C", checkout, "checkout", "--detach", sha], { allowFailure: true });
    if (directCheckout.code !== 0) {
      await fetchBranch(checkout, branch, remote);
      await runCommand("git", ["-C", checkout, "checkout", "--detach", sha]);
    }
    return await callback(checkout, remote.env);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function fetchAcceptedBaseFromRoot(checkout) {
  for (const refspec of acceptedBaseRefspecs()) {
    const result = await runCommand("git", [
      "-C",
      checkout,
      "fetch",
      "--no-tags",
      ROOT,
      refspec
    ], { allowFailure: true });
    if (result.code === 0) return;
  }
}

export function acceptedBaseRefspecs(branch = process.env.BRAI_ACCEPT_BASE || "main") {
  if (!/^[A-Za-z0-9._-]+$/.test(branch)) throw new Error(`Unsupported accepted base branch: ${branch}`);
  const target = `refs/remotes/origin/${branch}`;
  return [
    `+refs/remotes/origin/${branch}:${target}`,
    `+refs/heads/${branch}:${target}`
  ];
}

export function cloneSourceForRemote(remote) {
  return Object.keys(remote.env ?? {}).length > 0 ? remote.url : ROOT;
}

export function commandFailureMessage(command, code, stdout, stderr) {
  const tail = (value) => String(value ?? "").trim().split("\n").slice(-40).join("\n").slice(-6000);
  const parts = [`${command} exited ${code}`];
  if (tail(stderr)) parts.push(`stderr:\n${tail(stderr)}`);
  if (tail(stdout)) parts.push(`stdout:\n${tail(stdout)}`);
  return parts.join("\n");
}

async function fetchBranch(checkout, branch, remote) {
  await runCommand("git", [
    "-C",
    checkout,
    "fetch",
    "--no-tags",
    remote.url,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  ], { env: { ...process.env, ...remote.env } });
}

async function fetchRemote(origin, tempRoot) {
  const token = await githubToken();
  const githubMatch = origin.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/) ??
    origin.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!token || !githubMatch) return { url: origin, env: {} };

  const askpass = path.join(tempRoot, "git-askpass.sh");
  await writeFile(askpass, "#!/usr/bin/env bash\nprintf '%s\\n' \"$BRAI_TEMPORAL_GIT_PASSWORD\"\n", { mode: 0o700 });
  await chmod(askpass, 0o700);
  return {
    url: `https://x-access-token@github.com/${githubMatch[1]}.git`,
    env: {
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      BRAI_TEMPORAL_GIT_PASSWORD: token.trim()
    }
  };
}

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.BRAI_TEMPORAL_GITHUB_TOKEN) return process.env.BRAI_TEMPORAL_GITHUB_TOKEN;
  if (process.env.BRAI_TEMPORAL_GITHUB_TOKEN_PATH) return readTextSecret(process.env.BRAI_TEMPORAL_GITHUB_TOKEN_PATH);
  return "";
}

async function deployEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra
  };

  copyEnv(env, "BRAI_TEMPORAL_DEPLOY_HOST", "BRAI_DEPLOY_HOST");
  copyEnv(env, "BRAI_TEMPORAL_DEPLOY_USER", "BRAI_DEPLOY_USER");
  copyEnv(env, "BRAI_TEMPORAL_DEPLOY_SSH_PORT", "BRAI_DEPLOY_SSH_PORT");
  copyEnv(env, "BRAI_TEMPORAL_DEPLOY_REPO", "BRAI_DEPLOY_REPO");

  if (!env.BRAI_DEPLOY_SSH_KEY && env.BRAI_TEMPORAL_DEPLOY_SSH_KEY_PATH) {
    env.BRAI_DEPLOY_SSH_KEY = await readTextSecret(env.BRAI_TEMPORAL_DEPLOY_SSH_KEY_PATH);
  }

  const token = env.BRAI_TEMPORAL_GITHUB_TOKEN_PATH
    ? await readTextSecret(env.BRAI_TEMPORAL_GITHUB_TOKEN_PATH)
    : env.BRAI_TEMPORAL_GITHUB_TOKEN;
  if (token && !env.GITHUB_TOKEN) env.GITHUB_TOKEN = token.trim();
  if (token && !env.GH_TOKEN) env.GH_TOKEN = token.trim();

  return env;
}

function copyEnv(env, from, to) {
  if (env[from] && !env[to]) env[to] = env[from];
}

async function readTextSecret(filePath) {
  return readFile(filePath, "utf8");
}

function runExistingScript(script, args, { cwd, env }) {
  return runCommand(path.join(cwd, script), args, { cwd, env });
}

export function runCommand(command, args, {
  cwd = ROOT,
  env = process.env,
  allowFailure = false,
  signal = activityCancellationSignal(),
  killGraceMs = 5000,
  heartbeatFn = activityHeartbeat,
  heartbeatIntervalMs = 1000
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Activity cancelled", "AbortError"));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let closed = false;
    let aborting = false;
    let killTimer;
    let killPollTimer;
    let heartbeatTimer;
    let settled = false;
    const abortReason = () => signal?.reason ?? new DOMException("Activity cancelled", "AbortError");
    const killProcessGroup = (processSignal) => {
      try {
        if (process.platform === "win32") child.kill(processSignal);
        else process.kill(-child.pid, processSignal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    const processGroupAlive = () => {
      try {
        if (process.platform === "win32") return child.exitCode == null;
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(killPollTimer);
      clearInterval(heartbeatTimer);
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const finishAbortIfDone = () => {
      if (closed && !processGroupAlive()) {
        finish(reject, abortReason());
        return true;
      }
      return false;
    };
    const onAbort = () => {
      if (aborting || settled) return;
      aborting = true;
      try {
        killProcessGroup("SIGTERM");
      } catch (error) {
        finish(reject, error);
        return;
      }
      killTimer = setTimeout(() => {
        try {
          killProcessGroup("SIGKILL");
          const deadline = Date.now() + 1000;
          const waitForGroupExit = () => {
            try {
              if (finishAbortIfDone()) return;
              if (Date.now() >= deadline) {
                finish(reject, new Error(`Process group for ${command} did not exit after SIGKILL`));
                return;
              }
              killPollTimer = setTimeout(waitForGroupExit, 10);
            } catch (error) {
              finish(reject, error);
            }
          };
          waitForGroupExit();
        } catch (error) {
          finish(reject, error);
        }
      }, Number.isFinite(killGraceMs) && killGraceMs >= 0 ? killGraceMs : 5000);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      closed = true;
      if (aborting) {
        finishAbortIfDone();
        return;
      }
      const result = { code, stdout, stderr };
      if (code === 0 || allowFailure) finish(resolve, result);
      else finish(reject, Object.assign(new Error(commandFailureMessage(command, code, stdout, stderr)), result));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (heartbeatFn() !== false) {
      heartbeatTimer = setInterval(heartbeatFn, Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
        ? heartbeatIntervalMs
        : 1000);
    }
  });
}

function activityCancellationSignal() {
  try {
    return cancellationSignal();
  } catch {
    return null;
  }
}

function activityHeartbeat() {
  try {
    heartbeat();
    return true;
  } catch {
    return false;
  }
}

function parsePreviewSlot(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => line.match(/^BRAI_PREVIEW_SLOT_OUTPUT=(.+)$/)?.[1] ?? "")
    .filter(Boolean)
    .at(-1) ?? "";
}

function parseReleased(output) {
  const jsonLine = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .at(-1);
  if (!jsonLine) return false;
  try {
    return JSON.parse(jsonLine).released === true;
  } catch {
    return false;
  }
}

function assertSafeBranch(branch) {
  if (!/^(main|dev|codex\/[A-Za-z0-9._-]+)$/.test(String(branch ?? ""))) {
    throw new Error(`Unsupported branch for Temporal activity: ${branch || "<empty>"}`);
  }
}

function assertSafeSha(sha) {
  if (!/^[0-9a-f]{7,64}$/i.test(String(sha ?? ""))) {
    throw new Error(`Unsupported commit sha for Temporal activity: ${sha || "<empty>"}`);
  }
}
