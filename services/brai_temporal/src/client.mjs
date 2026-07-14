import { Client, Connection } from "@temporalio/client";
import {
  EVENT_SIGNAL,
  PREVIEW_EVENTS,
  PREVIEW_TASK_QUEUE,
  PROMOTION_EVENTS,
  PROMOTION_TASK_QUEUE,
  STATE_QUERY,
  previewDeployWorkflowId,
  previewReadyForSha,
  previewWorkflowId,
  promotionWorkflowId
} from "./state.mjs";
import { signalWithClosedWorkflowRetry } from "./workflow-signal.mjs";

const argv = process.argv.slice(2);
const command = argv.shift();
const opts = parseOptions(argv);

try {
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233"
  });
  const client = new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default"
  });

  if (command === "preview") {
    await signalPreview(client, opts);
  } else if (command === "promotion") {
    await signalPromotion(client, opts);
  } else if (command === "dispatch-preview-deploy") {
    await dispatchPreviewDeploy(client, opts);
  } else if (command === "dispatch-no-preview-handoff") {
    await dispatchNoPreviewHandoff(client, opts);
  } else if (command === "dispatch-no-preview-merged") {
    await dispatchNoPreviewMerged(client, opts);
  } else if (command === "dispatch-promotion") {
    await dispatchPromotion(client, opts);
  } else if (command === "dispatch-release-preview") {
    await dispatchReleasePreview(client, opts);
  } else if (command === "query-preview") {
    await queryWorkflow(client, previewWorkflowId(required(opts, "branch")));
  } else if (command === "query-preview-deploy") {
    await readWorkflowResult(client, previewDeployWorkflowId(required(opts, "branch"), required(opts, "sha")));
  } else if (command === "cancel-preview-deploy") {
    await cancelPreviewDeploy(client, opts);
  } else if (command === "query-promotion") {
    await queryWorkflow(client, promotionWorkflowId(required(opts, "target"), required(opts, "sha")));
  } else if (command === "inventory") {
    await inventory(client, opts);
  } else if (command === "demo") {
    await signalPreview(client, {
      branch: opts.branch ?? "codex/temporal-smoke",
      sha: opts.sha ?? "fake-sha",
      event: "branch_pushed",
      source: "manual-demo"
    });
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}

async function dispatchPreviewDeploy(client, options) {
  const branch = required(options, "branch");
  const sha = required(options, "sha");
  if (process.env.BRAI_TEMPORAL_EXACT_SHA_PREVIEW !== "true") {
    throw new Error("dispatch-preview-deploy requires the exact-SHA branch worker");
  }
  const event = buildEvent("preview_deploy_requested", options, sha);
  const { handle, started } = await startOrGet(client, "BranchPreviewDeployWorkflow", {
    args: [{
      branch,
      sha,
      baseSha: event.baseSha,
      at: event.at,
      source: event.source
    }],
    taskQueue: process.env.BRAI_TEMPORAL_PREVIEW_TASK_QUEUE ?? PREVIEW_TASK_QUEUE,
    workflowId: previewDeployWorkflowId(branch, sha),
    workflowIdConflictPolicy: "TERMINATE_EXISTING"
  });
  console.log(`${started ? "started" : "using"} ${handle.workflowId} exact-sha-preview-deploy`);
  const state = await waitForState(handle, (current) => previewReadyForSha(current, sha));
  printState(state);
}

async function cancelPreviewDeploy(client, options) {
  const branch = required(options, "branch");
  const sha = required(options, "sha");
  const workflowId = previewDeployWorkflowId(branch, sha);
  await client.workflow.getHandle(workflowId).cancel();
  console.log(`cancelled ${workflowId}`);
}

async function dispatchNoPreviewHandoff(client, options) {
  const branch = required(options, "branch");
  const sha = required(options, "sha");
  const event = buildEvent("no_preview_handoff_requested", options, sha);
  const handle = await startAndSignalPreview(client, branch, sha, event);
  const state = await waitForState(handle, (current) =>
    current.lastSha === sha && current.autoMerge === "enabled" && taskPassedForSha(current, "auto_merge", sha)
  );
  printState(state);
}

async function dispatchNoPreviewMerged(client, options) {
  const branch = required(options, "branch");
  const sha = required(options, "sha");
  const event = buildEvent("no_preview_merged_requested", options, sha);
  const handle = await startAndSignalPreview(client, branch, sha, event);
  const state = await waitForState(handle, (current) =>
    current.lastSha === sha && current.terminal && current.status === "no_preview_merged"
  );
  printState(state);
}

async function dispatchPromotion(client, options) {
  const target = required(options, "target");
  const sha = required(options, "sha");
  const event = buildEvent("promotion_requested", options, sha);
  const handle = await startAndSignalPromotion(client, target, sha, event);
  const state = await waitForState(handle, (current) => current.terminal);
  if (target === "prod" && state.status === "released") {
    await supersedeOlderProdPromotions(client, sha, event);
  }
  printState(state);
}

async function dispatchReleasePreview(client, options) {
  const branch = required(options, "branch");
  const sha = required(options, "sha");
  const event = buildEvent("slot_release_requested", options, sha);
  const handle = await startAndSignalPreview(client, branch, sha, event);
  const state = await waitForState(handle, (current) => current.lastSha === sha && current.terminal);
  printState(state);
}

async function startAndSignalPreview(client, branch, sha, event) {
  if (!PREVIEW_EVENTS.has(event.type)) throw new Error(`Unsupported preview event: ${event.type}`);
  const { handle, started } = await signalWithClosedWorkflowRetry(
    () => startOrGet(client, "BranchPreviewWorkflow", {
      args: [{ branch, sha, at: event.at, source: event.source }],
      taskQueue: process.env.BRAI_TEMPORAL_PREVIEW_TASK_QUEUE ?? PREVIEW_TASK_QUEUE,
      workflowId: previewWorkflowId(branch)
    }),
    EVENT_SIGNAL,
    event
  );
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
  return handle;
}

async function startAndSignalPromotion(client, target, sha, event) {
  if (!PROMOTION_EVENTS.has(event.type)) throw new Error(`Unsupported promotion event: ${event.type}`);
  const { handle, started } = await startOrGet(client, "PromotionWorkflow", {
    args: [{ target, sha, at: event.at, source: event.source }],
    taskQueue: process.env.BRAI_TEMPORAL_PROMOTION_TASK_QUEUE ?? PROMOTION_TASK_QUEUE,
    workflowId: promotionWorkflowId(target, sha)
  });
  await handle.signal(EVENT_SIGNAL, event);
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
  return handle;
}

async function signalPreview(client, options) {
  const branch = required(options, "branch");
  const sha = options.sha ?? "";
  const event = buildEvent(options.event ?? "branch_pushed", options, sha);
  if (!PREVIEW_EVENTS.has(event.type)) throw new Error(`Unsupported preview event: ${event.type}`);
  const { handle, started } = await signalWithClosedWorkflowRetry(
    () => startOrGet(client, "BranchPreviewWorkflow", {
      args: [{ branch, sha, at: event.at, source: event.source }],
      taskQueue: process.env.BRAI_TEMPORAL_PREVIEW_TASK_QUEUE ?? PREVIEW_TASK_QUEUE,
      workflowId: previewWorkflowId(branch)
    }),
    EVENT_SIGNAL,
    event,
    { skipWhenStarted: event.type === "branch_pushed" }
  );
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
}

async function signalPromotion(client, options) {
  const target = required(options, "target");
  const sha = required(options, "sha");
  const event = buildEvent(options.event ?? "promotion_started", options, sha);
  if (!PROMOTION_EVENTS.has(event.type)) throw new Error(`Unsupported promotion event: ${event.type}`);
  const { handle, started } = await startOrGet(client, "PromotionWorkflow", {
    args: [{ target, sha, at: event.at, source: event.source }],
    taskQueue: process.env.BRAI_TEMPORAL_PROMOTION_TASK_QUEUE ?? PROMOTION_TASK_QUEUE,
    workflowId: promotionWorkflowId(target, sha)
  });

  if (!started || event.type !== "promotion_started") {
    await handle.signal(EVENT_SIGNAL, event);
  }
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
}

async function startOrGet(client, workflowType, options) {
  try {
    const handle = await client.workflow.start(workflowType, {
      ...options,
      workflowIdReusePolicy: "ALLOW_DUPLICATE"
    });
    return { handle, started: true };
  } catch (error) {
    if (!isAlreadyStarted(error)) throw error;
    return {
      handle: client.workflow.getHandle(options.workflowId),
      started: false
    };
  }
}

async function waitForState(handle, done) {
  const timeoutMs = Number(process.env.BRAI_TEMPORAL_WAIT_TIMEOUT_MS ?? 6 * 60 * 60 * 1000);
  const pollMs = Number(process.env.BRAI_TEMPORAL_WAIT_POLL_MS ?? 5000);
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() <= deadline) {
    lastState = await handle.query(STATE_QUERY);
    if (done(lastState)) return lastState;
    if (isBlocked(lastState)) throw new Error(`Temporal workflow blocked: ${JSON.stringify(lastState.blocker ?? lastState.blockers)}`);
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for ${handle.workflowId}; last state: ${JSON.stringify(lastState)}`);
}

function isBlocked(state) {
  return state?.status === "waiting_for_fix" || Boolean(state?.blocker);
}

function taskPassedForSha(state, task, sha) {
  return state.tasks?.[task]?.status === "passed" && state.tasks[task].sha === sha;
}

async function queryWorkflow(client, workflowId) {
  const state = await client.workflow.getHandle(workflowId).query(STATE_QUERY);
  printState(state);
}

async function readWorkflowResult(client, workflowId) {
  const state = await client.workflow.getHandle(workflowId).result();
  printState(state);
}

async function inventory(client, options) {
  const status = normalizeExecutionStatus(options.status ?? "RUNNING");
  const limit = Number(options.limit ?? 500);
  const prefix = options.prefix ?? "";
  const query = options.query ?? `ExecutionStatus = '${status}'`;
  const queryTimeoutMs = Number(process.env.BRAI_TEMPORAL_INVENTORY_QUERY_TIMEOUT_MS ?? 1000);
  const rows = [];

  for await (const info of client.workflow.list({ query })) {
    if (prefix && !info.workflowId.startsWith(prefix)) continue;
    const state = await queryWorkflowState(client, info.workflowId, queryTimeoutMs);
    const category = categoryFor(info, state);
    rows.push({
      workflowId: info.workflowId,
      runId: info.runId,
      type: info.type,
      status: info.status.name,
      group: groupFor(info.workflowId),
      category,
      startedAt: info.startTime?.toISOString?.() ?? "",
      stateStatus: state?.status ?? "",
      stateTerminal: state?.terminal ?? null,
      blocker: state?.blocker ?? null
    });
    if (rows.length >= limit) break;
  }

  const groups = {};
  const categories = {};
  for (const row of rows) {
    groups[row.group] = (groups[row.group] ?? 0) + 1;
    categories[row.category] = (categories[row.category] ?? 0) + 1;
  }
  console.log(JSON.stringify({ query, count: rows.length, groups, categories, rows }, null, 2));
}

async function supersedeOlderProdPromotions(client, currentSha, sourceEvent) {
  const query = "WorkflowType = 'PromotionWorkflow' AND ExecutionStatus = 'Running'";
  for await (const info of client.workflow.list({ query })) {
    const prefix = "brai:promotion:prod:";
    if (!info.workflowId.startsWith(prefix) || info.workflowId === promotionWorkflowId("prod", currentSha)) continue;
    const oldSha = info.workflowId.slice(prefix.length);
    const handle = client.workflow.getHandle(info.workflowId);
    await handle.signal(EVENT_SIGNAL, {
      ...sourceEvent,
      type: "superseded_closed",
      sha: oldSha,
      source: "superseded-promotion-recovery",
      reason: `Superseded by successful prod deploy ${currentSha}`
    });
    console.log(`superseded ${info.workflowId}`);
  }
}

async function queryWorkflowState(client, workflowId, timeoutMs) {
  try {
    return await Promise.race([
      client.workflow.getHandle(workflowId).query(STATE_QUERY),
      sleep(timeoutMs).then(() => null)
    ]);
  } catch {
    return null;
  }
}

function groupFor(workflowId) {
  if (workflowId.startsWith("brai:preview-deploy:")) return "brai-preview";
  if (workflowId.startsWith("brai:preview:")) return "brai-preview";
  if (workflowId.startsWith("brai:promotion:")) return "brai-promotion";
  if (workflowId.startsWith("bright-os:")) return "legacy-bright-os";
  return "other";
}

function categoryFor(info, state) {
  if (info.workflowId.startsWith("bright-os:")) return "legacy";
  if (state?.status === "waiting_for_fix" || state?.blocker) return "blocked";
  if (state?.terminal === true) return "stale";
  const ageMs = Date.now() - Number(info.startTime?.getTime?.() ?? Date.now());
  const staleMs = Number(process.env.BRAI_TEMPORAL_STALE_MS ?? 7 * 24 * 60 * 60 * 1000);
  return ageMs > staleMs ? "stale" : "active";
}

function normalizeExecutionStatus(status) {
  const normalized = String(status ?? "").toUpperCase();
  const statuses = {
    RUNNING: "Running",
    COMPLETED: "Completed",
    FAILED: "Failed",
    CANCELED: "Canceled",
    TERMINATED: "Terminated",
    CONTINUED_AS_NEW: "ContinuedAsNew",
    TIMED_OUT: "TimedOut"
  };
  return statuses[normalized] ?? status;
}

function buildEvent(type, options, sha) {
  const github = {
    ref: process.env.GITHUB_REF ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    serverUrl: process.env.GITHUB_SERVER_URL ?? "",
    repository: process.env.GITHUB_REPOSITORY ?? "",
    workflow: process.env.GITHUB_WORKFLOW ?? ""
  };
  const runUrl = options.runUrl ?? (
    github.serverUrl && github.repository && github.runId
      ? `${github.serverUrl}/${github.repository}/actions/runs/${github.runId}`
      : ""
  );
  return {
    type,
    sha,
    baseSha: options.baseSha ?? "",
    slot: options.slot ?? "",
    deliveryClass: options.deliveryClass ?? "",
    reason: options.reason ?? "",
    runUrl,
    prNumber: options.prNumber ?? "",
    prUrl: options.prUrl ?? "",
    mergedAt: options.mergedAt ?? "",
    closeOutcome: options.closeOutcome ?? "",
    requireRelease: options.requireRelease ?? "",
    acceptedPreview: options.acceptedPreview ?? "",
    restartTemporalWorker: options.restartTemporalWorker ?? "",
    source: options.source ?? process.env.GITHUB_JOB ?? "manual",
    at: options.at ?? new Date().toISOString(),
    github
  };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    parsed[toCamel(rawKey)] = inlineValue ?? args[index + 1] ?? "";
    if (inlineValue == null) index += 1;
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function required(options, key) {
  if (!options[key]) throw new Error(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return options[key];
}

function isAlreadyStarted(error) {
  return error?.name === "WorkflowExecutionAlreadyStartedError" || String(error?.message ?? "").includes("already started");
}

function printState(state) {
  console.log(JSON.stringify(state, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  console.error(`usage:
  npm run signal -- preview --branch codex/example --sha <sha> --event branch_pushed
  npm run signal -- dispatch-preview-deploy --branch codex/example --sha <sha> [--base-sha <sha>]
  npm run signal -- dispatch-no-preview-handoff --branch codex/example --sha <sha> --delivery-class infra-docs
  npm run signal -- dispatch-no-preview-merged --branch codex/example --sha <sha> --merged-at <iso>
  npm run signal -- dispatch-promotion --target prod --sha <sha> [--base-sha <sha>]
  npm run signal -- dispatch-release-preview --branch codex/example --sha <sha> --close-outcome abandoned_closed
  npm run signal -- promotion --target prod --sha <sha> --event prod_deploy_started
  npm run signal -- query-preview --branch codex/example
  npm run signal -- query-preview-deploy --branch codex/example --sha <sha>
  npm run signal -- cancel-preview-deploy --branch codex/example --sha <sha>
  npm run signal -- inventory [--status RUNNING] [--prefix brai:]`);
}
