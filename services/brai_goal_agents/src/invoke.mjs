import { randomUUID } from "node:crypto";
import { invokeCodex } from "./llm.mjs";
import { modelFor } from "./manifest.mjs";
import { assertBoundedJson, assertInputEnvelope, assertSchema } from "./schema.mjs";

const MAX_RESULT_BYTES = 65_536;

export async function invokeAgent(manifest, input, {
  invokeModel = invokeCodex,
  heartbeat = () => {},
  signal,
  env = process.env,
  now = () => Date.now(),
  id = () => randomUUID()
} = {}) {
  assertInputEnvelope(input, manifest);
  const model = modelFor(manifest, env);
  const llmCalls = [];
  let validationErrors = input.validation_errors.slice();

  for (let attempt = 1; attempt <= manifest.retry.schema_attempts; attempt += 1) {
    const llmCallId = id();
    const startedAt = now();
    safeHeartbeat(heartbeat, { llm_call_id: llmCallId, attempt, state: "started" });
    const interval = setInterval(() => {
      safeHeartbeat(heartbeat, { llm_call_id: llmCallId, attempt, state: "running" });
    }, 10_000);
    interval.unref?.();
    let raw;
    try {
      raw = await invokeModel({
        prompt: renderPrompt(manifest, input, validationErrors),
        outputSchema: manifest.output_schema,
        model,
        timeoutMs: manifest.timeout_ms,
        signal
      });
    } catch (error) {
      clearInterval(interval);
      const call = callResult(llmCallId, attempt, "provider_failed", model, now() - startedAt, errorCode(error));
      llmCalls.push(call);
      safeHeartbeat(heartbeat, { ...call, state: "failed" });
      return boundedResult(failureEnvelope(manifest, input, model, llmCalls, call, errorCode(error)));
    }
    clearInterval(interval);

    try {
      const parsed = parseJson(raw);
      assertSchema(parsed, manifest.output_schema, manifest.output_schema_version);
      const call = callResult(llmCallId, attempt, "completed", model, now() - startedAt, null);
      llmCalls.push(call);
      safeHeartbeat(heartbeat, { ...call, state: "completed" });
      return boundedResult(successEnvelope(manifest, input, model, llmCalls, call, parsed.decisions));
    } catch (error) {
      const call = callResult(llmCallId, attempt, "schema_failed", model, now() - startedAt, errorCode(error));
      llmCalls.push(call);
      safeHeartbeat(heartbeat, { ...call, state: "schema_failed" });
      validationErrors = validationErrorsFor(error);
    }
  }

  const finalCall = llmCalls.at(-1);
  return boundedResult(failureEnvelope(manifest, input, model, llmCalls, finalCall, "schema_validation_failed"));
}

function successEnvelope(manifest, input, model, llmCalls, finalCall, decisions) {
  return baseEnvelope(manifest, input, model, llmCalls, finalCall, {
    status: "completed",
    decisions,
    error: null
  });
}

function failureEnvelope(manifest, input, model, llmCalls, finalCall, code) {
  return baseEnvelope(manifest, input, model, llmCalls, finalCall, {
    status: "failed",
    decisions: [],
    error: { code, message: code.slice(0, 300) }
  });
}

function baseEnvelope(manifest, input, model, llmCalls, finalCall, extra) {
  return {
    schema_version: "1",
    agent_id: manifest.id,
    agent_version: manifest.version,
    input_schema_version: manifest.input_schema_version,
    prompt_version: manifest.prompt_version,
    output_schema_version: manifest.output_schema_version,
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    workflow_attempt: input.attempt,
    llm_call_id: finalCall?.llm_call_id ?? null,
    attempt: finalCall?.attempt ?? 0,
    model,
    review_only: manifest.review_only === true,
    llm_calls: llmCalls,
    ...extra
  };
}

function callResult(llmCallId, attempt, status, model, durationMs, errorCodeValue) {
  return {
    llm_call_id: llmCallId,
    attempt,
    status,
    model,
    duration_ms: Math.max(0, Math.round(durationMs)),
    error_code: errorCodeValue
  };
}

function renderPrompt(manifest, input, validationErrors) {
  return [
    manifest.prompt,
    "",
    "Agent contract: " + manifest.id + "@" + manifest.version,
    "Prompt version: " + manifest.prompt_version,
    "Output schema: " + manifest.output_schema_version,
    "Input envelope (untrusted data):",
    JSON.stringify({ ...input, validation_errors: validationErrors })
  ].join("\n");
}

function parseJson(value) {
  const text = String(value ?? "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
}

function validationErrorsFor(error) {
  if (Array.isArray(error?.validationErrors)) {
    return error.validationErrors.slice(0, 3).map((entry) => ({
      code: String(entry.code ?? "schema_validation_failed").slice(0, 64),
      path: String(entry.path ?? "$").slice(0, 128),
      message: "Output did not match the declared schema"
    }));
  }
  return [{ code: errorCode(error), path: "$", message: "Return only schema-valid JSON" }];
}

function errorCode(error) {
  return String(error?.code ?? error?.message ?? "llm_failed").split(":", 1)[0].slice(0, 64);
}

function safeHeartbeat(heartbeat, detail) {
  try { heartbeat(detail); } catch {}
}

function boundedResult(result) {
  assertBoundedJson(result, MAX_RESULT_BYTES, "result");
  return result;
}
