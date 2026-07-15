import { parseJsonObject, sanitizeText } from './store-helpers.js';
import { MAX_AGENT_RESULT_LLM_CALLS } from '../../brai_goal_agents/src/contracts.mjs';

export const GOAL_AGENT_TERMINAL = new Set(['completed', 'failed', 'needs_review']);

export function persistLlmCalls(store, execution, manifest, result, now) {
  if (store.db.currentTxId) throw persistenceError('ai_log_transaction_boundary_required', 500);
  const calls = boundedLlmCalls(result);
  const ids = new Set();
  for (const call of calls) {
    if (!isLoggableCall(call) || ids.has(call.llm_call_id)) {
      throw persistenceError('invalid_llm_call_log', 400);
    }
    ids.add(call.llm_call_id);
    store.db.transaction(() => recordLlmCall(store, execution, manifest, result, call, now))();
  }
  return calls.map((call) => call.llm_call_id);
}

export function assertLlmCallsPersisted(store, execution, manifest, result) {
  const calls = validatedLlmCalls(result);
  if (calls.length === 0) return [];
  const rows = store.db.prepare(`
    SELECT agent_id, agent_version, status, json_data, ai_title, flow_id, flow_command,
      trace_id, workflow_id, run_id, attempt_number, llm_call_id
    FROM ai_logs WHERE llm_call_id IN (${calls.map(() => '?').join(',')})
  `).all(...calls.map((call) => call.llm_call_id));
  const byId = new Map(rows.map((row) => [row.llm_call_id, row]));
  for (const call of calls) {
    const row = byId.get(call.llm_call_id);
    if (!row) throw persistenceError('agent_llm_log_missing', 409);
    if (!matchesLlmCall(row, execution, manifest, result, call)) {
      throw persistenceError('idempotency_conflict', 409);
    }
  }
  return calls.map((call) => call.llm_call_id);
}

export function finishGoalAgentFailure(store, {
  executionId, reason, now, result = null, status = 'failed', currentStep = 'invoke_agent'
}) {
  return store.db.transaction(() => {
    const execution = store.db.prepare('SELECT * FROM workflow_executions WHERE id = ? FOR UPDATE').get(executionId);
    if (!execution) throw persistenceError('workflow_execution_not_found', 404);
    if (!GOAL_AGENT_TERMINAL.has(execution.status)) {
      failExecution(store, execution, reason, now, { result, status, currentStep });
    }
    return formatExecution(store.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId));
  })();
}

export function failExecution(store, execution, reason, now, {
  result = null, status = 'failed', currentStep = 'invoke_agent'
} = {}) {
  const error = String(reason ?? 'agent_failed').slice(0, 1000);
  const nextRetryAt = execution.workflow_definition_id === 'goal.discovery' && status === 'failed'
    ? discoveryRetryAt(execution, now)
    : null;
  store.db.prepare(`
    UPDATE workflow_executions SET status = ?, current_step = ?, result_json = COALESCE(?::jsonb, result_json),
      last_error = ?, next_retry_at_utc = ?, completed_at_utc = ?, updated_at_utc = ?, trace_status = 'complete'
    WHERE id = ? AND status IN ('queued','running')
  `).run(status, currentStep, result ? JSON.stringify(result) : null, error, nextRetryAt, now, now, execution.id);
  if (execution.workflow_definition_id === 'goal.discovery') restoreDiscoveryWatermark(store, execution, now);
}

function discoveryRetryAt(execution, now) {
  const attempt = Math.max(0, Number(execution.attempt_count ?? 0) - 1);
  const delayMs = Math.min(24 * 60 * 60 * 1000, 60_000 * (2 ** Math.min(attempt, 11)));
  return new Date(Date.parse(now) + delayMs).toISOString();
}

export function isDeterministicPersistenceError(error) {
  const status = Number(error?.status);
  return error?.deterministic === true || (Number.isInteger(status) && status >= 400 && status < 500);
}

export function persistenceReason(prefix, error) {
  return `${prefix}:${error?.code ?? error?.message ?? 'unknown'}`.slice(0, 1000);
}

export function terminalResult(result, error, stage) {
  const diagnostic = {
    stage,
    code: String(error?.code ?? error?.message ?? 'unknown').slice(0, 1000),
    retryable: false
  };
  try {
    const payload = result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, persistence_diagnostic: diagnostic }
      : { raw_result: result ?? null, persistence_diagnostic: diagnostic };
    if (Buffer.byteLength(JSON.stringify(payload)) <= 1_048_576) return payload;
  } catch {
    // Fall through to the bounded diagnostic when an invalid result cannot be serialized safely.
  }
  return {
    schema_version: sanitizeText(result?.schema_version),
    status: sanitizeText(result?.status),
    agent_id: sanitizeText(result?.agent_id),
    llm_call_id: sanitizeText(result?.llm_call_id),
    decision_count: Array.isArray(result?.decisions) ? result.decisions.length : null,
    agent_result_omitted: 'terminal_result_size_limit',
    persistence_diagnostic: diagnostic
  };
}

export function formatExecution(row) {
  return row ? {
    ...row,
    input_json: parseJsonObject(row.input_json),
    result_json: row.result_json ? parseJsonObject(row.result_json) : null
  } : null;
}

function recordLlmCall(store, execution, manifest, result, call, now) {
  store.recordAiLog({
    agentId: manifest.id, agentVersion: manifest.version, dt: now,
    status: call.status === 'completed' ? 'done' : 'failed',
    aiTitle: call.status === 'completed' ? 'Goal agent завершил вызов' : 'Goal agent сообщил ошибку вызова',
    flowId: String(execution.id), flowCommand: execution.workflow_definition_id,
    workflowId: execution.workflow_id, runId: execution.run_id,
    attemptNumber: Number.isInteger(call.attempt) ? call.attempt : null,
    llmCallId: sanitizeText(call.llm_call_id),
    jsonData: {
      schema: 'brai.goal_agent.ai_log.v1', status: call.status,
      model: call.model ?? result.model, duration_ms: call.duration_ms ?? null,
      error_code: call.error_code ?? null,
      workflow_attempt: Number.isInteger(result?.workflow_attempt) ? result.workflow_attempt : null
    }
  });
}

function validatedLlmCalls(result) {
  const calls = boundedLlmCalls(result);
  const ids = new Set();
  for (const call of calls) {
    if (!isLoggableCall(call) || ids.has(call.llm_call_id)) {
      throw persistenceError('invalid_llm_call_log', 400);
    }
    ids.add(call.llm_call_id);
  }
  return calls;
}

function boundedLlmCalls(result) {
  if (!Array.isArray(result?.llm_calls) || result.llm_calls.length > MAX_AGENT_RESULT_LLM_CALLS) {
    throw persistenceError('invalid_llm_calls', 400);
  }
  return result.llm_calls;
}

function matchesLlmCall(row, execution, manifest, result, call) {
  const json = parseJsonObject(row.json_data);
  return row.agent_id === manifest.id
    && String(row.agent_version) === String(manifest.version)
    && row.status === (call.status === 'completed' ? 'done' : 'failed')
    && row.ai_title === (call.status === 'completed'
      ? 'Goal agent завершил вызов'
      : 'Goal agent сообщил ошибку вызова')
    && String(row.flow_id) === String(execution.id)
    && row.flow_command === execution.workflow_definition_id
    && row.trace_id === null
    && row.workflow_id === execution.workflow_id
    && row.run_id === execution.run_id
    && Number(row.attempt_number) === call.attempt
    && row.llm_call_id === call.llm_call_id
    && Object.keys(json).length === 6
    && json.schema === 'brai.goal_agent.ai_log.v1'
    && json.status === call.status
    && json.model === call.model
    && json.duration_ms === call.duration_ms
    && json.error_code === call.error_code
    && json.workflow_attempt === (Number.isInteger(result?.workflow_attempt) ? result.workflow_attempt : null);
}

function restoreDiscoveryWatermark(store, execution, now) {
  store.db.prepare(`
    UPDATE context_discovery_watermarks SET
      first_unprocessed_change_at_utc = CASE
        WHEN active_range_first_change_at_utc IS NULL THEN first_unprocessed_change_at_utc
        WHEN first_unprocessed_change_at_utc IS NULL THEN active_range_first_change_at_utc
        ELSE LEAST(active_range_first_change_at_utc, first_unprocessed_change_at_utc)
      END,
      active_range_first_change_at_utc = NULL,
      active_workflow_execution_id = NULL, updated_at_utc = ?
    WHERE user_id = ? AND active_workflow_execution_id = ?
  `).run(now, execution.user_id, execution.id);
}

function isLoggableCall(call) {
  return call && typeof call === 'object' && !Array.isArray(call)
    && typeof call.llm_call_id === 'string' && call.llm_call_id.trim().length > 0
    && call.llm_call_id.length <= 128
    && Number.isInteger(call.attempt) && call.attempt >= 1 && call.attempt <= 3
    && ['completed', 'schema_failed', 'provider_failed'].includes(call.status)
    && typeof call.model === 'string' && call.model.trim().length > 0 && call.model.length <= 80
    && Number.isInteger(call.duration_ms) && call.duration_ms >= 0
    && (call.error_code === null || (typeof call.error_code === 'string' && call.error_code.length <= 64));
}

function persistenceError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
