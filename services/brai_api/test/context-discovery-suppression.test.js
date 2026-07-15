import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = '2026-07-13T18:00:00.000Z';
const OWNER = 'discovery-suppression-owner';
const OTHER = 'discovery-suppression-other';
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);
const PROPOSAL = {
  title: 'Подготовить переезд', description_md: 'Связанные действия',
  member_items_ids: ['move-a', 'move-b']
};

test('rejected discovery is suppressed only for the same user, source snapshot, and proposal', async () => {
  const fixture = await createFixture([NOW]);
  try {
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);

    const firstExecution = insertExecution(fixture.store, OWNER, 1, SOURCE_A);
    const first = scoped(OWNER, () => recordDiscovery(fixture.store, firstExecution, PROPOSAL));
    assert.equal(first.duplicate, false);
    assert.equal(first.decision.status, 'pending');
    const rejected = scoped(OWNER, () => fixture.store.resolveContextDecision({
      decisionId: first.decision.id, action: 'reject',
      resolutionKey: 'discovery:reject', nowIso: NOW
    }));
    assert.equal(rejected.decision.status, 'rejected');
    const resolutionReplay = scoped(OWNER, () => fixture.store.resolveContextDecision({
      decisionId: first.decision.id, action: 'reject',
      resolutionKey: 'discovery:reject', nowIso: NOW
    }));
    assert.equal(resolutionReplay.duplicate, true);
    const revisionAfterRejection = fixture.store.getContextDecisionRevision();

    const identicalExecution = insertExecution(fixture.store, OWNER, 2, SOURCE_A);
    const identical = scoped(OWNER, () => recordDiscovery(fixture.store, identicalExecution, PROPOSAL));
    assert.equal(identical.suppressed, true);
    assert.equal(identical.duplicate, true);
    assert.equal(identical.decision.id, first.decision.id);
    assert.equal(identical.decision.status, 'rejected');
    const identicalReplay = scoped(OWNER, () => recordDiscovery(fixture.store, identicalExecution, PROPOSAL));
    assert.equal(identicalReplay.suppressed, true);
    assert.equal(identicalReplay.decision.id, first.decision.id);
    assert.equal(fixture.store.getContextDecisionRevision(), revisionAfterRejection);
    assert.equal(decisionCount(fixture.store, OWNER), 1);

    const changedProposalExecution = insertExecution(fixture.store, OWNER, 3, SOURCE_A);
    const changedProposal = scoped(OWNER, () => recordDiscovery(
      fixture.store, changedProposalExecution, { ...PROPOSAL, title: 'Организовать переезд' }
    ));
    assert.equal(changedProposal.duplicate, false);
    assert.equal(changedProposal.decision.status, 'pending');

    const changedSourceExecution = insertExecution(fixture.store, OWNER, 4, SOURCE_B);
    const changedSource = scoped(OWNER, () => recordDiscovery(fixture.store, changedSourceExecution, PROPOSAL));
    assert.equal(changedSource.duplicate, false);
    assert.equal(changedSource.decision.status, 'pending');
    assert.equal(decisionCount(fixture.store, OWNER), 3);

    const otherExecution = insertExecution(fixture.store, OTHER, 2, SOURCE_A);
    const other = scoped(OTHER, () => recordDiscovery(fixture.store, otherExecution, PROPOSAL));
    assert.equal(other.duplicate, false);
    assert.equal(other.decision.status, 'pending');
    assert.equal(decisionCount(fixture.store, OTHER), 1);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT source_snapshot_hash, proposal_hash FROM context_decisions WHERE id = ?
    `).get(other.decision.id), {
      source_snapshot_hash: SOURCE_A,
      proposal_hash: fixture.store.db.prepare(`
        SELECT proposal_hash FROM context_decisions WHERE id = ?
      `).get(first.decision.id).proposal_hash
    });
    assert.throws(() => fixture.store.db.prepare(`
      UPDATE context_decisions SET source_snapshot_hash = 'not-a-sha256' WHERE id = ?
    `).run(other.decision.id), /context_decisions_source_snapshot_hash_check/);
  } finally {
    await fixture.close();
  }
});

function recordDiscovery(store, execution, proposal) {
  const agent = store.getAgent('goal.discovery');
  return store.recordContextDecision({
    agentId: agent.id, agentVersion: agent.version, promptVersion: agent.prompt_version,
    model: 'test-model', schemaVersion: agent.schema_version,
    decisionKind: 'goal_discovery', triggerRevision: execution.trigger_revision,
    confidence: 0.9, rationale: 'Связанные действия', evidence: [], proposal,
    workflowExecutionId: execution.id, nowIso: NOW
  });
}

function insertExecution(store, userId, revision, sourceSnapshotHash) {
  return store.db.prepare(`
    INSERT INTO workflow_executions (
      workflow_definition_id, workflow_definition_version, workflow_id,
      subject_kind, subject_id, trigger_kind, trigger_revision,
      status, current_step, attempt_count, created_at_utc, updated_at_utc,
      user_id, input_json
    ) VALUES (
      'goal.discovery', 1, ?, 'user', ?, 'test_discovery', ?,
      'running', 'persist_decisions', 1, ?, ?, ?, ?::jsonb
    ) RETURNING id, trigger_revision
  `).get(
    `test:discovery:${userId}:${revision}:${sourceSnapshotHash.slice(0, 8)}`,
    userId, revision, NOW, NOW, userId,
    JSON.stringify({ snapshot: { material_context: { content_sha256: sourceSnapshotHash } } })
  );
}

function decisionCount(store, userId) {
  return store.db.prepare(`
    SELECT count(*)::int AS count FROM context_decisions WHERE user_id = ?
  `).get(userId).count;
}

function scoped(userId, callback) {
  return withUserScope(userId, callback);
}
