import { Client, Connection } from "@temporalio/client";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_SMOKE_AGENT_ID,
  CONTEXT_SMOKE_SCHEMA,
  CONTEXT_SMOKE_WORKFLOW,
  assertContextSmokeResponse
} from "./context-smoke-contract.mjs";
import { contextTaskQueue } from "./contracts.mjs";
import { environmentName, loadManifest, taskQueueFor } from "./manifest.mjs";
import { agentDeploymentVersion, contextDeploymentVersion } from "./versioning.mjs";

export async function runGoalAgentContextSmoke({
  environment,
  address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  namespace = process.env.TEMPORAL_NAMESPACE ?? "default",
  nonce = randomBytes(32).toString("base64url"),
  workflowUuid = randomUUID(),
  connect = (options) => Connection.connect(options),
  createClient = (connection) => new Client({ connection, namespace })
}) {
  const resolvedEnvironment = environmentName(environment);
  const manifest = await loadManifest(CONTEXT_SMOKE_AGENT_ID);
  const workflowTaskQueue = taskQueueFor(manifest, resolvedEnvironment);
  const workflowDeployment = agentDeploymentVersion(manifest, resolvedEnvironment);
  const expectedContextDeployment = contextDeploymentVersion(resolvedEnvironment);
  const workflowId = `brai:goal-agent-context-smoke:${resolvedEnvironment}:${workflowUuid}`;
  const input = {
    schema_version: CONTEXT_SMOKE_SCHEMA,
    environment: resolvedEnvironment,
    context_task_queue: contextTaskQueue(resolvedEnvironment),
    nonce
  };
  const connection = await connect({ address });
  try {
    const response = await createClient(connection).workflow.execute(CONTEXT_SMOKE_WORKFLOW, {
      args: [input],
      taskQueue: workflowTaskQueue,
      workflowId,
      workflowExecutionTimeout: "30 seconds",
      workflowRunTimeout: "25 seconds",
      workflowTaskTimeout: "10 seconds",
      retry: { maximumAttempts: 1 },
      versioningOverride: { pinnedTo: workflowDeployment }
    });
    return assertContextSmokeResponse(response, {
      ...input,
      workflow_deployment: workflowDeployment,
      workflow_id: workflowId,
      workflow_task_queue: workflowTaskQueue,
      workflow_type: CONTEXT_SMOKE_WORKFLOW
    }, expectedContextDeployment);
  } finally {
    await connection.close();
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--environment") {
    throw new Error("usage: context-smoke-cli --environment <prod|dev|preview-a..e>");
  }
  return { environment: argv[1] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGoalAgentContextSmoke(parseArgs(process.argv.slice(2)))
    .then((result) => console.log(JSON.stringify({
      ok: true,
      environment: result.environment,
      workflow_deployment: result.workflow_deployment,
      context_deployment: result.context_deployment
    })))
    .catch((error) => {
      console.error(String(error?.message ?? error).slice(0, 1_000));
      process.exitCode = 1;
    });
}
