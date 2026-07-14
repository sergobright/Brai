import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import { withUserScope } from '../src/user-scope.js';
import { persistAndComplete, resultFor } from './goal-agent-test-support.js';

const OWNER = 'stale-discovery-owner';
const NOW = '2026-07-13T19:00:00.000Z';

test('stale discovery keeps its watermark unprocessed and queues a fresh exact range', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    fixture.store.syncGoalAgentCatalog(await loadGoalAgentManifests(), NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'discovery-member-a');
      seedActivity(fixture.store, 'discovery-member-b');
      fixture.store.noteGoalDiscoveryChanges({ count: 5, nowIso: NOW });
    });
    const [execution] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW });
    assert.ok(execution);
    owner(fixture, () => fixture.store.markGoalAgentExecutionStarted({
      executionId: execution.id, runId: 'stale-discovery-run', nowIso: NOW
    }));
    fixture.store.db.prepare(`
      UPDATE activities SET updated_at_utc = ? WHERE id = 'discovery-member-b'
    `).run(later(1));

    const completed = owner(fixture, () => persistAndComplete(fixture.store, {
      executionId: execution.id,
      result: resultFor(fixture.store, 'goal.discovery', {
        llmCalls: [{ llm_call_id: 'stale-discovery-call', status: 'completed' }],
        decisions: [{
          decision_kind: 'goal_discovery', subject_items_id: 'discovery-member-a', confidence: 1,
          rationale: 'Найдена общая цель',
          evidence: [
            { items_id: 'discovery-member-a', field: 'title', excerpt: 'A' },
            { items_id: 'discovery-member-b', field: 'title', excerpt: 'B' }
          ],
          proposal: {
            title: 'Новая цель', description_md: '',
            member_items_ids: ['discovery-member-a', 'discovery-member-b']
          }
        }]
      }),
      nowIso: later(2)
    }));
    assert.equal(completed.status, 'completed');
    assert.equal(fixture.store.db.prepare(`
      SELECT status FROM context_decisions WHERE workflow_execution_id = ?
    `).get(execution.id).status, 'stale_context');
    const watermark = fixture.store.db.prepare(`
      SELECT processed_sequence, relevant_sequence, relevant_change_count,
        active_workflow_execution_id
      FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER);
    assert.equal(watermark.processed_sequence, 0);
    assert.equal(watermark.relevant_sequence, 5);
    assert.equal(watermark.relevant_change_count, 5);
    assert.notEqual(watermark.active_workflow_execution_id, execution.id);
    const refresh = fixture.store.db.prepare(`
      SELECT status, workflow_id, trigger_kind, watermark_from, watermark_to
      FROM workflow_executions WHERE id = ?
    `).get(watermark.active_workflow_execution_id);
    assert.equal(refresh.status, 'queued');
    assert.equal(refresh.trigger_kind, 'stale_context_refresh');
    assert.equal(Number(refresh.watermark_from), 1);
    assert.equal(Number(refresh.watermark_to), 5);
    assert.notEqual(refresh.workflow_id, execution.workflow_id);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM ai_logs WHERE llm_call_id = 'stale-discovery-call'
    `).get().count, 1);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM activities WHERE activity_type_id = 'goal'
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

function claimOwner(fixture) {
  fixture.store.db.prepare(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES (?, 'Stale Discovery', 'stale-discovery@example.test', true, now(), now())
  `).run(OWNER);
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run(OWNER, NOW);
}

function owner(fixture, callback) {
  return withUserScope(OWNER, callback);
}

function seedActivity(store, id) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, user_id
    ) VALUES (?, 'action', ?, '', '', '', 'New', ?, ?, ?)
  `).run(id, id, NOW, NOW, OWNER);
  store.ensureActivityRoleLink({ id, title: id, description_md: '', author: '', created_at_utc: NOW, updated_at_utc: NOW });
}

function later(hours) {
  return new Date(Date.parse(NOW) + hours * 60 * 60 * 1000).toISOString();
}
