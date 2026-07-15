import crypto from 'node:crypto';
import { scopedUserId } from './user-scope.js';
import { parseJsonArray, parseJsonObject } from './store-helpers.js';
import {
  MAX_CONTEXT_PAGE_BYTES,
  MAX_CONTEXT_PAGES,
  MAX_PAGE_ITEMS
} from '../../brai_goal_agents/src/contracts.mjs';

const PAGE_PAYLOAD_BYTES = MAX_CONTEXT_PAGE_BYTES - 1_024;

export function buildGoalAgentInput(store, {
  agentId, subjectId, triggerKind, triggerRevision, watermarkTo, userId, agent
}) {
  const catalogs = {
    activity_types: store.db.prepare('SELECT id, title FROM activity_types ORDER BY id').all(),
    relation_types: store.db.prepare("SELECT id, key, directionality, is_ordered FROM relation_types WHERE status = 'active' AND (is_system = 1 OR user_id = ?) ORDER BY id").all(userId)
  };
  const trigger = {
    kind: triggerKind,
    ...(agentId === 'goal.discovery' ? { watermark: String(watermarkTo) } : { items_id: subjectId }),
    domain_revision: nonNegative(triggerRevision) ?? 0,
    ...(agentId === 'goal.planner' ? { explicit_request: true } : {})
  };
  const { snapshot, pageSets } = snapshotFor(store, agentId, subjectId);
  const revisions = {
    activity_revision: store.getActivityServerRevision(),
    inbox_revision: store.getInboxServerRevision(),
    relation_revision: store.getRelationServerRevision()
  };
  const materialContext = {
    ...revisions,
    content_sha256: goalAgentStableHash({ snapshot, pageSets: pageSets ?? {}, catalogs, revisions })
  };
  return {
    schema_version: '1', agent_id: agentId, agent_version: agent.version,
    user_id: userId, trigger,
    snapshot: { ...snapshot, material_context: materialContext },
    catalogs, validation_errors: [],
    ...(pageSets ? { page_sets: pageSets } : {})
  };
}

export function validateGoalAgentResultContext(store, execution, decisions) {
  if (!validateGoalAgentInputIntegrity(execution.input_json)) return { valid: false, stale: false };
  const available = new Map();
  collectSnapshots(execution.input_json, available);
  const referenced = new Set();
  for (const decision of decisions) {
    collectDecisionReferences(decision, referenced);
    if (!decisionAllowed(execution, decision, available)) return { valid: false, stale: false };
  }
  let stale = false;
  const material = execution.input_json?.snapshot?.material_context;
  if (!material || material.activity_revision !== store.getActivityServerRevision()
    || material.inbox_revision !== store.getInboxServerRevision()
    || material.relation_revision !== store.getRelationServerRevision()) stale = true;
  for (const id of referenced) {
    const snapshot = available.get(id);
    if (!snapshot) return { valid: false, stale: false };
    const current = currentWorkItem(store, id);
    if (!current || current.deleted_at_utc) return { valid: true, stale: true };
    if (snapshot.updated_at_utc && current.updated_at_utc !== snapshot.updated_at_utc) stale = true;
  }
  return { valid: true, stale };
}

export function validateGoalAgentDecisionContext(store, execution, decision, proposal) {
  const invalid = { valid: false, stale: false };
  const input = parseJsonObject(execution?.input_json);
  const contract = parseJsonObject(execution?.contract_json);
  const materialHash = input.snapshot?.material_context?.content_sha256;
  const frozen = store.db.prepare(`SELECT definition_contract_hash, frozen_at_utc
    FROM workflow_definitions WHERE id = ? AND version = ?`).get(
    execution?.workflow_definition_id, execution?.workflow_definition_version
  );
  if (!validExecutionContract(contract, execution)
    || execution.status !== 'completed' || goalAgentStableHash(contract) !== execution.contract_hash
    || !frozen?.frozen_at_utc || frozen.definition_contract_hash !== execution.contract_hash
    || Number(execution.workflow_definition_version) !== contract.workflow_definition_version
    || input.agent_id !== contract.id || input.agent_version !== contract.version
    || input.user_id !== execution.user_id || input.trigger?.kind !== execution.trigger_kind
    || Number(input.trigger?.domain_revision) !== Number(execution.trigger_revision ?? 0)
    || decision.workflow_id !== execution.workflow_id || decision.run_id !== execution.run_id
    || decision.agent_id !== contract.id || decision.agent_version !== contract.version
    || decision.prompt_version !== contract.prompt_version
    || decision.schema_version !== contract.output_schema_version
    || decision.trigger_revision !== execution.trigger_revision
    || decision.source_snapshot_hash !== materialHash
    || !contract.decision_kinds.includes(decision.decision_kind)) return invalid;
  return validateGoalAgentResultContext(store, { ...execution, input_json: input }, [{
    decision_kind: decision.decision_kind,
    subject_items_id: decision.trigger_items_id,
    evidence: parseJsonArray(decision.evidence_json),
    proposal
  }]);
}

function validExecutionContract(contract, execution) {
  return contract.id === execution?.workflow_definition_id
    && typeof contract.version === 'string' && contract.version.length > 0
    && Number.isInteger(contract.workflow_definition_version)
    && typeof contract.prompt_version === 'string' && contract.prompt_version.length > 0
    && typeof contract.output_schema_version === 'string' && contract.output_schema_version.length > 0
    && Array.isArray(contract.decision_kinds) && contract.decision_kinds.length > 0;
}

export function validateGoalAgentInputIntegrity(input) {
  const material = input?.snapshot?.material_context;
  if (!material || typeof material.content_sha256 !== 'string') return false;
  const { material_context: _material, ...snapshot } = input.snapshot;
  const revisions = {
    activity_revision: material.activity_revision,
    inbox_revision: material.inbox_revision,
    relation_revision: material.relation_revision
  };
  const expected = goalAgentStableHash({
    snapshot,
    pageSets: input.page_sets ?? {},
    catalogs: input.catalogs,
    revisions
  });
  return expected === material.content_sha256;
}

export function loadGoalAgentExecutionContract(store, agentId) {
  const row = store.db.prepare(`
    SELECT a.id, a.version, a.prompt_version, a.metadata_json,
      w.input_schema_version, w.output_schema_version, w.output_schema_json
    FROM agents a
    JOIN workflow_definitions w ON w.id = a.id AND w.version = 1
    WHERE a.id = ?
  `).get(agentId);
  if (!row) return null;
  const metadata = parseJsonObject(row.metadata_json);
  const outputSchema = parseJsonObject(row.output_schema_json);
  const kindRule = outputSchema?.properties?.decisions?.items?.properties?.decision_kind;
  const schemaKinds = kindRule?.enum ?? (kindRule?.const ? [kindRule.const] : []);
  return {
    id: row.id,
    version: row.version,
    prompt_version: row.prompt_version,
    input_schema_version: row.input_schema_version,
    output_schema_version: row.output_schema_version,
    output_schema: outputSchema,
    review_only: metadata.review_only === true,
    decision_kinds: Array.isArray(metadata.decision_kinds) ? metadata.decision_kinds : schemaKinds
  };
}

export function goalAgentStableHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function snapshotFor(store, agentId, subjectId) {
  if (agentId === 'activity.classifier') {
    const activity = store.getActivityItem(subjectId);
    const inbox = activity ? null : inboxByItem(store, subjectId);
    if (!activity && !inbox) throw contextError('agent_subject_not_found', 404);
    return { snapshot: { subject: activity ? compactActivity(activity) : compactInbox(inbox) } };
  }
  if (agentId === 'goal.item-matcher') {
    const activity = store.getActivityItem(subjectId);
    const subject = activity?.activity_type_id === 'operation'
      ? inboxByItem(store, subjectId) : activity ?? inboxByItem(store, subjectId);
    if (!subject) throw contextError('agent_subject_not_found', 404);
    const linked = new Set(activeTargets(store, subjectId));
    const goals = currentGoals(store).filter((goal) => goal.status === 'New' || subject.status === 'Done');
    return {
      snapshot: { subject: 'activity_type_id' in subject ? compactActivity(subject) : compactInbox(subject) },
      pageSets: { items: paginate(goals.filter((goal) => !linked.has(goal.id)).map(compactActivity)) }
    };
  }
  if (agentId === 'goal.member-finder') {
    const goal = store.getActivityItem(subjectId);
    if (!goal || goal.activity_type_id !== 'goal') throw contextError('goal_not_found', 404);
    if (goal.status !== 'New') throw contextError('goal_not_eligible', 409);
    const linked = new Set(activeSources(store, subjectId));
    return {
      snapshot: { goal: compactActivity(goal) },
      pageSets: { items: paginate(workItems(store).filter((item) => !linked.has(item.items_id))) }
    };
  }
  if (agentId === 'goal.discovery') {
    return {
      snapshot: {},
      pageSets: {
        items: paginate(workItems(store)),
        goals: paginate(currentGoals(store).map(compactActivity))
      }
    };
  }
  const goal = store.getActivityItem(subjectId);
  if (!goal || goal.activity_type_id !== 'goal') throw contextError('goal_not_found', 404);
  if (goal.status !== 'New') throw contextError('goal_not_eligible', 409);
  return {
    snapshot: { goal: compactActivity(goal) },
    pageSets: {
      members: paginate(activeSources(store, subjectId).map((id) => currentWorkItem(store, id)).filter(Boolean))
    }
  };
}

function workItems(store) {
  const activities = store.listActivities()
    .map((item) => ({ ...compactActivity(item), items_id: item.id, kind: item.activity_type_id }));
  const operations = store.listOperations().map((item) => ({
    ...compactInbox(item), items_id: item.items_id, kind: 'operation'
  }));
  return [...activities, ...operations].sort((a, b) => a.items_id.localeCompare(b.items_id));
}

function currentGoals(store) {
  return store.listGoals().filter((goal) => !goal.deleted_at_utc);
}

function currentWorkItem(store, id) {
  const activity = store.getActivityItem(id);
  if (activity && activity.activity_type_id !== 'operation') {
    return { ...compactActivity(activity), deleted_at_utc: activity.deleted_at_utc };
  }
  const inbox = inboxByItem(store, id);
  return inbox ? { ...compactInbox(inbox), deleted_at_utc: inbox.deleted_at_utc } : null;
}

function inboxByItem(store, itemsId) {
  const row = store.db.prepare(`
    SELECT i.id FROM inbox i JOIN item_roles r ON r.id = i.item_roles_id
    WHERE r.items_id = ? AND i.user_id = ? AND i.is_normalized = 1 AND i.deleted_at_utc IS NULL
    ORDER BY i.updated_at_utc DESC LIMIT 1
  `).get(itemsId, requireUser());
  return row ? store.getInboxItem(row.id) : null;
}

function activeTargets(store, sourceId) {
  return store.db.prepare("SELECT target_items_id FROM relations WHERE user_id = ? AND source_items_id = ? AND status = 'active'")
    .all(requireUser(), sourceId).map((row) => row.target_items_id);
}

function activeSources(store, targetId) {
  return store.db.prepare("SELECT source_items_id FROM relations WHERE user_id = ? AND target_items_id = ? AND status = 'active' ORDER BY position, id")
    .all(requireUser(), targetId).map((row) => row.source_items_id);
}

function compactActivity(item) {
  return {
    items_id: item.id, activity_type_id: item.activity_type_id,
    title: String(item.title ?? '').slice(0, 160),
    description_md: String(item.description_md ?? '').slice(0, 600),
    status: item.status, updated_at_utc: item.updated_at_utc
  };
}

function compactInbox(item) {
  return {
    items_id: item.items_id, inbox_id: item.id, preliminary_section: item.preliminary_section,
    title: String(item.title ?? '').slice(0, 160),
    description_md: String(item.description_md ?? '').slice(0, 400),
    normalization: String(item.normalization_text ?? '').slice(0, 400),
    status: item.status, updated_at_utc: item.updated_at_utc
  };
}

function paginate(items) {
  const result = [];
  let page = [];
  for (const item of items) {
    const candidate = [...page, item];
    if (candidate.length > MAX_PAGE_ITEMS || jsonBytes({ items: candidate }) > PAGE_PAYLOAD_BYTES) {
      if (page.length === 0) throw contextError('goal_agent_context_item_too_large', 422);
      result.push({ items: page });
      page = [item];
      if (jsonBytes({ items: page }) > PAGE_PAYLOAD_BYTES) throw contextError('goal_agent_context_item_too_large', 422);
    } else {
      page = candidate;
    }
  }
  if (page.length > 0) result.push({ items: page });
  if (result.length > MAX_CONTEXT_PAGES) throw contextError('goal_agent_context_pages_exceeded', 422);
  return result.length > 0 ? result : [{ items: [] }];
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function collectSnapshots(value, map) {
  if (Array.isArray(value)) {
    for (const entry of value) collectSnapshots(entry, map);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.items_id === 'string') map.set(value.items_id, value);
  for (const entry of Object.values(value)) collectSnapshots(entry, map);
}

function collectDecisionReferences(decision, refs) {
  addRef(refs, decision?.subject_items_id);
  addRef(refs, decision?.proposal?.source_items_id);
  addRef(refs, decision?.proposal?.target_items_id);
  addRef(refs, decision?.proposal?.goal_items_id);
  for (const id of decision?.proposal?.member_items_ids ?? []) addRef(refs, id);
  for (const evidence of decision?.evidence ?? []) addRef(refs, evidence?.items_id);
}

function decisionAllowed(execution, decision, available) {
  const proposal = decision?.proposal ?? {};
  if (execution.workflow_definition_id === 'activity.classifier') {
    return decision.subject_items_id === execution.subject_id && available.has(execution.subject_id);
  }
  if (execution.workflow_definition_id === 'goal.planner') {
    return decision.subject_items_id === execution.subject_id
      && proposal.goal_items_id === execution.subject_id && available.has(execution.subject_id);
  }
  if (execution.workflow_definition_id === 'goal.item-matcher') {
    return decision.subject_items_id === execution.subject_id
      && proposal.relation_type_id === 'part_of'
      && proposal.source_items_id === execution.subject_id && available.has(proposal.target_items_id);
  }
  if (execution.workflow_definition_id === 'goal.member-finder') {
    return decision.subject_items_id === execution.subject_id
      && proposal.relation_type_id === 'part_of'
      && proposal.target_items_id === execution.subject_id && available.has(proposal.source_items_id);
  }
  return (proposal.member_items_ids ?? []).every((itemsId) => available.has(itemsId));
}

function addRef(refs, value) {
  if (typeof value === 'string' && value) refs.add(value);
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function requireUser() {
  const userId = scopedUserId();
  if (!userId) throw contextError('unauthorized', 401);
  return userId;
}

function contextError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
