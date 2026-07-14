import { ApplicationFailure, proxyActivities, workflowInfo } from "@temporalio/workflow";
import {
  MAX_AGENT_INPUT_BYTES,
  MAX_AGENT_RESULT_LLM_CALLS,
  MAX_CONTEXT_PAGES,
  assertContextDescriptor,
  assertContextPage,
  assertExecutionReference
} from "./contracts.mjs";
import {
  compareDiscoveryAgainstGoals,
  discoverySourceSummary,
  discoverySummary,
  interleave,
  packMergeBatches
} from "./workflow-discovery.mjs";
import { assertContextSmokeResponse, contextSmokeRequest } from "./context-smoke-contract.mjs";

const { invokeAgent } = proxyActivities({
  startToCloseTimeout: "2 minutes",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 }
});

const PAGE_SIZE = 50;
const MAX_PAGES = MAX_CONTEXT_PAGES;
const MAX_MERGE_ROUNDS = 20;
const MAX_WORKFLOW_RESULT_BYTES = 1_048_576;
const MAX_LLM_CALLS_PER_ACTIVITY = 3;
const LLM_CALL_BUDGET_EXHAUSTED = "workflow_llm_call_budget_exhausted";

export async function ActivityClassifierWorkflow(reference) {
  const context = await loadContext(reference, "activity.classifier");
  const result = await runSingleAgent(
    "activity.classifier", context.base, durableAgentCall(reference, invokeAgent), workflowInfo()
  );
  await persistResult(reference, result);
  return workflowResult(result);
}

export async function GoalItemMatcherWorkflow(reference) {
  const context = await loadContext(reference, "goal.item-matcher");
  const result = await runPagedAgentFromContext(
    "goal.item-matcher", reference, context, "items", durableAgentCall(reference, invokeAgent), workflowInfo()
  );
  await persistResult(reference, result);
  return workflowResult(result);
}

export async function GoalMemberFinderWorkflow(reference) {
  const context = await loadContext(reference, "goal.member-finder");
  const result = await runPagedAgentFromContext(
    "goal.member-finder", reference, context, "items", durableAgentCall(reference, invokeAgent), workflowInfo()
  );
  await persistResult(reference, result);
  return workflowResult(result);
}

export async function GoalDiscoveryWorkflow(reference) {
  const context = await loadContext(reference, "goal.discovery");
  const result = await runDiscoveryFromContext(
    reference, context, durableAgentCall(reference, invokeAgent), workflowInfo()
  );
  await persistResult(reference, result);
  return workflowResult(result);
}

export async function GoalPlannerWorkflow(reference) {
  const context = await loadContext(reference, "goal.planner");
  const result = await runPlannerFromContext(
    reference, context, durableAgentCall(reference, invokeAgent), workflowInfo()
  );
  await persistResult(reference, result);
  return workflowResult(result);
}

export async function GoalAgentContextSmokeWorkflow(input) {
  const request = contextSmokeRequest(input, workflowInfo());
  const { goalAgentContextSmoke } = proxyActivities({
    taskQueue: request.context_task_queue,
    scheduleToCloseTimeout: "15 seconds",
    startToCloseTimeout: "10 seconds",
    retry: { maximumAttempts: 1 }
  });
  return assertContextSmokeResponse(await goalAgentContextSmoke(request), request);
}

export function workflowResult(result) {
  if (result?.status === "completed") return result;
  throw ApplicationFailure.nonRetryable(
    result?.error?.message ?? "goal_agent_failed",
    "GoalAgentResultFailure",
    result
  );
}

export function durableAgentCall(reference, call, persist = persistReturnedLlmCalls) {
  return async (input) => {
    const result = await call(input);
    await persist(reference, result);
    return result;
  };
}

export async function runSingleAgent(expectedAgentId, input, call, info) {
  assertAgent(input, expectedAgentId);
  return call(enrichWorkflowInput(withoutPages(input), info));
}

export async function runPagedAgentFromContext(expectedAgentId, reference, context, pageKind, call, info, load = loadPage) {
  assertAgent(context.base, expectedAgentId);
  const pageCount = validatedPageCount(context, pageKind);
  const results = [];
  for (let index = 0; index < pageCount; index += 1) {
    const page = await load(reference, pageKind, index);
    const result = await call(pageInput(context.base, { items: page.items }, info));
    results.push(result);
    if (result.status !== "completed") return aggregateResults(results, []);
  }
  return aggregateResults(results, dedupeDecisions(results.flatMap((result) => result.decisions)));
}

export async function runDiscoveryFromContext(reference, context, call, info, load = loadPage) {
  assertAgent(context.base, "goal.discovery");
  const itemPageCount = validatedPageCount(context, "items");
  const goalPageCount = validatedPageCount(context, "goals");
  const results = [];
  const mapped = [];
  const provisionalPages = [];
  for (let index = 0; index < itemPageCount; index += 1) {
    if (!hasDiscoveryCallBudget(results)) return aggregateFailure(results, LLM_CALL_BUDGET_EXHAUSTED);
    const page = await load(reference, "items", index);
    const result = await call(pageInput(context.base, { items: page.items }, info, {
      stage: "map", page_index: index, page_count: itemPageCount
    }));
    results.push(result);
    if (result.status !== "completed") return aggregateResults(results, []);
    mapped.push(...result.decisions.map(discoverySummary));
    provisionalPages.push(page.items.map(discoverySourceSummary));
  }
  let decisions;
  try {
    decisions = await mergeDiscoveryCandidates(
      context.base,
      [...mapped, ...interleave(provisionalPages)],
      results,
      call,
      info
    );
  } catch (error) {
    return aggregateFailure(results, errorCode(error));
  }
  for (let index = 0; index < goalPageCount; index += 1) {
    const goals = await load(reference, "goals", index);
    try {
      const comparison = await compareDiscoveryAgainstGoals({
        decisions, goals: goals.items,
        call: budgetedDiscoveryCall(results, call),
        results,
        buildInput: (candidates, existingGoals, batchIndex, batchCount) => mergeInput(
          context.base, candidates, info, {
            round: index + 1, batchIndex, batchCount, existingGoals
          }
        )
      });
      if (comparison.failed) return aggregateResults(results, []);
      decisions = comparison.decisions;
    } catch (error) {
      return aggregateFailure(results, errorCode(error));
    }
  }
  return aggregateResults(results, decisions);
}

export async function runPlannerFromContext(reference, context, call, info, load = loadPage) {
  assertAgent(context.base, "goal.planner");
  const pageCount = validatedPageCount(context, "members");
  const results = [];
  const plans = [];
  for (let index = 0; index < pageCount; index += 1) {
    const page = await load(reference, "members", index);
    const result = await call(pageInput(context.base, { members: page.items }, info, {
      stage: "map", page_index: index, page_count: pageCount
    }));
    results.push(result);
    if (result.status !== "completed") return aggregateResults(results, []);
    plans.push(...result.decisions);
  }
  if (plans.length === 0) return aggregateResults(results, []);
  try {
    return aggregateResults(results, await mergePlannerCandidates(context.base, plans, results, call, info));
  } catch (error) {
    return aggregateFailure(results, errorCode(error));
  }
}

async function loadContext(reference, expectedAgentId) {
  assertExecutionReference(reference, expectedAgentId);
  const { loadGoalAgentContext } = contextActivities(reference);
  return assertContextDescriptor(await loadGoalAgentContext(reference), reference);
}

async function loadPage(reference, kind, index) {
  const { loadGoalAgentPage } = contextActivities(reference);
  return assertContextPage(
    await loadGoalAgentPage({ reference, kind, index }),
    reference,
    kind,
    index
  );
}

async function persistResult(reference, result) {
  const { persistGoalAgentResult } = contextActivities(reference);
  const acknowledgement = await persistGoalAgentResult({ reference, result });
  if (result.status === "completed" && acknowledgement?.execution_status !== "completed") {
    throw ApplicationFailure.nonRetryable(
      acknowledgement?.last_error ?? "goal_agent_persistence_rejected",
      "GoalAgentPersistenceRejected",
      acknowledgement
    );
  }
  return acknowledgement;
}

async function persistReturnedLlmCalls(reference, result) {
  const { persistGoalAgentLlmCalls } = contextActivities(reference);
  const acknowledgement = await persistGoalAgentLlmCalls({ reference, result });
  const expectedIds = Array.isArray(result?.llm_calls)
    ? result.llm_calls.map((call) => call?.llm_call_id)
    : null;
  if (acknowledgement?.schema_version !== "brai.goal-agent.llm-log-ack.v1"
    || !["running", "completed"].includes(acknowledgement.execution_status)
    || !expectedIds
    || JSON.stringify(acknowledgement.llm_call_ids) !== JSON.stringify(expectedIds)) {
    throw ApplicationFailure.nonRetryable(
      acknowledgement?.last_error ?? "goal_agent_llm_log_persistence_rejected",
      "GoalAgentAiLogPersistenceRejected",
      acknowledgement
    );
  }
  return acknowledgement;
}

function contextActivities(reference) {
  return proxyActivities({
    taskQueue: reference.context_task_queue,
    startToCloseTimeout: "30 seconds",
    retry: { initialInterval: "1 second", maximumInterval: "30 seconds" }
  });
}

function validatedPageCount(context, kind) {
  const count = context?.page_counts?.[kind];
  if (!Number.isInteger(count) || count < 1) throw new Error("pages_required:" + kind);
  if (count > MAX_PAGES) throw new Error("pages_too_many:" + kind);
  return count;
}

async function mergeDiscoveryCandidates(input, summaries, results, call, info) {
  let current = summaries;
  for (let round = 1; round <= MAX_MERGE_ROUNDS; round += 1) {
    const batches = packDiscoveryMergeBatches(input, current, info, round);
    const merged = [];
    for (let index = 0; index < batches.length; index += 1) {
      assertDiscoveryCallBudget(results);
      const result = await call(mergeInput(input, batches[index], info, {
        round,
        batchIndex: index,
        batchCount: batches.length
      }));
      results.push(result);
      if (result.status !== "completed") throw new Error(result.error?.code ?? "agent_failed");
      merged.push(...result.decisions);
    }
    const decisions = dedupeDecisions(merged);
    if (batches.length === 1) return decisions;
    const next = decisions.map(discoverySummary);
    if (packDiscoveryMergeBatches(input, next, info, round + 1).length >= batches.length) {
      throw new Error("discovery_merge_did_not_converge");
    }
    current = next;
  }
  throw new Error("discovery_merge_round_limit");
}

function packDiscoveryMergeBatches(input, summaries, info, round) {
  if (summaries.length === 0) return [[]];
  const batches = [];
  let batch = [];
  const conservativeBatchCount = summaries.length;
  for (const summary of summaries) {
    const next = [...batch, summary];
    if (mergeInputBytes(input, next, info, round, batches.length, conservativeBatchCount) > MAX_AGENT_INPUT_BYTES) {
      if (batch.length === 0) throw new Error("discovery_summary_too_large");
      batches.push(batch);
      batch = [summary];
      if (mergeInputBytes(input, batch, info, round, batches.length, conservativeBatchCount) > MAX_AGENT_INPUT_BYTES) {
        throw new Error("discovery_summary_too_large");
      }
    } else {
      batch = next;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function mergeInputBytes(input, candidates, info, round, batchIndex, batchCount) {
  return jsonBytes(mergeInput(input, candidates, info, { round, batchIndex, batchCount }));
}

function hasDiscoveryCallBudget(results) {
  return llmCallCount(results) <= MAX_AGENT_RESULT_LLM_CALLS - MAX_LLM_CALLS_PER_ACTIVITY;
}

function assertDiscoveryCallBudget(results) {
  if (hasDiscoveryCallBudget(results)) return;
  const error = new Error(LLM_CALL_BUDGET_EXHAUSTED);
  error.code = LLM_CALL_BUDGET_EXHAUSTED;
  throw error;
}

function budgetedDiscoveryCall(results, call) {
  return async (input) => {
    assertDiscoveryCallBudget(results);
    return call(input);
  };
}

function llmCallCount(results) {
  return results.reduce((count, result) => count + (result.llm_calls?.length ?? 0), 0);
}

async function mergePlannerCandidates(input, plans, results, call, info) {
  let batches = packMergeBatches(plans.map(plannerSummary));
  for (let round = 1; round <= MAX_MERGE_ROUNDS; round += 1) {
    const merged = [];
    const groupCount = Math.ceil(batches.length / 2);
    for (let index = 0; index < batches.length; index += 2) {
      const candidates = [...batches[index], ...(batches[index + 1] ?? [])];
      const result = await call(plannerMergeInput(input, candidates, info, round, index / 2, groupCount));
      results.push(result);
      if (result.status !== "completed") throw new Error(result.error?.code ?? "agent_failed");
      merged.push(...result.decisions);
    }
    const decisions = dedupeDecisions(merged);
    if (batches.length === 1 || decisions.length === 0) return decisions;
    const next = packMergeBatches(decisions.map(plannerSummary));
    if (next.length >= batches.length) throw new Error("planner_merge_did_not_converge");
    batches = next;
  }
  throw new Error("planner_merge_round_limit");
}

export async function runPagedAgent(expectedAgentId, input, call, info) {
  assertAgent(input, expectedAgentId);
  const pages = validatedPages(input?.pages);
  const results = [];
  for (let index = 0; index < pages.length; index += 1) {
    const result = await call(pageInput(input, pages[index], info));
    results.push(result);
    if (result.status !== "completed") return aggregateResults(results, []);
  }
  return aggregateResults(results, dedupeDecisions(results.flatMap((result) => result.decisions)));
}

export async function runDiscovery(input, call, info) {
  assertAgent(input, "goal.discovery");
  const pages = validatedPages(input?.pages);
  const results = [];
  const mapped = [];
  for (let index = 0; index < pages.length; index += 1) {
    if (!hasDiscoveryCallBudget(results)) return aggregateFailure(results, LLM_CALL_BUDGET_EXHAUSTED);
    const result = await call(pageInput(input, pages[index], info, {
      stage: "map",
      page_index: index,
      page_count: pages.length
    }));
    results.push(result);
    if (result.status !== "completed") return aggregateResults(results, []);
    mapped.push(...result.decisions);
  }

  try {
    const decisions = await mergeDiscoveryCandidates(
      input,
      dedupeDecisions(mapped).map(discoverySummary),
      results,
      call,
      info
    );
    return aggregateResults(results, decisions);
  } catch (error) {
    return aggregateFailure(results, errorCode(error));
  }
}

export function enrichWorkflowInput(input, info) {
  return {
    ...input,
    workflow_id: info.workflowId,
    run_id: info.runId,
    attempt: info.attempt
  };
}

function pageInput(input, page, info, discovery = null) {
  const base = withoutPages(input);
  const trigger = discovery
    ? { ...base.trigger, stage: discovery.stage }
    : base.trigger;
  return enrichWorkflowInput({
    ...base,
    trigger,
    snapshot: {
      ...base.snapshot,
      ...page,
      ...(discovery ? {
        processing_stage: discovery.stage,
        page_index: discovery.page_index,
        page_count: discovery.page_count
      } : {})
    }
  }, info);
}

function mergeInput(input, candidates, info, roundOrOptions, batchIndex, batchCount) {
  const options = typeof roundOrOptions === "object" ? roundOrOptions : {
    round: roundOrOptions,
    batchIndex,
    batchCount
  };
  const base = withoutPages(input);
  return enrichWorkflowInput({
    ...base,
    trigger: { ...base.trigger, stage: "merge" },
    snapshot: {
      ...base.snapshot,
      processing_stage: "merge",
      merge_round: options.round,
      batch_index: options.batchIndex,
      batch_count: options.batchCount,
      candidates,
      ...(options.existingGoals ? {
        comparison_mode: "filter_only",
        existing_goals: options.existingGoals
      } : {})
    }
  }, info);
}

function plannerMergeInput(input, candidates, info, round, batchIndex, batchCount) {
  const base = withoutPages(input);
  return enrichWorkflowInput({
    ...base,
    trigger: { ...base.trigger, stage: "merge" },
    snapshot: {
      ...base.snapshot,
      processing_stage: "merge",
      merge_round: round,
      batch_index: batchIndex,
      batch_count: batchCount,
      candidate_plans: candidates
    }
  }, info);
}

function validatedPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error("pages_required");
  if (pages.length > MAX_PAGES) throw new Error("pages_too_many");
  return pages.map((page, pageIndex) => {
    if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.items)) {
      throw new Error("invalid_page:" + pageIndex);
    }
    if (page.items.length > PAGE_SIZE) throw new Error("page_too_large:" + pageIndex);
    return page;
  });
}

function withoutPages(input) {
  const { pages: _pages, ...base } = input ?? {};
  return base;
}

function aggregateResults(results, decisions) {
  const final = results.at(-1);
  if (!final) throw new Error("agent_result_required");
  const llmCalls = results.flatMap((result) => result.llm_calls ?? []);
  const aggregate = {
    ...final,
    llm_call_id: llmCalls.at(-1)?.llm_call_id ?? final.llm_call_id,
    attempt: llmCalls.at(-1)?.attempt ?? final.attempt,
    llm_calls: llmCalls,
    decisions: final.status === "completed" ? decisions : []
  };
  if (jsonBytes(aggregate) <= MAX_WORKFLOW_RESULT_BYTES) return aggregate;
  return {
    ...aggregate,
    status: "failed",
    decisions: [],
    error: { code: "workflow_result_too_large", message: "workflow_result_too_large" }
  };
}

function aggregateFailure(results, code) {
  const aggregate = aggregateResults(results, []);
  return {
    ...aggregate,
    status: "failed",
    decisions: [],
    error: { code, message: code }
  };
}

function dedupeDecisions(decisions) {
  const seen = new Set();
  return decisions.filter((decision) => {
    const key = JSON.stringify([
      decision?.decision_kind,
      decision?.subject_items_id,
      decision?.proposal
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function plannerSummary(decision) {
  return {
    decision_kind: decision.decision_kind,
    subject_items_id: decision.subject_items_id,
    confidence: decision.confidence,
    rationale: decision.rationale,
    proposal: decision.proposal
  };
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertAgent(input, expectedAgentId) {
  if (input?.agent_id !== expectedAgentId) throw new Error("agent_workflow_mismatch:" + expectedAgentId);
}

function errorCode(error) {
  return String(error?.code ?? error?.message ?? "workflow_failed").split(":", 1)[0].slice(0, 64);
}
