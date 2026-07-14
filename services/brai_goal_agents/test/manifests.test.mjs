import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AGENT_IDS,
  environmentName,
  loadManifest,
  modelFor,
  taskQueueFor
} from "../src/manifest.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("exactly five logical agents have separate manifests and entrypoints", async () => {
  assert.deepEqual(AGENT_IDS, [
    "activity.classifier",
    "goal.item-matcher",
    "goal.member-finder",
    "goal.discovery",
    "goal.planner"
  ]);
  for (const id of AGENT_IDS) {
    const manifest = await loadManifest(id);
    assert.equal(manifest.id, id);
    assert.equal(manifest.version, "1");
    assert.equal(manifest.workflow_definition_version, 1);
    assert.match(manifest.worker_build_id, /\.v1$/);
    assert.equal(manifest.input_schema_version, "brai.goal-agent.input.v1");
    assert.equal(manifest.retry.schema_attempts, 3);
    assert.ok(manifest.prompt_version);
    assert.ok(manifest.output_schema_version);
    assert.ok(manifest.model_env);
    assert.equal(manifest.output_schema.additionalProperties, false);
    assert.ok(fs.existsSync(path.join(root, manifest.entrypoint)));
  }
  assert.equal(fs.readdirSync(path.join(root, "manifests")).filter((name) => name.endsWith(".json")).length, 5);
  assert.equal(fs.readdirSync(path.join(root, "src/entrypoints")).filter((name) => name.endsWith(".mjs")).length, 5);
});

test("queues are deterministic and environment-qualified", async () => {
  const manifest = await loadManifest("goal.item-matcher");
  assert.equal(taskQueueFor(manifest, "prod"), "brai-agent-goal-item-matcher-prod");
  assert.equal(taskQueueFor(manifest, "preview-e"), "brai-agent-goal-item-matcher-preview-e");
  assert.equal(environmentName("PREVIEW-A"), "preview-a");
  assert.throws(() => environmentName("qa"), /invalid_environment/);
});

test("an explicitly configured queue cannot cross environment boundaries", async () => {
  const manifest = await loadManifest("goal.planner");
  const previous = process.env.BRAI_GOAL_AGENT_TASK_QUEUE;
  process.env.BRAI_GOAL_AGENT_TASK_QUEUE = "brai-agent-goal-planner-prod";
  try {
    assert.throws(() => taskQueueFor(manifest, "preview-a"), /task_queue_mismatch/);
  } finally {
    if (previous === undefined) delete process.env.BRAI_GOAL_AGENT_TASK_QUEUE;
    else process.env.BRAI_GOAL_AGENT_TASK_QUEUE = previous;
  }
});

test("model config may repeat the frozen default but cannot override it", async () => {
  const manifest = await loadManifest("goal.discovery");
  const model = manifest.default_model;
  assert.equal(modelFor(manifest, {
    BRAI_GOAL_DISCOVERY_MODEL: model,
    BRAI_GOAL_AGENT_DEFAULT_MODEL: model
  }), model);
  assert.equal(modelFor(manifest, { BRAI_GOAL_AGENT_DEFAULT_MODEL: model }), model);
  assert.throws(() => modelFor(manifest, {
    BRAI_GOAL_DISCOVERY_MODEL: "silent-per-agent-drift"
  }), /goal_agent_model_contract_mismatch/);
  assert.throws(() => modelFor(manifest, {
    BRAI_GOAL_AGENT_DEFAULT_MODEL: "silent-shared-drift"
  }), /goal_agent_model_contract_mismatch/);
  assert.throws(() => modelFor(manifest, {
    BRAI_GOAL_DISCOVERY_MODEL: model,
    BRAI_GOAL_AGENT_DEFAULT_MODEL: "shadowed-shared-drift"
  }), /goal_agent_model_contract_mismatch/);
  assert.throws(() => modelFor({ ...manifest, default_model: "" }, {}), /invalid_model/);
});

test("v1 agent-specific bounds stay narrow", async () => {
  const classifier = await loadManifest("activity.classifier");
  const matcher = await loadManifest("goal.item-matcher");
  const memberFinder = await loadManifest("goal.member-finder");
  const discovery = await loadManifest("goal.discovery");
  const planner = await loadManifest("goal.planner");
  assert.equal(classifier.output_schema.properties.decisions.maxItems, 1);
  for (const manifest of [matcher, memberFinder]) {
    assert.equal(manifest.page_size, 50);
    assert.deepEqual(manifest.decision_kinds, ["relation_add"]);
    assert.equal(
      manifest.output_schema.properties.decisions.items.properties.proposal.properties.relation_type_id.const,
      "part_of"
    );
  }
  assert.deepEqual(discovery.pipeline.stages, ["map", "merge"]);
  assert.equal(discovery.pipeline.minimum_members, 2);
  assert.equal(discovery.pipeline.maximum_members, 50);
  assert.equal(discovery.review_only, true);
  assert.equal(planner.minimum_steps, 2);
  assert.equal(planner.maximum_steps, 20);
  assert.equal(planner.explicit_trigger_only, true);
  assert.equal(planner.review_only, true);
});
