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
};
