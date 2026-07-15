import {
  ActivityCancellationType,
  condition,
  defineQuery,
  defineSignal,
  isCancellation,
  proxyActivities,
  setHandler,
  workflowInfo
} from "@temporalio/workflow";
import {
  EVENT_SIGNAL,
  STATE_QUERY,
  applyPreviewEvent,
  applyPromotionEvent,
  createPreviewState,
  createPromotionState
} from "./state.mjs";

const activities = proxyActivities({
  startToCloseTimeout: "8 hours",
  heartbeatTimeout: "15 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 1 }
});

const PREVIEW_REQUESTS = new Set([
  "preview_deploy_requested",
  "no_preview_handoff_requested",
  "no_preview_merged_requested",
  "slot_release_requested"
]);
const PROMOTION_REQUESTS = new Set(["promotion_requested"]);

export const eventSignal = defineSignal(EVENT_SIGNAL);
export const stateQuery = defineQuery(STATE_QUERY);

export async function BranchPreviewWorkflow(input) {
  const state = createPreviewState(input);
  const requests = [];

  setHandler(eventSignal, (event) => {
    if (PREVIEW_REQUESTS.has(event?.type)) {
      if (event?.sha && state.lastSha && event.sha !== state.lastSha) return;
      applyPreviewEvent(state, event);
      requests.push(event);
      return;
    }
    applyPreviewEvent(state, event);
  });
  setHandler(stateQuery, () => state);

  while (!state.terminal) {
    await condition(() => state.terminal || requests.length > 0);
    while (!state.terminal && requests.length > 0) {
      await runPreviewRequest(state, requests.shift());
    }
  }

  return state;
}

export async function BranchPreviewDeployWorkflow(input) {
  const state = createPreviewState(input);
  const info = workflowInfo();
  state.workflowId = info.workflowId;
  state.taskQueue = info.taskQueue;
  setHandler(stateQuery, () => state);
  applyPreviewEvent(state, {
    type: "delivery_classified",
    deliveryClass: "preview",
    sha: input.sha,
    at: input.at,
    source: input.source || "exact-sha-preview-deploy"
  });
  applyPreviewEvent(state, {
    type: "checks_passed",
    sha: input.sha,
    at: input.at,
    source: input.source || "exact-sha-preview-deploy"
  });
  await runPreviewDeploy(state, {
    type: "preview_deploy_requested",
    sha: input.sha,
    baseSha: input.baseSha || "",
    at: input.at,
    source: input.source || "exact-sha-preview-deploy"
  });
  return state;
}

export async function PromotionWorkflow(input) {
  const state = createPromotionState(input);
  const requests = [];

  setHandler(eventSignal, (event) => {
    if (PROMOTION_REQUESTS.has(event?.type)) {
      applyPromotionEvent(state, event);
      requests.push(event);
      return;
    }
    applyPromotionEvent(state, event);
  });
  setHandler(stateQuery, () => state);

  while (!state.terminal) {
    await condition(() => state.terminal || requests.length > 0);
    while (!state.terminal && requests.length > 0) {
      await runPromotionRequest(state, requests.shift());
    }
  }

  return state;
}

async function runPreviewRequest(state, request) {
  if (request.type === "preview_deploy_requested") {
    await runPreviewDeploy(state, request);
  } else if (request.type === "no_preview_handoff_requested") {
    await runNoPreviewHandoff(state, request);
  } else if (request.type === "no_preview_merged_requested") {
    await runNoPreviewMerged(state, request);
  } else if (request.type === "slot_release_requested") {
    await runSlotRelease(state, request);
  }
}

async function runPreviewDeploy(state, request) {
  applyPreviewEvent(state, eventLike(request, "preview_deploy_started"));
  applyPreviewEvent(state, eventLike(request, "supabase_preview_started"));

  let result;
  try {
    result = await activities.deployBranch({
      branch: state.branch,
      sha: request.sha || state.lastSha,
      baseSha: request.baseSha || ""
    });
    const passed = { slot: result.previewSlot || request.slot || "" };
    applyPreviewEvent(state, eventLike(request, "supabase_preview_passed", passed));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error), slot: request.slot || "" };
    applyPreviewEvent(state, eventLike(request, "supabase_preview_failed", failed));
    applyPreviewEvent(state, eventLike(request, "preview_deploy_failed", failed));
    return;
  }

  applyPreviewEvent(state, eventLike(request, "goal_agents_deploy_started", {
    slot: result.previewSlot || request.slot || ""
  }));
  try {
    const verified = await activities.verifyGoalAgentDeployment({
      branch: state.branch,
      sha: request.sha || state.lastSha,
      baseSha: request.baseSha || ""
    });
    const passed = { slot: verified.previewSlot || result.previewSlot || request.slot || "" };
    applyPreviewEvent(state, eventLike(request, "goal_agents_deploy_passed", passed));
    applyPreviewEvent(state, eventLike(request, "preview_deploy_passed", passed));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error), slot: result.previewSlot || request.slot || "" };
    applyPreviewEvent(state, eventLike(request, "goal_agents_deploy_failed", failed));
    applyPreviewEvent(state, eventLike(request, "preview_deploy_failed", failed));
  }
}

async function runNoPreviewHandoff(state, request) {
  applyPreviewEvent(state, eventLike(request, "delivery_handoff_started"));
  applyPreviewEvent(state, eventLike(request, "auto_merge_started"));

  try {
    const result = await activities.enableNoPreviewAutoMerge({
      branch: state.branch,
      sha: request.sha || state.lastSha
    });
    if (!result.awaitingOwnerHandoff) applyPreviewEvent(state, eventLike(request, "auto_merge_enabled"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPreviewEvent(state, eventLike(request, "delivery_handoff_failed", failed));
    applyPreviewEvent(state, eventLike(request, "auto_merge_failed", failed));
  }
}

async function runNoPreviewMerged(state, request) {
  applyPreviewEvent(state, eventLike(request, "delivery_handoff_passed"));
  try {
    await activities.cleanupAcceptedBranches({ branch: state.branch });
  } catch (error) {
    if (isCancellation(error)) throw error;
    applyPreviewEvent(state, eventLike(request, "delivery_handoff_failed", { reason: reasonFromError(error) }));
    return;
  }
  applyPreviewEvent(state, eventLike(request, "pr_merged"));
}

async function runSlotRelease(state, request) {
  applyPreviewEvent(state, eventLike(request, "supabase_preview_release_started"));
  applyPreviewEvent(state, eventLike(request, "slot_release_started"));

  try {
    const result = await activities.releasePreviewSlot({
      branch: state.branch,
      requireRelease: request.requireRelease === true || request.requireRelease === "true",
      acceptedPreview: request.acceptedPreview === true || request.acceptedPreview === "true"
    });

    if (result.released) {
      applyPreviewEvent(state, eventLike(request, "supabase_preview_released"));
      applyPreviewEvent(state, eventLike(request, "slot_released"));
      if (["abandoned_closed", "branch_deleted", "superseded_closed"].includes(request.closeOutcome)) {
        applyPreviewEvent(state, eventLike(request, request.closeOutcome));
      }
    } else if (request.closeOutcome === "branch_deleted") {
      applyPreviewEvent(state, eventLike(request, "branch_deleted"));
    } else {
      applyPreviewEvent(state, eventLike(request, request.closeOutcome || "abandoned_closed"));
    }
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPreviewEvent(state, eventLike(request, "supabase_preview_release_failed", failed));
    applyPreviewEvent(state, eventLike(request, "slot_release_failed", failed));
  }
}

async function runPromotionRequest(state, request) {
  if (state.target === "prod") {
    await runProdPromotion(state, request);
  } else {
    await runDevPromotion(state, request);
  }
}

async function runProdPromotion(state, request) {
  applyPromotionEvent(state, eventLike(request, "prod_deploy_started"));
  applyPromotionEvent(state, eventLike(request, "accepted_previews_started"));

  try {
    await activities.completeAcceptedPreviews({
      targetBranch: "main",
      targetEnvironment: "prod",
      targetCommit: state.sha,
      mode: "validate"
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPromotionEvent(state, eventLike(request, "accepted_previews_failed", failed));
    applyPromotionEvent(state, eventLike(request, "prod_deploy_failed", failed));
    return;
  }

  applyPromotionEvent(state, eventLike(request, "supabase_prod_migration_started"));

  try {
    await activities.deployBranch({
      branch: "main",
      sha: state.sha,
      baseSha: request.baseSha || ""
    });
    applyPromotionEvent(state, eventLike(request, "supabase_prod_migration_passed"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPromotionEvent(state, eventLike(request, "supabase_prod_migration_failed", failed));
    applyPromotionEvent(state, eventLike(request, "prod_deploy_failed", failed));
    return;
  }

  try {
    await activities.completeAcceptedPreviews({
      targetBranch: "main",
      targetEnvironment: "prod",
      targetCommit: state.sha,
      mode: "promote"
    });
    applyPromotionEvent(state, eventLike(request, "prod_work_reconciled"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    applyPromotionEvent(state, eventLike(request, "accepted_previews_failed", { reason: reasonFromError(error) }));
    return;
  }

  applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_started"));
  try {
    await activities.verifyGoalAgentDeployment({ branch: "main", sha: state.sha });
    applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_passed"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_failed", failed));
    applyPromotionEvent(state, eventLike(request, "prod_deploy_failed", failed));
    return;
  }

  try {
    await activities.completeAcceptedPreviews({
      targetBranch: "main",
      targetEnvironment: "prod",
      targetCommit: state.sha,
      mode: "release"
    });
    applyPromotionEvent(state, eventLike(request, "accepted_previews_passed"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    applyPromotionEvent(state, eventLike(request, "accepted_previews_failed", { reason: reasonFromError(error) }));
    return;
  }

  try {
    await activities.syncMainCheckout({
      sha: state.sha,
      restartTemporalWorker: false
    });
    await activities.cleanupAcceptedBranches({ recentMerged: true });
    if (request.restartTemporalWorker === true || request.restartTemporalWorker === "true") {
      await activities.syncMainCheckout({ sha: state.sha, restartTemporalWorker: true });
    }
  } catch (error) {
    if (isCancellation(error)) throw error;
    applyPromotionEvent(state, eventLike(request, "prod_deploy_failed", { reason: reasonFromError(error) }));
    return;
  }

  applyPromotionEvent(state, eventLike(request, "prod_deploy_passed"));
  applyPromotionEvent(state, eventLike(request, "released"));
}

async function runDevPromotion(state, request) {
  applyPromotionEvent(state, eventLike(request, "dev_deploy_started"));
  applyPromotionEvent(state, eventLike(request, "dev_supabase_migration_started"));

  try {
    await activities.deployBranch({
      branch: "dev",
      sha: state.sha,
      baseSha: request.baseSha || ""
    });
    applyPromotionEvent(state, eventLike(request, "dev_supabase_migration_passed"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPromotionEvent(state, eventLike(request, "dev_supabase_migration_failed", failed));
    applyPromotionEvent(state, eventLike(request, "dev_deploy_failed", failed));
    return;
  }

  applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_started"));
  try {
    await activities.verifyGoalAgentDeployment({ branch: "dev", sha: state.sha });
    applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_passed"));
    applyPromotionEvent(state, eventLike(request, "dev_version_recorded"));
    applyPromotionEvent(state, eventLike(request, "dev_deploy_passed"));
    applyPromotionEvent(state, eventLike(request, "released"));
  } catch (error) {
    if (isCancellation(error)) throw error;
    const failed = { reason: reasonFromError(error) };
    applyPromotionEvent(state, eventLike(request, "goal_agents_deploy_failed", failed));
    applyPromotionEvent(state, eventLike(request, "dev_deploy_failed", failed));
  }
}

function eventLike(source, type, extra = {}) {
  return {
    ...source,
    ...extra,
    type,
    source: source.source || "temporal-orchestrator"
  };
}

function reasonFromError(error) {
  return String(error?.message ?? error ?? "Temporal activity failed").slice(0, 1000);
}
