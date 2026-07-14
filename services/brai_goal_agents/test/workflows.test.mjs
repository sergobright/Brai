import assert from "node:assert/strict";
import test from "node:test";
import {
  durableAgentCall,
  enrichWorkflowInput,
  runDiscovery,
  runDiscoveryFromContext,
  runPagedAgent,
  runPagedAgentFromContext,
  runPlannerFromContext
} from "../src/workflows.mjs";
import {
  MAX_AGENT_INPUT_BYTES,
  MAX_AGENT_RESULT_LLM_CALLS,
  MAX_CONTEXT_PAGE_BYTES,
  assertAgentResultEnvelope
} from "../src/contracts.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { discoverySummary } from "../src/workflow-discovery.mjs";

const info = { workflowId: "workflow-1", runId: "run-1", attempt: 1 };

function envelope(agentId, pages) {
  return {
    schema_version: "1",
    agent_id: agentId,
    agent_version: "1",
    user_id: "user-1",
    trigger: { kind: "changed", items_id: "item-1", domain_revision: 1 },
    snapshot: { context: "shared" },
    catalogs: {},
    validation_errors: [],
    pages
  };
}

function decision(id, description = "description") {
  return {
    decision_kind: "goal_discovery",
    subject_items_id: id,
    confidence: 0.8,
    rationale: "rationale",
    evidence: [{ items_id: id, field: "title", excerpt: id }],
    proposal: {
      title: `Goal ${id}`,
      description_md: description,
      member_items_ids: [`${id}-a`, `${id}-b`]
    }
  };
}

function result(agentId, call, decisions) {
  return {
    schema_version: "1",
    agent_id: agentId,
    agent_version: "1",
    status: "completed",
    llm_call_id: `call-${call}`,
    attempt: 1,
    llm_calls: [{ llm_call_id: `call-${call}`, attempt: 1, status: "completed" }],
    decisions,
    error: null
  };
}

test("Temporal-owned execution metadata is injected when caller omits run_id", () => {
  const enriched = enrichWorkflowInput({
    schema_version: "1",
    agent_id: "goal.planner",
    agent_version: "1"
  }, {
    workflowId: "temporal-workflow",
    runId: "temporal-run",
    attempt: 4
  });
  assert.equal(enriched.workflow_id, "temporal-workflow");
  assert.equal(enriched.run_id, "temporal-run");
  assert.equal(enriched.attempt, 4);
});

test("caller cannot spoof Temporal workflow identity or retry attempt", () => {
  const enriched = enrichWorkflowInput({
    workflow_id: "spoofed-workflow",
    run_id: null,
    attempt: 99
  }, {
    workflowId: "actual-workflow",
    runId: "actual-run",
    attempt: 2
  });
  assert.deepEqual(enriched, {
    workflow_id: "actual-workflow",
    run_id: "actual-run",
    attempt: 2
  });
});

test("paged matchers traverse 51+ items without truncation and aggregate calls", async () => {
  const pages = [
    { items: Array.from({ length: 50 }, (_, index) => ({ items_id: `item-${index}` })) },
    { items: [{ items_id: "item-50" }, { items_id: "item-51" }] }
  ];
  const observed = [];
  const output = await runPagedAgent("goal.item-matcher", envelope("goal.item-matcher", pages), async (input) => {
    observed.push(input.snapshot.items.map((item) => item.items_id));
    return result("goal.item-matcher", observed.length, [{
      decision_kind: "relation_add",
      subject_items_id: input.snapshot.items[0].items_id,
      proposal: {
        relation_type_id: "part_of",
        source_items_id: input.snapshot.items[0].items_id,
        target_items_id: "goal-1",
        suggested_position: null
      }
    }]);
  }, info);
  assert.equal(observed.length, 2);
  assert.equal(observed.flat().length, 52);
  assert.equal(output.llm_calls.length, 2);
  assert.equal(output.decisions.length, 2);
});

test("paged matcher rejects a 51-item page before invoking the model", async () => {
  let calls = 0;
  await assert.rejects(() => runPagedAgent("goal.item-matcher", envelope("goal.item-matcher", [{
    items: Array.from({ length: 51 }, (_, index) => ({ items_id: `item-${index}` }))
  }]), async () => {
    calls += 1;
  }, info), /page_too_large:0/);
  assert.equal(calls, 0);
});

test("discovery maps every page and always performs a final merge", async () => {
  const stages = [];
  let calls = 0;
  const pages = [
    { items: [{ items_id: "item-1" }] },
    { items: [{ items_id: "item-2" }] }
  ];
  const output = await runDiscovery(envelope("goal.discovery", pages), async (input) => {
    calls += 1;
    stages.push(input.trigger.stage);
    if (input.trigger.stage === "map") {
      return result("goal.discovery", calls, [decision(input.snapshot.items[0].items_id)]);
    }
    assert.equal(input.snapshot.candidates.length, 2);
    return result("goal.discovery", calls, [decision("merged")]);
  }, info);
  assert.deepEqual(stages, ["map", "map", "merge"]);
  assert.equal(output.decisions[0].subject_items_id, "merged");
  assert.equal(output.llm_calls.length, 3);
});

test("discovery uses a bounded merge tree when summaries exceed one input envelope", async () => {
  const stages = [];
  let calls = 0;
  const largeDescription = "x".repeat(7_000);
  const pages = Array.from({ length: 10 }, (_, index) => ({
    items: [{ items_id: `item-${index + 1}` }]
  }));
  const output = await runDiscovery(envelope("goal.discovery", pages), async (input) => {
    calls += 1;
    stages.push(input.trigger.stage);
    if (input.trigger.stage === "map") {
      return result("goal.discovery", calls, [decision(input.snapshot.items[0].items_id, largeDescription)]);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= MAX_AGENT_INPUT_BYTES);
    return result("goal.discovery", calls, [decision(`merged-${calls}`)]);
  }, info);
  assert.equal(stages.filter((stage) => stage === "map").length, pages.length);
  assert.ok(stages.filter((stage) => stage === "merge").length >= 2);
  assert.equal(output.llm_calls.length, stages.length);
  assert.equal(output.decisions.length, 1);
});

test("discovery completes the 200-page 20-draft bound without overflowing observable calls", async () => {
  const stress = await runDiscoveryCallBoundStress(1);
  assert.equal(stress.output.status, "completed", JSON.stringify({
    error: stress.output.error,
    activityCalls: stress.activityCalls,
    observableCalls: stress.observableCalls
  }));
  assert.equal(stress.output.llm_calls.length, stress.observableCalls);
  assert.ok(stress.output.llm_calls.length <= MAX_AGENT_RESULT_LLM_CALLS);
  assert.equal(stress.coveredSourceItems, 10_000);
  assert.ok(stress.maxInputBytes <= MAX_AGENT_INPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(stress.output)) <= 1_048_576);
  const manifest = await loadManifest("goal.discovery");
  assert.doesNotThrow(() => assertAgentResultEnvelope(stress.output, manifest, {
    workflow_id: info.workflowId,
    run_id: info.runId
  }));
});

test("discovery stops before the result call bound when every Activity consumes all schema attempts", async () => {
  const stress = await runDiscoveryCallBoundStress(3);
  assert.equal(stress.output.status, "failed");
  assert.equal(stress.output.error.code, "workflow_llm_call_budget_exhausted");
  assert.equal(stress.output.llm_calls.length, stress.observableCalls);
  assert.ok(stress.output.llm_calls.length <= MAX_AGENT_RESULT_LLM_CALLS);
  assert.equal(stress.coveredSourceItems, 10_000);
  assert.ok(stress.maxInputBytes <= MAX_AGENT_INPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(stress.output)) <= 1_048_576);
  const manifest = await loadManifest("goal.discovery");
  assert.doesNotThrow(() => assertAgentResultEnvelope(stress.output, manifest, {
    workflow_id: info.workflowId,
    run_id: info.runId
  }));
});

test("context-backed matcher loads bounded pages sequentially without embedding them in workflow input", async () => {
  const reference = executionReference("goal.item-matcher");
  const context = descriptor("goal.item-matcher", { items: 2 });
  const loaded = [];
  const output = await runPagedAgentFromContext(
    "goal.item-matcher",
    reference,
    context,
    "items",
    async (input) => result("goal.item-matcher", loaded.length, []),
    info,
    async (_reference, kind, index) => {
      loaded.push([kind, index]);
      return { items: [{ items_id: `item-${index}` }] };
    }
  );
  assert.deepEqual(loaded, [["items", 0], ["items", 1]]);
  assert.equal("pages" in context.base, false);
  assert.equal(output.llm_calls.length, 2);
});

test("each returned Activity result logs all schema attempts before the next context page", async () => {
  const reference = executionReference("goal.item-matcher");
  const context = descriptor("goal.item-matcher", { items: 2 });
  const events = [];
  const first = result("goal.item-matcher", 2, [{
    decision_kind: "relation_add",
    subject_items_id: "item-0",
    proposal: {
      relation_type_id: "part_of",
      source_items_id: "item-0",
      target_items_id: "goal-1",
      suggested_position: null
    }
  }]);
  first.llm_calls = [
    { llm_call_id: "call-1", attempt: 1, status: "schema_failed" },
    { llm_call_id: "call-2", attempt: 2, status: "completed" }
  ];

  await assert.rejects(() => runPagedAgentFromContext(
    "goal.item-matcher",
    reference,
    context,
    "items",
    durableAgentCall(reference, async () => {
      events.push("invoke");
      return first;
    }, async (_reference, returned) => {
      events.push(`persist:${returned.llm_calls.map((call) => call.llm_call_id).join(",")}`);
    }),
    info,
    async (_reference, _kind, index) => {
      events.push(`load:${index}`);
      if (index === 1) throw new Error("later_context_load_failed");
      return { items: [{ items_id: "item-0" }] };
    }
  ), /later_context_load_failed/);
  assert.deepEqual(events, ["load:0", "invoke", "persist:call-1,call-2", "load:1"]);
});

test("AI-log persistence failure blocks the next model Activity", async () => {
  const reference = executionReference("goal.item-matcher");
  const context = descriptor("goal.item-matcher", { items: 2 });
  let calls = 0;
  let loads = 0;
  await assert.rejects(() => runPagedAgentFromContext(
    "goal.item-matcher",
    reference,
    context,
    "items",
    durableAgentCall(reference, async () => {
      calls += 1;
      return result("goal.item-matcher", calls, []);
    }, async () => {
      throw new Error("ai_log_write_failed");
    }),
    info,
    async () => {
      loads += 1;
      return { items: [{ items_id: `item-${loads}` }] };
    }
  ), /ai_log_write_failed/);
  assert.equal(calls, 1);
  assert.equal(loads, 1);
});

test("context-backed discovery can group real IDs across page boundaries and scans Goal pages", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 2, goals: 1 });
  const seenMergeCandidates = [];
  let calls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    seenMergeCandidates.push(input.snapshot.candidates);
    return result("goal.discovery", calls, [decision("cross-page")]);
  }, info, async (_reference, kind, index) => ({
    items: kind === "items"
      ? [{ items_id: `source-${index}`, title: `Source ${index}`, description_md: "context" }]
      : [{ items_id: "goal-existing", title: "Existing Goal", description_md: "" }]
  }));
  const provisional = seenMergeCandidates[0].filter((entry) => entry.candidate_kind === "source_item");
  assert.deepEqual(provisional.map((entry) => entry.items_id), ["source-0", "source-1"]);
  assert.equal(calls, 4);
  assert.equal(output.llm_calls.length, calls);
  assert.equal(output.decisions.length, 1);
});

test("final discovery comparison repacks large candidates and covers every existing Goal within the input limit", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 2 });
  const largeCandidates = boundaryCandidates();
  const largeGoals = boundaryGoals();
  const candidateBytes = Buffer.byteLength(JSON.stringify(largeCandidates.map(discoverySummary)));
  const goalPageBytes = Buffer.byteLength(JSON.stringify({ items: largeGoals }));
  assert.ok(candidateBytes >= 32_000 && candidateBytes < 33_000);
  assert.ok(goalPageBytes >= 33_000 && goalPageBytes <= MAX_CONTEXT_PAGE_BYTES);
  assert.ok(candidateBytes + goalPageBytes > MAX_AGENT_INPUT_BYTES);

  const compared = new Set();
  const callBytes = [];
  let largeGoalCalls = 0;
  let calls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    callBytes.push(Buffer.byteLength(JSON.stringify(input)));
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    const goals = input.snapshot.existing_goals;
    if (!goals) return result("goal.discovery", calls, largeCandidates);
    assert.equal(input.snapshot.comparison_mode, "filter_only");
    for (const candidate of input.snapshot.candidates) {
      for (const goal of goals) compared.add(`${candidate.subject_items_id}:${goal.items_id}`);
    }
    if (goals[0]?.items_id !== "goal-warmup") largeGoalCalls += 1;
    return result("goal.discovery", calls, input.snapshot.candidates.map(rehydrateDiscovery));
  }, info, async (_reference, kind, index) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "context" }]
      : index === 0
        ? [{ items_id: "goal-warmup", title: "Warmup", description_md: "" }]
        : largeGoals
  }));

  assert.ok(largeGoalCalls >= 2);
  assert.deepEqual(output.decisions, largeCandidates);
  assert.ok(callBytes.every((bytes) => bytes <= MAX_AGENT_INPUT_BYTES));
  for (const candidate of largeCandidates) {
    for (const goal of [{ items_id: "goal-warmup" }, ...largeGoals]) {
      assert.ok(compared.has(`${candidate.subject_items_id}:${goal.items_id}`));
    }
  }
});

test("filter-only discovery keeps an original full-decision subset across every Goal page", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 2 });
  const candidates = [decision("subset-a"), decision("subset-b"), decision("subset-c")];
  candidates[2].evidence[0].excerpt = "original-evidence";
  const seen = [];
  const callBytes = [];
  let calls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    callBytes.push(Buffer.byteLength(JSON.stringify(input)));
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    if (!input.snapshot.existing_goals) return result("goal.discovery", calls, candidates);
    assert.equal(input.snapshot.comparison_mode, "filter_only");
    seen.push(input.snapshot.candidates.map((candidate) => candidate.subject_items_id));
    const selected = seen.length === 1
      ? [input.snapshot.candidates[0], input.snapshot.candidates[2]]
      : [input.snapshot.candidates[1]];
    return result("goal.discovery", calls, selected.map((candidate) => (
      rehydrateDiscovery(candidate, "agent-rewritten-evidence")
    )));
  }, info, async (_reference, kind, index) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "" }]
      : [{ items_id: `subset-goal-${index}`, title: `Goal ${index}`, description_md: "" }]
  }));
  assert.deepEqual(seen, [["subset-a", "subset-b", "subset-c"], ["subset-a", "subset-c"]]);
  assert.deepEqual(output.decisions, [candidates[2]]);
  assert.equal(output.decisions[0].evidence[0].excerpt, "original-evidence");
  assert.ok(callBytes.every((bytes) => bytes <= MAX_AGENT_INPUT_BYTES));
});

test("final discovery rejects an added candidate in the second adaptive chunk", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 1 });
  const candidates = boundaryCandidates();
  const goals = boundaryGoals();
  const callBytes = [];
  let calls = 0;
  let comparisonCalls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    callBytes.push(Buffer.byteLength(JSON.stringify(input)));
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    if (!input.snapshot.existing_goals) return result("goal.discovery", calls, candidates);
    comparisonCalls += 1;
    const selected = input.snapshot.candidates.map(rehydrateDiscovery);
    if (comparisonCalls === 2) selected.push(decision("foreign-added-candidate"));
    return result("goal.discovery", calls, selected);
  }, info, async (_reference, kind) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "" }]
      : goals
  }));
  assert.equal(comparisonCalls, 2);
  assert.equal(output.status, "failed");
  assert.equal(output.error.code, "discovery_comparison_mutated_candidate");
  assert.ok(callBytes.every((bytes) => bytes <= MAX_AGENT_INPUT_BYTES));
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_AGENT_INPUT_BYTES);
});

test("final discovery rejects a mutated candidate on the second Goal page", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 2 });
  const candidates = [decision("page-a"), decision("page-b")];
  let calls = 0;
  let comparisonCalls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    if (!input.snapshot.existing_goals) return result("goal.discovery", calls, candidates);
    comparisonCalls += 1;
    const selected = input.snapshot.candidates.map(rehydrateDiscovery);
    if (comparisonCalls === 2) selected[0] = { ...selected[0], rationale: "mutated" };
    return result("goal.discovery", calls, selected);
  }, info, async (_reference, kind, index) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "" }]
      : [{ items_id: `page-goal-${index}`, title: `Goal ${index}`, description_md: "" }]
  }));
  assert.equal(comparisonCalls, 2);
  assert.equal(output.status, "failed");
  assert.equal(output.error.code, "discovery_comparison_mutated_candidate");
});

test("filter-only discovery rejects an output duplicate beyond the input multiset", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 1 });
  const candidate = decision("duplicate-candidate");
  let calls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    if (!input.snapshot.existing_goals) return result("goal.discovery", calls, [candidate]);
    const repeated = rehydrateDiscovery(input.snapshot.candidates[0]);
    return result("goal.discovery", calls, [repeated, repeated]);
  }, info, async (_reference, kind) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "" }]
      : [{ items_id: "duplicate-goal", title: "Goal", description_md: "" }]
  }));
  assert.equal(output.status, "failed");
  assert.equal(output.error.code, "discovery_comparison_mutated_candidate");
});

test("an indivisible oversized discovery comparison cell returns a bounded deterministic failure", async () => {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 1, goals: 1 });
  const hugeCandidate = decision("huge-candidate", "c".repeat(46_000));
  const hugeGoal = { items_id: "huge-goal", title: "Huge Goal", description_md: "g".repeat(20_000) };
  assert.ok(Buffer.byteLength(JSON.stringify(hugeCandidate)) <= MAX_AGENT_INPUT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ items: [hugeGoal] })) <= MAX_CONTEXT_PAGE_BYTES);
  let calls = 0;
  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    calls += 1;
    if (input.trigger.stage === "map") return result("goal.discovery", calls, []);
    return result("goal.discovery", calls, [hugeCandidate]);
  }, info, async (_reference, kind) => ({
    items: kind === "items"
      ? [{ items_id: "source-0", title: "Source", description_md: "" }]
      : [hugeGoal]
  }));
  assert.equal(calls, 2);
  assert.equal(output.status, "failed");
  assert.equal(output.error.code, "discovery_comparison_cell_too_large");
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= MAX_AGENT_INPUT_BYTES);
});

test("context-backed planner considers every membership page before one bounded merge", async () => {
  const reference = executionReference("goal.planner");
  const context = descriptor("goal.planner", { members: 2 });
  const loaded = [];
  let calls = 0;
  const output = await runPlannerFromContext(reference, context, async (input) => {
    calls += 1;
    if (input.trigger.stage === "map") {
      return result("goal.planner", calls, [plannerDecision(`page-${input.snapshot.page_index}`)]);
    }
    assert.equal(input.snapshot.candidate_plans.length, 2);
    return result("goal.planner", calls, [plannerDecision("merged")]);
  }, info, async (_reference, kind, index) => {
    loaded.push([kind, index]);
    return { items: [{ items_id: `member-${index}` }] };
  });
  assert.deepEqual(loaded, [["members", 0], ["members", 1]]);
  assert.equal(calls, 3);
  assert.equal(output.decisions[0].proposal.steps[0].title, "merged");
});

function executionReference(agentId) {
  return {
    schema_version: "brai.goal-agent.execution-reference.v1",
    execution_id: "execution-1",
    agent_id: agentId,
    workflow_id: "brai:preview-c:test-workflow",
    context_capability: "A".repeat(43),
    context_task_queue: "brai-agent-context-preview-c"
  };
}

function descriptor(agentId, pageCounts) {
  const { pages: _pages, ...base } = envelope(agentId);
  return {
    agent_id: agentId,
    base,
    page_counts: pageCounts
  };
}

function plannerDecision(title) {
  return {
    decision_kind: "goal_plan",
    subject_items_id: "item-1",
    confidence: 0.8,
    rationale: "rationale",
    evidence: [{ items_id: "item-1", field: "title", excerpt: "Goal" }],
    proposal: {
      goal_items_id: "item-1",
      steps: [
        { title, description_md: "", position: 0 },
        { title: `${title}-2`, description_md: "", position: 1 }
      ]
    }
  };
}

function rehydrateDiscovery(summary, excerpt = summary.subject_items_id) {
  return {
    ...summary,
    evidence: [{ items_id: summary.subject_items_id, field: "title", excerpt }]
  };
}

function boundaryCandidates() {
  return Array.from({ length: 12 }, (_, index) => decision(
    `candidate-${index}`, "c".repeat(2_472)
  ));
}

function boundaryGoals() {
  return Array.from({ length: 12 }, (_, index) => ({
    items_id: `goal-${index}`, title: `Goal ${index}`, description_md: "g".repeat(2_723)
  }));
}

async function runDiscoveryCallBoundStress(llmCallsPerActivity) {
  const reference = executionReference("goal.discovery");
  const context = descriptor("goal.discovery", { items: 200, goals: 1 });
  context.base.catalogs = { padding: "x".repeat(18_000) };
  const sourceItems = new Set();
  let activityCalls = 0;
  let observableCalls = 0;
  let maxInputBytes = 0;

  const output = await runDiscoveryFromContext(reference, context, async (input) => {
    activityCalls += 1;
    maxInputBytes = Math.max(maxInputBytes, Buffer.byteLength(JSON.stringify(input)));
    let decisions;
    if (input.trigger.stage === "map") {
      const memberIds = input.snapshot.items.map((item) => item.items_id);
      decisions = Array.from({ length: 20 }, (_, index) => stressDiscoveryDecision(
        `map-${input.snapshot.page_index}-${index}`,
        [memberIds[index * 2], memberIds[index * 2 + 1]]
      ));
    } else if (input.snapshot.comparison_mode) {
      decisions = input.snapshot.candidates.map((candidate) => ({
        ...candidate,
        evidence: candidate.proposal.member_items_ids.slice(0, 2).map((itemsId) => ({
          items_id: itemsId,
          field: "title",
          excerpt: "source"
        }))
      }));
    } else {
      const memberIds = [...new Set(input.snapshot.candidates.flatMap((candidate) => {
        if (candidate.candidate_kind === "source_item") {
          sourceItems.add(candidate.items_id);
          return [candidate.items_id];
        }
        return candidate.proposal?.member_items_ids ?? [];
      }))];
      const decisionCount = input.snapshot.batch_count <= 2
        ? 1
        : llmCallsPerActivity === 1 ? 16 : 19;
      decisions = Array.from({ length: decisionCount }, (_, index) => stressDiscoveryDecision(
        `merge-${activityCalls}-${index}`,
        memberIds.slice(0, 2)
      ));
    }
    const llmCalls = Array.from({ length: llmCallsPerActivity }, (_, index) => {
      observableCalls += 1;
      return {
        llm_call_id: `stress-call-${observableCalls}`,
        attempt: index + 1,
        status: index + 1 === llmCallsPerActivity ? "completed" : "schema_failed",
        model: "gpt-5.4-mini",
        duration_ms: 1,
        error_code: index + 1 === llmCallsPerActivity ? null : "invalid_json"
      };
    });
    const finalCall = llmCalls.at(-1);
    return {
      schema_version: "1",
      agent_id: "goal.discovery",
      agent_version: "1",
      input_schema_version: "brai.goal-agent.input.v1",
      prompt_version: "goal-discovery.v1",
      output_schema_version: "brai.goal-discovery.result.v1",
      workflow_id: info.workflowId,
      run_id: info.runId,
      workflow_attempt: 1,
      llm_call_id: finalCall.llm_call_id,
      attempt: finalCall.attempt,
      model: "gpt-5.4-mini",
      review_only: true,
      llm_calls: llmCalls,
      status: "completed",
      decisions,
      error: null
    };
  }, info, async (_reference, kind, index) => ({
    items: kind === "goals" ? [] : Array.from({ length: 50 }, (_, itemIndex) => ({
      items_id: `${String(index).padStart(3, "0")}-${String(itemIndex).padStart(2, "0")}-${"x".repeat(118)}`,
      title: `Source ${index}-${itemIndex} ${"t".repeat(60)}`,
      description_md: "d".repeat(240)
    }))
  }));

  return {
    output,
    activityCalls,
    observableCalls,
    coveredSourceItems: sourceItems.size,
    maxInputBytes
  };
}

function stressDiscoveryDecision(label, memberItemsIds) {
  return {
    decision_kind: "goal_discovery",
    subject_items_id: null,
    confidence: 0.8,
    rationale: "r".repeat(100),
    evidence: memberItemsIds.map((itemsId) => ({ items_id: itemsId, field: "title", excerpt: "source" })),
    proposal: {
      title: `Goal ${label}`.slice(0, 80),
      description_md: "d".repeat(1_200),
      member_items_ids: memberItemsIds
    }
  };
}
