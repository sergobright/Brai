import {
  CONTEXT_SMOKE_AGENT_ID,
  CONTEXT_SMOKE_SCHEMA,
  CONTEXT_SMOKE_WORKFLOW,
  assertContextSmokeRequest
} from '../../brai_goal_agents/src/context-smoke-contract.mjs';
import { contextTaskQueue } from '../../brai_goal_agents/src/contracts.mjs';
import { agentDeploymentVersion, contextDeploymentVersion } from '../../brai_goal_agents/src/versioning.mjs';

export function createGoalAgentContextSmokeActivity({ environment, manifests, activityInfo }) {
  const contextQueue = contextTaskQueue(environment);
  const manifest = manifests.get(CONTEXT_SMOKE_AGENT_ID);
  if (!manifest) throw new Error('goal_agent_smoke_manifest_missing');
  const workflowDeployment = agentDeploymentVersion(manifest, environment);
  const contextDeployment = contextDeploymentVersion(environment);

  return async function goalAgentContextSmoke(request) {
    assertContextSmokeRequest(request, {
      schema_version: CONTEXT_SMOKE_SCHEMA,
      environment,
      context_task_queue: contextQueue,
      workflow_type: CONTEXT_SMOKE_WORKFLOW,
      workflow_task_queue: `${manifest.queue_base}-${environment}`,
      workflow_deployment: workflowDeployment
    });
    let info;
    try { info = activityInfo(); } catch { throw new Error('context_smoke_activity_identity_missing'); }
    if (info?.inWorkflow !== true || info.taskQueue !== contextQueue
      || info.workflowType !== CONTEXT_SMOKE_WORKFLOW
      || info.workflowExecution?.workflowId !== request.workflow_id) {
      throw new Error('context_smoke_activity_identity_mismatch');
    }
    return { ...request, context_deployment: contextDeployment };
  };
}
