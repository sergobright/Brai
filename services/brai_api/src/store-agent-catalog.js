import { parseJsonObject, sanitizeText } from './store-helpers.js';

export const agentCatalogMethods = {
  listAgents() {
    return this.db.prepare(`
      SELECT id, version, target, kind, status, title, summary,
        trigger_description, conditions_description, input_description,
        output_description, interactions_description, side_effects_description,
        llm_provider, llm_model, llm_timeout_ms, fallback_description,
        source_module, prompt_version, schema_version, task_queue_base,
        runtime_service, metadata_json, updated_at_utc
      FROM agents
      ORDER BY title, id
    `).all().map(formatAgent);
  },

  getCatalogAgent(id) {
    const cleanId = sanitizeText(id);
    if (!cleanId) return null;
    const row = this.db.prepare(`
      SELECT id, version, target, kind, status, title, summary,
        trigger_description, conditions_description, input_description,
        output_description, interactions_description, side_effects_description,
        llm_provider, llm_model, llm_timeout_ms, fallback_description,
        source_module, prompt_version, schema_version, task_queue_base,
        runtime_service, metadata_json, updated_at_utc
      FROM agents WHERE id = ?
    `).get(cleanId);
    return row ? formatAgent(row) : null;
  },

  setAgentEnabled({ agentId, enabled, actorUserId, nowIso = new Date().toISOString() }) {
    if (!actorUserId || actorUserId !== this.primaryUserId()) throw agentCatalogError('primary_account_required', 403);
    const current = this.getCatalogAgent(agentId);
    if (!current) throw agentCatalogError('agent_not_found', 404);
    if (!current.toggleable) throw agentCatalogError('agent_status_locked', 409);
    if (typeof enabled !== 'boolean') throw agentCatalogError('invalid_agent_status', 400);
    const nextStatus = enabled ? 'active' : 'inactive';
    const previousOverride = this.db.prepare(`
      SELECT enabled FROM agent_status_overrides WHERE agent_id = ?
    `).get(current.id);
    const changed = current.status !== nextStatus
      || previousOverride == null
      || Boolean(previousOverride.enabled) !== enabled;
    const apply = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_status_overrides (
          agent_id, enabled, updated_by_user_id, updated_at_utc
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT (agent_id) DO UPDATE SET
          enabled = excluded.enabled,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at_utc = excluded.updated_at_utc
      `).run(current.id, enabled, actorUserId, nowIso);
      this.db.prepare('UPDATE agents SET status = ?, updated_at_utc = ? WHERE id = ?')
        .run(nextStatus, nowIso, current.id);
    });
    apply();
    if (changed) {
      this.recordLog?.({
        dt: nowIso,
        source: 'agents',
        operation: 'agents.set_global_status',
        status: 'done',
        userId: actorUserId,
        message: enabled ? 'Global agent enabled' : 'Global agent disabled',
        jsonData: { agent_id: current.id, enabled }
      });
    }
    return this.getCatalogAgent(current.id);
  }
};

function formatAgent(row) {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    ...row,
    metadata_json: metadata,
    enabled: row.status === 'active',
    toggleable: metadata.user_toggleable === true
  };
}

function agentCatalogError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
