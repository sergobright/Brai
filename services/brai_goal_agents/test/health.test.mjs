import assert from "node:assert/strict";
import test from "node:test";
import { exactPollerHealth } from "../src/health.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { agentDeploymentVersion, contextDeploymentVersion } from "../src/versioning.mjs";

const PLANNER_BUILD_ID = agentDeploymentVersion(await loadManifest("goal.planner"), "preview-b").buildId;
const CONTEXT_BUILD_ID = contextDeploymentVersion("dev").buildId;

function connectionWithPollers(pollersByType) {
  let closed = false;
  const requests = [];
  return {
    connection: {
      workflowService: {
        async describeTaskQueue(request) {
          requests.push(request);
          return { pollers: pollersByType[request.taskQueueType] ?? [] };
        }
      },
      async close() { closed = true; }
    },
    requests,
    closed: () => closed
  };
}

test("health requires workflow and activity pollers with the exact agent/environment identity", async () => {
  const fixture = connectionWithPollers({
    1: [poller("goal.planner:preview-b:host:1", "brai-agent-goal-planner-preview-b", PLANNER_BUILD_ID)],
    2: [poller("goal.planner:preview-b:host:1", "brai-agent-goal-planner-preview-b", PLANNER_BUILD_ID)]
  });
  const result = await exactPollerHealth({
    agentId: "goal.planner",
    environment: "preview-b",
    connect: async () => fixture.connection
  });
  assert.deepEqual(result, {
    ok: true,
    agent_id: "goal.planner",
    environment: "preview-b",
    task_queue: "brai-agent-goal-planner-preview-b",
    deployment_version: {
      deploymentName: "brai-agent-goal-planner-preview-b",
      buildId: PLANNER_BUILD_ID
    },
    workflow_pollers: 1,
    activity_pollers: 1
  });
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every((request) => request.taskQueue.name === "brai-agent-goal-planner-preview-b"));
  assert.equal(fixture.closed(), true);
});

test("a poller from another environment never satisfies health", async () => {
  const fixture = connectionWithPollers({
    1: [poller("goal.planner:prod:host:1", "brai-agent-goal-planner-prod", "goal-planner.v1")],
    2: [poller("goal.planner:prod:host:1", "brai-agent-goal-planner-prod", "goal-planner.v1")]
  });
  await assert.rejects(() => exactPollerHealth({
    agentId: "goal.planner",
    environment: "preview-b",
    connect: async () => fixture.connection
  }), /exact_poller_missing:goal\.planner:preview-b/);
  assert.equal(fixture.closed(), true);
});

test("API context health requires the exact activity-only deployment poller", async () => {
  const fixture = connectionWithPollers({
    2: [poller("brai-api-context:dev:host:9", "brai-api-context-dev", CONTEXT_BUILD_ID)]
  });
  const result = await exactPollerHealth({
    agentId: "api.context", environment: "dev", connect: async () => fixture.connection
  });
  assert.equal(result.activity_pollers, 1);
  assert.equal(result.workflow_pollers, 0);
  assert.equal(result.task_queue, "brai-agent-context-dev");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].taskQueueType, 2);
});

test("matching identity with the wrong build never satisfies health", async () => {
  const fixture = connectionWithPollers({
    1: [poller("goal.planner:preview-b:host:1", "brai-agent-goal-planner-preview-b", "old-build")],
    2: [poller("goal.planner:preview-b:host:1", "brai-agent-goal-planner-preview-b", "old-build")]
  });
  await assert.rejects(() => exactPollerHealth({
    agentId: "goal.planner", environment: "preview-b", connect: async () => fixture.connection
  }), /exact_poller_missing/);
});

test("a stale poller from the previous systemd process never satisfies deploy health", async () => {
  const fixture = connectionWithPollers({
    1: [poller("goal.planner:preview-b:host:10", "brai-agent-goal-planner-preview-b", PLANNER_BUILD_ID)],
    2: [poller("goal.planner:preview-b:host:10", "brai-agent-goal-planner-preview-b", PLANNER_BUILD_ID)]
  });
  await assert.rejects(() => exactPollerHealth({
    agentId: "goal.planner", environment: "preview-b", processId: "11",
    connect: async () => fixture.connection
  }), /exact_poller_missing/);
});

function poller(identity, deploymentName, buildId) {
  return { identity, deploymentOptions: { deploymentName, buildId } };
}
