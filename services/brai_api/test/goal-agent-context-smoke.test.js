import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalAgentContextSmokeActivity } from '../src/goal-agent-context-smoke.js';
import {
  CONTEXT_SMOKE_SCHEMA,
  CONTEXT_SMOKE_WORKFLOW,
  contextSmokeRequest
} from '../../brai_goal_agents/src/context-smoke-contract.mjs';
import { loadManifest } from '../../brai_goal_agents/src/manifest.mjs';
import { agentDeploymentVersion } from '../../brai_goal_agents/src/versioning.mjs';

const environment = 'preview-d';
const workflowId = `brai:goal-agent-context-smoke:${environment}:22222222-2222-4222-8222-222222222222`;

async function fixture(overrides = {}) {
  const manifest = await loadManifest('activity.classifier');
  const request = contextSmokeRequest({
    schema_version: CONTEXT_SMOKE_SCHEMA,
    environment,
    context_task_queue: `brai-agent-context-${environment}`,
    nonce: 'b'.repeat(43)
  }, {
    workflowType: CONTEXT_SMOKE_WORKFLOW,
    workflowId,
    taskQueue: `${manifest.queue_base}-${environment}`,
    currentDeploymentVersion: agentDeploymentVersion(manifest, environment)
  });
  const info = {
    inWorkflow: true,
    taskQueue: request.context_task_queue,
    workflowType: CONTEXT_SMOKE_WORKFLOW,
    workflowExecution: { workflowId, runId: 'run-1' },
    ...overrides
  };
  return {
    request,
    activity: createGoalAgentContextSmokeActivity({
      environment,
      manifests: new Map([[manifest.id, manifest]]),
      activityInfo: () => info
    })
  };
}

test('API-owned smoke Activity returns only the bounded exact deployment proof', async () => {
  const { request, activity } = await fixture();
  const response = await activity(request);
  assert.equal(response.nonce, request.nonce);
  assert.equal(response.context_deployment.deploymentName, `brai-api-context-${environment}`);
  assert.deepEqual(Object.keys(response).sort(), [...Object.keys(request), 'context_deployment'].sort());
});

test('API-owned smoke Activity rejects a direct or wrong-workflow call before returning proof', async () => {
  const direct = await fixture({ inWorkflow: false });
  await assert.rejects(() => direct.activity(direct.request), /context_smoke_activity_identity_mismatch/);
  const wrongWorkflow = await fixture({ workflowType: 'GoalPlannerWorkflow' });
  await assert.rejects(() => wrongWorkflow.activity(wrongWorkflow.request), /context_smoke_activity_identity_mismatch/);
});

test('API-owned smoke Activity rejects a tampered environment contract', async () => {
  const { request, activity } = await fixture();
  await assert.rejects(() => activity({ ...request, environment: 'prod' }), /context_smoke_environment_mismatch|task_queue_mismatch/);
});
