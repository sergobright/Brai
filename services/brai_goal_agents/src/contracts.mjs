export const EXECUTION_REFERENCE_SCHEMA = "brai.goal-agent.execution-reference.v1";
export const CONTEXT_DESCRIPTOR_SCHEMA = "brai.goal-agent.context-descriptor.v1";
export const CONTEXT_PAGE_SCHEMA = "brai.goal-agent.context-page.v1";

export const MAX_AGENT_INPUT_BYTES = 65_536;
export const MAX_CONTEXT_BASE_BYTES = 20_000;
export const MAX_CONTEXT_PAGE_BYTES = 36_000;
export const MAX_CONTEXT_PAGES = 200;
export const MAX_PAGE_ITEMS = 50;
export const MAX_AGENT_RESULT_LLM_CALLS = 2_000;

const AGENT_IDS = new Set([
  "activity.classifier", "goal.item-matcher", "goal.member-finder",
  "goal.discovery", "goal.planner"
]);
const PAGE_KINDS = Object.freeze({
  "activity.classifier": [],
  "goal.item-matcher": ["items"],
  "goal.member-finder": ["items"],
  "goal.discovery": ["items", "goals"],
  "goal.planner": ["members"]
});

export function contextTaskQueue(environment) {
  const value = requiredText(environment, "environment", 32);
  if (!/^(prod|dev|preview-[a-e])$/.test(value)) throw contractError("invalid_environment");
  return `brai-agent-context-${value}`;
}

export function assertExecutionReference(reference, expectedAgentId = null) {
  assertPlainObject(reference, "execution_reference");
  exactKeys(reference, ["schema_version", "execution_id", "agent_id", "workflow_id", "context_task_queue", "context_capability"]);
  if (reference.schema_version !== EXECUTION_REFERENCE_SCHEMA) throw contractError("invalid_execution_reference_schema");
  requiredText(reference.execution_id, "execution_id", 128);
  const agentId = requiredText(reference.agent_id, "agent_id", 64);
  if (!AGENT_IDS.has(agentId)) throw contractError("invalid_agent_id");
  if (expectedAgentId && agentId !== expectedAgentId) throw contractError("agent_workflow_mismatch");
  requiredText(reference.workflow_id, "workflow_id", 256);
  const capability = requiredText(reference.context_capability, "context_capability", 64);
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw contractError("invalid_context_capability");
  const queue = requiredText(reference.context_task_queue, "context_task_queue", 96);
  if (!/^brai-agent-context-(prod|dev|preview-[a-e])$/.test(queue)) throw contractError("invalid_context_task_queue");
  assertBoundedJson(reference, 1_024, "execution_reference");
  return reference;
}

export function assertContextDescriptor(descriptor, reference) {
  assertPlainObject(descriptor, "context_descriptor");
  exactKeys(descriptor, ["schema_version", "execution_id", "agent_id", "agent_version", "base", "page_counts"]);
  if (descriptor.schema_version !== CONTEXT_DESCRIPTOR_SCHEMA) throw contractError("invalid_context_descriptor_schema");
  if (descriptor.execution_id !== reference.execution_id || descriptor.agent_id !== reference.agent_id) {
    throw contractError("context_descriptor_mismatch");
  }
  requiredText(descriptor.agent_version, "agent_version", 32);
  assertAgentContextBase(descriptor.base, descriptor.agent_id, descriptor.agent_version);
  assertPlainObject(descriptor.page_counts, "page_counts");
  const allowed = new Set(PAGE_KINDS[descriptor.agent_id]);
  for (const [kind, count] of Object.entries(descriptor.page_counts)) {
    if (!allowed.has(kind)) throw contractError("context_page_kind_not_allowed");
    if (!Number.isInteger(count) || count < 0 || count > MAX_CONTEXT_PAGES) throw contractError("invalid_context_page_count");
  }
  for (const kind of allowed) {
    if (!(kind in descriptor.page_counts)) throw contractError("context_page_kind_missing");
  }
  assertBoundedJson(descriptor, MAX_CONTEXT_BASE_BYTES + 2_048, "context_descriptor");
  return descriptor;
}

export function assertContextPage(page, reference, kind, index) {
  assertPlainObject(page, "context_page");
  exactKeys(page, ["schema_version", "execution_id", "agent_id", "kind", "index", "items"]);
  if (page.schema_version !== CONTEXT_PAGE_SCHEMA) throw contractError("invalid_context_page_schema");
  if (page.execution_id !== reference.execution_id || page.agent_id !== reference.agent_id
    || page.kind !== kind || page.index !== index) throw contractError("context_page_mismatch");
  if (!PAGE_KINDS[reference.agent_id].includes(kind)) throw contractError("context_page_kind_not_allowed");
  if (!Array.isArray(page.items) || page.items.length > MAX_PAGE_ITEMS) throw contractError("context_page_items_invalid");
  assertBoundedJson(page, MAX_CONTEXT_PAGE_BYTES, "context_page");
  return page;
}

export function assertAgentContextBase(base, expectedAgentId, expectedVersion) {
  assertPlainObject(base, "agent_context_base");
  exactKeys(base, [
    "schema_version", "agent_id", "agent_version", "user_id",
    "trigger", "snapshot", "catalogs", "validation_errors"
  ]);
  if (base.schema_version !== "1" || base.agent_id !== expectedAgentId || base.agent_version !== expectedVersion) {
    throw contractError("agent_context_base_mismatch");
  }
  requiredText(base.user_id, "user_id", 128);
  assertPlainObject(base.trigger, "trigger");
  requiredText(base.trigger.kind, "trigger_kind", 64);
  assertPlainObject(base.snapshot, "snapshot");
  assertPlainObject(base.catalogs, "catalogs");
  if (!Array.isArray(base.validation_errors) || base.validation_errors.length > 3) {
    throw contractError("invalid_validation_errors");
  }
  assertBoundedJson(base, MAX_CONTEXT_BASE_BYTES, "context_base");
  return base;
}

export function assertManifestContract(manifest, expectedId) {
  assertPlainObject(manifest, "manifest");
  if (manifest.id !== expectedId || !AGENT_IDS.has(manifest.id)) throw contractError("invalid_manifest_id");
  for (const [key, max] of [
    ["version", 32], ["workflow_type", 80], ["queue_base", 80], ["entrypoint", 100],
    ["input_schema_version", 80], ["prompt_version", 64], ["output_schema_version", 80],
    ["model_env", 80], ["default_model", 80], ["prompt", 12_000]
  ]) requiredText(manifest[key], key, max);
  if (!Number.isInteger(manifest.workflow_definition_version)
    || String(manifest.workflow_definition_version) !== manifest.version) {
    throw contractError("invalid_workflow_definition_version");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.worker_build_id ?? "")) {
    throw contractError("invalid_worker_build_id");
  }
  if (manifest.queue_base !== `brai-agent-${manifest.id.replaceAll(".", "-")}`) throw contractError("invalid_queue_base");
  if (!/^BRAI_[A-Z0-9_]+_MODEL$/.test(manifest.model_env)) throw contractError("invalid_model_env");
  if (manifest.retry?.schema_attempts !== 3) throw contractError("invalid_schema_attempts");
  if (!Number.isInteger(manifest.timeout_ms) || manifest.timeout_ms < 1_000 || manifest.timeout_ms > 120_000) {
    throw contractError("invalid_timeout_ms");
  }
  if (!Array.isArray(manifest.decision_kinds) || manifest.decision_kinds.length === 0
    || manifest.decision_kinds.some((kind) => typeof kind !== "string" || !kind)) {
    throw contractError("decision_kinds_required");
  }
  if (typeof manifest.review_only !== "boolean") throw contractError("invalid_review_only");
  validateJsonSchema(manifest.output_schema, "$");
  const schemaKinds = manifest.output_schema?.properties?.decisions?.items?.properties?.decision_kind;
  const declared = new Set(manifest.decision_kinds);
  const schemaAllowed = new Set(schemaKinds?.enum ?? (schemaKinds?.const ? [schemaKinds.const] : []));
  if (schemaAllowed.size !== declared.size || [...declared].some((kind) => !schemaAllowed.has(kind))) {
    throw contractError("manifest_decision_kind_mismatch");
  }
  assertBoundedJson(manifest.output_schema, 32_768, "output_schema");
  return manifest;
}

export function assertAgentResultEnvelope(result, manifest, expected = {}) {
  assertPlainObject(result, "agent_result");
  exactKeys(result, [
    "schema_version", "agent_id", "agent_version", "input_schema_version",
    "prompt_version", "output_schema_version", "workflow_id", "run_id",
    "workflow_attempt", "llm_call_id", "attempt", "model", "review_only",
    "llm_calls", "status", "decisions", "error"
  ]);
  assertBoundedJson(result, 1_048_576, "agent_result");
  if (result.schema_version !== "1" || result.agent_id !== manifest.id
    || result.agent_version !== manifest.version
    || result.input_schema_version !== manifest.input_schema_version
    || result.prompt_version !== manifest.prompt_version
    || result.output_schema_version !== manifest.output_schema_version
    || result.review_only !== manifest.review_only) throw contractError("agent_result_contract_mismatch");
  if (!new Set(["completed", "failed"]).has(result.status)) throw contractError("invalid_agent_result_status");
  if (!Number.isInteger(result.workflow_attempt) || result.workflow_attempt < 1) throw contractError("invalid_workflow_attempt");
  requiredText(result.workflow_id, "workflow_id", 256);
  requiredText(result.run_id, "run_id", 256);
  requiredText(result.model, "model", 80);
  if (expected.workflow_id && result.workflow_id !== expected.workflow_id) throw contractError("workflow_id_mismatch");
  if (expected.run_id && result.run_id !== expected.run_id) throw contractError("run_id_mismatch");
  if (!Array.isArray(result.llm_calls) || !Array.isArray(result.decisions)) throw contractError("invalid_agent_result_arrays");
  if (result.llm_calls.length > MAX_AGENT_RESULT_LLM_CALLS) throw contractError("llm_calls_too_many");
  const callIds = new Set();
  for (const call of result.llm_calls) {
    assertPlainObject(call, "llm_call");
    exactKeys(call, ["llm_call_id", "attempt", "status", "model", "duration_ms", "error_code"]);
    const callId = requiredText(call.llm_call_id, "llm_call_id", 128);
    if (callIds.has(callId)) throw contractError("duplicate_llm_call_id");
    callIds.add(callId);
    if (!Number.isInteger(call.attempt) || call.attempt < 1 || call.attempt > 3) throw contractError("invalid_llm_call_attempt");
    if (!["completed", "schema_failed", "provider_failed"].includes(call.status)) throw contractError("invalid_llm_call_status");
    requiredText(call.model, "llm_call_model", 80);
    if (!Number.isInteger(call.duration_ms) || call.duration_ms < 0) throw contractError("invalid_llm_call_duration");
    if (call.error_code !== null && (typeof call.error_code !== "string" || call.error_code.length > 64)) {
      throw contractError("invalid_llm_call_error");
    }
  }
  const finalCall = result.llm_calls.at(-1);
  if (finalCall) {
    if (result.llm_call_id !== finalCall.llm_call_id || result.attempt !== finalCall.attempt) {
      throw contractError("final_llm_call_mismatch");
    }
  } else if (result.llm_call_id !== null || result.attempt !== 0) {
    throw contractError("unexpected_final_llm_call");
  }
  const allowed = new Set(manifest.decision_kinds);
  if (result.decisions.some((decision) => !allowed.has(decision?.decision_kind))) throw contractError("decision_kind_not_allowed");
  if (result.status === "failed" && (!result.error || typeof result.error.code !== "string")) {
    throw contractError("agent_result_error_required");
  }
  assertJsonSchema({
    schema_version: result.schema_version,
    agent_id: result.agent_id,
    agent_version: result.agent_version,
    decisions: result.decisions
  }, manifest.output_schema, "agent_result_payload");
  return result;
}

export function assertBoundedJson(value, maxBytes, label) {
  if (jsonBytes(value) > maxBytes) throw contractError(`${label}_too_large`);
  return value;
}

function assertJsonSchema(value, schema, label) {
  const errors = [];
  validateValue(value, schema, "$", errors);
  if (errors.length > 0) throw contractError(`${label}_schema_invalid:${errors[0]}`);
}

function validateJsonSchema(schema, path) {
  assertPlainObject(schema, "output_schema");
  if (schema.type !== "object") throw contractError(`invalid_output_schema:${path}`);
  if (!schema.properties || !Array.isArray(schema.required)) throw contractError(`invalid_output_schema:${path}`);
}

function validateValue(value, schema, path, errors) {
  if (!schema || errors.length > 10) return;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push(`${path}:const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) errors.push(`${path}:enum`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) { errors.push(`${path}:type`); return; }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path}:minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}:maxLength`);
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path}:minimum`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path}:maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path}:minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}:maxItems`);
    if (schema.uniqueItems && new Set(value.map(JSON.stringify)).size !== value.length) errors.push(`${path}:uniqueItems`);
    value.forEach((entry, index) => validateValue(entry, schema.items, `${path}[${index}]`, errors));
  }
  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key}:required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${path}.${key}:additional`);
    }
    for (const [key, rule] of Object.entries(properties)) if (key in value) validateValue(value[key], rule, `${path}.${key}`, errors);
  }
}

function matchesType(value, type) {
  if (type === "object") return isPlainObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

function exactKeys(value, keys) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !(key in value))) {
    throw contractError("unexpected_contract_fields");
  }
}

function requiredText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw contractError(`invalid_${label}`);
  return value;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw contractError(`invalid_${label}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function contractError(code) {
  const error = new Error(code);
  error.code = String(code).split(":", 1)[0];
  return error;
}
