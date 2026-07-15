import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { invokeAgent } from "./invoke.mjs";
import { environmentName, loadManifest, modelFor, taskQueueFor } from "./manifest.mjs";
import { agentDeploymentVersion } from "./versioning.mjs";

const workflowsPath = fileURLToPath(new URL("./workflows.mjs", import.meta.url));
export const FORBIDDEN_RUNTIME_KEYS = Object.freeze(
  JSON.parse(fs.readFileSync(new URL("../runtime-policy.json", import.meta.url), "utf8")).forbidden_environment_keys
);

export async function runAgentWorker(agentId, {
  env = process.env,
  createConnection = (options) => NativeConnection.connect(options),
  createWorker = (options) => Worker.create(options),
  log = console
} = {}) {
  assertCredentialIsolation(env);
  const manifest = await loadManifest(agentId);
  const environment = environmentName(env.BRAI_ENVIRONMENT);
  const taskQueue = taskQueueFor(manifest, environment, env.BRAI_GOAL_AGENT_TASK_QUEUE);
  modelFor(manifest, env);
  const address = env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = env.TEMPORAL_NAMESPACE ?? "default";
  const identity = workerIdentity(manifest, environment);
  const connection = await createConnection({ address });
  let worker;
  try {
    worker = await createWorker(workerOptionsFor({
      manifest,
      environment,
      taskQueue,
      namespace,
      identity,
      connection,
      env
    }));
  } catch (error) {
    await connection.close();
    throw error;
  }
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    boundedLog(log, "info", "goal_agent_shutdown", { agent_id: manifest.id, environment, task_queue: taskQueue, signal });
    worker.shutdown();
  };
  const onTerm = () => shutdown("SIGTERM");
  const onInt = () => shutdown("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  boundedLog(log, "info", "goal_agent_started", {
    agent_id: manifest.id,
    agent_version: manifest.version,
    environment,
    task_queue: taskQueue,
    identity
  });
  try {
    await worker.run();
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    await connection.close();
    boundedLog(log, "info", "goal_agent_stopped", { agent_id: manifest.id, environment, task_queue: taskQueue });
  }
}

export function workerOptionsFor({ manifest, environment, taskQueue, namespace, identity, connection, env = process.env }) {
  const deploymentVersion = agentDeploymentVersion(manifest, environment);
  return {
    activities: {
      invokeAgent: (input) => invokeAgent(manifest, input, {
        env,
        heartbeat,
        signal: cancellationSignal()
      })
    },
    connection,
    namespace,
    taskQueue,
    workflowsPath,
    identity,
    shutdownGraceTime: "30 seconds",
    maxConcurrentActivityTaskExecutions: 1,
    maxConcurrentWorkflowTaskExecutions: 10,
    workerDeploymentOptions: {
      version: deploymentVersion,
      useWorkerVersioning: true,
      defaultVersioningBehavior: "PINNED"
    }
  };
}

export function assertCredentialIsolation(env) {
  const present = FORBIDDEN_RUNTIME_KEYS.filter((key) => String(env[key] ?? "").trim());
  if (present.length > 0) throw new Error("forbidden_agent_credentials:" + present.join(","));
}

export function workerIdentity(manifest, environment, hostname = os.hostname(), pid = process.pid) {
  return manifest.id + ":" + environment + ":" + hostname + ":" + pid;
}

function boundedLog(logger, level, event, detail) {
  const line = JSON.stringify({ event, ...detail });
  logger[level]?.(line.slice(0, 2_000));
}
