import { createHash } from 'node:crypto';
import { scopedUserId } from './user-scope.js';

export const aiLogMethods = {
  recordAiLog(input) {
    const row = {
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      dt: input.dt ?? new Date().toISOString(),
      status: input.status,
      json_data: JSON.stringify(input.jsonData ?? {}),
      ai_title: input.aiTitle,
      flow_id: input.flowId ?? null,
      flow_command: input.flowCommand ?? null,
      trace_id: input.traceId ?? null,
      workflow_id: input.workflowId ?? null,
      run_id: input.runId ?? null,
      attempt_number: Number.isInteger(input.attemptNumber) ? input.attemptNumber : null,
      llm_call_id: input.llmCallId ?? null,
      user_id: input.userId ?? scopedUserId() ?? null
    };
    const info = this.db.prepare(`
      INSERT INTO ai_logs (
        agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command, trace_id,
        workflow_id, run_id, attempt_number, llm_call_id, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (llm_call_id) WHERE llm_call_id IS NOT NULL DO NOTHING
      RETURNING id
    `).run(
      row.agent_id,
      row.agent_version,
      row.dt,
      row.status,
      row.json_data,
      row.ai_title,
      row.flow_id,
      row.flow_command,
      row.trace_id,
      row.workflow_id,
      row.run_id,
      row.attempt_number,
      row.llm_call_id,
      row.user_id
    );
    const id = Number(info.lastInsertRowid);
    if (!id && row.llm_call_id) {
      const existing = this.db.prepare(`
        SELECT id, agent_id, agent_version, status, json_data, ai_title, flow_id, flow_command, trace_id,
          workflow_id, run_id, attempt_number, llm_call_id, user_id
        FROM ai_logs WHERE llm_call_id = ?
      `).get(row.llm_call_id);
      if (!existing || aiLogFingerprint(existing) !== aiLogFingerprint(row)) {
        throw aiLogError('idempotency_conflict', 409);
      }
      return Number(existing.id);
    }
    this.recordLog?.({
      dt: row.dt,
      traceId: input.traceId,
      source: 'ai',
      operation: `ai.${input.agentId}`,
      status: input.status === 'failed' ? 'failed' : 'done',
      severityText: input.status === 'failed' ? 'ERROR' : 'INFO',
      message: input.aiTitle,
      jsonData: {
        agent_id: input.agentId,
        agent_version: input.agentVersion,
        flow_id: input.flowId ?? null,
        flow_command: input.flowCommand ?? null,
        workflow_id: input.workflowId ?? null,
        run_id: input.runId ?? null,
        attempt_number: Number.isInteger(input.attemptNumber) ? input.attemptNumber : null
      }
    });
    return id;
  }
,

  listAiLogs({ limit = 50 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const userId = scopedUserId();
    return this.db
      .prepare(
        `
          SELECT id, agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command, trace_id,
            workflow_id, run_id, attempt_number, llm_call_id
          FROM ai_logs
          ${userId ? 'WHERE user_id = ?' : ''}
          ORDER BY dt DESC, id DESC
          LIMIT ?
        `
      )
      .all(...(userId ? [userId, rowLimit] : [rowLimit]))
      .map((row) => ({
        ...row,
        json_data: parseJsonObject(row.json_data)
      }));
  }
};

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function aiLogFingerprint(row) {
  return createHash('sha256').update(stableJson({
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    status: row.status,
    json_data: parseJsonValue(row.json_data),
    ai_title: row.ai_title,
    flow_id: row.flow_id,
    flow_command: row.flow_command,
    trace_id: row.trace_id,
    workflow_id: row.workflow_id,
    run_id: row.run_id,
    attempt_number: row.attempt_number,
    llm_call_id: row.llm_call_id,
    user_id: row.user_id
  })).digest('hex');
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { invalid_json: String(value) };
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function aiLogError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
