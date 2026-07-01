import { Client, Connection } from "@temporalio/client";
import {
  EVENT_SIGNAL,
  PREVIEW_EVENTS,
  PREVIEW_TASK_QUEUE,
  PROMOTION_EVENTS,
  PROMOTION_TASK_QUEUE,
  STATE_QUERY,
  previewWorkflowId,
  promotionWorkflowId
} from "./state.mjs";

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
  } else if (command === "query-preview") {
    await queryWorkflow(client, previewWorkflowId(required(opts, "branch")));
  } else if (command === "query-promotion") {
    await queryWorkflow(client, promotionWorkflowId(required(opts, "target"), required(opts, "sha")));
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

async function signalPreview(client, options) {
  const branch = required(options, "branch");
  const sha = options.sha ?? "";
  const event = buildEvent(options.event ?? "branch_pushed", options, sha);
  if (!PREVIEW_EVENTS.has(event.type)) throw new Error(`Unsupported preview event: ${event.type}`);
  const { handle, started } = await startOrGet(client, "BranchPreviewWorkflow", {
    args: [{ branch, sha, at: event.at, source: event.source }],
    taskQueue: process.env.BRIGHT_TEMPORAL_PREVIEW_TASK_QUEUE ?? PREVIEW_TASK_QUEUE,
    workflowId: previewWorkflowId(branch)
  });

  if (!started || event.type !== "branch_pushed") {
    await handle.signal(EVENT_SIGNAL, event);
  }
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
}

async function signalPromotion(client, options) {
  const target = required(options, "target");
  const sha = required(options, "sha");
  const event = buildEvent(options.event ?? "promotion_started", options, sha);
  if (!PROMOTION_EVENTS.has(event.type)) throw new Error(`Unsupported promotion event: ${event.type}`);
  const { handle, started } = await startOrGet(client, "PromotionWorkflow", {
    args: [{ target, sha, at: event.at, source: event.source }],
    taskQueue: process.env.BRIGHT_TEMPORAL_PROMOTION_TASK_QUEUE ?? PROMOTION_TASK_QUEUE,
    workflowId: promotionWorkflowId(target, sha)
  });

  if (!started || event.type !== "promotion_started") {
    await handle.signal(EVENT_SIGNAL, event);
  }
  console.log(`${started ? "started" : "signaled"} ${handle.workflowId} ${event.type}`);
}

async function startOrGet(client, workflowType, options) {
  try {
    const handle = await client.workflow.start(workflowType, options);
    return { handle, started: true };
  } catch (error) {
    if (!isAlreadyStarted(error)) throw error;
    return {
      handle: client.workflow.getHandle(options.workflowId),
      started: false
    };
  }
}

async function queryWorkflow(client, workflowId) {
  const state = await client.workflow.getHandle(workflowId).query(STATE_QUERY);
  console.log(JSON.stringify(state, null, 2));
}

function buildEvent(type, options, sha) {
  return {
    type,
    sha,
    slot: options.slot ?? "",
    deliveryClass: options.deliveryClass ?? "",
    reason: options.reason ?? "",
    prNumber: options.prNumber ?? "",
    prUrl: options.prUrl ?? "",
    mergedAt: options.mergedAt ?? "",
    source: options.source ?? process.env.GITHUB_JOB ?? "manual",
    at: options.at ?? new Date().toISOString(),
    github: {
      ref: process.env.GITHUB_REF ?? "",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
      runId: process.env.GITHUB_RUN_ID ?? "",
      serverUrl: process.env.GITHUB_SERVER_URL ?? "",
      repository: process.env.GITHUB_REPOSITORY ?? "",
      workflow: process.env.GITHUB_WORKFLOW ?? ""
    }
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

function usage() {
  console.error(`usage:
  npm run signal -- preview --branch codex/example --sha <sha> --event branch_pushed
  npm run signal -- promotion --target prod --sha <sha> --event prod_deploy_started
  npm run signal -- query-preview --branch codex/example
  npm run signal -- demo --branch codex/temporal-smoke`);
}
