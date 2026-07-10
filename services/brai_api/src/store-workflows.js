import { parseJsonArray, parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const INBOX_WORKFLOW_DEFINITION_ID = 'inbox.raw-normalization';
export const INBOX_WORKFLOW_DEFINITION_VERSION = 1;

export function inboxWorkflowId(inboxId) {
  return `brai:inbox:${inboxId}`;
}

export const workflowStoreMethods = {
  syncInboxWorkflowTaskQueue(taskQueue) {
    const queue = sanitizeText(taskQueue);
    if (!queue) return;
    this.db.prepare(`
      UPDATE workflow_definitions
      SET task_queue = ?, updated_at_utc = now()::text
      WHERE id = ? AND version = ?
    `).run(queue, INBOX_WORKFLOW_DEFINITION_ID, INBOX_WORKFLOW_DEFINITION_VERSION);
  },

  getInboxWorkflowOutputSchema() {
    const row = this.db.prepare(`
      SELECT output_schema_json
      FROM workflow_definitions
      WHERE id = ? AND version = ? AND status = 'active'
    `).get(INBOX_WORKFLOW_DEFINITION_ID, INBOX_WORKFLOW_DEFINITION_VERSION);
    if (!row) return null;
    const schema = parseJsonObject(row.output_schema_json);
    return schema.properties && Array.isArray(schema.required) ? schema : null;
  },

  ensureInboxWorkflowExecution({ inboxId, nowIso }) {
    const id = sanitizeText(inboxId);
    if (!id) return null;
    const now = nowIso ?? new Date().toISOString();
    const workflowId = inboxWorkflowId(id);
    const row = this.db.prepare(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id, run_id,
        role_contract_id, raw_record_id, status, current_step, attempt_count,
        last_error, started_at_utc, completed_at_utc, created_at_utc, updated_at_utc, user_id
      ) VALUES (?, ?, ?, NULL, 'inbox', ?, 'queued', 'ingest', 0, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET updated_at_utc = workflow_executions.updated_at_utc
      RETURNING *
    `).get(
      INBOX_WORKFLOW_DEFINITION_ID,
      INBOX_WORKFLOW_DEFINITION_VERSION,
      workflowId,
      id,
      now,
      now,
      scopedUserId()
    );
    this.db.prepare(`
      UPDATE inbox
      SET workflow_execution_id = ?, updated_at_utc = updated_at_utc
      WHERE id = ? AND workflow_execution_id IS NULL
    `).run(row.id, id);
    return row;
  },

  getInboxWorkflowExecution(inboxId) {
    const id = sanitizeText(inboxId);
    if (!id) return null;
    const scope = scopeSql('w');
    return this.db.prepare(`
      SELECT w.*
      FROM workflow_executions w
      WHERE w.role_contract_id = 'inbox'
        AND w.raw_record_id = ?
        ${scope.clause}
      ORDER BY w.id DESC
      LIMIT 1
    `).get(id, ...scope.params) ?? null;
  },

  markInboxWorkflowStarted({ inboxId, workflowId, runId, nowIso }) {
    const id = sanitizeText(inboxId);
    const now = nowIso ?? new Date().toISOString();
    const scope = scopeSql();
    this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = ?, status = 'running', current_step = 'raw_normalizer',
        started_at_utc = COALESCE(started_at_utc, ?), last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'inbox' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, now, now, id, ...scope.params);
  },

  markInboxWorkflowStep({ inboxId, workflowId, runId, step, attemptCount = 0, nowIso }) {
    const id = sanitizeText(inboxId);
    const now = nowIso ?? new Date().toISOString();
    const scope = scopeSql();
    this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = COALESCE(?, run_id), status = 'running', current_step = ?,
        attempt_count = GREATEST(attempt_count, ?), started_at_utc = COALESCE(started_at_utc, ?),
        last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'inbox' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, step, attemptCount, now, now, id, ...scope.params);
  },

  failInboxWorkflow({ inboxId, workflowId, runId, reason, step = 'raw_normalizer', needsReview = false, attemptCount = 0, nowIso }) {
    const id = sanitizeText(inboxId);
    const now = nowIso ?? new Date().toISOString();
    const status = needsReview ? 'needs_review' : 'failed';
    const error = sanitizeText(reason)?.slice(0, 1000) ?? 'workflow_failed';
    const currentStep = sanitizeText(step) ?? 'raw_normalizer';
    const scope = scopeSql();
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = COALESCE(?, run_id), status = ?, current_step = ?,
        attempt_count = GREATEST(attempt_count, ?), last_error = ?, completed_at_utc = ?, updated_at_utc = ?
      WHERE role_contract_id = 'inbox' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, status, currentStep, attemptCount, error, now, now, id, ...scope.params);
    if (result.changes === 0) return;
    this.recordLog({
      dt: now,
      source: 'workflow',
      operation: 'inbox.raw_normalization',
      status: 'failed',
      severityText: 'ERROR',
      reason: error,
      message: 'Inbox normalization workflow failed',
      jsonData: { workflow_id: workflowId, run_id: runId, inbox_id: id, workflow_status: status, attempt_count: attemptCount }
    });
  },

  applyNormalizedInbox({ inboxId, workflowId, runId, normalized, normalizationText, nowIso }) {
    const id = sanitizeText(inboxId);
    if (!id) throw businessError('inbox_id_required');
    const now = nowIso ?? new Date().toISOString();
    const run = this.db.transaction(() => {
      const inbox = this.getInboxItem(id);
      if (!inbox) throw businessError('raw_record_missing');
      if (inbox.deleted_at_utc) throw businessError('raw_record_deleted');

      const execution = this.getInboxWorkflowExecution(id);
      if (!execution) throw businessError('workflow_execution_missing');
      if (
        execution.workflow_definition_id !== INBOX_WORKFLOW_DEFINITION_ID
        || execution.workflow_definition_version !== INBOX_WORKFLOW_DEFINITION_VERSION
      ) throw businessError('stale_workflow_version');

      if (inbox.item_roles_id) {
        return { ok: true, idempotent: true, items_id: id, item_roles_id: inbox.item_roles_id };
      }

      const contract = this.db.prepare(`
        SELECT * FROM role_contracts
        WHERE id = 'inbox'
          AND workflow_definition_id = ?
          AND workflow_definition_version = ?
      `).get(INBOX_WORKFLOW_DEFINITION_ID, INBOX_WORKFLOW_DEFINITION_VERSION);
      if (!contract) throw businessError('role_contract_missing');

      this.db.prepare(`
        INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO NOTHING
      `).run(id, scopedUserId(), normalized.title, normalized.description, inbox.author ?? '', now, now);

      let role = this.db.prepare(`
        SELECT id FROM item_roles
        WHERE items_id = ? AND item_role_types_id = ? AND status = 'active'
        LIMIT 1
      `).get(id, contract.item_role_types_id);
      if (!role) {
        role = this.db.prepare(`
          INSERT INTO item_roles (
            items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json
          ) VALUES (?, ?, ?, NULL, 'active', '{}')
          RETURNING id
        `).get(id, contract.item_role_types_id, now);
      }

      const initialEventId = inbox.initial_event_id;
      if (!initialEventId) throw businessError('initial_event_missing');
      const initialEvent = this.db.prepare('SELECT item_roles_id FROM events WHERE id = ?').get(initialEventId);
      if (!initialEvent) throw businessError('initial_event_missing');
      if (initialEvent.item_roles_id && initialEvent.item_roles_id !== role.id) {
        throw businessError('initial_event_role_conflict');
      }

      if (normalized.classKey && !this.db.prepare('SELECT key FROM inbox_classes WHERE key = ?').get(normalized.classKey)) {
        this.upsertInboxClass({
          key: normalized.classKey,
          title: normalized.classTitle || normalized.classKey,
          description: normalized.classDescription || 'Класс предложен AI-разбором Inbox.',
          status: 'candidate',
          createdByAgentId: 'inbox.normalizer',
          nowIso: now
        });
      }

      this.db.prepare(`
        UPDATE items
        SET title = ?, description = ?, updated_at_utc = ?
        WHERE id = ?
      `).run(normalized.title, normalized.description, now, id);
      this.db.prepare(`
        UPDATE inbox
        SET title = ?, description_text = ?, preliminary_section = ?, normalization_text = ?,
          is_normalized = 1, item_roles_id = ?, updated_at_utc = ?
        WHERE id = ? AND item_roles_id IS NULL
      `).run(normalized.title, normalized.description, normalized.classKey, normalizationText, role.id, now, id);
      this.db.prepare(`
        UPDATE events
        SET item_roles_id = ?
        WHERE id = ? AND item_roles_id IS NULL
      `).run(role.id, initialEventId);

      this.insertEventRecord({
        id: `inbox:${workflowId}:normalized`,
        eventId: `${workflowId}:normalized`,
        eventDomain: 'inbox',
        eventType: 'normalized',
        eventAction: 'inbox.normalized',
        title: 'Inbox normalized',
        itemsId: id,
        itemRolesId: role.id,
        subjectType: 'inbox',
        subjectId: id,
        actorType: 'agent',
        actorId: 'inbox.normalizer',
        occurredAtUtc: now,
        receivedAtUtc: now,
        payloadVersion: 1,
        payloadJson: JSON.stringify({ schema: 'brai.inbox.normalized-event.v1', workflow_id: workflowId })
      });

      this.db.prepare(`
        UPDATE workflow_executions
        SET workflow_id = ?, run_id = COALESCE(?, run_id), status = 'completed',
          current_step = 'apply_normalized_raw', last_error = NULL,
          completed_at_utc = ?, updated_at_utc = ?
        WHERE id = ?
      `).run(workflowId, runId, now, now, execution.id);
      this.recordLog({
        dt: now,
        source: 'workflow',
        operation: 'inbox.apply_normalized_raw',
        status: 'done',
        itemsId: id,
        eventDomain: 'inbox',
        eventId: `${workflowId}:normalized`,
        message: 'Inbox normalization applied',
        jsonData: { workflow_id: workflowId, run_id: runId, inbox_id: id, item_roles_id: role.id }
      });
      return { ok: true, idempotent: false, items_id: id, item_roles_id: role.id };
    });
    return run();
  },

  getInboxWorkflowDetails(inboxId) {
    const execution = this.getInboxWorkflowExecution(inboxId);
    if (!execution) return null;
    const definition = this.db.prepare(`
      SELECT id, version, title, task_queue, steps_json, input_schema_version, output_schema_version
      FROM workflow_definitions
      WHERE id = ? AND version = ?
    `).get(execution.workflow_definition_id, execution.workflow_definition_version);
    const attempts = this.db.prepare(`
      SELECT id, agent_id, agent_version, dt, status, ai_title, flow_command,
        workflow_id, run_id, attempt_number, json_data
      FROM ai_logs
      WHERE workflow_id = ?
      ORDER BY dt ASC, id ASC
      LIMIT 50
    `).all(execution.workflow_id).map((row) => ({ ...row, json_data: parseJsonObject(row.json_data) }));
    return {
      execution,
      definition: definition ? { ...definition, steps: parseJsonArray(definition.steps_json) } : null,
      attempts
    };
  }
};

function businessError(code) {
  const error = new Error(code);
  error.businessError = true;
  return error;
}
