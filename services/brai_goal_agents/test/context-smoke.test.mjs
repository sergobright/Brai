import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SMOKE_SCHEMA,
  CONTEXT_SMOKE_WORKFLOW,
  assertContextSmokeResponse,
  contextSmokeRequest
} from "../src/context-smoke-contract.mjs";
import { runGoalAgentContextSmoke } from "../src/context-smoke-cli.mjs";
import { contextDeploymentVersion } from "../src/versioning.mjs";

const environment = "preview-c";
const workflowId = `brai:goal-agent-context-smoke:${environment}:11111111-1111-4111-8111-111111111111`;
const input = {
  schema_version: CONTEXT_SMOKE_SCHEMA,
  environment,
  context_task_queue: `brai-agent-context-${environment}`,
  nonce: "a".repeat(43)
};
const info = {
  workflowType: CONTEXT_SMOKE_WORKFLOW,
  workflowId,
  taskQueue: `brai-agent-activity-classifier-${environment}`,
  currentDeploymentVersion: {
    deploymentName: `brai-agent-activity-classifier-${environment}`,
    buildId: "relations-goals-activity-classifier.v1.123456789abc"
  }
};

test("smoke contract binds nonce, environment, queues, workflow type and exact deployment", () => {
  const request = contextSmokeRequest(input, info);
  const response = assertContextSmokeResponse({
    ...request,
    context_deployment: {
      deploymentName: `brai-api-context-${environment}`,
      buildId: "relations-goals-context.v1.123456789abc"
    }
  }, request);
  assert.equal(response.nonce, input.nonce);
  assert.equal(response.workflow_deployment.buildId, info.currentDeploymentVersion.buildId);
});

test("smoke contract fails closed for spoofed queues, nonce, and deployment", () => {
  assert.throws(() => contextSmokeRequest({ ...input, nonce: "short" }, info), /invalid_context_smoke_nonce/);
  assert.throws(() => contextSmokeRequest(input, { ...info, taskQueue: "brai-agent-goal-planner-preview-c" }), /task_queue_mismatch/);
  assert.throws(() => contextSmokeRequest(input, {
    ...info,
    currentDeploymentVersion: { ...info.currentDeploymentVersion, buildId: "bad build" }
  }), /invalid_context_smoke_deployment/);
});

test("smoke CLI pins the real workflow to the exact classifier build and closes the connection", async () => {
  let closed = false;
  let observed;
  const result = await runGoalAgentContextSmoke({
    environment,
    nonce: input.nonce,
    workflowUuid: "11111111-1111-4111-8111-111111111111",
    connect: async () => ({ close: async () => { closed = true; } }),
    createClient: () => ({
      workflow: {
        execute: async (workflowType, options) => {
          observed = { workflowType, options };
          return {
            ...options.args[0],
            workflow_deployment: options.versioningOverride.pinnedTo,
            workflow_id: options.workflowId,
            workflow_task_queue: options.taskQueue,
            workflow_type: workflowType,
            context_deployment: contextDeploymentVersion(environment)
          };
        }
      }
    })
  });
  assert.equal(closed, true);
  assert.equal(observed.workflowType, CONTEXT_SMOKE_WORKFLOW);
  assert.equal(observed.options.workflowExecutionTimeout, "30 seconds");
  assert.equal(observed.options.retry.maximumAttempts, 1);
  assert.deepEqual(result.workflow_deployment, observed.options.versioningOverride.pinnedTo);
});
