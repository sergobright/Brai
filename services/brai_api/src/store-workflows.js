import { parseJsonArray, parseJsonObject, sanitizeText } from './store-helpers.js';
import { recordInboxTechnicalLog } from './store-inbox-events.js';
import { scopeSql, scopedUserId } from './user-scope.js';

export const INBOX_WORKFLOW_DEFINITION_ID = 'inbox.raw-normalization';
export const INBOX_WORKFLOW_DEFINITION_VERSION = 3;
const SUPPORTED_INBOX_WORKFLOW_VERSIONS = new Set([1, 2, INBOX_WORKFLOW_DEFINITION_VERSION]);
const TERMINAL_TEMPORAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
  'NOT_FOUND'
]);

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

  getInboxWorkflowOutputSchema(version = INBOX_WORKFLOW_DEFINITION_VERSION) {
    const workflowVersion = Number(version);
    if (!Number.isInteger(workflowVersion) || !SUPPORTED_INBOX_WORKFLOW_VERSIONS.has(workflowVersion)) return null;
    const row = this.db.prepare(`
      SELECT output_schema_json
      FROM workflow_definitions
      WHERE id = ? AND version = ?
    `).get(INBOX_WORKFLOW_DEFINITION_ID, workflowVersion);
    if (!row) return null;
    const schema = parseJsonObject(row.output_schema_json);
    return schema.properties && Array.isArray(schema.required) ? schema : null;
  },

  ensureInboxWorkflowExecution({ inboxId, nowIso }) {
    const id = sanitizeText(inboxId);
    if (!id) return null;
    if (!this.getInboxItem(id)) return null;
    const now = nowIso ?? new Date().toISOString();
    const workflowId = inboxWorkflowId(id);
    const row = this.db.prepare(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id, run_id,
        role_contract_id, raw_record_id, status, current_step, attempt_count,
        last_error, started_at_utc, completed_at_utc, created_at_utc, updated_at_utc, user_id
      ) VALUES (?, ?, ?, NULL, 'inbox', ?, 'queued', 'ingest', 0, NULL, NULL, NULL, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET updated_at_utc = workflow_executions.updated_at_utc
      WHERE workflow_executions.user_id IS NOT DISTINCT FROM excluded.user_id
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
    if (!row) throw businessError('workflow_id_conflict');
    const scope = scopeSql();
    this.db.prepare(`
      UPDATE inbox
      SET workflow_execution_id = ?, updated_at_utc = updated_at_utc
      WHERE id = ? AND workflow_execution_id IS NULL ${scope.clause}
    `).run(row.id, id, ...scope.params);
    return row;
  },

  listQueuedInboxWorkflowStarts({ limit = 100 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.db.prepare(`
      SELECT w.raw_record_id AS inbox_id, w.user_id AS owner_user_id
      FROM workflow_executions w
      JOIN inbox i ON i.id = w.raw_record_id
      WHERE w.role_contract_id = 'inbox'
        AND w.status = 'queued'
        AND i.item_roles_id IS NULL
        AND i.deleted_at_utc IS NULL
      ORDER BY w.created_at_utc, w.id
      LIMIT ?
    `).all(rowLimit);
  },

  listRunningInboxWorkflowExecutions({ limit = 100 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.db.prepare(`
      SELECT
        w.raw_record_id AS inbox_id,
        w.user_id AS owner_user_id,
        w.workflow_id,
        w.run_id,
        w.current_step
      FROM workflow_executions w
      WHERE w.role_contract_id = 'inbox'
        AND w.status = 'running'
      ORDER BY w.updated_at_utc, w.id
      LIMIT ?
    `).all(rowLimit);
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
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = ?, status = 'running', current_step = 'dispatch',
        started_at_utc = COALESCE(started_at_utc, ?), last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'inbox' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, now, now, id, ...scope.params);
    return result.changes > 0;
  },

  markInboxWorkflowStep({ inboxId, workflowId, runId, step, attemptCount = 0, nowIso }) {
    const id = sanitizeText(inboxId);
    const now = nowIso ?? new Date().toISOString();
    const scope = scopeSql();
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = COALESCE(?, run_id), status = 'running', current_step = ?,
        attempt_count = GREATEST(attempt_count, ?), started_at_utc = COALESCE(started_at_utc, ?),
        last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'inbox' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, step, attemptCount, now, now, id, ...scope.params);
    return result.changes > 0;
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
    recordInboxTechnicalLog(this, {
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

  reconcileInboxWorkflowTerminal({ inboxId, workflowId, runId, temporalStatus, nowIso }) {
    const id = sanitizeText(inboxId);
    const operationId = sanitizeText(workflowId);
    const temporalRunId = sanitizeText(runId);
    const status = sanitizeText(temporalStatus)?.toUpperCase();
    if (!id || !operationId || !status || !TERMINAL_TEMPORAL_STATUSES.has(status)) {
      return { changed: false, status: null };
    }
    const now = nowIso ?? new Date().toISOString();
    const scope = scopeSql('w');
    const result = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT w.id, w.current_step, i.item_roles_id, i.is_normalized
        FROM workflow_executions w
        JOIN inbox i ON i.id = w.raw_record_id
        WHERE w.role_contract_id = 'inbox'
          AND w.raw_record_id = ?
          AND w.workflow_id = ?
          AND w.run_id IS NOT DISTINCT FROM ?
          AND w.status = 'running'
          ${scope.clause}
        LIMIT 1
        FOR UPDATE OF w
      `).get(id, operationId, temporalRunId, ...scope.params);
      if (!row) return { changed: false, status: null, reason: null, step: null };

      const domainCompleted = status === 'COMPLETED'
        && Boolean(row.item_roles_id)
        && Boolean(row.is_normalized);
      const localStatus = domainCompleted ? 'completed' : 'failed';
      const reason = domainCompleted
        ? null
        : status === 'COMPLETED'
          ? 'temporal_completed_without_domain_result'
          : `temporal_${status.toLowerCase()}`;
      const updated = this.db.prepare(`
        UPDATE workflow_executions
        SET status = ?, last_error = ?, completed_at_utc = ?, updated_at_utc = ?
        WHERE id = ?
          AND status = 'running'
          AND workflow_id = ?
          AND run_id IS NOT DISTINCT FROM ?
      `).run(localStatus, reason, now, now, row.id, operationId, temporalRunId);
      if (updated.changes !== 1) return { changed: false, status: null, reason: null, step: null };
      return { changed: true, status: localStatus, reason, step: row.current_step };
    })();

    if (result.changed) {
      recordInboxTechnicalLog(this, {
        dt: now,
        source: 'workflow',
        operation: 'inbox.workflow_terminal_reconcile',
        status: result.status === 'completed' ? 'done' : 'failed',
        severityText: result.status === 'completed' ? 'INFO' : 'ERROR',
        reason: result.reason,
        message: 'Inbox workflow terminal state reconciled from Temporal',
        jsonData: {
          workflow_id: operationId,
          run_id: temporalRunId,
          inbox_id: id,
          temporal_status: status,
          workflow_status: result.status,
          workflow_step: result.step
        }
      });
    }
    return { changed: result.changed, status: result.status };
  },

  applyNormalizedInbox({ inboxId, workflowId, runId, normalized, normalizationText, deferTerminal = false, nowIso }) {
    const id = sanitizeText(inboxId);
    if (!id) throw businessError('inbox_id_required');
    const operationId = sanitizeText(workflowId);
    if (!operationId) throw businessError('workflow_id_required');
    const temporalRunId = sanitizeText(runId);
    const now = nowIso ?? new Date().toISOString();
    const eventPayload = normalizedEventPayload({ workflowId: operationId, normalized, normalizationText });
    const run = this.db.transaction(() => {
      const inbox = this.getInboxItem(id);
      if (!inbox) throw businessError('raw_record_missing');
      if (inbox.deleted_at_utc) throw businessError('raw_record_deleted');

      const executionScope = scopeSql('w');
      const execution = this.db.prepare(`
        SELECT w.*
        FROM workflow_executions w
        WHERE w.role_contract_id = 'inbox'
          AND w.raw_record_id = ?
          ${executionScope.clause}
        ORDER BY w.id DESC
        LIMIT 1
        FOR UPDATE OF w
      `).get(id, ...executionScope.params);
      if (!execution) throw businessError('workflow_execution_missing');
      if (
        execution.workflow_definition_id !== INBOX_WORKFLOW_DEFINITION_ID
        || !SUPPORTED_INBOX_WORKFLOW_VERSIONS.has(execution.workflow_definition_version)
      ) throw businessError('stale_workflow_version');
      if (execution.workflow_id !== operationId) throw businessError('workflow_id_conflict');
      if (execution.run_id !== temporalRunId) throw businessError('workflow_run_id_conflict');

      if (inbox.item_roles_id) {
        const existingEvent = this.db.prepare(`
          SELECT item_roles_id, payload_json
          FROM events
          WHERE id = ? AND event_domain = 'inbox' AND subject_id = ?
        `).get(`inbox:${operationId}:normalized`, id);
        if (
          !existingEvent
          || existingEvent.item_roles_id !== inbox.item_roles_id
          || JSON.stringify(parseJsonObject(existingEvent.payload_json)) !== JSON.stringify(eventPayload)
        ) throw businessError('idempotency_conflict');
        return { ok: true, idempotent: true, items_id: id, item_roles_id: inbox.item_roles_id };
      }
      if (execution.status !== 'running') throw businessError('workflow_execution_not_running');

      const contract = this.db.prepare(`
        SELECT * FROM role_contracts
        WHERE id = 'inbox'
          AND workflow_definition_id = ?
      `).get(INBOX_WORKFLOW_DEFINITION_ID);
      if (!contract) throw businessError('role_contract_missing');

      if (this.db.prepare('SELECT id FROM items WHERE id = ?').get(id)) {
        throw businessError('item_id_conflict');
      }

      this.db.prepare(`
        INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc, deleted_at_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(id, scopedUserId(), normalized.title, normalized.description, inbox.author ?? '', now, now);

      const role = this.db.prepare(`
        INSERT INTO item_roles (
          items_id, item_role_types_id, active_from_utc, active_to_utc, status, metadata_json
        ) VALUES (?, ?, ?, NULL, 'active', '{}')
        RETURNING id
      `).get(id, contract.item_role_types_id, now);

      const initialEventId = inbox.initial_event_id;
      if (!initialEventId) throw businessError('initial_event_missing');
      const initialEvent = this.db.prepare(`
        SELECT item_roles_id
        FROM events
        WHERE id = ? AND event_domain = 'inbox' AND subject_id = ?
      `).get(initialEventId, id);
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

      const linkedInbox = this.db.prepare(`
        UPDATE inbox
        SET title = ?, description_text = ?, preliminary_section = ?, normalization_text = ?,
          is_normalized = 1, item_roles_id = ?, updated_at_utc = ?
        WHERE id = ? AND item_roles_id IS NULL
      `).run(normalized.title, normalized.description, normalized.classKey, normalizationText, role.id, now, id);
      if (linkedInbox.changes !== 1) throw businessError('raw_record_link_conflict');
      this.db.prepare(`
        UPDATE events
        SET item_roles_id = ?
        WHERE event_domain = 'inbox'
          AND subject_id = ?
          AND status = 'accepted'
          AND item_roles_id IS NULL
      `).run(role.id, id);

      const normalizedEventSequence = this.insertEventRecord({
        id: `inbox:${operationId}:normalized`,
        eventId: `${operationId}:normalized`,
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
        payloadJson: JSON.stringify(eventPayload)
      });
      if (!normalizedEventSequence) throw businessError('normalized_event_conflict');

      const localStatus = deferTerminal ? 'running' : 'completed';
      const completedAt = deferTerminal ? null : now;
      const updatedExecution = this.db.prepare(`
        UPDATE workflow_executions
        SET status = ?,
          current_step = 'apply_normalized_raw', last_error = NULL,
          completed_at_utc = ?, updated_at_utc = ?
        WHERE id = ?
          AND status = 'running'
          AND workflow_id = ?
          AND run_id IS NOT DISTINCT FROM ?
      `).run(localStatus, completedAt, now, execution.id, operationId, temporalRunId);
      if (updatedExecution.changes !== 1) throw businessError('workflow_execution_changed');
      return { ok: true, idempotent: false, items_id: id, item_roles_id: role.id };
    });
    const result = run();
    if (!result.idempotent) {
      recordInboxTechnicalLog(this, {
        dt: now,
        source: 'workflow',
        operation: 'inbox.apply_normalized_raw',
        status: 'done',
        itemsId: id,
        eventDomain: 'inbox',
        eventId: `${operationId}:normalized`,
        message: 'Inbox normalization applied',
        jsonData: { workflow_id: operationId, run_id: runId, inbox_id: id, item_roles_id: result.item_roles_id }
      });
    }
    return result;
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
        AND run_id IS NOT DISTINCT FROM ?
      ORDER BY dt ASC, id ASC
      LIMIT 50
    `).all(execution.workflow_id, execution.run_id).map((row) => ({ ...row, json_data: parseJsonObject(row.json_data) }));
    const resolvedDefinition = definition ? { ...definition, steps: parseJsonArray(definition.steps_json) } : null;
    return {
      execution,
      definition: resolvedDefinition,
      step_states: resolvedDefinition
        ? inboxStepStates({ execution, steps: resolvedDefinition.steps, attempts, item: this.getInboxItem(inboxId) })
        : [],
      attempts
    };
  }
};

function inboxStepStates({ execution, steps, attempts, item }) {
  const currentIndex = steps.indexOf(execution.current_step);
  const terminal = ['completed', 'failed', 'needs_review'].includes(execution.status);
  const failedIndex = ['failed', 'needs_review'].includes(execution.status) ? currentIndex : -1;
  const inline = execution.run_id?.startsWith('inline:') === true;
  const attemptsFor = (agentId) => attempts.filter((attempt) => attempt.agent_id === agentId);
  const imageAttempts = attemptsFor('inbox.image_describer');
  const normalizerAttempts = attemptsFor('inbox.normalizer');
  const progressedPast = (step) => currentIndex > steps.indexOf(step);
  const failedAt = (step) => failedIndex === steps.indexOf(step);
  const skippedAfterFailure = (step) => failedIndex >= 0 && steps.indexOf(step) > failedIndex;
  const state = (id, value, reason = null) => ({ id, state: value, reason });

  return steps.map((step) => {
    if (step === 'ingest') return state(step, 'completed');
    if (step === 'dispatch') {
      if (inline) return state(step, 'skipped', 'inline_execution');
      if (execution.status === 'queued') return state(step, 'pending');
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      return state(step, execution.run_id ? 'completed' : 'pending');
    }
    if (step === 'prepare_raw') {
      if (failedAt(step)) return state(step, 'failed');
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      if (progressedPast(step) || terminal) return state(step, 'completed');
      return state(step, 'pending');
    }
    if (step === 'image_describer') {
      if (imageAttempts.some((attempt) => attempt.status === 'done')) return state(step, 'completed');
      if (failedAt(step) || (imageAttempts.some((attempt) => attempt.status === 'failed') && terminal)) {
        return state(step, 'failed');
      }
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
      if (progressedPast(step) || terminal) return state(step, 'skipped', 'not_required');
      return state(step, 'pending');
    }
    if (step === 'raw_normalizer') {
      if (failedAt(step) && terminal) return state(step, 'failed');
      if (normalizerAttempts.some((attempt) => attempt.status === 'done')) return state(step, 'completed');
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
      if (progressedPast(step)) return state(step, 'completed');
      return state(step, 'pending');
    }
    if (step === 'apply_normalized_raw') {
      if (item?.is_normalized && item?.item_roles_id) return state(step, 'completed');
      if (failedAt(step)) return state(step, 'failed');
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
      return state(step, 'pending');
    }
    if (step === 'terminal_reconcile') {
      if (inline) return state(step, 'skipped', 'inline_execution');
      if (terminal) return state(step, 'completed');
      if (execution.status === 'running' && item?.is_normalized && item?.item_roles_id) return state(step, 'running');
      return state(step, 'pending');
    }
    if (failedAt(step)) return state(step, 'failed');
    if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
    if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
    return state(step, progressedPast(step) || execution.status === 'completed' ? 'completed' : 'pending');
  });
}

function businessError(code) {
  const error = new Error(code);
  error.businessError = true;
  return error;
}

function normalizedEventPayload({ workflowId, normalized, normalizationText }) {
  return {
    schema: 'brai.inbox.normalized-event.v1',
    workflow_id: workflowId,
    title: normalized.title,
    description_md: normalized.description,
    preliminary_section: normalized.classKey,
    class_title: normalized.classTitle || '',
    class_description: normalized.classDescription || '',
    normalization_text: normalizationText,
    is_normalized: true
  };
}
