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
  },

  listLatestInboxAiLogs(inboxIds = []) {
    const ids = [...new Set(inboxIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `
          SELECT id, agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command
          FROM ai_logs
          WHERE flow_id IN (${placeholders})
            AND agent_id IN ('inbox.image_describer', 'inbox.normalizer')
          ORDER BY dt DESC, id DESC
        `
      )
      .all(...ids);
    const seen = new Set();
    return rows.flatMap((row) => {
      if (!row.flow_id || seen.has(row.flow_id)) return [];
      seen.add(row.flow_id);
      return [{ ...row, json_data: parseJsonObject(row.json_data) }];
    });
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
