import { CancelledFailure, WorkflowFailedError, WorkflowNotFoundError } from "@temporalio/client";

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

export async function cancelWorkflowWithTimeout(handle, timeoutMs = 10_000) {
  let timer;
  const deadline = Date.now() + timeoutMs;
  const cancellation = (async () => {
    while (Date.now() < deadline) {
      try {
        await handle.cancel();
        return;
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
      }
    }
    throw new Error(`Temporal cancellation timed out after ${timeoutMs}ms`);
  })();
  try {
    await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Temporal cancellation timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function cancelWorkflowAndWaitWithTimeout(handle, timeoutMs = 10_000) {
  const startedAt = Date.now();
  await cancelWorkflowWithTimeout(handle, timeoutMs);
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  let timer;
  try {
    await Promise.race([
      handle.result(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Temporal cancellation result timed out after ${timeoutMs}ms`)), remainingMs);
      })
    ]);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return;
    if (!(error instanceof WorkflowFailedError) || !hasCancelledCause(error.cause)) throw error;
  } finally {
    clearTimeout(timer);
  }
}

function hasCancelledCause(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    if (current instanceof CancelledFailure) return true;
    seen.add(current);
  }
  return false;
}
