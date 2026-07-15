import { parseJsonArray, parseJsonObject } from './store-helpers.js';

export function readContextDecisionPage(store, {
  userId, status = 'pending', limit = 100, cursor, page = 'decisions', now
}) {
  store.reconcileContextAudits({ userId, nowIso: now });
  const rowLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const pageCursor = decodePageCursor(cursor);
  const decisionCursor = page === 'decisions' ? pageCursor : null;
  const decisionRows = store.db.prepare(`
    SELECT * FROM context_decisions
    WHERE user_id = ? AND status = ?
      ${decisionCursor ? 'AND (created_at_utc < ? OR (created_at_utc = ? AND id < ?))' : ''}
    ORDER BY created_at_utc DESC, id DESC LIMIT ?
  `).all(userId, status,
    ...(decisionCursor ? [decisionCursor.created_at_utc, decisionCursor.created_at_utc, decisionCursor.id] : []),
    rowLimit + 1);
  const decisions = decisionRows.slice(0, rowLimit).map(formatContextDecision);
  const auditCursor = page === 'audits' ? pageCursor : null;
  const auditRows = store.db.prepare(`
    SELECT * FROM context_audit_batches
    WHERE user_id = ? AND status IN ('pending', 'overdue')
      ${auditCursor ? 'AND (created_at_utc < ? OR (created_at_utc = ? AND id < ?))' : ''}
    ORDER BY created_at_utc DESC, id DESC LIMIT ?
  `).all(userId,
    ...(auditCursor ? [auditCursor.created_at_utc, auditCursor.created_at_utc, auditCursor.id] : []),
    rowLimit + 1);
  const auditPage = auditRows.slice(0, rowLimit);
  const itemsByBatch = readAuditItems(store, auditPage);
  const audits = auditPage.map((batch) => formatAudit(batch, itemsByBatch.get(batch.id)));
  const notifications = store.db.prepare(`
    SELECT id, kind, policies_id, title, body, read_at_utc, created_at_utc
    FROM context_notifications
    WHERE user_id = ? AND read_at_utc IS NULL
    ORDER BY created_at_utc, id LIMIT ?
  `).all(userId, rowLimit).map(formatNotification);
  return {
    server_time_utc: now,
    server_revision: store.getContextDecisionRevision(),
    decisions,
    audits,
    notifications,
    next_cursor: encodePageCursor(
      page === 'audits'
        ? (auditRows.length > rowLimit ? auditRows[rowLimit - 1] : null)
        : (decisionRows.length > rowLimit ? decisionRows[rowLimit - 1] : null)
    )
  };
}

export function formatContextDecision(row) {
  return row ? {
    id: row.id,
    decision_kind: row.decision_kind,
    status: row.status,
    confidence: row.confidence,
    subject_items_id: row.trigger_items_id ?? null,
    evidence: parseJsonArray(row.evidence_json),
    proposal: parseJsonObject(row.proposal_json),
    rationale: row.rationale ?? '',
    policy: {
      id: row.policies_id,
      state: row.evaluated_policy_state,
      threshold: row.evaluated_threshold ?? null
    },
    operation_id: row.resulting_operation_id ?? null,
    relation_ids: row.resulting_relation_id ? [row.resulting_relation_id] : [],
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    prompt_version: row.prompt_version,
    model: row.model,
    schema_version: row.schema_version,
    workflow_id: row.workflow_id ?? null,
    run_id: row.run_id ?? null,
    created_at_utc: row.created_at_utc,
    resolved_at_utc: row.resolved_at_utc ?? null,
    updated_at_utc: row.updated_at_utc
  } : null;
}

function readAuditItems(store, auditPage) {
  const itemsByBatch = new Map(auditPage.map((batch) => [batch.id, []]));
  if (auditPage.length === 0) return itemsByBatch;
  const items = store.db.prepare(`
    SELECT i.*, d.decision_kind, d.trigger_items_id, d.confidence, d.rationale, d.evidence_json, d.proposal_json
    FROM context_audit_items i
    JOIN context_decisions d ON d.id = i.decisions_id
    WHERE i.audit_batches_id IN (${auditPage.map(() => '?').join(', ')})
    ORDER BY i.audit_batches_id, i.position
  `).all(...auditPage.map((batch) => batch.id));
  for (const item of items) itemsByBatch.get(item.audit_batches_id).push({
    ...item,
    evidence: parseJsonArray(item.evidence_json),
    proposal: parseJsonObject(item.proposal_json)
  });
  return itemsByBatch;
}

function formatAudit(batch, items) {
  return {
    id: batch.id,
    status: batch.status,
    policy_id: batch.policies_id,
    decision_ids: items.map((item) => item.decisions_id),
    due_at_utc: batch.due_at_utc,
    created_at_utc: batch.created_at_utc,
    updated_at_utc: batch.updated_at_utc,
    items
  };
}

function formatNotification(notification) {
  return {
    id: notification.id,
    type: notification.kind,
    policy_id: notification.policies_id,
    title: notification.title,
    body: notification.body,
    read_at_utc: notification.read_at_utc,
    created_at_utc: notification.created_at_utc
  };
}

function encodePageCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ created_at_utc: row.created_at_utc, id: String(row.id) })).toString('base64url');
}

function decodePageCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!cursor || typeof cursor.created_at_utc !== 'string' || !Number.isFinite(Date.parse(cursor.created_at_utc))
      || typeof cursor.id !== 'string' || !cursor.id) throw new Error('invalid');
    return cursor;
  } catch {
    const error = new Error('context_cursor_invalid');
    error.code = 'context_cursor_invalid';
    error.status = 400;
    throw error;
  }
}
