import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDueAt,
  auditIsDue,
  auditIsOverdue,
  canonicalJson,
  decisionIdentity,
  evaluateCalibration,
  mayAutoApply,
  policyIdentity,
  selectAuditSample,
  stableHash
} from '../src/context-policy.js';

test('canonical hashes ignore object key order but preserve semantic values', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  assert.notEqual(stableHash({ a: 1 }), stableHash({ a: 2 }));
});

test('policy and decision identities include their exact isolation contracts', () => {
  const policy = {
    user_id: 'u', agent_id: 'a', agent_version: '1', prompt_version: '1',
    model: 'm', schema_version: '1', decision_kind: 'relation_add'
  };
  assert.equal(policyIdentity(policy), policyIdentity({ ...policy }));
  assert.notEqual(policyIdentity(policy), policyIdentity({ ...policy, model: 'm2' }));
  const decision = {
    user_id: 'u', agent_id: 'a', agent_version: '1', prompt_version: '1', model: 'm',
    schema_version: '1', decision_kind: 'relation_add', trigger_items_id: 'i',
    trigger_revision: 2, proposal_hash: 'p'
  };
  assert.notEqual(decisionIdentity(decision), decisionIdentity({ ...decision, trigger_revision: 3 }));
  assert.notEqual(decisionIdentity(decision), decisionIdentity({ ...decision, prompt_version: '2' }));
});

test('calibration requires 25 labels and at least 95 percent precision', () => {
  assert.equal(evaluateCalibration(Array.from({ length: 24 }, () => ({ confidence: 0.8, accepted: true }))).state, 'shadow');
  const exact = evaluateCalibration([
    ...Array.from({ length: 24 }, () => ({ confidence: 0.8, accepted: true })),
    { confidence: 0.8, accepted: false }
  ]);
  assert.equal(exact.state, 'active');
  assert.equal(exact.precision, 0.96);
  const below = evaluateCalibration([
    ...Array.from({ length: 9499 }, () => ({ confidence: 0.8, accepted: true })),
    ...Array.from({ length: 501 }, () => ({ confidence: 0.8, accepted: false }))
  ]);
  assert.equal(below.precision, null);
  assert.equal(below.state, 'shadow');
});

test('calibration picks the lowest qualifying cutoff for maximum coverage', () => {
  const result = evaluateCalibration([
    ...Array.from({ length: 25 }, () => ({ confidence: 0.9, accepted: true })),
    { confidence: 0.7, accepted: false },
    { confidence: 0.7, accepted: false }
  ]);
  assert.equal(result.state, 'active');
  assert.equal(result.threshold, 0.9);
  assert.equal(result.sample_count, 25);
});

test('only active above-threshold simple decisions may auto-apply', () => {
  const active = { state: 'active', threshold: 0.9 };
  assert.equal(mayAutoApply('relation_add', 0.9, active), true);
  assert.equal(mayAutoApply('relation_add', 0.89, active), false);
  assert.equal(mayAutoApply('goal_discovery', 1, active), false);
  assert.equal(mayAutoApply('goal_plan', 1, active), false);
});

test('audit boundaries are 100 accepts, 30 days, and 14 day overdue', () => {
  const start = '2026-01-01T00:00:00.000Z';
  assert.equal(auditIsDue({ autoAcceptCount: 99, activatedAtUtc: start, nowUtc: '2026-01-30T23:59:59.999Z' }), false);
  assert.equal(auditIsDue({ autoAcceptCount: 100, lastAuditAtUtc: start, nowUtc: start }), true);
  assert.equal(auditIsDue({ autoAcceptCount: 5, activatedAtUtc: start, nowUtc: '2026-01-31T00:00:00.000Z' }), true);
  assert.equal(auditIsDue({ autoAcceptCount: 5, nowUtc: '2026-01-31T00:00:00.000Z' }), false);
  const due = auditDueAt(start);
  assert.equal(due, '2026-01-15T00:00:00.000Z');
  assert.equal(auditIsOverdue(due, '2026-01-14T23:59:59.999Z'), false);
  assert.equal(auditIsOverdue(due, due), true);
});

test('audit samples three nearest and two unique random remainder items', () => {
  const decisions = Array.from({ length: 8 }, (_, index) => ({
    id: `d${index + 1}`, confidence: 0.9 + index / 100, audited: false
  }));
  const values = [0, 0.999];
  const sample = selectAuditSample(decisions, 0.9, () => values.shift());
  assert.deepEqual(sample.map((item) => item.id), ['d1', 'd2', 'd3', 'd4', 'd8']);
});
