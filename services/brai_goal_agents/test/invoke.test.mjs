import assert from "node:assert/strict";
import test from "node:test";
import { invokeAgent } from "../src/invoke.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { assertInputEnvelope, assertSchema } from "../src/schema.mjs";

function inputFor(manifest, trigger = { kind: "activity_created", items_id: "item-1", domain_revision: 1 }) {
  return {
    schema_version: "1",
    agent_id: manifest.id,
    agent_version: manifest.version,
    workflow_id: "workflow-1",
    run_id: "run-1",
    attempt: 1,
    user_id: "user-1",
    trigger,
    snapshot: {},
    catalogs: {},
    validation_errors: []
  };
}

function validOutput(manifest) {
  return JSON.stringify({
    schema_version: "1",
    agent_id: manifest.id,
    agent_version: manifest.version,
    decisions: []
  });
}

test("validated output returns a bounded observable result envelope", async () => {
  const manifest = await loadManifest("goal.item-matcher");
  const heartbeats = [];
  const result = await invokeAgent(manifest, inputFor(manifest), {
    invokeModel: async () => validOutput(manifest),
    heartbeat: (detail) => heartbeats.push(detail),
    env: { BRAI_GOAL_ITEM_MATCHER_MODEL: manifest.default_model },
    now: () => 100,
    id: () => "llm-call-1"
  });
  assert.equal(result.status, "completed");
  assert.equal(result.input_schema_version, "brai.goal-agent.input.v1");
  assert.equal(result.llm_call_id, "llm-call-1");
  assert.equal(result.attempt, 1);
  assert.equal(result.model, manifest.default_model);
  assert.equal(result.llm_calls.length, 1);
  assert.equal(result.llm_calls[0].status, "completed");
  assert.ok(heartbeats.some((entry) => entry.state === "started"));
  assert.ok(heartbeats.some((entry) => entry.state === "completed"));
});

test("invocation refuses model drift before calling the provider", async () => {
  const manifest = await loadManifest("goal.item-matcher");
  let invoked = false;
  await assert.rejects(() => invokeAgent(manifest, inputFor(manifest), {
    env: { BRAI_GOAL_ITEM_MATCHER_MODEL: "silent-model-drift" },
    invokeModel: async () => {
      invoked = true;
      return validOutput(manifest);
    }
  }), /goal_agent_model_contract_mismatch/);
  assert.equal(invoked, false);
});

test("schema failures make at most three distinct model calls", async () => {
  const manifest = await loadManifest("goal.item-matcher");
  let calls = 0;
  const ids = ["call-1", "call-2", "call-3"];
  const result = await invokeAgent(manifest, inputFor(manifest), {
    invokeModel: async () => {
      calls += 1;
      return JSON.stringify({ decisions: [], unexpected: true });
    },
    id: () => ids[calls],
    now: () => 100
  });
  assert.equal(calls, 3);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "schema_validation_failed");
  assert.deepEqual(result.llm_calls.map((entry) => entry.status), [
    "schema_failed",
    "schema_failed",
    "schema_failed"
  ]);
  assert.deepEqual(result.llm_calls.map((entry) => entry.llm_call_id), ids);
});

test("provider failure crosses the boundary once and is not disguised as a schema retry", async () => {
  const manifest = await loadManifest("goal.member-finder");
  let calls = 0;
  const result = await invokeAgent(manifest, inputFor(manifest), {
    invokeModel: async () => {
      calls += 1;
      const error = new Error("llm_timeout");
      error.code = "llm_timeout";
      throw error;
    },
    id: () => "provider-call",
    now: () => 100
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "llm_timeout");
  assert.equal(result.llm_calls[0].status, "provider_failed");
});

test("planner and discovery enforce their trigger boundary before any model call", async () => {
  const planner = await loadManifest("goal.planner");
  const discovery = await loadManifest("goal.discovery");
  assert.throws(
    () => assertInputEnvelope(inputFor(planner, { kind: "user_request", items_id: "goal-1" }), planner),
    /planner_explicit_request_required/
  );
  assert.throws(
    () => assertInputEnvelope(inputFor(discovery, { kind: "watermark", watermark: "5" }), discovery),
    /discovery_stage_required/
  );
});

test("strict schemas reject unknown output fields and non-finite confidence", async () => {
  const manifest = await loadManifest("activity.classifier");
  const decisionSchema = manifest.output_schema;
  assert.throws(() => assertSchema({
    schema_version: "1",
    agent_id: manifest.id,
    agent_version: manifest.version,
    decisions: [],
    secret: "must-not-cross"
  }, decisionSchema), /schema_validation_failed/);
  const decision = {
    decision_kind: "activity_type_change",
    subject_items_id: "item-1",
    confidence: Number.NaN,
    rationale: "reason",
    evidence: [{ items_id: "item-1", field: "title", excerpt: "title" }],
    proposal: {
      current_role: "activity",
      current_type: "action",
      target_type: "goal",
      end_inbox_role: false
    }
  };
  assert.throws(() => assertSchema({
    schema_version: "1",
    agent_id: manifest.id,
    agent_version: manifest.version,
    decisions: [decision]
  }, decisionSchema), /schema_validation_failed/);
});
