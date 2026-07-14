import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./activities.mjs";
import { workerTaskQueues } from "./worker-queues.mjs";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const workflowsPath = fileURLToPath(new URL("./workflows.mjs", import.meta.url));
const taskQueues = workerTaskQueues(process.env);

const connection = await NativeConnection.connect({ address });
const workers = await Promise.all(
  taskQueues.map((taskQueue) =>
    Worker.create({
      activities,
      connection,
      namespace,
      taskQueue,
      workflowsPath
    })
  )
);

console.log(`Brai Temporal worker connected to ${address}/${namespace}: ${taskQueues.join(",")}`);
await Promise.all(workers.map((worker) => worker.run()));
