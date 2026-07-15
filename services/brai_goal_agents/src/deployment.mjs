import { Connection } from "@temporalio/client";
import { fileURLToPath } from "node:url";
import { environmentName, loadManifest } from "./manifest.mjs";
import { agentDeploymentVersion } from "./versioning.mjs";

export async function promoteAgentDeployment({
  agentId,
  environment,
  address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
  namespace = process.env.TEMPORAL_NAMESPACE ?? "default",
  identity = `brai-goal-agent-deploy:${process.pid}`,
  connect = (options) => Connection.connect(options)
}) {
  const manifest = await loadManifest(agentId);
  const resolvedEnvironment = environmentName(environment);
  const version = agentDeploymentVersion(manifest, resolvedEnvironment);
  const connection = await connect({ address });
  try {
    await connection.workflowService.setWorkerDeploymentCurrentVersion({
      namespace,
      deploymentName: version.deploymentName,
      buildId: version.buildId,
      identity,
      allowNoPollers: false,
      ignoreMissingTaskQueues: false
    });
    return { ok: true, agent_id: agentId, environment: resolvedEnvironment, ...version };
  } finally {
    await connection.close();
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("usage: deployment --agent <id> --environment <env>");
    values[key.slice(2)] = value;
  }
  if (!values.agent || !values.environment) throw new Error("usage: deployment --agent <id> --environment <env>");
  return values;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  promoteAgentDeployment({ agentId: args.agent, environment: args.environment })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(String(error?.message ?? error).slice(0, 1_000));
      process.exitCode = 1;
    });
}
