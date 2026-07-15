import {
  createTasks,
  normalizeEvent,
  refreshGates,
  remember,
  resetTask,
  setTask,
  setUnknownBlocker
} from "./state-helpers.mjs";

export const PROMOTION_TASK_QUEUE = "brai-promotion";

const PROMOTION_TASKS = {
  supabase_migration: "Supabase migration",
  goal_agents_deploy: "Goal agents deploy",
  deploy: "Target deploy",
  version_recorded: "Version and deployment ledger recorded",
  accepted_previews: "Accepted preview promotion and slot release"
};

export const PROMOTION_EVENTS = new Set([
  "promotion_requested",
  "promotion_started",
  "dev_deploy_started",
  "dev_supabase_migration_started",
  "dev_supabase_migration_passed",
  "dev_supabase_migration_failed",
  "goal_agents_deploy_started",
  "goal_agents_deploy_passed",
  "goal_agents_deploy_failed",
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

export function promotionWorkflowId(target, sha) {
  return `brai:promotion:${target}:${sha}`;
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
      resetTask(state, "goal_agents_deploy", event);
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
      resetTask(state, "goal_agents_deploy", event);
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
    case "goal_agents_deploy_started":
      state.status = event.type;
      setTask(state, "goal_agents_deploy", "running", event);
      break;
    case "goal_agents_deploy_passed":
      state.status = event.type;
      setTask(state, "goal_agents_deploy", "passed", event);
      break;
    case "goal_agents_deploy_failed":
      state.status = "waiting_for_fix";
      setTask(state, "goal_agents_deploy", "failed", event);
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
