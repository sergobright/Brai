import { PREVIEW_TASK_QUEUE, PROMOTION_TASK_QUEUE } from "./state.mjs";

export function workerTaskQueues(env = process.env) {
  const configured = String(env.BRAI_TEMPORAL_WORKER_TASK_QUEUES ?? "").trim();
  const queues = configured ? configured.split(",").map((value) => value.trim()).filter(Boolean) : [
    PREVIEW_TASK_QUEUE,
    PROMOTION_TASK_QUEUE
  ];
  if (queues.length === 0 || new Set(queues).size !== queues.length
    || queues.some((queue) => !/^brai-[a-z0-9._:-]{1,95}$/.test(queue))) {
    throw new Error("invalid_temporal_worker_task_queues");
  }
  return queues;
}
