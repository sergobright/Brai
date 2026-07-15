const MAX_INPUT_BYTES = 65_536;

export const INPUT_ENVELOPE_SCHEMA = {
  type: "object",
  required: [
    "schema_version", "agent_id", "agent_version", "workflow_id", "run_id",
    "attempt", "user_id", "trigger", "snapshot", "catalogs", "validation_errors"
  ],
  additionalProperties: false,
  properties: {
    schema_version: { type: "string", const: "1" },
    agent_id: { type: "string", minLength: 1, maxLength: 64 },
    agent_version: { type: "string", minLength: 1, maxLength: 32 },
    workflow_id: { type: "string", minLength: 1, maxLength: 256 },
    run_id: { type: "string", minLength: 1, maxLength: 256 },
    attempt: { type: "integer", minimum: 1, maximum: 100 },
    user_id: { type: "string", minLength: 1, maxLength: 128 },
    trigger: {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", minLength: 1, maxLength: 64 },
        items_id: { type: "string", minLength: 1, maxLength: 128 },
        domain_revision: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        stage: { type: "string", enum: ["map", "merge"] },
        watermark: { type: "string", minLength: 1, maxLength: 128 },
        explicit_request: { type: "boolean" }
      }
    },
    snapshot: { type: "object", maxProperties: 100 },
    catalogs: { type: "object", maxProperties: 20 },
    validation_errors: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["code", "path"],
        additionalProperties: false,
        properties: {
          code: { type: "string", minLength: 1, maxLength: 64 },
          path: { type: "string", minLength: 1, maxLength: 128 },
          message: { type: "string", maxLength: 300 }
        }
      }
    }
  }
};

export function assertSchema(value, schema, label = "payload") {
  const errors = [];
  validate(value, schema, "$", errors);
  if (errors.length > 0) {
    const error = new Error(`schema_validation_failed:${label}:${JSON.stringify(errors.slice(0, 12))}`);
    error.code = "schema_validation_failed";
    error.validationErrors = errors.slice(0, 12);
    throw error;
  }
  return value;
}

export function assertInputEnvelope(input, manifest) {
  assertBoundedJson(input, MAX_INPUT_BYTES, "input");
  assertSchema(input, INPUT_ENVELOPE_SCHEMA, "input");
  if (input.agent_id !== manifest.id) throw contractError("agent_id_mismatch");
  if (input.agent_version !== manifest.version) throw contractError("agent_version_mismatch");
  if (manifest.id === "goal.discovery" && !input.trigger.stage) throw contractError("discovery_stage_required");
  if (manifest.id === "goal.planner" && input.trigger.explicit_request !== true) {
    throw contractError("planner_explicit_request_required");
  }
  return input;
}

export function assertBoundedJson(value, maxBytes, label) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > maxBytes) throw contractError(`${label}_too_large`);
  return bytes;
}

function validate(value, schema, path, errors) {
  if (!schema || errors.length >= 20) return;
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, code: "const" });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push({ path, code: "enum" });
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    errors.push({ path, code: "type", expected: types.join("|") });
    return;
  }
  if (typeof value === "string") validateString(value, schema, path, errors);
  if (typeof value === "number") validateNumber(value, schema, path, errors);
  if (Array.isArray(value)) validateArray(value, schema, path, errors);
  if (isObject(value)) validateObject(value, schema, path, errors);
}

function validateString(value, schema, path, errors) {
  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push({ path, code: "minLength" });
  if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push({ path, code: "maxLength" });
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, code: "pattern" });
}

function validateNumber(value, schema, path, errors) {
  if (!Number.isFinite(value)) errors.push({ path, code: "finite" });
  if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push({ path, code: "minimum" });
  if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push({ path, code: "maximum" });
}

function validateArray(value, schema, path, errors) {
  if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push({ path, code: "minItems" });
  if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push({ path, code: "maxItems" });
  if (schema.uniqueItems && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) {
    errors.push({ path, code: "uniqueItems" });
  }
  value.forEach((entry, index) => validate(entry, schema.items, `${path}[${index}]`, errors));
}

function validateObject(value, schema, path, errors) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!(key in value)) errors.push({ path: `${path}.${key}`, code: "required" });
  }
  if (Number.isInteger(schema.maxProperties) && Object.keys(value).length > schema.maxProperties) {
    errors.push({ path, code: "maxProperties" });
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push({ path: `${path}.${key}`, code: "additional_property" });
    }
  }
  for (const [key, rule] of Object.entries(properties)) {
    if (key in value) validate(value[key], rule, `${path}.${key}`, errors);
  }
}

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
