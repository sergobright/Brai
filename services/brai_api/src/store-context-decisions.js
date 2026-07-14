import {
  auditDueAt,
  auditIsDue,
  auditIsOverdue,
  decisionIdentity,
  evaluateCalibration,
  mayAutoApply,
  policyIdentity,
  selectAuditSample,
  stableHash
} from './context-policy.js';
import { formatContextDecision, readContextDecisionPage } from './context-decision-page.js';
import { validateGoalAgentDecisionContext } from './goal-agent-context.js';
import { scheduleFreshGoalAgentAnalysis } from './store-goal-agent-workflows.js';
import { parseJsonObject, sanitizeText } from './store-helpers.js';
import { scopedUserId } from './user-scope.js';

const DECISION_KINDS = new Set(['activity_type_change', 'relation_add', 'goal_discovery', 'goal_plan']);
const DRAFT_KINDS = new Set(['goal_discovery', 'goal_plan']);
const SIMPLE_KINDS = new Set(['activity_type_change', 'relation_add']);

export const contextDecisionMethods = {
  getContextDecisionRevision() {
    return Number(this.db.prepare(`
      SELECT last_value FROM sequence_counters WHERE name = 'context.decision_revision'
    `).get()?.last_value ?? 0);
  },
  contextDecisionState({ status = 'pending', limit = 100, cursor, page = 'decisions', nowIso } = {}) {
    const userId = requireUser();
    const now = nowIso ?? new Date().toISOString();
    return readContextDecisionPage(this, { userId, status, limit, cursor, page, now });
  },
  reconcileContextAudits({ userId = null, nowIso } = {}) {
    const now = nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      const overdueCount = enforceOverdueAudits(this, userId, now);
      const policies = this.db.prepare(`
        SELECT id FROM context_policies
        WHERE state = 'active' ${userId ? 'AND user_id = ?' : ''}
        ORDER BY id
      `).all(...(userId ? [userId] : []));
      let createdCount = 0;
      for (const policy of policies) if (maybeCreateAudit(this, policy.id, now)) createdCount += 1;
      if (overdueCount > 0 || createdCount > 0) bumpRevision(this);
      return { overdue_count: overdueCount, created_count: createdCount };
    })();
  },
  recordContextDecision(input) {
    const userId = requireUser();
    const now = input.nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      const contract = normalizeContract(input, userId);
      const policy = ensurePolicy(this, contract, now);
      enforceOverduePolicy(this, policy.id, now);
      const currentPolicy = this.db.prepare('SELECT * FROM context_policies WHERE id = ?').get(policy.id);
      const proposal = boundedObject(input.proposal, 64_000, 'decision_proposal_invalid');
      const proposalHash = stableHash(proposal);
      const sourceSnapshotHash = readSourceSnapshotHash(this, contract, input.workflowExecutionId);
      const id = decisionIdentity({ ...contract, proposal_hash: proposalHash });
      const existing = this.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id);
      if (existing) {
        if (existing.proposal_hash !== proposalHash) throw contextError('decision_idempotency_conflict', 409);
        return { decision: formatContextDecision(existing), duplicate: true };
      }
      const suppressed = findRejectedDiscovery(this, contract, sourceSnapshotHash, proposalHash);
      if (suppressed) {
        return { decision: formatContextDecision(suppressed), duplicate: true, suppressed: true };
      }
      const evidence = boundedArray(input.evidence, 16_000, 'decision_evidence_invalid');
      const confidence = finiteConfidence(input.confidence);
      const auto = mayAutoApply(contract.decision_kind, confidence, {
        state: currentPolicy.state,
        threshold: currentPolicy.active_threshold
      });
      if (auto) this.lockRelationMutationDomain();
      this.db.prepare(`
        INSERT INTO context_decisions (
          id, user_id, policies_id, agent_id, agent_version, prompt_version, model,
          schema_version, decision_kind, trigger_items_id, trigger_revision,
          source_snapshot_hash, proposal_hash, confidence, rationale, evidence_json, proposal_json,
          workflow_execution_id, workflow_id, run_id, attempt_number,
          evaluated_policy_state, evaluated_threshold, status, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb,
          ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id, userId, currentPolicy.id, contract.agent_id, contract.agent_version,
        contract.prompt_version, contract.model, contract.schema_version,
        contract.decision_kind, contract.trigger_items_id, contract.trigger_revision,
        sourceSnapshotHash, proposalHash, confidence, boundedText(input.rationale, 2_000),
        JSON.stringify(evidence), JSON.stringify(proposal), input.workflowExecutionId ?? null,
        sanitizeText(input.workflowId), sanitizeText(input.runId), positiveInteger(input.attemptNumber),
        currentPolicy.state, currentPolicy.active_threshold, now, now
      );
      if (input.staleContext === true) {
        this.db.prepare(`
          UPDATE context_decisions SET status = 'stale_context', updated_at_utc = ? WHERE id = ?
        `).run(now, id);
      } else if (auto) {
        const applied = applyDecision(this, { id, operationId: `decision:auto:${id}`, payload: proposal, nowIso: now });
        this.db.prepare(`
          UPDATE context_decisions SET status = 'auto_accepted', resolver_actor_type = 'system',
            resolver_actor_id = 'calibration-policy', resolved_at_utc = ?, updated_at_utc = ?,
            resulting_operation_id = ?, resulting_relation_id = ? WHERE id = ?
        `).run(now, now, applied.operation_id, applied.relation_id, id);
        this.db.prepare(`
          UPDATE context_policies SET auto_accept_count_since_audit = auto_accept_count_since_audit + 1,
            updated_at_utc = ? WHERE id = ?
        `).run(now, currentPolicy.id);
        maybeCreateAudit(this, currentPolicy.id, now);
        if (contract.decision_kind === 'activity_type_change') {
          this.scheduleGoalMatcherForCurrent?.({
            itemsId: contract.trigger_items_id,
            triggerRevision: contract.trigger_revision,
            nowIso: now
          });
        }
      }
      bumpRevision(this);
      return { decision: formatContextDecision(this.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id)), duplicate: false };
    })();
  },
  resolveContextDecision({ decisionId, action, resolutionKey, editedPayload, nowIso }) {
    const userId = requireUser();
    const id = requiredText(decisionId, 'decision_id_required');
    const key = requiredText(resolutionKey, 'resolution_key_required');
    if (action !== 'accept' && action !== 'reject') throw contextError('decision_resolution_invalid', 400);
    const now = nowIso ?? new Date().toISOString();
    const resolutionHash = stableHash({ action, edited_payload: editedPayload ?? null });
    return atomic(this, () => {
      if (action === 'accept') this.lockRelationMutationDomain();
      const replay = this.db.prepare(`SELECT * FROM context_decisions WHERE user_id = ? AND resolution_key = ?`).get(userId, key);
      if (replay) {
        if (replay.id !== id || replay.resolution_action !== action || replay.resolution_payload_hash !== resolutionHash) {
          throw contextError('resolution_idempotency_conflict', 409);
        }
        return { decision: formatContextDecision(replay), duplicate: true };
      }
      const decision = this.db.prepare(`SELECT * FROM context_decisions WHERE id = ? AND user_id = ? FOR UPDATE`).get(id, userId);
      if (!decision) throw contextError('decision_not_found', 404);
      if (decision.status !== 'pending') throw contextError('decision_already_resolved', 409);
      let operation = null;
      if (action === 'accept') {
        if (SIMPLE_KINDS.has(decision.decision_kind) && editedPayload !== undefined) {
          throw contextError('simple_decision_not_editable', 400);
        }
        if (DRAFT_KINDS.has(decision.decision_kind) && !editedPayload) {
          throw contextError('edited_payload_required', 400);
        }
        const payload = editedPayload
          ? boundedObject(editedPayload, 64_000, 'edited_payload_invalid')
          : parseJsonObject(decision.proposal_json);
        if (resolveStaleWorkflowDecision(this, {
          decision, payload, userId, key, resolutionHash, now
        })) {
          bumpRevision(this);
          return { decision: formatContextDecision(this.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id)), duplicate: false };
        }
        operation = applyDecision(this, { id, operationId: key, payload, nowIso: now });
      }
      const status = action === 'accept' ? 'accepted' : 'rejected';
      this.db.prepare(`
        UPDATE context_decisions SET status = ?, resolver_actor_type = 'user', resolver_actor_id = ?,
          resolution_key = ?, resolution_action = ?, resolution_payload_hash = ?, resolved_at_utc = ?,
          resulting_operation_id = ?, resulting_relation_id = ?, updated_at_utc = ?
        WHERE id = ? AND user_id = ?
      `).run(status, userId, key, action, resolutionHash, now,
        operation?.operation_id ?? null, operation?.relation_id ?? null, now, id, userId);
      addLabel(this, decision, action === 'accept', 'review', now);
      recalculatePolicy(this, decision.policies_id, now);
      if (decision.decision_kind === 'activity_type_change') {
        this.scheduleGoalMatcherForCurrent?.({
          itemsId: decision.trigger_items_id,
          triggerRevision: decision.trigger_revision,
          nowIso: now
        });
      }
      bumpRevision(this);
      return { decision: formatContextDecision(this.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id)), duplicate: false };
    })();
  },
  resolveContextAuditItem({ auditItemId, action, resolutionKey, nowIso }) {
    const userId = requireUser();
    if (action !== 'confirm' && action !== 'reject') throw contextError('audit_resolution_invalid', 400);
    const key = requiredText(resolutionKey, 'resolution_key_required');
    const now = nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      if (action === 'reject') this.lockRelationMutationDomain();
      this.db.prepare('SELECT pg_advisory_xact_lock(hashtext(?))')
        .get(`context-audit-resolution:${userId}:${key}`);
      const item = this.db.prepare(`
        SELECT i.id AS audit_item_id, i.status AS audit_item_status,
          i.audit_batches_id, i.decisions_id,
          i.resolution_key AS audit_resolution_key,
          i.resolution_action AS audit_resolution_action,
          b.user_id, b.policies_id, d.*
        FROM context_audit_items i
        JOIN context_audit_batches b ON b.id = i.audit_batches_id
        JOIN context_decisions d ON d.id = i.decisions_id
        WHERE (i.id::text = ? OR i.decisions_id = ?) AND b.user_id = ? FOR UPDATE
      `).get(String(auditItemId), String(auditItemId), userId);
      if (!item) throw contextError('audit_item_not_found', 404);
      enforceOverduePolicy(this, item.policies_id, now);
      if (item.audit_item_status !== 'pending') {
        if (item.audit_resolution_key === key && item.audit_resolution_action === action) return { duplicate: true };
        throw contextError('audit_resolution_idempotency_conflict', 409);
      }
      const keyOwner = this.db.prepare(`
        SELECT i.id FROM context_audit_items i
        JOIN context_audit_batches b ON b.id = i.audit_batches_id
        WHERE b.user_id = ? AND i.resolution_key = ?
      `).get(userId, key);
      if (keyOwner && keyOwner.id !== item.audit_item_id) {
        throw contextError('audit_resolution_idempotency_conflict', 409);
      }
      let compensation = null;
      if (action === 'reject') compensation = compensateDecision(this, item, `audit:${item.audit_batches_id}:${item.audit_item_id}`, now);
      const status = action === 'confirm' ? 'confirmed' : 'rejected';
      this.db.prepare(`
        UPDATE context_audit_items SET status = ?, resolution_key = ?, resolution_action = ?, resolved_at_utc = ?
        WHERE id = ?
      `).run(status, key, action, now, item.audit_item_id);
      this.db.prepare(`
        UPDATE context_decisions SET status = ?, compensation_operation_id = COALESCE(?, compensation_operation_id),
          updated_at_utc = ? WHERE id = ?
      `).run(action === 'confirm' ? 'audit_confirmed' : 'audit_rejected', compensation?.operation_id ?? null, now, item.decisions_id);
      addLabel(this, item, action === 'confirm', 'audit', now);
      const pending = this.db.prepare(`SELECT count(*)::int AS count FROM context_audit_items WHERE audit_batches_id = ? AND status = 'pending'`).get(item.audit_batches_id).count;
      if (pending === 0) this.db.prepare(`UPDATE context_audit_batches SET status = 'completed', completed_at_utc = ?, updated_at_utc = ? WHERE id = ?`).run(now, now, item.audit_batches_id);
      recalculatePolicy(this, item.policies_id, now);
      bumpRevision(this);
      return { duplicate: false, status, compensation_operation_id: compensation?.operation_id ?? null };
    })();
  },
  undoContextDecision({ decisionId, operationId, nowIso }) {
    const userId = requireUser();
    const id = requiredText(operationId, 'operation_id_required');
    const now = nowIso ?? new Date().toISOString();
    return atomic(this, () => {
      this.lockRelationMutationDomain();
      const decision = this.db.prepare(`SELECT * FROM context_decisions WHERE id = ? AND user_id = ? FOR UPDATE`).get(decisionId, userId);
      if (!decision) throw contextError('decision_not_found', 404);
      if (decision.status === 'undone') {
        if (decision.compensation_operation_id !== id) throw contextError('undo_idempotency_conflict', 409);
        const operation = this.db.prepare(`SELECT result_json FROM context_operations
          WHERE id = ? AND user_id = ? AND kind = 'compensation' AND status = 'completed'`).get(id, userId);
        if (!operation) throw contextError('undo_result_missing', 500);
        return { ...parseJsonObject(operation.result_json), duplicate: true };
      }
      if (!['auto_accepted', 'audit_confirmed'].includes(decision.status)) throw contextError('decision_not_undoable', 409);
      const compensation = compensateDecision(this, decision, id, now);
      this.db.prepare(`UPDATE context_decisions SET status = 'undone', resolution_action = 'undo',
        compensation_operation_id = ?, updated_at_utc = ? WHERE id = ?`).run(compensation.operation_id, now, decision.id);
      addLabel(this, decision, false, 'undo', now);
      recalculatePolicy(this, decision.policies_id, now);
      bumpRevision(this);
      return { ...compensation, duplicate: false };
    })();
  },
  markContextNotificationRead(id, nowIso = new Date().toISOString()) {
    const userId = requireUser();
    const result = this.db.prepare(`
      UPDATE context_notifications SET read_at_utc = COALESCE(read_at_utc, ?)
      WHERE id = ? AND user_id = ?
    `).run(nowIso, id, userId);
    if (result.changes > 0) bumpRevision(this);
    return result.changes > 0;
  }
};

function ensurePolicy(store, contract, now) {
  const id = policyIdentity(contract);
  store.db.prepare(`
    INSERT INTO context_policies (
      id, user_id, agent_id, agent_version, prompt_version, model, schema_version,
      decision_kind, state, active_threshold, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'shadow', NULL, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `).run(id, contract.user_id, contract.agent_id, contract.agent_version,
    contract.prompt_version, contract.model, contract.schema_version, contract.decision_kind, now, now);
  return store.db.prepare('SELECT * FROM context_policies WHERE id = ? AND user_id = ?').get(id, contract.user_id);
}
function readSourceSnapshotHash(store, contract, workflowExecutionId) {
  const id = Number(workflowExecutionId);
  if (!Number.isInteger(id) || id < 1) return null;
  const row = store.db.prepare(`
    SELECT input_json #>> '{snapshot,material_context,content_sha256}' AS source_snapshot_hash
    FROM workflow_executions
    WHERE id = ? AND user_id = ? AND workflow_definition_id = ?
  `).get(id, contract.user_id, contract.agent_id);
  const hash = sanitizeText(row?.source_snapshot_hash);
  return /^[0-9a-f]{64}$/.test(hash ?? '') ? hash : null;
}
function findRejectedDiscovery(store, contract, sourceSnapshotHash, proposalHash) {
  if (contract.decision_kind !== 'goal_discovery' || !sourceSnapshotHash) return null;
  return store.db.prepare(`
    SELECT * FROM context_decisions
    WHERE user_id = ? AND decision_kind = 'goal_discovery' AND status = 'rejected'
      AND source_snapshot_hash = ? AND proposal_hash = ?
    ORDER BY resolved_at_utc DESC NULLS LAST, id LIMIT 1
  `).get(contract.user_id, sourceSnapshotHash, proposalHash) ?? null;
}
function resolveStaleWorkflowDecision(store, { decision, payload, userId, key, resolutionHash, now }) {
  if (!decision.workflow_execution_id) return false;
  const execution = store.db.prepare(`SELECT * FROM workflow_executions
    WHERE id = ? AND user_id = ?`).get(decision.workflow_execution_id, userId);
  const original = parseJsonObject(decision.proposal_json);
  const context = execution && stableHash(original) === decision.proposal_hash
    ? validateGoalAgentDecisionContext(store, execution, decision, payload) : null;
  if (!context?.valid) throw contextError('decision_context_integrity_failed', 500);
  if (!context.stale) return false;
  store.db.prepare(`UPDATE context_decisions SET status = 'stale_context',
    resolver_actor_type = 'user', resolver_actor_id = ?, resolution_key = ?,
    resolution_action = 'accept', resolution_payload_hash = ?, resolved_at_utc = ?, updated_at_utc = ?
    WHERE id = ? AND user_id = ?`).run(userId, key, resolutionHash, now, now, decision.id, userId);
  scheduleFreshGoalAgentAnalysis(store, execution, now);
  return true;
}

function recalculatePolicy(store, policyId, now) {
  enforceOverduePolicy(store, policyId, now);
  const policy = store.db.prepare('SELECT * FROM context_policies WHERE id = ? FOR UPDATE').get(policyId);
  if (!policy) return null;
  const labels = store.db.prepare('SELECT confidence, accepted FROM context_policy_labels WHERE policies_id = ?').all(policyId);
  const eligible = !DRAFT_KINDS.has(policy.decision_kind);
  const evaluation = eligible ? evaluateCalibration(labels) : { state: 'shadow', threshold: null, sample_count: labels.length, accepted_count: labels.filter((row) => row.accepted === 1).length, precision: null };
  const overdue = store.db.prepare(`
    SELECT 1 AS present FROM context_audit_batches
    WHERE policies_id = ? AND status = 'overdue' LIMIT 1
  `).get(policyId);
  const state = overdue ? 'shadow' : evaluation.state;
  const threshold = overdue ? null : evaluation.threshold;
  const newlyActive = policy.state !== 'active' && state === 'active';
  store.db.prepare(`
    UPDATE context_policies SET state = ?, active_threshold = ?, sample_count = ?,
      accepted_count = ?, observed_precision = ?, activated_at_utc = CASE WHEN ? THEN ? ELSE activated_at_utc END,
      shadow_reason = ?, updated_at_utc = ? WHERE id = ?
  `).run(state, threshold, evaluation.sample_count,
    evaluation.accepted_count, evaluation.precision, newlyActive ? 1 : 0, now,
    overdue ? 'audit_overdue' : state === 'shadow' ? (eligible ? 'insufficient_calibration' : 'review_only') : null,
    now, policyId);
  if (newlyActive && !policy.activation_notified_at_utc) {
    const notificationId = `policy-activated:${policyId}`;
    store.db.prepare(`
      INSERT INTO context_notifications (id, user_id, kind, policies_id, title, body, created_at_utc)
      VALUES (?, ?, 'policy_activated', ?, 'Автоматизация включена',
        'Brai автоматически применяет проверенные предложения этого агента.', ?)
      ON CONFLICT (user_id, kind, policies_id) DO NOTHING
    `).run(notificationId, policy.user_id, policyId, now);
    store.db.prepare('UPDATE context_policies SET activation_notified_at_utc = ? WHERE id = ?').run(now, policyId);
  }
  return store.db.prepare('SELECT * FROM context_policies WHERE id = ?').get(policyId);
}
function maybeCreateAudit(store, policyId, now) {
  const policy = store.db.prepare('SELECT * FROM context_policies WHERE id = ? FOR UPDATE').get(policyId);
  if (!policy || policy.state !== 'active' || !auditIsDue({
    autoAcceptCount: policy.auto_accept_count_since_audit,
    lastAuditAtUtc: policy.last_audit_at_utc,
    activatedAtUtc: policy.activated_at_utc,
    nowUtc: now
  })) return null;
  const candidates = store.db.prepare(`
    SELECT d.id, d.confidence, (i.id IS NOT NULL) AS audited
    FROM context_decisions d
    LEFT JOIN context_audit_items i ON i.decisions_id = d.id
    WHERE d.policies_id = ? AND d.status IN ('auto_accepted', 'audit_confirmed')
      AND d.created_at_utc > COALESCE(?, '') AND d.created_at_utc <= ?
    ORDER BY d.created_at_utc, d.id
  `).all(policyId, policy.last_audit_at_utc ?? policy.activated_at_utc, now);
  const batchId = stableHash({ policy_id: policyId, from: policy.last_audit_at_utc ?? policy.activated_at_utc, to: now });
  const sample = selectAuditSample(candidates, policy.active_threshold, seededRandom(batchId));
  if (sample.length !== 5) return null;
  const started = policy.last_audit_at_utc ?? policy.activated_at_utc;
  store.db.prepare(`
    INSERT INTO context_audit_batches (
      id, user_id, policies_id, status, window_started_at_utc, window_ended_at_utc,
      due_at_utc, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO NOTHING
  `).run(batchId, policy.user_id, policyId, started, now, auditDueAt(now), now, now);
  const insert = store.db.prepare(`
    INSERT INTO context_audit_items (
      audit_batches_id, decisions_id, sample_kind, position, created_at_utc
    ) VALUES (?, ?, ?, ?, ?) ON CONFLICT (decisions_id) DO NOTHING
  `);
  sample.forEach((decision, index) => insert.run(batchId, decision.id, index < 3 ? 'nearest_threshold' : 'random', index, now));
  store.db.prepare(`UPDATE context_policies SET auto_accept_count_since_audit = 0,
    last_audit_at_utc = ?, updated_at_utc = ? WHERE id = ?`).run(now, now, policyId);
  return batchId;
}
function enforceOverdueAudits(store, userId, now) {
  const rows = store.db.prepare(`
    SELECT id, policies_id, status, due_at_utc FROM context_audit_batches
    WHERE status IN ('pending', 'overdue') ${userId ? 'AND user_id = ?' : ''}
  `).all(...(userId ? [userId] : []));
  let changed = 0;
  for (const row of rows) if (row.status === 'overdue' || auditIsOverdue(row.due_at_utc, now)) {
    if (row.status === 'pending') {
      changed += store.db.prepare(`
        UPDATE context_audit_batches SET status = 'overdue', updated_at_utc = ? WHERE id = ? AND status = 'pending'
      `).run(now, row.id).changes;
    }
    changed += store.db.prepare(`
      UPDATE context_policies SET state = 'shadow', active_threshold = NULL,
        shadow_reason = 'audit_overdue', updated_at_utc = ?
      WHERE id = ? AND (state <> 'shadow' OR active_threshold IS NOT NULL
        OR shadow_reason IS DISTINCT FROM 'audit_overdue')
    `).run(now, row.policies_id).changes;
  }
  return changed;
}
function enforceOverduePolicy(store, policyId, now) {
  const rows = store.db.prepare(`
    SELECT id, status, due_at_utc FROM context_audit_batches
    WHERE policies_id = ? AND status IN ('pending', 'overdue')
  `).all(policyId);
  for (const row of rows) if (row.status === 'overdue' || auditIsOverdue(row.due_at_utc, now)) {
    if (row.status === 'pending') {
      store.db.prepare(`UPDATE context_audit_batches SET status = 'overdue', updated_at_utc = ? WHERE id = ?`).run(now, row.id);
    }
    store.db.prepare(`UPDATE context_policies SET state = 'shadow', active_threshold = NULL,
      shadow_reason = 'audit_overdue', updated_at_utc = ? WHERE id = ?`).run(now, policyId);
  }
}
function applyDecision(store, { id, operationId, payload, nowIso }) {
  if (typeof store.applyContextDecisionPackage !== 'function') throw contextError('decision_apply_unavailable', 503);
  const decision = store.db.prepare('SELECT * FROM context_decisions WHERE id = ?').get(id);
  return store.applyContextDecisionPackage({ decision: formatContextDecision(decision), payload, operationId, nowIso });
}
function compensateDecision(store, decision, operationId, nowIso) {
  if (typeof store.compensateContextDecision !== 'function') throw contextError('decision_compensation_unavailable', 503);
  return store.compensateContextDecision({ decision: formatContextDecision(decision), operationId, nowIso });
}
function addLabel(store, decision, accepted, source, now) {
  store.db.prepare(`
    INSERT INTO context_policy_labels (policies_id, decisions_id, source, accepted, confidence, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (decisions_id, source) DO NOTHING
  `).run(decision.policies_id, decision.id ?? decision.decisions_id, source, accepted ? 1 : 0, decision.confidence, now);
}
function normalizeContract(input, userId) {
  const decisionKind = requiredText(input.decisionKind, 'decision_kind_required');
  if (!DECISION_KINDS.has(decisionKind)) throw contextError('decision_kind_unsupported', 400);
  const triggerRevision = Number(input.triggerRevision);
  return {
    user_id: userId,
    agent_id: requiredText(input.agentId, 'agent_id_required'),
    agent_version: requiredText(input.agentVersion, 'agent_version_required'),
    prompt_version: requiredText(input.promptVersion, 'prompt_version_required'),
    model: requiredText(input.model, 'model_required'),
    schema_version: requiredText(input.schemaVersion, 'schema_version_required'),
    decision_kind: decisionKind,
    trigger_items_id: sanitizeText(input.triggerItemsId),
    trigger_revision: Number.isInteger(triggerRevision) && triggerRevision >= 0 ? triggerRevision : null
  };
}
function boundedObject(value, max, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contextError(code, 400);
  if (JSON.stringify(value).length > max) throw contextError(code, 413);
  return value;
}
function boundedArray(value, max, code) {
  const array = Array.isArray(value) ? value : [];
  if (JSON.stringify(array).length > max) throw contextError(code, 413);
  return array;
}
function boundedText(value, max) { return String(value ?? '').slice(0, max); }
function finiteConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) throw contextError('confidence_invalid', 400);
  return number;
}
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}
function requiredText(value, code) {
  const text = sanitizeText(value);
  if (!text) throw contextError(code, 400);
  return text;
}
function requireUser() {
  const userId = sanitizeText(scopedUserId());
  if (!userId) throw contextError('unauthorized', 401);
  return userId;
}
function atomic(store, fn) {
  return store.db.currentTxId ? fn : store.db.transaction(fn);
}
function bumpRevision(store) {
  return store.nextPostgresCounter('context.decision_revision');
}
function seededRandom(seed) {
  let state = Number.parseInt(seed.slice(0, 8), 16) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function contextError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
