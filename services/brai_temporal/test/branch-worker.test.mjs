import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { workerTaskQueues } from "../src/worker-queues.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");

test("branch worker polls only its exact SHA-qualified queue", () => {
  assert.deepEqual(workerTaskQueues({
    BRAI_TEMPORAL_WORKER_TASK_QUEUES: "brai-preview-branch-0123456789abcdef0123456789abcdef01234567"
  }), ["brai-preview-branch-0123456789abcdef0123456789abcdef01234567"]);
  assert.throws(() => workerTaskQueues({
    BRAI_TEMPORAL_WORKER_TASK_QUEUES: "brai-preview,brai-preview"
  }), /invalid_temporal_worker_task_queues/);
});

test("preview dispatch boots exact branch worker before invoking the client", () => {
  const script = fs.readFileSync(path.join(repo, "deploy/scripts/ci-temporal-signal.sh"), "utf8");
  const queue = script.indexOf('task_queue="brai-preview-branch-$sha"');
  const worker = script.indexOf('BRAI_TEMPORAL_WORKER_TASK_QUEUES="$task_queue"');
  const client = script.indexOf('BRAI_TEMPORAL_PREVIEW_TASK_QUEUE="$task_queue"');
  assert.ok(queue > 0 && queue < worker && worker < client);
  assert.match(script, /dispatch-preview-deploy requires an exact 40-character --sha/);
  assert.match(script, /CLEANUP_TEMPORAL_ADDRESS="127\.0\.0\.1:\$local_port"/);
  assert.match(script, /TEMPORAL_ADDRESS="\$CLEANUP_TEMPORAL_ADDRESS"[\s\S]*?cancel-preview-deploy/);
});

test("isolated workflow separates generic deploy and Goal-agent verification", () => {
  const source = fs.readFileSync(path.join(repo, "services/brai_temporal/src/workflows.mjs"), "utf8");
  const workflow = source.indexOf("export async function BranchPreviewDeployWorkflow");
  const deploy = source.indexOf("activities.deployBranch", workflow);
  const agentStarted = source.indexOf('"goal_agents_deploy_started"', deploy);
  const verify = source.indexOf("activities.verifyGoalAgentDeployment", agentStarted);
  const agentPassed = source.indexOf('"goal_agents_deploy_passed"', verify);
  const previewPassed = source.indexOf('"preview_deploy_passed"', agentPassed);
  assert.ok(workflow > 0 && workflow < deploy && deploy < agentStarted);
  assert.ok(agentStarted < verify && verify < agentPassed && agentPassed < previewPassed);
  const activities = fs.readFileSync(path.join(repo, "services/brai_temporal/src/activities.mjs"), "utf8");
  assert.match(activities, /deploy\/scripts\/ci-ssh-deploy-goal-agents\.sh/);
  assert.doesNotMatch(activities, /ci-ssh-goal-agent-gate\.sh/);
});
