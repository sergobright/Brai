import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowNotFoundError } from "@temporalio/client";
import { signalWithClosedWorkflowRetry } from "../src/workflow-signal.mjs";

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
