import assert from "node:assert/strict";
import test from "node:test";
import { goalAgentStableHash } from "../../brai_api/src/goal-agent-context.js";
import {
  GoalAgentDrainError,
  inspectGoalAgentTemporalState,
  MAX_DRAIN_EXECUTIONS,
  readGoalAgentDrainState,
  runGoalAgentDrainCheck,
  runGoalAgentTemporalEmptyCheck,
  selectNonterminalDrainRows,
  temporalVersionMatches,
  validateDeploymentContinuity,
  validateFrozenDrainRows,
  validateTemporalDrainState
} from "../../../deploy/scripts/goal-agent-drain-check.mjs";

const environment = "preview-b";
const agentId = "goal.item-matcher";
const frozenContract = {
  id: agentId,
  version: "1",
  workflow_definition_version: 1,
  worker_build_id: "goal-item-matcher.v1.aaaaaaaaaaaa",
  worker_deployment_name_base: "brai-agent-goal-item-matcher",
  workflow_type: "GoalItemMatcherWorkflow",
  queue_base: "brai-agent-goal-item-matcher",
  entrypoint: "src/entrypoints/goal-item-matcher.mjs",
  input_schema_version: "brai.goal-agent.input.v1",
  prompt_version: "goal-item-matcher.v1",
  output_schema_version: "brai.goal-item-matcher.result.v1",
  model_env: "BRAI_GOAL_ITEM_MATCHER_MODEL",
  default_model: "gpt-5.4-mini",
  timeout_ms: 60_000,
  retry: { schema_attempts: 3 },
  decision_kinds: ["relation_add"],
  review_only: false,
  prompt: "Match one work item to an existing goal.",
  output_schema: { type: "object", additionalProperties: false }
};
const expected = {
  agentId,
  buildId: frozenContract.worker_build_id,
  deploymentName: "brai-agent-goal-item-matcher-preview-b",
  queueBase: frozenContract.queue_base,
  workflowType: frozenContract.workflow_type,
  contract: frozenContract
};
const catalog = {
  environment,
  context: {
    buildId: "relations-goals-context.v1.bbbbbbbbbbbb",
    deploymentName: "brai-api-context-preview-b"
  },
  agents: { [agentId]: expected }
};

function row(overrides = {}) {
  const contract = structuredClone(frozenContract);
  return {
    agent_id: agentId,
    status: "queued",
    deployment_environment: environment,
    workflow_id: `brai:${environment}:agent:${agentId}:v1:owner:subject:trigger:1`,
    run_id: null,
    contract_json: contract,
    contract_hash: goalAgentStableHash(contract),
    input_json: {
      execution_contract: { context_worker_build_id: catalog.context.buildId }
    },
    ...overrides
  };
}

function temporal(workflowRow, overrides = {}) {
  return {
    found: true,
    workflowId: workflowRow.workflow_id,
    runId: workflowRow.run_id ?? "run-1",
    type: expected.workflowType,
    status: "RUNNING",
    raw: {
      versioningInfo: {
        versioningOverride: {
          pinned: {
            version: {
              buildId: expected.buildId,
              deploymentName: expected.deploymentName
            }
          }
        }
      }
    },
    ...overrides
  };
}

test("queued work without a Temporal run is restart-safe only on exact frozen builds", () => {
  const queued = row();
  const rows = validateFrozenDrainRows([queued], catalog);
  assert.equal(rows.length, 1);
  assert.doesNotThrow(() => validateTemporalDrainState({
    rows,
    temporal: { described: [{ workflowId: queued.workflow_id, found: false }], visible: [] },
    catalog
  }));
  assert.doesNotThrow(() => validateDeploymentContinuity({
    rows,
    catalog,
    deployedBranch: "codex/relations-goal-lists-implementation",
    expectedBranch: "codex/relations-goal-lists-implementation",
    deployedContext: catalog.context
  }));
});

test("queued or running work on an old agent build blocks", () => {
  for (const status of ["queued", "running"]) {
    const contract = {
      id: agentId,
      worker_build_id: "goal-item-matcher.v1.oldoldoldold",
      worker_deployment_name_base: expected.queueBase
    };
    assert.throws(() => validateFrozenDrainRows([row({
      status,
      run_id: status === "running" ? "run-old" : null,
      contract_json: contract,
      contract_hash: goalAgentStableHash(contract)
    })], catalog), errorCode("goal_agent_drain_agent_build_mismatch"));
  }
});

test("missing or wrong frozen context build blocks before context access", () => {
  for (const contextBuild of [undefined, "relations-goals-context.v1.oldoldoldold"]) {
    assert.throws(() => validateFrozenDrainRows([row({
      input_json: { execution_contract: { context_worker_build_id: contextBuild } }
    })], catalog), errorCode("goal_agent_drain_context_build_mismatch"));
  }
});

test("an exact terminal Temporal run is excluded before incoming frozen-build validation", () => {
  const stale = row({
    status: "running",
    run_id: "run-terminal",
    input_json: {
      execution_contract: { context_worker_build_id: "relations-goals-context.v1.oldoldoldold" }
    }
  });
  const terminal = temporal(stale, { status: "FAILED" });
  const selected = selectNonterminalDrainRows(
    [stale],
    { described: [terminal], visible: [] },
    catalog
  );
  assert.deepEqual(selected, []);
  assert.deepEqual(validateFrozenDrainRows(selected, catalog), []);
});

test("queued work rejects self-consistent manifest contract substitutions", () => {
  for (const mutation of [
    { workflow_type: "SubstitutedWorkflow" },
    { prompt: "Substituted prompt" },
    { output_schema: { type: "object", required: ["substituted"] } },
    { workflow_definition_version: 2, version: "2" }
  ]) {
    const contract = { ...structuredClone(frozenContract), ...mutation };
    assert.throws(() => validateFrozenDrainRows([row({
      contract_json: contract,
      contract_hash: goalAgentStableHash(contract)
    })], catalog), errorCode("goal_agent_drain_agent_contract_mismatch"));
  }
});

test("malformed run state, JSON, and workflow identity fail closed", () => {
  assert.throws(() => validateFrozenDrainRows([
    row({ status: "running", run_id: null })
  ], catalog), errorCode("goal_agent_drain_running_run_missing"));
  assert.throws(() => validateFrozenDrainRows([
    row({ contract_json: "not-json" })
  ], catalog), errorCode("goal_agent_drain_row_malformed"));
  assert.throws(() => validateFrozenDrainRows([
    row({ workflow_id: "brai:prod:agent:goal.item-matcher:v1:wrong" })
  ], catalog), errorCode("goal_agent_drain_workflow_identity_mismatch"));
});

test("exact running workflow matches DB run, workflow type, and pinned deployment", () => {
  const running = row({ status: "running", run_id: "run-exact" });
  const rows = validateFrozenDrainRows([running], catalog);
  const execution = temporal(running);
  assert.doesNotThrow(() => validateTemporalDrainState({
    rows,
    temporal: { described: [execution], visible: [execution] },
    catalog
  }));
  assert.equal(temporalVersionMatches(execution.raw, expected), true);
  assert.equal(temporalVersionMatches(execution.raw, { ...expected, buildId: "wrong" }), false);
});

test("list inventory may omit version metadata when exact describe pins the deployment", () => {
  const running = row({ status: "running", run_id: "run-exact" });
  const rows = validateFrozenDrainRows([running], catalog);
  const inventory = temporal(running, { raw: {} });
  assert.doesNotThrow(() => validateTemporalDrainState({
    rows,
    temporal: { described: [temporal(running)], visible: [inventory] },
    catalog
  }));
  assert.throws(() => validateTemporalDrainState({
    rows,
    temporal: { described: [inventory], visible: [inventory] },
    catalog
  }), errorCode("goal_agent_drain_temporal_contract_mismatch"));
  assert.throws(() => validateTemporalDrainState({
    rows,
    temporal: {
      described: [temporal(running)],
      visible: [temporal(running, { runId: "run-other", raw: {} })]
    },
    catalog
  }), errorCode("goal_agent_drain_temporal_contract_mismatch"));
});

test("running mismatch and Temporal orphan fail closed while queued history may be terminal", () => {
  const running = row({ status: "running", run_id: "run-exact" });
  const rows = validateFrozenDrainRows([running], catalog);
  assert.throws(() => validateTemporalDrainState({
    rows,
    temporal: {
      described: [temporal(running, { runId: "run-other" })],
      visible: []
    },
    catalog
  }), errorCode("goal_agent_drain_temporal_contract_mismatch"));
  assert.throws(() => validateTemporalDrainState({
    rows,
    temporal: {
      described: [temporal(running)],
      visible: [temporal(row({ workflow_id: `${running.workflow_id}:orphan` }))]
    },
    catalog
  }), errorCode("goal_agent_drain_temporal_orphan"));
  assert.throws(() => validateFrozenDrainRows([row({ run_id: "queued-bound-run" })], catalog),
    errorCode("goal_agent_drain_queued_run_inconsistent"));
  const queued = row();
  assert.throws(() => validateTemporalDrainState({
    rows: validateFrozenDrainRows([queued], catalog),
    temporal: { described: [temporal(queued)], visible: [temporal(queued)] },
    catalog
  }), errorCode("goal_agent_drain_queued_temporal_inconsistent"));
  assert.doesNotThrow(() => validateTemporalDrainState({
    rows: validateFrozenDrainRows([queued], catalog),
    temporal: {
      described: [temporal(queued, { status: "COMPLETED" })],
      visible: []
    },
    catalog
  }));
});

test("foreign-environment seeded rows are excluded but NULL environment blocks", () => {
  assert.deepEqual(validateFrozenDrainRows([
    row({ deployment_environment: "prod" }),
    row()
  ], catalog).map((entry) => entry.deployment_environment), [environment]);
  assert.throws(() => validateFrozenDrainRows([
    row({ deployment_environment: null })
  ], catalog), errorCode("goal_agent_drain_environment_missing"));
});

test("same-build preservation is branch-bound and requires deployed context continuity", () => {
  const rows = validateFrozenDrainRows([row()], catalog);
  assert.throws(() => validateDeploymentContinuity({
    rows,
    catalog,
    deployedBranch: "codex/previous-slot-owner",
    expectedBranch: "codex/relations-goal-lists-implementation",
    deployedContext: catalog.context
  }), errorCode("goal_agent_drain_branch_mismatch"));
  assert.throws(() => validateDeploymentContinuity({
    rows,
    catalog,
    deployedBranch: "codex/relations-goal-lists-implementation",
    expectedBranch: "codex/relations-goal-lists-implementation",
    deployedContext: { ...catalog.context, buildId: "wrong-context" }
  }), errorCode("goal_agent_drain_deployed_context_mismatch"));
});

test("legacy schema bootstraps only after proving zero five-agent rows", async () => {
  const queries = [];
  const emptyPool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("to_regclass")) return { rows: [{ name: "workflow_executions" }] };
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ column_name: "workflow_definition_id" }, { column_name: "status" }] };
      }
      return { rows: [{ count: 0 }] };
    }
  };
  assert.deepEqual(await readGoalAgentDrainState(emptyPool, environment), {
    rows: [], schemaMode: "legacy-empty"
  });
  assert.deepEqual([...queries.at(-1).params[0]].sort(), [
    "activity.classifier", "goal.discovery", "goal.item-matcher",
    "goal.member-finder", "goal.planner"
  ]);

  const occupiedPool = {
    ...emptyPool,
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ name: "workflow_executions" }] };
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ column_name: "workflow_definition_id" }, { column_name: "status" }] };
      }
      return { rows: [{ count: 1 }] };
    }
  };
  await assert.rejects(
    () => readGoalAgentDrainState(occupiedPool, environment),
    errorCode("goal_agent_drain_legacy_state_unknown")
  );
});

test("absent schema is safe, while current DB inventory is environment-filtered and bounded", async () => {
  const absent = { query: async () => ({ rows: [{ name: null }] }) };
  assert.deepEqual(await readGoalAgentDrainState(absent, environment), {
    rows: [], schemaMode: "absent"
  });

  let selectQuery;
  let selectParams;
  const columns = [
    "workflow_definition_id", "status", "contract_hash", "contract_json",
    "deployment_environment", "input_json", "run_id", "workflow_id"
  ];
  const oversized = {
    async query(sql, params) {
      if (sql.includes("to_regclass")) return { rows: [{ name: "workflow_executions" }] };
      if (sql.includes("information_schema.columns")) {
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      selectQuery = sql;
      selectParams = params;
      return { rows: Array.from({ length: MAX_DRAIN_EXECUTIONS + 1 }, () => row()) };
    }
  };
  await assert.rejects(
    () => readGoalAgentDrainState(oversized, environment),
    errorCode("goal_agent_drain_state_too_large")
  );
  assert.match(selectQuery, /deployment_environment = \$3 OR deployment_environment IS NULL/);
  assert.equal(selectParams[2], environment);
  assert.equal(selectParams[3], MAX_DRAIN_EXECUTIONS + 1);
});

test("Temporal inventory uses the exact environment prefix and rejects an oversized result", async () => {
  let options;
  const client = {
    workflow: {
      async *list(value) {
        options = value;
        for (let index = 0; index <= MAX_DRAIN_EXECUTIONS; index += 1) {
          yield {
            workflowId: `brai:${environment}:agent:${agentId}:v1:${index}`,
            runId: `run-${index}`,
            type: expected.workflowType,
            status: { name: "RUNNING" },
            raw: {}
          };
        }
      }
    }
  };
  await assert.rejects(
    () => inspectGoalAgentTemporalState(client, [], environment),
    errorCode("goal_agent_drain_temporal_state_too_large")
  );
  assert.deepEqual(options, {
    query: `WorkflowId STARTS_WITH 'brai:${environment}:agent:' AND ExecutionStatus = 'Running'`,
    pageSize: 100
  });
});

test("first-install Temporal-only check rejects an exact-environment orphan", async () => {
  const orphan = temporal(row({ status: "running", run_id: "run-orphan" }));
  const connection = { close: async () => {} };
  const workflow = {
    async *list() { yield orphan; }
  };
  await assert.rejects(() => runGoalAgentTemporalEmptyCheck({
    environment,
    connectTemporal: async () => connection,
    clientFactory: () => ({ workflow, withDeadline: (_deadline, operation) => operation() })
  }), errorCode("goal_agent_drain_temporal_orphan"));
});

test("database and Temporal availability failures are phase-bounded", async () => {
  await assert.rejects(() => runGoalAgentDrainCheck({
    databaseUrl: "postgres://local.invalid/test",
    environment,
    currentSource: "/unused",
    expectedBranch: "codex/relations-goal-lists-implementation",
    poolFactory: () => ({
      query: async () => { throw new Error("secret database detail"); },
      end: async () => {}
    }),
    connectTemporal: async () => { throw new Error("must not connect"); }
  }), phaseError("goal_agent_drain_check_unavailable", "database"));

  await assert.rejects(() => runGoalAgentDrainCheck({
    databaseUrl: "postgres://local.invalid/test",
    environment,
    currentSource: "/unused",
    expectedBranch: "codex/relations-goal-lists-implementation",
    poolFactory: () => ({
      query: async () => ({ rows: [{ name: null }] }),
      end: async () => {}
    }),
    connectTemporal: async () => { throw new Error("secret Temporal detail"); }
  }), phaseError("goal_agent_drain_check_unavailable", "temporal"));
});

function errorCode(code) {
  return (error) => error instanceof GoalAgentDrainError && error.code === code;
}

function phaseError(code, phase) {
  return (error) => errorCode(code)(error) && error.phase === phase;
}
