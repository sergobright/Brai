#!/usr/bin/env node
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { goalAgentStableHash } from "../../services/brai_api/src/goal-agent-context.js";
import { AGENT_IDS, environmentName, loadManifest } from "../../services/brai_goal_agents/src/manifest.mjs";
import { agentDeploymentVersion, contextDeploymentVersion } from "../../services/brai_goal_agents/src/versioning.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromApi = createRequire(path.join(root, "services/brai_api/package.json"));
const requireFromGoalAgents = createRequire(path.join(root, "services/brai_goal_agents/package.json"));
const { Pool } = requireFromApi("pg");
const { Client, Connection, WorkflowNotFoundError } = requireFromGoalAgents("@temporalio/client");

export const MAX_DRAIN_EXECUTIONS = 200;
const NONTERMINAL = new Set(["queued", "running"]);
const TERMINAL_TEMPORAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]);
const CURRENT_COLUMNS = [
  "contract_hash",
  "contract_json",
  "deployment_environment",
  "input_json",
  "run_id",
  "status",
  "workflow_definition_id",
  "workflow_id"
];

export class GoalAgentDrainError extends Error {
  constructor(code, phase = "contract") {
    super(code);
    this.code = code;
    this.phase = phase;
  }
}

export async function incomingDrainCatalog(environment) {
  const resolvedEnvironment = environmentName(environment);
  const manifests = await Promise.all(AGENT_IDS.map(loadManifest));
  return {
    environment: resolvedEnvironment,
    context: contextDeploymentVersion(resolvedEnvironment),
    agents: Object.fromEntries(manifests.map((manifest) => {
      const version = agentDeploymentVersion(manifest, resolvedEnvironment);
      return [manifest.id, {
        agentId: manifest.id,
        buildId: version.buildId,
        deploymentName: version.deploymentName,
        queueBase: manifest.queue_base,
        workflowType: manifest.workflow_type,
        contract: {
          ...manifest,
          worker_build_id: version.buildId,
          worker_deployment_name_base: manifest.queue_base
        }
      }];
    }))
  };
}

export async function readGoalAgentDrainState(pool, environment, limit = MAX_DRAIN_EXECUTIONS) {
  const table = await pool.query("SELECT to_regclass('workflow_executions')::text AS name");
  if (!table.rows[0]?.name) return { rows: [], schemaMode: "absent" };

  const columnsResult = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'workflow_executions'
  `);
  const columns = new Set(columnsResult.rows.map((row) => row.column_name));
  const hasLegacyIdentity = columns.has("workflow_definition_id") && columns.has("status");
  const hasCurrentContract = CURRENT_COLUMNS.every((column) => columns.has(column));
  if (!hasCurrentContract) {
    const count = hasLegacyIdentity
      ? await pool.query(`
          SELECT count(*)::int AS count FROM workflow_executions
          WHERE workflow_definition_id = ANY($1::text[])
        `, [AGENT_IDS])
      : await pool.query("SELECT count(*)::int AS count FROM workflow_executions");
    if (Number(count.rows[0]?.count ?? 0) !== 0) {
      throw new GoalAgentDrainError("goal_agent_drain_legacy_state_unknown", "database");
    }
    return { rows: [], schemaMode: "legacy-empty" };
  }

  const result = await pool.query(`
    SELECT workflow_definition_id AS agent_id, status, deployment_environment,
      workflow_id, run_id, contract_json, contract_hash, input_json
    FROM workflow_executions
    WHERE workflow_definition_id = ANY($1::text[])
      AND status = ANY($2::text[])
      AND (deployment_environment = $3 OR deployment_environment IS NULL)
    ORDER BY workflow_definition_id, status, workflow_id
    LIMIT $4
  `, [AGENT_IDS, [...NONTERMINAL], environment, limit + 1]);
  if (result.rows.length > limit) {
    throw new GoalAgentDrainError("goal_agent_drain_state_too_large", "database");
  }
  return { rows: result.rows, schemaMode: "current" };
}

export function validateFrozenDrainRows(rows, catalog) {
  const target = [];
  for (const raw of validateDrainRowIdentities(rows, catalog)) {
    const row = {
      ...raw,
      contract_json: jsonObject(raw.contract_json),
      input_json: jsonObject(raw.input_json)
    };
    const expected = catalog.agents[row.agent_id];
    const contract = row.contract_json;
    if (contract.id !== row.agent_id
      || contract.worker_build_id !== expected.buildId
      || contract.worker_deployment_name_base !== expected.queueBase
      || row.contract_hash !== goalAgentStableHash(contract)) {
      throw new GoalAgentDrainError("goal_agent_drain_agent_build_mismatch");
    }
    const incomingContract = expected.contract;
    const frozenIncomingFields = Object.fromEntries(
      Object.keys(incomingContract).map((key) => [key, contract[key]])
    );
    if (goalAgentStableHash(frozenIncomingFields) !== goalAgentStableHash(incomingContract)) {
      throw new GoalAgentDrainError("goal_agent_drain_agent_contract_mismatch");
    }
    if (row.input_json.execution_contract?.context_worker_build_id !== catalog.context.buildId) {
      throw new GoalAgentDrainError("goal_agent_drain_context_build_mismatch");
    }
    target.push(row);
  }
  return target;
}

export function validateDrainRowIdentities(rows, catalog) {
  const target = [];
  for (const raw of rows) {
    if (raw.deployment_environment == null) {
      throw new GoalAgentDrainError("goal_agent_drain_environment_missing");
    }
    if (raw.deployment_environment !== catalog.environment) continue;
    const expected = catalog.agents[raw.agent_id];
    const row = { ...raw };
    if (!expected || !NONTERMINAL.has(row.status)) {
      throw new GoalAgentDrainError("goal_agent_drain_row_malformed");
    }
    if (row.status === "running" && !textValue(row.run_id)) {
      throw new GoalAgentDrainError("goal_agent_drain_running_run_missing");
    }
    if (row.status === "queued" && textValue(row.run_id)) {
      throw new GoalAgentDrainError("goal_agent_drain_queued_run_inconsistent");
    }
    if (!String(row.workflow_id ?? "").startsWith(
      `brai:${catalog.environment}:agent:${row.agent_id}:`
    )) {
      throw new GoalAgentDrainError("goal_agent_drain_workflow_identity_mismatch");
    }
    target.push(row);
  }
  return target;
}

export function selectNonterminalDrainRows(rows, temporal, catalog) {
  const described = new Map(temporal.described.map((execution) => [execution.workflowId, execution]));
  return rows.filter((row) => {
    if (row.status !== "running") return true;
    const execution = described.get(row.workflow_id);
    if (!execution?.found) return true;
    const expected = catalog.agents[row.agent_id];
    if (execution.workflowId !== row.workflow_id
      || execution.runId !== row.run_id
      || execution.type !== expected?.workflowType) {
      throw new GoalAgentDrainError("goal_agent_drain_temporal_contract_mismatch");
    }
    if (execution.status === "RUNNING") return true;
    if (TERMINAL_TEMPORAL.has(execution.status)) return false;
    throw new GoalAgentDrainError("goal_agent_drain_temporal_status_mismatch");
  });
}

export async function inspectGoalAgentTemporalState(client, rows, environment, limit = MAX_DRAIN_EXECUTIONS) {
  const described = [];
  for (const row of rows) {
    try {
      const description = await client.workflow.getHandle(row.workflow_id, row.run_id || undefined).describe();
      described.push(temporalExecution(description, true));
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError) && error?.name !== "WorkflowNotFoundError") throw error;
      described.push({ workflowId: row.workflow_id, found: false });
    }
  }

  const visible = [];
  const prefix = `brai:${environment}:agent:`;
  const query = `WorkflowId STARTS_WITH '${prefix}' AND ExecutionStatus = 'Running'`;
  for await (const execution of client.workflow.list({ query, pageSize: 100 })) {
    visible.push(temporalExecution(execution, true));
    if (visible.length > limit) {
      throw new GoalAgentDrainError("goal_agent_drain_temporal_state_too_large", "temporal");
    }
  }
  return { described, visible };
}

export function validateTemporalDrainState({ rows, temporal, catalog }) {
  const byWorkflow = new Map(rows.map((row) => [row.workflow_id, row]));
  const described = new Map(temporal.described.map((execution) => [execution.workflowId, execution]));
  for (const row of rows) {
    const execution = described.get(row.workflow_id);
    if (!execution?.found) {
      if (row.status === "running") throw new GoalAgentDrainError("goal_agent_drain_temporal_run_missing");
      continue;
    }
    if (row.status === "queued") {
      if (!TERMINAL_TEMPORAL.has(execution.status)) {
        throw new GoalAgentDrainError("goal_agent_drain_queued_temporal_inconsistent");
      }
      continue;
    }
    if (execution.status !== "RUNNING") {
      throw new GoalAgentDrainError("goal_agent_drain_temporal_status_mismatch");
    }
    validateTemporalExecution(execution, row, catalog);
  }

  for (const execution of temporal.visible) {
    const row = byWorkflow.get(execution.workflowId);
    if (!row) throw new GoalAgentDrainError("goal_agent_drain_temporal_orphan");
    if (row.status === "queued") {
      throw new GoalAgentDrainError("goal_agent_drain_queued_temporal_inconsistent");
    }
    validateTemporalInventoryExecution(execution, row, catalog);
  }
}

export function validateDeploymentContinuity({ rows, catalog, deployedBranch, expectedBranch, deployedContext }) {
  if (rows.length === 0) return;
  if (!deployedBranch || deployedBranch !== expectedBranch) {
    throw new GoalAgentDrainError("goal_agent_drain_branch_mismatch");
  }
  if (deployedContext?.deploymentName !== catalog.context.deploymentName
    || deployedContext?.buildId !== catalog.context.buildId) {
    throw new GoalAgentDrainError("goal_agent_drain_deployed_context_mismatch");
  }
}

export async function deployedSourceContract(sourceRoot, environment) {
  let deployedBranch = null;
  let deployedContext = null;
  try {
    deployedBranch = (await fs.readFile(path.join(sourceRoot, ".brai-deploy-branch"), "utf8")).trim() || null;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    const versioningUrl = pathToFileURL(path.join(
      sourceRoot, "services/brai_goal_agents/src/versioning.mjs"
    ));
    versioningUrl.searchParams.set("drain", String(Date.now()));
    const deployedVersioning = await import(versioningUrl.href);
    deployedContext = deployedVersioning.contextDeploymentVersion(environment);
  } catch {
    deployedContext = null;
  }
  return { deployedBranch, deployedContext };
}

export async function runGoalAgentDrainCheck({
  databaseUrl,
  environment,
  currentSource,
  expectedBranch,
  temporalAddress = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? "default",
  poolFactory = (options) => new Pool(options),
  connectTemporal = (options) => Connection.connect(options)
}) {
  const catalog = await incomingDrainCatalog(environment);
  const pool = poolFactory({
    connectionString: databaseUrl,
    ssl: postgresSsl(databaseUrl),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000
  });
  let database;
  try {
    database = await readGoalAgentDrainState(pool, catalog.environment);
  } catch (error) {
    if (error instanceof GoalAgentDrainError) throw error;
    throw new GoalAgentDrainError("goal_agent_drain_check_unavailable", "database");
  } finally {
    await pool.end().catch(() => {});
  }

  const candidates = validateDrainRowIdentities(database.rows, catalog);
  let connection;
  let temporal;
  try {
    connection = await connectTemporal({ address: temporalAddress, connectTimeout: "5 seconds" });
    const client = new Client({ connection, namespace: temporalNamespace });
    temporal = await client.withDeadline(Date.now() + 20_000, () => (
      inspectGoalAgentTemporalState(client, candidates, catalog.environment)
    ));
  } catch (error) {
    if (error instanceof GoalAgentDrainError) throw error;
    throw new GoalAgentDrainError("goal_agent_drain_check_unavailable", "temporal");
  } finally {
    await connection?.close().catch(() => {});
  }
  const rows = validateFrozenDrainRows(selectNonterminalDrainRows(candidates, temporal, catalog), catalog);
  validateTemporalDrainState({ rows, temporal, catalog });

  let deployed = { deployedBranch: null, deployedContext: null };
  if (rows.length > 0) {
    try {
      deployed = await deployedSourceContract(currentSource, catalog.environment);
    } catch {
      throw new GoalAgentDrainError("goal_agent_drain_deployed_source_unavailable", "source");
    }
  }
  validateDeploymentContinuity({
    rows,
    catalog,
    expectedBranch,
    deployedBranch: deployed.deployedBranch,
    deployedContext: deployed.deployedContext
  });

  const byAgent = Object.fromEntries(AGENT_IDS.map((agentId) => [
    agentId, rows.filter((row) => row.agent_id === agentId).length
  ]));
  const stateDigest = goalAgentStableHash({
    rows: rows.map((row) => ({
      agent_id: row.agent_id,
      context_worker_build_id: row.input_json.execution_contract.context_worker_build_id,
      run_id: row.run_id,
      status: row.status,
      worker_build_id: row.contract_json.worker_build_id,
      workflow_id: row.workflow_id
    })),
    temporal: temporal.visible.map((execution) => ({
      run_id: execution.runId,
      workflow_id: execution.workflowId
    })).sort((left, right) => left.workflow_id.localeCompare(right.workflow_id))
  });
  return {
    ok: true,
    environment: catalog.environment,
    nonterminal: rows.length,
    stateDigest,
    preserveTargetData: rows.length > 0,
    database: {
      schemaMode: database.schemaMode,
      queued: rows.filter((row) => row.status === "queued").length,
      running: rows.filter((row) => row.status === "running").length,
      byAgent
    },
    temporal: { running: temporal.visible.length }
  };
}

export async function runGoalAgentTemporalEmptyCheck({
  environment,
  temporalAddress = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? "default",
  connectTemporal = (options) => Connection.connect(options),
  clientFactory = (options) => new Client(options)
}) {
  const catalog = await incomingDrainCatalog(environment);
  let connection;
  let temporal;
  try {
    connection = await connectTemporal({ address: temporalAddress, connectTimeout: "5 seconds" });
    const client = clientFactory({ connection, namespace: temporalNamespace });
    temporal = await client.withDeadline(Date.now() + 20_000, () => (
      inspectGoalAgentTemporalState(client, [], catalog.environment)
    ));
  } catch (error) {
    if (error instanceof GoalAgentDrainError) throw error;
    throw new GoalAgentDrainError("goal_agent_drain_check_unavailable", "temporal");
  } finally {
    await connection?.close().catch(() => {});
  }
  validateTemporalDrainState({ rows: [], temporal, catalog });
  return {
    ok: true,
    environment: catalog.environment,
    temporalRunning: 0,
    temporal: { running: 0 }
  };
}

function validateTemporalExecution(execution, row, catalog) {
  validateTemporalInventoryExecution(execution, row, catalog);
  if (!temporalVersionMatches(execution.raw, catalog.agents[row.agent_id])) {
    throw new GoalAgentDrainError("goal_agent_drain_temporal_contract_mismatch");
  }
}

function validateTemporalInventoryExecution(execution, row, catalog) {
  const expected = catalog.agents[row.agent_id];
  if (execution.status !== "RUNNING"
    || execution.workflowId !== row.workflow_id
    || (row.run_id && execution.runId !== row.run_id)
    || execution.type !== expected.workflowType) {
    throw new GoalAgentDrainError("goal_agent_drain_temporal_contract_mismatch");
  }
}

export function temporalVersionMatches(raw, expected) {
  const info = raw?.versioningInfo;
  const pinned = info?.versioningOverride?.pinned?.version;
  if (pinned?.buildId || pinned?.deploymentName) {
    return pinned.buildId === expected.buildId && pinned.deploymentName === expected.deploymentName;
  }
  if (info?.versioningOverride?.pinnedVersion) {
    return info.versioningOverride.pinnedVersion === `${expected.deploymentName}.${expected.buildId}`;
  }
  const deployment = info?.deploymentVersion;
  if (deployment?.buildId || deployment?.deploymentName) {
    return deployment.buildId === expected.buildId && deployment.deploymentName === expected.deploymentName;
  }
  return raw?.assignedBuildId === expected.buildId && raw?.workerDeploymentName === expected.deploymentName;
}

function temporalExecution(execution, found) {
  const raw = execution.raw?.workflowExecutionInfo ?? execution.raw ?? {};
  return {
    found,
    workflowId: execution.workflowId,
    runId: execution.runId,
    type: execution.type,
    status: execution.status?.name ?? "UNKNOWN",
    raw
  };
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new GoalAgentDrainError("goal_agent_drain_row_malformed");
}

function textValue(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function postgresSsl(databaseUrl) {
  const override = process.env.BRAI_DATABASE_SSL;
  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return { rejectUnauthorized: false };
  return /supabase\.(?:co|com)|pooler\.supabase\.com/.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : false;
}

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    if (!key?.startsWith("--") || values[index + 1] == null) {
      throw new GoalAgentDrainError("goal_agent_drain_invalid_arguments", "input");
    }
    args[key.slice(2)] = values[index + 1];
  }
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args["require-empty-temporal"] === "true" && args.environment) {
      const summary = await runGoalAgentTemporalEmptyCheck({ environment: args.environment });
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return;
    }
    const databaseUrl = process.env.BRAI_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!databaseUrl || !args.environment || !args["current-source"] || !args["expected-branch"]) {
      throw new GoalAgentDrainError("goal_agent_drain_invalid_arguments", "input");
    }
    const summary = await runGoalAgentDrainCheck({
      databaseUrl,
      environment: args.environment,
      currentSource: args["current-source"],
      expectedBranch: args["expected-branch"]
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    const code = error instanceof GoalAgentDrainError
      ? error.code
      : "goal_agent_drain_check_unavailable";
    const phase = error instanceof GoalAgentDrainError ? error.phase : "unknown";
    process.stdout.write(`${JSON.stringify({ ok: false, error: code, phase })}\n`);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) await main();
