import { NativeConnection, Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import * as activities from "./activities.mjs";
import { PREVIEW_TASK_QUEUE, PROMOTION_TASK_QUEUE } from "./state.mjs";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const workflowsPath = fileURLToPath(new URL("./workflows.mjs", import.meta.url));

const connection = await NativeConnection.connect({ address });
const workers = await Promise.all(
  [PREVIEW_TASK_QUEUE, PROMOTION_TASK_QUEUE].map((taskQueue) =>
    Worker.create({
      activities,
      connection,
      namespace,
      taskQueue,
      workflowsPath
    })
  )
);

console.log(`Bright OS Temporal worker connected to ${address}/${namespace}`);
await Promise.all(workers.map((worker) => worker.run()));
