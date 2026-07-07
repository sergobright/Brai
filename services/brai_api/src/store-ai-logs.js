export const aiLogMethods = {
  recordAiLog(input) {
    const info = this.db.prepare(`
      INSERT INTO ai_logs (
        agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.agentId,
      input.agentVersion,
      input.dt ?? new Date().toISOString(),
      input.status,
      JSON.stringify(input.jsonData ?? {}),
      input.aiTitle,
      input.flowId ?? null,
      input.flowCommand ?? null
    );
    return Number(info.lastInsertRowid);
  }
,

  listAiLogs({ limit = 50 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return this.db
      .prepare(
        `
          SELECT id, agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command
          FROM ai_logs
          ORDER BY dt DESC, id DESC
          LIMIT ?
        `
      )
      .all(rowLimit)
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
