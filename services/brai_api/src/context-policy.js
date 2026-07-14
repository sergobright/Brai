import crypto from 'node:crypto';

const REVIEW_ONLY_KINDS = new Set(['goal_discovery', 'goal_plan']);
const DAY_MS = 24 * 60 * 60 * 1000;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function policyIdentity(input) {
  return stableHash({
    user_id: input.user_id,
    agent_id: input.agent_id,
    agent_version: input.agent_version,
    prompt_version: input.prompt_version,
    model: input.model,
    schema_version: input.schema_version,
    decision_kind: input.decision_kind
  });
}

export function decisionIdentity(input) {
  return stableHash({
    user_id: input.user_id,
    agent_id: input.agent_id,
    agent_version: input.agent_version,
    prompt_version: input.prompt_version,
    model: input.model,
    schema_version: input.schema_version,
    decision_kind: input.decision_kind,
    trigger_items_id: input.trigger_items_id ?? null,
    trigger_revision: input.trigger_revision ?? null,
    proposal_hash: input.proposal_hash
  });
}

export function evaluateCalibration(labels, { minimumLabels = 25, minimumPrecision = 0.95 } = {}) {
  const normalized = labels
    .filter((label) => Number.isFinite(label.confidence))
    .map((label) => ({ confidence: label.confidence, accepted: Boolean(label.accepted) }));
  const cutoffs = [...new Set(normalized.map((label) => label.confidence))].sort((a, b) => a - b);
  for (const threshold of cutoffs) {
    const sample = normalized.filter((label) => label.confidence >= threshold);
    const accepted = sample.filter((label) => label.accepted).length;
    const precision = sample.length === 0 ? 0 : accepted / sample.length;
    if (sample.length >= minimumLabels && precision >= minimumPrecision) {
      return { state: 'active', threshold, sample_count: sample.length, accepted_count: accepted, precision };
    }
  }
  return { state: 'shadow', threshold: null, sample_count: normalized.length, accepted_count: normalized.filter((label) => label.accepted).length, precision: null };
}

export function mayAutoApply(decisionKind, confidence, policy) {
  return !REVIEW_ONLY_KINDS.has(decisionKind)
    && policy?.state === 'active'
    && Number.isFinite(policy.threshold)
    && Number.isFinite(confidence)
    && confidence >= policy.threshold;
}

export function auditIsDue({ autoAcceptCount, lastAuditAtUtc, activatedAtUtc, nowUtc }) {
  if (autoAcceptCount >= 100) return true;
  const windowStartedAtUtc = lastAuditAtUtc ?? activatedAtUtc;
  if (!windowStartedAtUtc) return false;
  return autoAcceptCount >= 5
    && new Date(nowUtc).getTime() - new Date(windowStartedAtUtc).getTime() >= 30 * DAY_MS;
}

export function auditIsOverdue(dueAtUtc, nowUtc) {
  return new Date(nowUtc).getTime() >= new Date(dueAtUtc).getTime();
}

export function auditDueAt(createdAtUtc) {
  return new Date(new Date(createdAtUtc).getTime() + 14 * DAY_MS).toISOString();
}

export function selectAuditSample(decisions, threshold, random = Math.random) {
  if (decisions.length < 5) return [];
  const eligible = decisions
    .filter((decision) => !decision.audited && decision.confidence >= threshold)
    .sort((a, b) => a.confidence - b.confidence || String(a.id).localeCompare(String(b.id)));
  if (eligible.length < 5) return [];
  const nearest = eligible.slice(0, 3);
  const remainder = eligible.slice(3);
  const randomItems = [];
  while (randomItems.length < 2) {
    const index = Math.min(remainder.length - 1, Math.floor(random() * remainder.length));
    randomItems.push(remainder.splice(index, 1)[0]);
  }
  return [...nearest, ...randomItems];
}
