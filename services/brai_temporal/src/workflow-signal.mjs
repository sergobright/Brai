import { WorkflowNotFoundError } from "@temporalio/client";

export async function signalWithClosedWorkflowRetry(startOrGet, signalName, event, { skipWhenStarted = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await startOrGet();
    if (result.started && skipWhenStarted) return result;
    try {
      await result.handle.signal(signalName, event);
      return result;
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError) || attempt > 0) throw error;
    }
  }
  throw new Error("unreachable workflow signal retry");
}
