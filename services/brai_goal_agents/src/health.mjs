import { Connection } from "@temporalio/client";
import { fileURLToPath } from "node:url";
import { environmentName, loadManifest, taskQueueFor } from "./manifest.mjs";
import { agentDeploymentVersion, contextDeploymentVersion } from "./versioning.mjs";

const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;

export async function exactPollerHealth({
  agentId,
  environment,
  processId = null,
  address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  namespace = process.env.TEMPORAL_NAMESPACE ?? "default",
  connect = (options) => Connection.connect(options)
}) {
  if (processId !== null && !/^[1-9][0-9]*$/.test(String(processId))) throw new Error("invalid_process_id");
  const resolvedEnvironment = environmentName(environment);
  if (agentId === "api.context") {
    return exactContextPollerHealth({ resolvedEnvironment, processId, address, namespace, connect });
  }
  const manifest = await loadManifest(agentId);
  const taskQueue = taskQueueFor(manifest, resolvedEnvironment);
  const expectedIdentity = manifest.id + ":" + resolvedEnvironment + ":";
  const expectedDeployment = agentDeploymentVersion(manifest, resolvedEnvironment);
  const connection = await connect({ address });
  try {
    const workflowPollers = await describePollers(connection, namespace, taskQueue, TASK_QUEUE_TYPE_WORKFLOW);
    const activityPollers = await describePollers(connection, namespace, taskQueue, TASK_QUEUE_TYPE_ACTIVITY);
    const matchingWorkflow = workflowPollers.filter((poller) => exactPoller(
      poller, expectedIdentity, expectedDeployment, processId
    ));
    const matchingActivity = activityPollers.filter((poller) => exactPoller(
      poller, expectedIdentity, expectedDeployment, processId
    ));
    if (matchingWorkflow.length === 0 || matchingActivity.length === 0) {
      throw new Error("exact_poller_missing:" + manifest.id + ":" + resolvedEnvironment);
    }
    return {
      ok: true,
      agent_id: manifest.id,
      environment: resolvedEnvironment,
      task_queue: taskQueue,
      deployment_version: expectedDeployment,
      workflow_pollers: matchingWorkflow.length,
      activity_pollers: matchingActivity.length
    };
  } finally {
    await connection.close();
  }
}

async function exactContextPollerHealth({ resolvedEnvironment, processId, address, namespace, connect }) {
  const taskQueue = `brai-agent-context-${resolvedEnvironment}`;
  const expectedIdentity = `brai-api-context:${resolvedEnvironment}:`;
  const expectedDeployment = contextDeploymentVersion(resolvedEnvironment);
  const connection = await connect({ address });
  try {
    const pollers = await describePollers(connection, namespace, taskQueue, TASK_QUEUE_TYPE_ACTIVITY);
    const matching = pollers.filter((poller) => exactPoller(
      poller, expectedIdentity, expectedDeployment, processId
    ));
    if (matching.length === 0) throw new Error("exact_context_poller_missing:" + resolvedEnvironment);
    return {
      ok: true, agent_id: "api.context", environment: resolvedEnvironment,
      task_queue: taskQueue, deployment_version: expectedDeployment,
      workflow_pollers: 0, activity_pollers: matching.length
    };
  } finally {
    await connection.close();
  }
}

async function describePollers(connection, namespace, taskQueue, taskQueueType) {
  const response = await connection.workflowService.describeTaskQueue({
    namespace,
    taskQueue: { name: taskQueue },
    taskQueueType
  });
  return response.pollers ?? [];
}

function exactPoller(poller, identityPrefix, expectedDeployment, processId) {
  const identity = String(poller?.identity ?? "");
  const options = poller?.deploymentOptions;
  const version = options?.deploymentVersion ?? options;
  return identity.startsWith(identityPrefix)
    && (!processId || identity.endsWith(`:${processId}`))
    && version?.deploymentName === expectedDeployment.deploymentName
    && version?.buildId === expectedDeployment.buildId;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("usage: health --agent <id> --environment <env>");
    values[key.slice(2)] = value;
  }
  if (!values.agent || !values.environment) throw new Error("usage: health --agent <id> --environment <env>");
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  exactPollerHealth({ agentId: args.agent, environment: args.environment, processId: args.pid ?? null })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? error).slice(0, 1_000));
      process.exitCode = 1;
    });
}
