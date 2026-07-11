export const PREVIEW_TASK_QUEUE = "brai-preview";
export const PROMOTION_TASK_QUEUE = "brai-promotion";
export const STATE_QUERY = "state";
export const EVENT_SIGNAL = "event";

const MAX_EVENTS = 100;
const NO_PREVIEW_TASKS = ["supabase_preview", "preview_deploy", "accepted_preview_promotion", "supabase_preview_release", "slot_release"];
const PREVIEW_TASKS = {
  branch_pushed: "Branch push observed",
  delivery_classification: "Delivery path classification",
  checks: "GitHub checks",
  supabase_preview: "Supabase preview branch",
  preview_deploy: "Preview deploy",
  delivery_handoff: "No-preview delivery handoff",
  auto_merge: "No-preview auto-merge",
  accepted_for_target: "Accepted for target",
  accepted_preview_promotion: "Accepted preview metadata promotion",
  supabase_preview_release: "Supabase preview branch release",
  slot_release: "Preview slot release"
};
const PROMOTION_TASKS = {
  supabase_migration: "Supabase migration",
  deploy: "Target deploy",
  version_recorded: "Version and deployment ledger recorded",
  accepted_previews: "Accepted preview promotion and slot release"
};

export const PREVIEW_EVENTS = new Set([
  "preview_deploy_requested",
  "no_preview_handoff_requested",
  "no_preview_merged_requested",
  "slot_release_requested",
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
  "supabase_preview_started",
  "supabase_preview_passed",
  "supabase_preview_failed",
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
  "supabase_preview_release_started",
  "supabase_preview_released",
  "supabase_preview_release_failed",
  "release_failed",
  "released",
  "abandoned_closed",
  "no_preview_merged",
  "superseded_closed",
  "branch_deleted"
]);

export const PROMOTION_EVENTS = new Set([
  "promotion_requested",
  "promotion_started",
  "dev_deploy_started",
  "dev_supabase_migration_started",
  "dev_supabase_migration_passed",
  "dev_supabase_migration_failed",
  "dev_version_recorded",
  "accepted_previews_started",
  "accepted_previews_passed",
  "accepted_previews_failed",
  "dev_deploy_passed",
  "dev_deploy_failed",
  "prod_deploy_started",
  "supabase_prod_migration_started",
  "supabase_prod_migration_passed",
  "supabase_prod_migration_failed",
  "prod_version_recorded",
  "prod_deploy_passed",
  "prod_deploy_failed",
  "released",
  "superseded_closed"
]);

export function previewWorkflowId(branch) {
  return `brai:preview:${branch}`;
}

export function promotionWorkflowId(target, sha) {
  return `brai:promotion:${target}:${sha}`;
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
    case "preview_deploy_requested":
      state.status = event.type;
      state.terminal = false;
      state.previewDeploy = "not_started";
      resetTask(state, "supabase_preview", event);
      resetTask(state, "preview_deploy", event);
      break;
    case "no_preview_handoff_requested":
      state.status = event.type;
      state.terminal = false;
      state.handoff = "not_started";
      state.autoMerge = "not_started";
      resetTask(state, "delivery_handoff", event);
      resetTask(state, "auto_merge", event);
      break;
    case "no_preview_merged_requested":
      state.status = event.type;
      state.terminal = false;
      resetTask(state, "delivery_handoff", event);
      break;
    case "slot_release_requested":
      state.status = event.type;
      state.terminal = false;
      resetTask(state, "supabase_preview_release", event);
      resetTask(state, "slot_release", event);
      break;
    case "branch_pushed":
      const classification = state.tasks.delivery_classification;
      const keepClassification = classification?.status === "passed" && classification.sha === event.sha;
      const keepNoPreview = keepClassification && isNoPreviewDeliveryClass(state.deliveryClass) && isNoPreviewRequired(state);
      state.status = "branch_pushed";
      state.terminal = false;
      state.checks = "not_started";
      state.previewDeploy = "not_started";
      state.slot = "";
      state.deliveryClass = keepClassification ? state.deliveryClass : event.deliveryClass || "preview";
      state.handoff = "not_started";
      state.autoMerge = "not_started";
      state.blocker = null;
      state.blockers = [];
      if (!keepClassification) resetTask(state, "delivery_classification", event);
      resetTask(state, "delivery_handoff", event);
      resetTask(state, "auto_merge", event);
      resetTask(state, "checks", event);
      resetTask(state, "supabase_preview", event);
      resetTask(state, "preview_deploy", event);
      resetTask(state, "accepted_for_target", event);
      resetTask(state, "accepted_preview_promotion", event);
      resetTask(state, "supabase_preview_release", event);
      resetTask(state, "slot_release", event);
      if (keepNoPreview) markNoPreviewRequired(state, event);
      setTask(state, "branch_pushed", "passed", event);
      break;
    case "delivery_classified":
      state.deliveryClass = event.deliveryClass || state.deliveryClass;
      state.status = "delivery_classified";
      setTask(state, "delivery_classification", "passed", event);
      if (isNoPreviewDeliveryClass(state.deliveryClass)) {
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
      setTask(state, "checks", "passed", event);
      state.status = previewReady(state) ? "ready_for_review" : "checks_passed";
      break;
    case "checks_failed":
      state.checks = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "checks", "failed", event);
      break;
    case "supabase_preview_started":
      state.status = event.type;
      setTask(state, "supabase_preview", "running", event);
      break;
    case "supabase_preview_passed":
      setTask(state, "supabase_preview", "passed", event);
      state.status = previewReady(state) ? "ready_for_review" : event.type;
      break;
    case "supabase_preview_failed":
      state.status = "waiting_for_fix";
      setTask(state, "supabase_preview", "failed", event);
      break;
    case "preview_deploy_started":
      state.previewDeploy = "running";
      state.status = "preview_deploy_started";
      setTask(state, "preview_deploy", "running", event);
      break;
    case "preview_deploy_passed":
      state.previewDeploy = "passed";
      setTask(state, "preview_deploy", "passed", event);
      state.status = previewReady(state) ? "ready_for_review" : "preview_deploy_passed";
      break;
    case "preview_deploy_failed":
      state.previewDeploy = "failed";
      state.status = "waiting_for_fix";
      setTask(state, "preview_deploy", "failed", event);
      break;
    case "pr_merged":
      setTask(state, "accepted_for_target", "passed", event);
      state.status = "accepted_for_target";
      if (isNoPreviewRequired(state)) {
        state.slot = "";
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
    case "supabase_preview_release_started":
      setTask(state, "supabase_preview_release", "running", event);
      state.status = event.type;
      break;
    case "supabase_preview_released":
      setTask(state, "supabase_preview_release", "passed", event);
      state.status = event.type;
      break;
    case "supabase_preview_release_failed":
      setTask(state, "supabase_preview_release", "failed", event);
      state.status = "waiting_for_fix";
      break;
    case "slot_released":
    case "released":
      setTask(state, "slot_release", "passed", event);
      if (event.source === "complete-accepted-previews") {
        state.status = "slot_released";
        state.terminal = false;
      } else {
        state.status = "released";
        state.terminal = true;
      }
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
    case "abandoned_closed":
      setTask(state, "slot_release", "passed", event);
      if (state.tasks.supabase_preview_release.status !== "passed") {
        setTask(state, "supabase_preview_release", "not_applicable", event);
      }
      state.status = "abandoned_closed";
      state.terminal = true;
      break;
    case "no_preview_merged":
      setTask(state, "accepted_for_target", "passed", event);
      state.status = "no_preview_merged";
      state.terminal = true;
      break;
    case "superseded_closed":
      state.status = "superseded_closed";
      state.terminal = true;
      break;
    default:
      state.status = "waiting_for_fix";
      setUnknownBlocker(state, event);
  }

  refreshGates(state, PREVIEW_TASKS);
  if (isNoPreviewRequired(state) && state.tasks.accepted_for_target.status === "passed" && state.gates.complete) {
    state.status = "no_preview_merged";
    state.terminal = true;
  }
  if (
    event.source === "complete-accepted-previews" &&
    state.tasks.accepted_for_target.status === "passed" &&
    state.tasks.accepted_preview_promotion.status === "passed" &&
    state.tasks.slot_release.status === "passed" &&
    state.gates.complete
  ) {
    state.status = "released";
    state.terminal = true;
  }
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
  if (input.target !== "prod") state.tasks.accepted_previews.status = "not_applicable";
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
    case "promotion_requested":
      state.status = event.type;
      state.terminal = false;
      state.deploy = "not_started";
      resetTask(state, "supabase_migration", event);
      resetTask(state, "deploy", event);
      resetTask(state, "version_recorded", event);
      if (state.target === "prod") {
        resetTask(state, "accepted_previews", event);
      }
      break;
    case "promotion_started":
      state.status = "promotion_started";
      break;
    case "dev_deploy_started":
    case "prod_deploy_started":
      state.deploy = "running";
      state.status = event.type;
      setTask(state, "deploy", "running", event);
      if (state.target === "prod") resetTask(state, "accepted_previews", event);
      resetTask(state, "version_recorded", event);
      break;
    case "dev_supabase_migration_started":
    case "supabase_prod_migration_started":
      state.status = event.type;
      setTask(state, "supabase_migration", "running", event);
      break;
    case "dev_supabase_migration_passed":
    case "supabase_prod_migration_passed":
      state.status = event.type;
      setTask(state, "supabase_migration", "passed", event);
      break;
    case "dev_supabase_migration_failed":
    case "supabase_prod_migration_failed":
      state.status = "waiting_for_fix";
      setTask(state, "supabase_migration", "failed", event);
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
    case "superseded_closed":
      state.status = "superseded_closed";
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

function isNoPreviewDeliveryClass(deliveryClass) {
  return deliveryClass === "infra-docs" || deliveryClass === "technical-no-preview";
}

function previewReady(state) {
  return state.checks === "passed" &&
    state.previewDeploy === "passed" &&
    state.tasks.supabase_preview?.status === "passed";
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
  const blocker = blockerFromEvent(task, event);
  const currentTask = taskFor(state, task);
  currentTask.blocker = blocker;
  currentTask.lastFailure = blocker;
  refreshBlockers(state);
}

function setUnknownBlocker(state, event) {
  state.blocker = blockerFromEvent("unknown_event", event);
  state.blockers = [state.blocker];
}

function blockerFromEvent(task, event) {
  return stripEmpty({
    task,
    event: event.type,
    at: event.at,
    sha: event.sha ?? "",
    source: event.source ?? "",
    reason: event.reason ?? "",
    runUrl: event.runUrl ?? "",
    attempt: event.github?.runAttempt ?? "",
    runId: event.github?.runId ?? "",
    slot: event.slot ?? "",
    deliveryClass: event.deliveryClass ?? "",
    prNumber: event.prNumber ?? "",
    prUrl: event.prUrl ?? "",
    mergedAt: event.mergedAt ?? ""
  });
}

function stripEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== "" && field != null));
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
