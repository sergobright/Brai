import { normalizeMarkdownSource, parseJsonArray, parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopedUserId, scopeSql } from './user-scope.js';

export const ACTIVITY_WORKFLOW_DEFINITION_ID = 'activity.raw-normalization';
export const ACTIVITY_WORKFLOW_DEFINITION_VERSION = 1;
export const ACTIVITY_NORMALIZER_AGENT_ID = 'activity.normalizer';

const TERMINAL_TEMPORAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
  'NOT_FOUND'
]);
const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'needs_review']);

export function activityWorkflowId(activityId) {
  return `brai:activity:${activityId}`;
}

export const activityWorkflowStoreMethods = {
  syncActivityWorkflowTaskQueue(taskQueue) {
    const queue = sanitizeText(taskQueue);
    if (!queue) return;
    this.db.prepare(`
      UPDATE workflow_definitions
      SET task_queue = ?, updated_at_utc = now()::text
      WHERE id = ? AND version = ?
    `).run(queue, ACTIVITY_WORKFLOW_DEFINITION_ID, ACTIVITY_WORKFLOW_DEFINITION_VERSION);
  },

  getActivityWorkflowOutputSchema(version = ACTIVITY_WORKFLOW_DEFINITION_VERSION) {
    const workflowVersion = Number(version);
    if (workflowVersion !== ACTIVITY_WORKFLOW_DEFINITION_VERSION) return null;
    const row = this.db.prepare(`
      SELECT output_schema_json
      FROM workflow_definitions
      WHERE id = ? AND version = ?
    `).get(ACTIVITY_WORKFLOW_DEFINITION_ID, workflowVersion);
    if (!row) return null;
    const schema = parseJsonObject(row.output_schema_json);
    return schema.properties && Array.isArray(schema.required) ? schema : null;
  },

  ensureActivityWorkflowExecution({ activityId, nowIso }) {
    const id = sanitizeText(activityId);
    if (!id) return null;
    if (!this.getActivityItem(id)) return null;
    const now = nowIso ?? new Date().toISOString();
    const workflowId = activityWorkflowId(id);
    const row = this.db.prepare(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id, run_id,
        role_contract_id, raw_record_id, status, current_step, attempt_count,
        last_error, started_at_utc, completed_at_utc, created_at_utc, updated_at_utc, user_id, trace_status
      ) VALUES (?, ?, ?, NULL, 'activity', ?, 'queued', 'ingest', 0, NULL, NULL, NULL, ?, ?, ?, 'recording')
      ON CONFLICT(workflow_id) DO UPDATE SET updated_at_utc = workflow_executions.updated_at_utc
      WHERE workflow_executions.user_id IS NOT DISTINCT FROM excluded.user_id
      RETURNING *
    `).get(
      ACTIVITY_WORKFLOW_DEFINITION_ID,
      ACTIVITY_WORKFLOW_DEFINITION_VERSION,
      workflowId,
      id,
      now,
      now,
      scopedUserId()
    );
    if (!row) throw businessError('workflow_id_conflict');
    this.recordActivityWorkflowStepStarted({
      activityId: id,
      workflowId,
      runId: null,
      stepKey: 'ingest',
      nowIso: now,
      metadataJson: { activity_id: id, workflow_id: workflowId }
    });
    this.recordActivityWorkflowStepFinished({
      activityId: id,
      workflowId,
      runId: null,
      stepKey: 'ingest',
      status: 'completed',
      nowIso: now
    });
    const scope = scopeSql();
    this.db.prepare(`
      UPDATE activities
      SET workflow_execution_id = ?, updated_at_utc = updated_at_utc
      WHERE id = ? AND workflow_execution_id IS NULL ${scope.clause}
    `).run(row.id, id, ...scope.params);
    return row;
  },

  listQueuedActivityWorkflowStarts({ limit = 100 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.db.prepare(`
      SELECT w.raw_record_id AS activity_id, w.user_id AS owner_user_id
      FROM workflow_executions w
      JOIN activities a ON a.id = w.raw_record_id
      WHERE w.role_contract_id = 'activity'
        AND w.status = 'queued'
        AND a.item_roles_id IS NULL
        AND a.activity_type_id IN ('action', 'operation')
      ORDER BY w.created_at_utc, w.id
      LIMIT ?
    `).all(rowLimit);
  },

  listRunningActivityWorkflowExecutions({ limit = 100 } = {}) {
    const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    return this.db.prepare(`
      SELECT
        w.raw_record_id AS activity_id,
        w.user_id AS owner_user_id,
        w.workflow_id,
        w.run_id,
        w.current_step
      FROM workflow_executions w
      WHERE w.role_contract_id = 'activity'
        AND w.status = 'running'
      ORDER BY w.updated_at_utc, w.id
      LIMIT ?
    `).all(rowLimit);
  },

  getActivityWorkflowExecution(activityId) {
    const id = sanitizeText(activityId);
    if (!id) return null;
    const scope = scopeSql('w');
    return this.db.prepare(`
      SELECT w.*
      FROM workflow_executions w
      WHERE w.role_contract_id = 'activity'
        AND w.raw_record_id = ?
        ${scope.clause}
      ORDER BY w.id DESC
      LIMIT 1
    `).get(id, ...scope.params) ?? null;
  },

  markActivityWorkflowStarted({ activityId, workflowId, runId, nowIso }) {
    const id = sanitizeText(activityId);
    const now = nowIso ?? new Date().toISOString();
    const scope = scopeSql();
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = ?, status = 'running', current_step = 'dispatch',
        started_at_utc = COALESCE(started_at_utc, ?), last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'activity' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, now, now, id, ...scope.params);
    if (result.changes > 0) {
      this.recordActivityWorkflowStepStarted({
        activityId: id,
        workflowId,
        runId,
        stepKey: 'dispatch',
        nowIso: now,
        metadataJson: { activity_id: id, workflow_id: workflowId, run_id: runId }
      });
      this.recordActivityWorkflowStepFinished({ activityId: id, workflowId, runId, stepKey: 'dispatch', status: 'completed', nowIso: now });
    }
    return result.changes > 0;
  },

  markActivityWorkflowStep({ activityId, workflowId, runId, step, attemptCount = 0, nowIso }) {
    const id = sanitizeText(activityId);
    const now = nowIso ?? new Date().toISOString();
    const stepKey = sanitizeText(step);
    if (!stepKey) return false;
    const scope = scopeSql();
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = COALESCE(?, run_id), status = 'running', current_step = ?,
        attempt_count = GREATEST(attempt_count, ?), started_at_utc = COALESCE(started_at_utc, ?),
        last_error = NULL, updated_at_utc = ?
      WHERE role_contract_id = 'activity' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, stepKey, attemptCount, now, now, id, ...scope.params);
    if (result.changes > 0) {
      this.recordActivityWorkflowStepStarted({
        activityId: id,
        workflowId,
        runId,
        stepKey,
        attempt: attemptForStep(attemptCount),
        activityType: stepKey,
        agentId: stepKey === 'raw_normalizer' ? ACTIVITY_NORMALIZER_AGENT_ID : null,
        nowIso: now,
        metadataJson: { activity_id: id, workflow_id: workflowId, run_id: runId }
      });
    }
    return result.changes > 0;
  },

  failActivityWorkflow({ activityId, workflowId, runId, reason, step = 'raw_normalizer', needsReview = false, attemptCount = 0, nowIso }) {
    const id = sanitizeText(activityId);
    const now = nowIso ?? new Date().toISOString();
    const status = needsReview ? 'needs_review' : 'failed';
    const error = sanitizeText(reason)?.slice(0, 1000) ?? 'workflow_failed';
    const currentStep = sanitizeText(step) ?? 'raw_normalizer';
    const scope = scopeSql();
    const result = this.db.prepare(`
      UPDATE workflow_executions
      SET workflow_id = ?, run_id = COALESCE(?, run_id), status = ?, current_step = ?,
        attempt_count = GREATEST(attempt_count, ?), last_error = ?, completed_at_utc = ?, updated_at_utc = ?
      WHERE role_contract_id = 'activity' AND raw_record_id = ?
        AND status IN ('queued', 'running') ${scope.clause}
    `).run(workflowId, runId, status, currentStep, attemptCount, error, now, now, id, ...scope.params);
    if (result.changes === 0) return;
    this.recordActivityWorkflowStepFinished({
      activityId: id,
      workflowId,
      runId,
      stepKey: currentStep,
      attempt: attemptForStep(attemptCount),
      status: status === 'failed' && /timeout/i.test(error) ? 'timed_out' : 'failed',
      errorCode: errorCode(error),
      errorSummary: error,
      nowIso: now
    });
    this.reconcileActivityWorkflowTraceStatus({ activityId: id, workflowId, runId, nowIso: now });
    safeRecordLog(this, {
      dt: now,
      source: 'workflow',
      operation: 'activity.raw_normalization',
      status: 'failed',
      severityText: 'ERROR',
      reason: error,
      message: 'Activity normalization workflow failed',
      jsonData: { workflow_id: workflowId, run_id: runId, activity_id: id, workflow_status: status, attempt_count: attemptCount }
    });
  },

  reconcileActivityWorkflowTerminal({ activityId, workflowId, runId, temporalStatus, nowIso }) {
    const id = sanitizeText(activityId);
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
        SELECT w.id, w.current_step, a.item_roles_id
        FROM workflow_executions w
        JOIN activities a ON a.id = w.raw_record_id
        WHERE w.role_contract_id = 'activity'
          AND w.raw_record_id = ?
          AND w.workflow_id = ?
          AND w.run_id IS NOT DISTINCT FROM ?
          AND w.status = 'running'
          ${scope.clause}
        LIMIT 1
        FOR UPDATE OF w
      `).get(id, operationId, temporalRunId, ...scope.params);
      if (!row) return { changed: false, status: null, reason: null, step: null, executionId: null };

      const domainCompleted = status === 'COMPLETED' && Boolean(row.item_roles_id);
      const localStatus = domainCompleted ? 'completed' : 'failed';
      const reason = domainCompleted ? null : status === 'COMPLETED' ? 'temporal_completed_without_domain_result' : `temporal_${status.toLowerCase()}`;
      const updated = this.db.prepare(`
        UPDATE workflow_executions
        SET status = ?, last_error = ?, completed_at_utc = ?, updated_at_utc = ?
        WHERE id = ?
          AND status = 'running'
          AND workflow_id = ?
          AND run_id IS NOT DISTINCT FROM ?
      `).run(localStatus, reason, now, now, row.id, operationId, temporalRunId);
      if (updated.changes !== 1) return { changed: false, status: null, reason: null, step: null, executionId: null };
      return { changed: true, status: localStatus, reason, step: row.current_step, executionId: row.id };
    })();

    if (result.changed) {
      this.recordActivityWorkflowStepStarted({
        activityId: id,
        workflowId: operationId,
        runId: temporalRunId,
        stepKey: 'terminal_reconcile',
        nowIso: now,
        metadataJson: { temporal_status: status }
      });
      this.recordActivityWorkflowStepFinished({
        activityId: id,
        workflowId: operationId,
        runId: temporalRunId,
        stepKey: 'terminal_reconcile',
        status: result.status === 'completed' ? 'completed' : 'failed',
        errorCode: result.reason,
        errorSummary: result.reason,
        nowIso: now,
        metadataJson: { temporal_status: status }
      });
      this.reconcileActivityWorkflowTraceStatus({ executionId: result.executionId, nowIso: now });
      safeRecordLog(this, {
        dt: now,
        source: 'workflow',
        operation: 'activity.workflow_terminal_reconcile',
        status: result.status === 'completed' ? 'done' : 'failed',
        severityText: result.status === 'completed' ? 'INFO' : 'ERROR',
        reason: result.reason,
        message: 'Activity workflow terminal state reconciled from Temporal',
        jsonData: {
          workflow_id: operationId,
          run_id: temporalRunId,
          activity_id: id,
          temporal_status: status,
          workflow_status: result.status,
          workflow_step: result.step
        }
      });
    }
    return { changed: result.changed, status: result.status };
  },

  applyNormalizedActivity({ activityId, workflowId, runId, normalized, normalizationText, deferTerminal = false, nowIso }) {
    const id = sanitizeText(activityId);
    if (!id) throw businessError('activity_id_required');
    const operationId = sanitizeText(workflowId);
    if (!operationId) throw businessError('workflow_id_required');
    const temporalRunId = sanitizeText(runId);
    const now = nowIso ?? new Date().toISOString();
    const title = sanitizeText(normalized?.title);
    const description = normalizeMarkdownSource(normalized?.description ?? '');
    const reason = normalizeMarkdownSource(normalized?.reason ?? '');
    const analysis = normalizeMarkdownSource(normalizationText ?? normalized?.normalization ?? '');
    if (!title || !description || !analysis) throw businessError('invalid_normalized_activity');
    const eventPayload = normalizedActivityEventPayload({ workflowId: operationId, title, description, reason, normalizationText: analysis });
    const run = this.db.transaction(() => {
      const activity = this.getActivityItem(id);
      if (!activity) throw businessError('raw_record_missing');

      const executionScope = scopeSql('w');
      const execution = this.db.prepare(`
        SELECT w.*
        FROM workflow_executions w
        WHERE w.role_contract_id = 'activity'
          AND w.raw_record_id = ?
          ${executionScope.clause}
        ORDER BY w.id DESC
        LIMIT 1
        FOR UPDATE OF w
      `).get(id, ...executionScope.params);
      if (!execution) throw businessError('workflow_execution_missing');
      if (
        execution.workflow_definition_id !== ACTIVITY_WORKFLOW_DEFINITION_ID
        || execution.workflow_definition_version !== ACTIVITY_WORKFLOW_DEFINITION_VERSION
      ) throw businessError('stale_workflow_version');
      if (execution.workflow_id !== operationId) throw businessError('workflow_id_conflict');
      if (execution.run_id !== temporalRunId) throw businessError('workflow_run_id_conflict');

      if (activity.item_roles_id) {
        const existingEvent = this.db.prepare(`
          SELECT item_roles_id, payload_json
          FROM events
          WHERE id = ? AND event_domain = 'activity' AND subject_id = ?
        `).get(`activity:${operationId}:normalized`, id);
        if (
          !existingEvent
          || existingEvent.item_roles_id !== activity.item_roles_id
          || JSON.stringify(parseJsonObject(existingEvent.payload_json)) !== JSON.stringify(eventPayload)
        ) throw businessError('idempotency_conflict');
        return { ok: true, idempotent: true, items_id: id, item_roles_id: activity.item_roles_id, workflow_execution_id: execution.id };
      }
      if (execution.status !== 'running') throw businessError('workflow_execution_not_running');

      const contract = this.db.prepare(`
        SELECT * FROM role_contracts
        WHERE id = 'activity'
          AND workflow_definition_id = ?
      `).get(ACTIVITY_WORKFLOW_DEFINITION_ID);
      if (!contract) throw businessError('role_contract_missing');

      const initialEventId = activity.initial_event_id;
      if (!initialEventId) throw businessError('initial_event_missing');
      const initialEvent = this.db.prepare(`
        SELECT item_roles_id
        FROM events
        WHERE id = ? AND event_domain = 'activity' AND subject_id = ?
      `).get(initialEventId, id);
      if (!initialEvent) throw businessError('initial_event_missing');
      if (initialEvent.item_roles_id) throw businessError('initial_event_role_conflict');

      const updatedActivity = this.db.prepare(`
        UPDATE activities
        SET title = ?, description_md = ?, reason = ?, updated_at_utc = ?
        WHERE id = ? AND item_roles_id IS NULL
      `).run(title, description, reason, now, id);
      if (updatedActivity.changes !== 1) throw businessError('raw_record_link_conflict');

      const linked = this.ensureActivityRoleLink({
        ...activity,
        title,
        description_md: description,
        reason,
        updated_at_utc: now
      });

      const normalizedEventSequence = this.insertEventRecord({
        id: `activity:${operationId}:normalized`,
        eventId: `${operationId}:normalized`,
        eventDomain: 'activity',
        eventType: 'normalized',
        eventAction: 'activity.normalized',
        title: 'Activity normalized',
        itemsId: id,
        itemRolesId: linked.item_roles_id,
        subjectType: 'activity',
        subjectId: id,
        actorType: 'agent',
        actorId: ACTIVITY_NORMALIZER_AGENT_ID,
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
      return { ok: true, idempotent: false, items_id: id, item_roles_id: linked.item_roles_id, workflow_execution_id: execution.id };
    });
    const result = run();
    if (!result.idempotent) {
      safeRecordLog(this, {
        dt: now,
        source: 'workflow',
        operation: 'activity.apply_normalized_raw',
        status: 'done',
        itemsId: id,
        eventDomain: 'activity',
        eventId: `${operationId}:normalized`,
        message: 'Activity normalization applied',
        jsonData: { workflow_id: operationId, run_id: runId, activity_id: id, item_roles_id: result.item_roles_id }
      });
      if (!deferTerminal) this.reconcileActivityWorkflowTraceStatus({ executionId: result.workflow_execution_id, nowIso: now });
    }
    return result;
  },

  getActivityWorkflowDetails(activityId) {
    const execution = this.getActivityWorkflowExecution(activityId);
    if (!execution) return null;
    const definition = this.db.prepare(`
      SELECT id, version, title, task_queue, steps_json, process_json, input_schema_version, output_schema_version
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
    const telemetrySteps = this.listActivityWorkflowExecutionSteps({ executionId: execution.id });
    const resolvedDefinition = definition ? { ...definition, steps: parseJsonArray(definition.steps_json) } : null;
    return {
      execution,
      definition: resolvedDefinition,
      step_states: resolvedDefinition
        ? activityStepStates({ execution, steps: resolvedDefinition.steps, attempts, item: this.getActivityItem(activityId), telemetrySteps })
        : [],
      steps: telemetrySteps,
      attempts
    };
  },

  recordActivityWorkflowStepStarted(input) {
    return safeWorkflowTelemetry(this, () => {
      const stepKey = sanitizeText(input.stepKey);
      const workflowId = sanitizeText(input.workflowId);
      const activityId = sanitizeText(input.activityId);
      if (!stepKey || !workflowId || !activityId) return false;
      const runId = sanitizeText(input.runId);
      const now = input.nowIso ?? new Date().toISOString();
      const attempt = attemptForStep(input.attempt);
      const metadata = boundedWorkflowMetadata(input.metadataJson);
      const result = this.db.prepare(`
        WITH execution AS (
          SELECT id
          FROM workflow_executions
          WHERE role_contract_id = 'activity'
            AND raw_record_id = ?
            AND workflow_id = ?
            AND run_id IS NOT DISTINCT FROM ?
          ORDER BY id DESC
          LIMIT 1
        )
        INSERT INTO workflow_execution_steps (
          workflow_execution_id, step_key, attempt, status, started_at_utc,
          activity_type, agent_id, metadata_json, created_at_utc, updated_at_utc
        )
        SELECT id, ?, ?, 'running', ?, ?, ?, ?::jsonb, ?, ?
        FROM execution
        ON CONFLICT (workflow_execution_id, step_key, attempt) DO UPDATE SET
          status = CASE
            WHEN workflow_execution_steps.status IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out')
              THEN workflow_execution_steps.status
            ELSE 'running'
          END,
          started_at_utc = COALESCE(workflow_execution_steps.started_at_utc, excluded.started_at_utc),
          activity_type = excluded.activity_type,
          agent_id = COALESCE(excluded.agent_id, workflow_execution_steps.agent_id),
          metadata_json = COALESCE(workflow_execution_steps.metadata_json, '{}'::jsonb) || excluded.metadata_json,
          updated_at_utc = excluded.updated_at_utc
      `).run(
        activityId,
        workflowId,
        runId,
        stepKey,
        attempt,
        now,
        sanitizeText(input.activityType) ?? stepKey,
        sanitizeText(input.agentId),
        metadata,
        now,
        now
      );
      return result.changes > 0;
    }, input);
  },

  recordActivityWorkflowStepFinished(input) {
    return safeWorkflowTelemetry(this, () => {
      const stepKey = sanitizeText(input.stepKey);
      const workflowId = sanitizeText(input.workflowId);
      const activityId = sanitizeText(input.activityId);
      if (!stepKey || !workflowId || !activityId) return false;
      const runId = sanitizeText(input.runId);
      const now = input.nowIso ?? new Date().toISOString();
      const attempt = attemptForStep(input.attempt);
      const status = workflowStepStatus(input.status);
      const metadata = boundedWorkflowMetadata(input.metadataJson);
      const result = this.db.prepare(`
        UPDATE workflow_execution_steps AS step
        SET status = ?,
          completed_at_utc = ?,
          duration_ms = CASE
            WHEN step.started_at_utc IS NULL THEN NULL
            ELSE GREATEST(0, floor(extract(epoch FROM (?::timestamptz - step.started_at_utc::timestamptz)) * 1000)::int)
          END,
          ai_log_id = COALESCE(?, step.ai_log_id),
          error_code = COALESCE(?, step.error_code),
          error_summary = COALESCE(?, step.error_summary),
          metadata_json = COALESCE(step.metadata_json, '{}'::jsonb) || ?::jsonb,
          updated_at_utc = ?
        FROM workflow_executions AS execution
        WHERE execution.id = step.workflow_execution_id
          AND execution.role_contract_id = 'activity'
          AND execution.raw_record_id = ?
          AND execution.workflow_id = ?
          AND execution.run_id IS NOT DISTINCT FROM ?
          AND step.step_key = ?
          AND step.attempt = ?
      `).run(
        status,
        now,
        now,
        Number.isInteger(input.aiLogId) ? input.aiLogId : null,
        sanitizeText(input.errorCode),
        boundedError(input.errorSummary),
        metadata,
        now,
        activityId,
        workflowId,
        runId,
        stepKey,
        attempt
      );
      return result.changes > 0;
    }, input);
  },

  recordActivityWorkflowStepSkipped({ activityId, workflowId, runId, stepKey, reason, nowIso, metadataJson }) {
    const now = nowIso ?? new Date().toISOString();
    this.recordActivityWorkflowStepStarted({
      activityId,
      workflowId,
      runId,
      stepKey,
      nowIso: now,
      metadataJson: { ...(metadataJson ?? {}), skip_reason: sanitizeText(reason) ?? 'not_required' }
    });
    return this.recordActivityWorkflowStepFinished({
      activityId,
      workflowId,
      runId,
      stepKey,
      status: 'skipped',
      errorCode: sanitizeText(reason) ?? 'not_required',
      errorSummary: sanitizeText(reason) ?? 'not_required',
      nowIso: now
    });
  },

  listActivityWorkflowExecutionSteps({ executionId }) {
    if (!Number.isInteger(executionId)) return [];
    return safeWorkflowTelemetry(this, () => this.db.prepare(`
      SELECT id, workflow_execution_id, step_key, attempt, status, started_at_utc,
        completed_at_utc, duration_ms, activity_type, agent_id, ai_log_id,
        error_code, error_summary, metadata_json
      FROM workflow_execution_steps
      WHERE workflow_execution_id = ?
      ORDER BY COALESCE(started_at_utc, completed_at_utc, updated_at_utc), attempt, id
    `).all(executionId).map((row) => ({ ...row, metadata_json: parseJsonObject(row.metadata_json) })), { executionId }) ?? [];
  },

  reconcileActivityWorkflowTraceStatus({ executionId, activityId, workflowId, runId, nowIso } = {}) {
    return safeWorkflowTelemetry(this, () => {
      const now = nowIso ?? new Date().toISOString();
      const row = Number.isInteger(executionId)
        ? this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?').get(executionId)
        : this.db.prepare(`
          SELECT *
          FROM workflow_executions
          WHERE role_contract_id = 'activity'
            AND raw_record_id = ?
            AND workflow_id = ?
            AND run_id IS NOT DISTINCT FROM ?
          ORDER BY id DESC
          LIMIT 1
        `).get(sanitizeText(activityId), sanitizeText(workflowId), sanitizeText(runId));
      if (!row || !TERMINAL_WORKFLOW_STATUSES.has(row.status)) return false;
      if (row.trace_status === 'unavailable') return false;
      const definition = this.db.prepare(`
        SELECT process_json
        FROM workflow_definitions
        WHERE id = ? AND version = ?
      `).get(row.workflow_definition_id, row.workflow_definition_version);
      const expected = expectedTraceSteps(definition?.process_json, row.status);
      const actual = this.db.prepare(`
        SELECT step_key, status
        FROM workflow_execution_steps
        WHERE workflow_execution_id = ?
      `).all(row.id);
      const actualKeys = new Set(actual.map((step) => step.step_key));
      const hasFailedStep = actual.some((step) => ['failed', 'timed_out'].includes(step.status));
      const complete = expected.every((step) => actualKeys.has(step)) && (row.status === 'completed' || hasFailedStep || row.status === 'needs_review');
      this.db.prepare(`
        UPDATE workflow_executions
        SET trace_status = ?, updated_at_utc = ?
        WHERE id = ? AND trace_status <> 'unavailable'
      `).run(complete ? 'complete' : 'partial', now, row.id);
      return true;
    }, { executionId, activityId, workflowId, runId });
  }
};

function activityStepStates({ execution, steps, attempts, item, telemetrySteps = [] }) {
  const currentIndex = steps.indexOf(execution.current_step);
  const terminal = ['completed', 'failed', 'needs_review'].includes(execution.status);
  const failedIndex = ['failed', 'needs_review'].includes(execution.status) ? currentIndex : -1;
  const progressedPast = (step) => currentIndex > steps.indexOf(step);
  const failedAt = (step) => failedIndex === steps.indexOf(step);
  const skippedAfterFailure = (step) => failedIndex >= 0 && steps.indexOf(step) > failedIndex;
  if (telemetrySteps.length > 0) {
    const byStep = new Map();
    for (const step of telemetrySteps) byStep.set(step.step_key, step);
    return steps.map((step) => {
      const telemetry = byStep.get(step);
      if (!telemetry) {
        if (step === 'image_describer' && skippedAfterFailure(step)) return { id: step, state: 'skipped', reason: 'upstream_failed' };
        if (step === 'image_describer' && (progressedPast(step) || terminal)) return { id: step, state: 'skipped', reason: 'not_required' };
        return { id: step, state: 'pending', reason: null };
      }
      const state = telemetry.status === 'completed' ? 'completed'
        : telemetry.status === 'failed' || telemetry.status === 'timed_out' ? 'failed'
          : telemetry.status === 'skipped' ? 'skipped'
            : telemetry.status === 'running' ? 'running'
              : telemetry.status;
      return { id: step, state, reason: telemetry.error_code ?? telemetry.metadata_json?.skip_reason ?? null };
    });
  }
  const inline = execution.run_id?.startsWith('inline:') === true;
  const normalizerAttempts = attempts.filter((attempt) => attempt.agent_id === ACTIVITY_NORMALIZER_AGENT_ID);
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
      if (failedAt(step)) return state(step, 'failed');
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
      if (item?.item_roles_id) return state(step, 'completed');
      if (failedAt(step)) return state(step, 'failed');
      if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
      if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
      return state(step, 'pending');
    }
    if (step === 'terminal_reconcile') {
      if (inline) return state(step, 'skipped', 'inline_execution');
      if (terminal) return state(step, 'completed');
      if (execution.status === 'running' && item?.item_roles_id) return state(step, 'running');
      return state(step, 'pending');
    }
    if (failedAt(step)) return state(step, 'failed');
    if (execution.status === 'running' && execution.current_step === step) return state(step, 'running');
    if (skippedAfterFailure(step)) return state(step, 'skipped', 'upstream_failed');
    return state(step, progressedPast(step) || execution.status === 'completed' ? 'completed' : 'pending');
  });
}

function normalizedActivityEventPayload({ workflowId, title, description, reason, normalizationText }) {
  return {
    schema: 'brai.activity.normalized-event.v1',
    workflow_id: workflowId,
    title,
    description_md: description,
    reason,
    normalization_text: normalizationText
  };
}

function businessError(code) {
  const error = new Error(code);
  error.businessError = true;
  return error;
}

function attemptForStep(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function workflowStepStatus(value) {
  return ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'timed_out'].includes(value)
    ? value
    : 'completed';
}

function boundedWorkflowMetadata(value) {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return JSON.stringify(object, (_key, candidate) => {
    if (typeof candidate === 'string') return sanitizeText(candidate)?.slice(0, 240) ?? '';
    if (typeof candidate === 'number' || typeof candidate === 'boolean' || candidate === null) return candidate;
    if (Array.isArray(candidate)) return candidate.slice(0, 20);
    return candidate;
  }).slice(0, 4000);
}

function boundedError(value) {
  return sanitizeText(value)?.slice(0, 1000) ?? null;
}

function errorCode(value) {
  return sanitizeText(value)?.split(':')[0]?.slice(0, 120) ?? 'workflow_failed';
}

function expectedTraceSteps(processJson, status) {
  const process = parseJsonObject(processJson);
  const steps = Array.isArray(process.steps) ? process.steps.map((step) => sanitizeText(step.id)).filter(Boolean) : [];
  if (status === 'completed') return steps;
  return steps.filter((step) => step !== 'terminal_reconcile');
}

function safeWorkflowTelemetry(store, fn, context) {
  try {
    return fn();
  } catch (error) {
    safeRecordLog(store, {
      dt: new Date().toISOString(),
      source: 'workflow',
      operation: 'workflow.telemetry',
      status: 'failed',
      severityText: 'WARN',
      reason: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      message: 'Workflow telemetry write failed',
      jsonData: {
        step_key: sanitizeText(context?.stepKey) ?? null,
        workflow_id: sanitizeText(context?.workflowId) ?? null,
        run_id_present: Boolean(context?.runId),
        activity_id_present: Boolean(context?.activityId)
      }
    });
    return false;
  }
}

function safeRecordLog(store, input) {
  try {
    store.recordLog?.(input);
  } catch (error) {
    try {
      (store.logger ?? console).error?.('Activity workflow technical log failed', {
        operation: input.operation,
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {}
  }
}
