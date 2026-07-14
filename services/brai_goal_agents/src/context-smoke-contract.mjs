export const CONTEXT_SMOKE_SCHEMA = "brai.goal-agent.context-smoke.v1";
export const CONTEXT_SMOKE_WORKFLOW = "GoalAgentContextSmokeWorkflow";
export const CONTEXT_SMOKE_AGENT_ID = "activity.classifier";

const INPUT_KEYS = ["context_task_queue", "environment", "nonce", "schema_version"];
const REQUEST_KEYS = [
  ...INPUT_KEYS,
  "workflow_deployment",
  "workflow_id",
  "workflow_task_queue",
  "workflow_type"
].sort();
const RESPONSE_KEYS = [...REQUEST_KEYS, "context_deployment"].sort();

export function contextSmokeRequest(input, info) {
  assertExactKeys(input, INPUT_KEYS, "invalid_context_smoke_input");
  assertEnvironment(input.environment);
  assertQueue(input.context_task_queue, `brai-agent-context-${input.environment}`);
  assertNonce(input.nonce);
  if (input.schema_version !== CONTEXT_SMOKE_SCHEMA) throw new Error("context_smoke_schema_mismatch");
  if (info?.workflowType !== CONTEXT_SMOKE_WORKFLOW) throw new Error("context_smoke_workflow_type_mismatch");
  assertWorkflowId(info?.workflowId, input.environment);
  assertQueue(info?.taskQueue, `brai-agent-activity-classifier-${input.environment}`);
  assertDeployment(info?.currentDeploymentVersion);
  return {
    ...input,
    workflow_deployment: info.currentDeploymentVersion,
    workflow_id: info.workflowId,
    workflow_task_queue: info.taskQueue,
    workflow_type: info.workflowType
  };
}

export function assertContextSmokeRequest(request, expected = {}) {
  assertExactKeys(request, REQUEST_KEYS, "invalid_context_smoke_request");
  contextSmokeRequest({
    schema_version: request.schema_version,
    environment: request.environment,
    context_task_queue: request.context_task_queue,
    nonce: request.nonce
  }, {
    workflowType: request.workflow_type,
    workflowId: request.workflow_id,
    taskQueue: request.workflow_task_queue,
    currentDeploymentVersion: request.workflow_deployment
  });
  assertExpected(request, expected);
  return request;
}

export function assertContextSmokeResponse(response, request, expectedContextDeployment = null) {
  assertExactKeys(response, RESPONSE_KEYS, "invalid_context_smoke_response");
  const { context_deployment: contextDeployment, ...responseRequest } = response;
  assertContextSmokeRequest(responseRequest, request);
  assertDeployment(contextDeployment);
  if (expectedContextDeployment) assertSameDeployment(contextDeployment, expectedContextDeployment);
  return response;
}

function assertExpected(actual, expected) {
  for (const key of [
    "schema_version", "environment", "context_task_queue", "nonce",
    "workflow_type", "workflow_id", "workflow_task_queue"
  ]) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) {
      throw new Error(`context_smoke_${key}_mismatch`);
    }
  }
  if (expected.workflow_deployment) assertSameDeployment(actual.workflow_deployment, expected.workflow_deployment);
}

function assertSameDeployment(actual, expected) {
  assertDeployment(actual);
  assertDeployment(expected);
  if (actual.deploymentName !== expected.deploymentName || actual.buildId !== expected.buildId) {
    throw new Error("context_smoke_deployment_mismatch");
  }
}

function assertDeployment(value) {
  assertExactKeys(value, ["buildId", "deploymentName"], "invalid_context_smoke_deployment");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.deploymentName)
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.buildId)) {
    throw new Error("invalid_context_smoke_deployment");
  }
}

function assertEnvironment(value) {
  if (!/^(?:prod|dev|preview-[a-e])$/.test(value ?? "")) throw new Error("invalid_context_smoke_environment");
}

function assertNonce(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value ?? "")) throw new Error("invalid_context_smoke_nonce");
}

function assertWorkflowId(value, environment) {
  const uuidV4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const pattern = new RegExp(`^brai:goal-agent-context-smoke:${environment}:${uuidV4}$`);
  if (!pattern.test(value ?? "")) throw new Error("invalid_context_smoke_workflow_id");
}

function assertQueue(actual, expected) {
  if (actual !== expected) throw new Error("context_smoke_task_queue_mismatch");
}

function assertExactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(code);
  }
}
