import assert from "node:assert/strict";
import test from "node:test";
import { promoteAgentDeployment } from "../src/deployment.mjs";
import { loadManifest } from "../src/manifest.mjs";
import { agentDeploymentVersion } from "../src/versioning.mjs";

test("promotion sets only the exact healthy deployment version and closes the connection", async () => {
  const expected = agentDeploymentVersion(await loadManifest("goal.item-matcher"), "preview-d");
  let request;
  let closed = false;
  const result = await promoteAgentDeployment({
    agentId: "goal.item-matcher",
    environment: "preview-d",
    namespace: "test",
    identity: "deploy:test",
    connect: async () => ({
      workflowService: {
        async setWorkerDeploymentCurrentVersion(input) { request = input; }
      },
      async close() { closed = true; }
    })
  });
  assert.deepEqual(request, {
    namespace: "test",
    deploymentName: "brai-agent-goal-item-matcher-preview-d",
    buildId: expected.buildId,
    identity: "deploy:test",
    allowNoPollers: false,
    ignoreMissingTaskQueues: false
  });
  assert.equal(result.buildId, expected.buildId);
  assert.equal(closed, true);
});
