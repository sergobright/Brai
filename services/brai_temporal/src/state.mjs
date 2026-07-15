import {
  createTasks,
  normalizeEvent,
  refreshGates,
  remember,
  resetTask,
  setTask,
  setUnknownBlocker
} from "./state-helpers.mjs";

export {
  PROMOTION_EVENTS,
  PROMOTION_TASK_QUEUE,
  applyPromotionEvent,
  createPromotionState,
  promotionWorkflowId
} from "./promotion-state.mjs";

export const PREVIEW_TASK_QUEUE = "brai-preview";
export const STATE_QUERY = "state";
export const EVENT_SIGNAL = "event";

const HEAD_EVENTS = new Set(["branch_pushed", "delivery_classified", "delivery_classification_failed"]);
const NO_PREVIEW_TASKS = ["supabase_preview", "goal_agents_deploy", "preview_deploy", "accepted_preview_promotion", "supabase_preview_release", "slot_release"];
const PREVIEW_TASKS = {
  branch_pushed: "Branch push observed",
  delivery_classification: "Delivery path classification",
  checks: "GitHub checks",
  supabase_preview: "Supabase preview branch",
  goal_agents_deploy: "Goal agents deploy",
  preview_deploy: "Preview deploy",
  delivery_handoff: "No-preview delivery handoff",
  auto_merge: "No-preview auto-merge",
  accepted_for_target: "Accepted for target",
  accepted_preview_promotion: "Accepted preview metadata promotion",
  supabase_preview_release: "Supabase preview branch release",
  slot_release: "Preview slot release"
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
  "goal_agents_deploy_started",
  "goal_agents_deploy_passed",
  "goal_agents_deploy_failed",
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

export function previewWorkflowId(branch) {
  return `brai:preview:${branch}`;
}

export function previewDeployWorkflowId(branch, sha) {
  return `brai:preview-deploy:${branch}:${sha}`;
}

export function createPreviewState(input) {
  const state = {
    type: "branch-preview",
    workflowId: previewWorkflowId(input.branch),
    taskQueue: PREVIEW_TASK_QUEUE,
    branch: input.branch,
    lastSha: input.sha ?? "",
    seenShas: input.sha ? [input.sha] : [],
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
  state.seenShas ??= state.lastSha ? [state.lastSha] : [];
  if (state.lastSha && event.sha && event.sha !== state.lastSha) {
    if (state.seenShas.includes(event.sha) || !HEAD_EVENTS.has(event.type)) return state;
    if (event.type !== "branch_pushed") {
      applyPreviewEvent(state, { ...event, type: "branch_pushed", source: `${event.source || "unknown"}:head` });
    }
  }
  if (state.lastSha && !event.sha) return state;
  if (event.type === "branch_pushed" && event.sha && !state.seenShas.includes(event.sha)) {
    state.seenShas.push(event.sha);
  }
  if (event.sha) state.lastSha = event.sha;
  remember(state, event);

  if (event.slot) state.slot = event.slot;

  switch (event.type) {
    case "preview_deploy_requested":
      state.status = event.type;
      state.terminal = false;
      state.previewDeploy = "not_started";
      resetTask(state, "supabase_preview", event);
      resetTask(state, "goal_agents_deploy", event);
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
      resetTask(state, "goal_agents_deploy", event);
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
    case "goal_agents_deploy_started":
      state.status = event.type;
      setTask(state, "goal_agents_deploy", "running", event);
      break;
    case "goal_agents_deploy_passed":
      setTask(state, "goal_agents_deploy", "passed", event);
      state.status = previewReady(state) ? "ready_for_review" : event.type;
      break;
    case "goal_agents_deploy_failed":
      state.status = "waiting_for_fix";
      setTask(state, "goal_agents_deploy", "failed", event);
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
      markPreviewReleaseClosed(state, event);
      state.status = "branch_deleted";
      state.terminal = true;
      break;
    case "abandoned_closed":
      markPreviewReleaseClosed(state, event);
      state.status = "abandoned_closed";
      state.terminal = true;
      break;
    case "no_preview_merged":
      setTask(state, "accepted_for_target", "passed", event);
      state.status = "no_preview_merged";
      state.terminal = true;
      break;
    case "superseded_closed":
      markPreviewReleaseClosed(state, event);
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

function markPreviewReleaseClosed(state, event) {
  setTask(state, "slot_release", "passed", event);
  if (state.tasks.supabase_preview_release.status !== "passed") {
    setTask(state, "supabase_preview_release", "not_applicable", event);
  }
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
  return previewReadyForSha(state, state.lastSha);
}

export function previewReadyForSha(state, sha) {
  const passed = (name) => state.tasks?.[name]?.status === "passed" && state.tasks[name].sha === sha;
  return Boolean(sha) && state.lastSha === sha && state.checks === "passed" && state.previewDeploy === "passed" &&
    ["checks", "supabase_preview", "goal_agents_deploy", "preview_deploy"].every(passed);
}
