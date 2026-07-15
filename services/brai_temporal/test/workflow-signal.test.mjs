import assert from "node:assert/strict";
import test from "node:test";
import { CancelledFailure, WorkflowFailedError, WorkflowNotFoundError } from "@temporalio/client";
import {
  cancelWorkflowAndWaitWithTimeout,
  cancelWorkflowWithTimeout,
  signalWithClosedWorkflowRetry
} from "../src/workflow-signal.mjs";

test("restarts and signals when the previous workflow closes before signal", async () => {
  const calls = [];
  const closing = {
    signal: async () => {
      calls.push("closing-signal");
      throw new WorkflowNotFoundError("Workflow not found", "brai:preview:test", undefined);
    }
  };
  const restarted = {
    signal: async (name, event) => calls.push([name, event.type])
  };
  let attempt = 0;

  const result = await signalWithClosedWorkflowRetry(async () => {
    attempt += 1;
    return attempt === 1
      ? { handle: closing, started: false }
      : { handle: restarted, started: true };
  }, "event", { type: "accepted_preview_promoted" });

  assert.equal(result.handle, restarted);
  assert.deepEqual(calls, ["closing-signal", ["event", "accepted_preview_promoted"]]);
});

test("does not retry unrelated signal failures", async () => {
  let attempts = 0;
  await assert.rejects(
    signalWithClosedWorkflowRetry(async () => {
      attempts += 1;
      return { handle: { signal: async () => { throw new Error("permission denied"); } }, started: false };
    }, "event", { type: "accepted_preview_promoted" }),
    /permission denied/
  );
  assert.equal(attempts, 1);
});

test("workflow cancellation is bounded", async () => {
  await assert.rejects(
    cancelWorkflowWithTimeout({ cancel: () => new Promise(() => {}) }, 20),
    /timed out after 20ms/
  );
  await cancelWorkflowWithTimeout({ cancel: async () => {} }, 20);

  let attempts = 0;
  await cancelWorkflowWithTimeout({
    cancel: async () => {
      attempts += 1;
      if (attempts < 3) throw new WorkflowNotFoundError("Workflow not found", "brai:promotion:prod:test", undefined);
    }
  }, 500);
  assert.equal(attempts, 3);
});

test("preview cancellation waits for the terminal workflow result", async () => {
  const calls = [];
  const nestedCancellation = new Error("activity failed during cancellation", {
    cause: new CancelledFailure("cancelled")
  });
  await cancelWorkflowAndWaitWithTimeout({
    cancel: async () => { calls.push("cancel"); },
    result: async () => {
      calls.push("result-started");
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push("result-finished");
      throw new WorkflowFailedError("Workflow execution cancelled", nestedCancellation, 0);
    }
  }, 200);
  assert.deepEqual(calls, ["cancel", "result-started", "result-finished"]);

  const cleanupFailure = new WorkflowFailedError("Workflow execution failed", new Error("process group survived"), 0);
  await assert.rejects(
    cancelWorkflowAndWaitWithTimeout({
      cancel: async () => {},
      result: async () => { throw cleanupFailure; }
    }, 200),
    (error) => error === cleanupFailure
  );

  await assert.rejects(
    cancelWorkflowAndWaitWithTimeout({
      cancel: async () => {},
      result: () => new Promise(() => {})
    }, 20),
    /cancellation result timed out after 20ms/
  );
});
