export const PREVIEW_TASK_QUEUE = "bright-os-preview";
export const PROMOTION_TASK_QUEUE = "bright-os-promotion";
export const STATE_QUERY = "state";
export const EVENT_SIGNAL = "event";

const MAX_EVENTS = 100;
const NO_PREVIEW_TASKS = ["preview_deploy", "accepted_preview_promotion", "slot_release"];
const PREVIEW_TASKS = {
  branch_pushed: "Branch push observed",
  delivery_classification: "Delivery path classification",
  checks: "GitHub checks",
  preview_deploy: "Preview deploy",
  delivery_handoff: "Infra/docs delivery handoff",
  auto_merge: "Infra/docs auto-merge",
  accepted_for_dev: "Accepted for target",
  accepted_preview_promotion: "Accepted preview metadata promotion",
  slot_release: "Preview slot release"
};
const PROMOTION_TASKS = {
  deploy: "Target deploy",
  version_recorded: "Version and deployment ledger recorded",
  accepted_previews: "Accepted preview promotion and slot release"
};

export const PREVIEW_EVENTS = new Set([
  "branch_pushed",
  "delivery_classified",
  "delivery_classification_failed",
  "delivery_handoff_started",
  "delivery_handoff_passed",
  "delivery_handoff_failed",
  "auto_merge_started",
  "auto_merge_enabled",
  "auto_merge_failed",
  "no_preview_required",
  "checks_started",
  "checks_passed",
  "checks_failed",
  "preview_deploy_started",
  "preview_deploy_passed",
  "preview_deploy_failed",
  "pr_merged",
  "accepted_preview_started",
  "accepted_preview_promoted",
  "accepted_preview_failed",
  "slot_release_started",
  "slot_released",
  "slot_release_failed",
  "release_failed",
  "released",
  "branch_deleted"
]);

export const PROMOTION_EVENTS = new Set([
  "promotion_started",
  "dev_deploy_started",
  "dev_version_recorded",
  "accepted_previews_started",
  "accepted_previews_passed",
  "accepted_previews_failed",
  "dev_deploy_passed",
  "dev_deploy_failed",
  "prod_deploy_started",
  "prod_version_recorded",
  "prod_deploy_passed",
  "prod_deploy_failed",
  "released"
]);

export function previewWorkflowId(branch) {
  return `bright-os:preview:${branch}`;
}

export function promotionWorkflowId(target, sha) {
  return `bright-os:promotion:${target}:${sha}`;
}

export function createPreviewState(input) {
  const state = {
    type: "branch-preview",
    workflowId: previewWorkflowId(input.branch),
    taskQueue: PREVIEW_TASK_QUEUE,
    branch: input.branch,
    lastSha: input.sha ?? "",
    deliveryClass: input.deliveryClass ?? "preview",
    handoff: "not_started",
    autoMerge: "not_started",
    status: "branch_pushed",
    terminal: false,
    checks: "not_started",
    previewDeploy: "not_started",
    slot: "",
    blocker: null,
    blockers: [],
    tasks: createTasks(PREVIEW_TASKS),
    events: []
  };
  return applyPreviewEvent(state, {
    type: "branch_pushed",
    sha: input.sha,
    source: input.source ?? "workflow-start",
    at: input.at
  });
}

export function applyPreviewEvent(state, rawEvent) {
  const event = normalizeEvent(rawEvent);
  if (event.sha) state.lastSha = event.sha;
  remember(state, event);

  if (event.slot) state.slot = event.slot;

  switch (event.type) {
    case "branch_pushed":
      state.status = "branch_pushed";
      state.terminal = false;
      state.checks = "not_started";
      state.previewDeploy = "not_started";
      state.slot = "";
      state.deliveryClass = event.deliveryClass || "preview";
      state.handoff = "not_started";
      state.autoMerge = "not_started";
      state.blocker = null;
      state.blockers = [];
      resetTask(state, "delivery_classification", event);
      resetTask(state, "delivery_handoff", event);
      resetTask(state, "auto_merge", event);
      resetTask(state, "checks", event);
      resetTask(state, "preview_deploy", event);
      resetTask(state, "accepted_for_dev", event);
      resetTask(state, "accepted_preview_promotion", event);
      resetTask(state, "slot_release", event);
      setTask(state, "branch_pushed", "passed", event);
      break;
    case "delivery_classified":
      state.deliveryClass = event.deliveryClass || state.deliveryClass;
      state.status = "delivery_classified";
      setTask(state, "delivery_classification", "passed", event);
      if (state.deliveryClass === "infra-docs") {
        markNoPreviewRequired(state, event);
      } else {
        setTask(state, "delivery_handoff", "not_applicable", event);
        setTask(state, "auto_merge", "not_applicable", event);
      }
      break;
    case "delivery_classification_failed":
      state.status = "waiting_for_fix";
      setTask(state, "delivery_classification", "failed", event);
      break;
    case "no_preview_required":
      state.deliveryClass = event.deliveryClass || (state.deliveryClass === "preview" ? "infra-docs" : state.deliveryClass);
      state.status = "no_preview_required";
      markNoPreviewRequired(state, event);
      break;
    case "delivery_handoff_started":
      state.handoff = "running";
      state.status = "delivery_handoff_started";
      setTask(state, "delivery_handoff", "running", event);
      break;
    case "delivery_handoff_passed":
      state.handoff = "passed";
      state.status = "delivery_handoff_passed";
      setTask(state, "delivery_handoff", "passed", event);
      break;
    case "delivery_handoff_failed":
      state.handoff = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "delivery_handoff", "failed", event);
      break;
    case "auto_merge_started":
      state.autoMerge = "running";
      state.status = "auto_merge_started";
      setTask(state, "auto_merge", "running", event);
      break;
    case "auto_merge_enabled":
      state.autoMerge = "enabled";
      state.status = "auto_merge_enabled";
      setTask(state, "auto_merge", "passed", event);
      break;
    case "auto_merge_failed":
      state.autoMerge = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "auto_merge", "failed", event);
      break;
    case "checks_started":
      state.checks = "running";
      state.status = "checks_started";
      setTask(state, "checks", "running", event);
      break;
    case "checks_passed":
      state.checks = "passed";
      state.status = state.previewDeploy === "passed" ? "ready_for_review" : "checks_passed";
      setTask(state, "checks", "passed", event);
      break;
    case "checks_failed":
      state.checks = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "checks", "failed", event);
      break;
    case "preview_deploy_started":
      state.previewDeploy = "running";
      state.status = "preview_deploy_started";
      setTask(state, "preview_deploy", "running", event);
      break;
    case "preview_deploy_passed":
      state.previewDeploy = "passed";
      state.status = state.checks === "passed" ? "ready_for_review" : "preview_deploy_passed";
      setTask(state, "preview_deploy", "passed", event);
      break;
    case "preview_deploy_failed":
      state.previewDeploy = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "preview_deploy", "failed", event);
      break;
    case "pr_merged":
      setTask(state, "accepted_for_dev", "passed", event);
      state.status = "accepted_for_dev";
      if (isNoPreviewRequired(state)) {
        state.slot = "";
        state.terminal = true;
      }
      break;
    case "accepted_preview_started":
      setTask(state, "accepted_preview_promotion", "running", event);
      state.status = "accepted_preview_started";
      break;
    case "accepted_preview_promoted":
      setTask(state, "accepted_preview_promotion", "passed", event);
      state.status = "accepted_preview_promoted";
      break;
    case "accepted_preview_failed":
      setTask(state, "accepted_preview_promotion", "failed", event);
      state.status = "waiting_for_fix";
      break;
    case "slot_release_started":
      setTask(state, "slot_release", "running", event);
      state.status = "slot_release_started";
      break;
    case "slot_released":
    case "released":
      setTask(state, "slot_release", "passed", event);
      state.status = "released";
      state.terminal = true;
      break;
    case "slot_release_failed":
    case "release_failed":
      setTask(state, "slot_release", "failed", event);
      state.status = "waiting_for_fix";
      break;
    case "branch_deleted":
      state.status = "branch_deleted";
      state.terminal = true;
      break;
    default:
      state.status = "waiting_for_fix";
      setUnknownBlocker(state, event);
  }

  refreshGates(state, PREVIEW_TASKS);
  return state;
}

export function createPromotionState(input) {
  const state = {
    type: "promotion",
    workflowId: promotionWorkflowId(input.target, input.sha),
    taskQueue: PROMOTION_TASK_QUEUE,
    target: input.target,
    sha: input.sha,
    status: "promotion_started",
    terminal: false,
    deploy: "not_started",
    blocker: null,
    blockers: [],
    tasks: createTasks(PROMOTION_TASKS),
    events: []
  };
  if (input.target !== "dev" && input.target !== "prod") state.tasks.accepted_previews.status = "not_applicable";
  return applyPromotionEvent(state, {
    type: "promotion_started",
    sha: input.sha,
    source: input.source ?? "workflow-start",
    at: input.at
  });
}

export function applyPromotionEvent(state, rawEvent) {
  const event = normalizeEvent(rawEvent);
  remember(state, event);

  switch (event.type) {
    case "promotion_started":
      state.status = "promotion_started";
      break;
    case "dev_deploy_started":
    case "prod_deploy_started":
      state.deploy = "running";
      state.status = event.type;
      setTask(state, "deploy", "running", event);
      if (state.target === "dev" || state.target === "prod") resetTask(state, "accepted_previews", event);
      resetTask(state, "version_recorded", event);
      break;
    case "dev_version_recorded":
    case "prod_version_recorded":
      setTask(state, "version_recorded", "passed", event);
      state.status = event.type;
      break;
    case "accepted_previews_started":
      setTask(state, "accepted_previews", "running", event);
      state.status = event.type;
      break;
    case "accepted_previews_passed":
      setTask(state, "accepted_previews", "passed", event);
      state.status = event.type;
      break;
    case "accepted_previews_failed":
      setTask(state, "accepted_previews", "failed", event);
      state.status = "waiting_for_fix";
      break;
    case "dev_deploy_passed":
    case "prod_deploy_passed":
      state.deploy = "passed";
      state.status = event.type;
      setTask(state, "deploy", "passed", event);
      break;
    case "dev_deploy_failed":
    case "prod_deploy_failed":
      state.deploy = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "deploy", "failed", event);
      break;
    case "released":
      state.status = "released";
      state.terminal = true;
      break;
    default:
      state.status = "waiting_for_fix";
      setUnknownBlocker(state, event);
  }

  refreshGates(state, PROMOTION_TASKS);
  if (state.deploy === "passed" && state.gates.complete) state.terminal = true;
  return state;
}

function normalizeEvent(event) {
  return {
    ...event,
    type: String(event?.type ?? "unknown"),
    at: event?.at ?? ""
  };
}

function remember(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}

function createTasks(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([name, label]) => [name, createTask(label)]));
}

function createTask(label) {
  return {
    label,
    status: "pending",
    lastEvent: "",
    lastAt: "",
    sha: "",
    source: ""
  };
}

function markNoPreviewRequired(state, event) {
  state.previewDeploy = "not_applicable";
  state.slot = "";
  for (const task of NO_PREVIEW_TASKS) setTask(state, task, "not_applicable", event);
}

function isNoPreviewRequired(state) {
  return state.tasks.preview_deploy?.status === "not_applicable";
}

function resetTask(state, name, event) {
  const task = taskFor(state, name);
  task.status = "pending";
  task.lastEvent = event.type;
  task.lastAt = event.at;
  task.sha = event.sha ?? task.sha;
  task.source = event.source ?? task.source;
  delete task.blocker;
  refreshBlockers(state);
}

function setTask(state, name, status, event) {
  const task = taskFor(state, name);
  task.status = status;
  task.lastEvent = event.type;
  task.lastAt = event.at;
  task.sha = event.sha ?? task.sha;
  task.source = event.source ?? task.source;
  if (status === "failed") {
    setBlocker(state, name, event);
  } else if (status === "running" || status === "passed" || status === "not_applicable") {
    delete task.blocker;
    refreshBlockers(state);
  }
}

function taskFor(state, name) {
  if (!state.tasks[name]) state.tasks[name] = createTask(name);
  return state.tasks[name];
}

function setBlocker(state, task, event) {
  taskFor(state, task).blocker = {
    task,
    event: event.type,
    at: event.at,
    sha: event.sha ?? "",
    source: event.source ?? ""
  };
  refreshBlockers(state);
}

function setUnknownBlocker(state, event) {
  state.blocker = {
    task: "unknown_event",
    event: event.type,
    at: event.at,
    sha: event.sha ?? "",
    source: event.source ?? ""
  };
  state.blockers = [state.blocker];
}

function refreshBlockers(state) {
  const blockers = Object.entries(state.tasks)
    .filter(([, task]) => task.status === "failed")
    .map(([task, details]) => details.blocker ?? {
      task,
      event: details.lastEvent,
      at: details.lastAt,
      sha: details.sha,
      source: details.source
    });
  state.blockers = blockers;
  state.blocker = blockers.at(-1) ?? null;
}

function refreshGates(state, definitions) {
  const missing = Object.entries(definitions)
    .filter(([name]) => state.tasks[name]?.status !== "passed" && state.tasks[name]?.status !== "not_applicable")
    .map(([name, label]) => ({ task: name, label, status: state.tasks[name]?.status ?? "missing" }));
  state.missing = missing;
  state.gates = {
    complete: missing.length === 0 && state.blockers.length === 0,
    missing
  };
}
