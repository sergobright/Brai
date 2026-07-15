import assert from 'node:assert/strict';
import test from 'node:test';
import { actionEvent, createFixture } from '../test-support/api.js';
import { buildGoalAgentInput } from '../src/goal-agent-context.js';
import {
  NOW, OWNER, claimOwner, owner, seedActivity
} from './goal-agent-test-support.js';

test('legacy Activity Operations are read-only and never schedule Goal agents', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedActivity(fixture.store, 'legacy-operation', 'operation');
      seedInboxOperation(fixture.store, 'normalized-operation');
    });

    assert.equal(owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'legacy-operation', triggerKind: 'activity_changed', triggerRevision: 1, nowIso: NOW
    })), null);
    assert.equal(owner(fixture, () => fixture.store.scheduleGoalMatcherForCurrent({
      itemsId: 'legacy-operation', triggerKind: 'activity_type_changed', triggerRevision: 2, nowIso: NOW
    })), null);
    owner(fixture, () => fixture.store.syncActivityEvents({
      device: { device_id: 'legacy-operation-device', platform: 'web' },
      events: [actionEvent('legacy-operation-done', 1, 'set_status', 'legacy-operation', NOW, { status: 'Done' })],
      nowIso: NOW
    }));
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER).count, 0);
    assert.throws(() => owner(fixture, () => buildGoalAgentInput(fixture.store, {
      agentId: 'goal.item-matcher', subjectId: 'legacy-operation',
      triggerKind: 'classifier_resolved', triggerRevision: 2,
      userId: OWNER, agent: fixture.store.getAgent('goal.item-matcher')
    })), /agent_subject_not_found/);

    const normalized = owner(fixture, () => fixture.store.scheduleGoalAgentForInbox({
      inboxId: 'normalized-operation', triggerKind: 'normalized', triggerRevision: 3, nowIso: NOW
    }));
    assert.equal(normalized.workflow_definition_id, 'goal.item-matcher');
    assert.equal(normalized.input_json.snapshot.subject.preliminary_section, 'operation');
    assert.equal(executionCount(fixture, 'legacy-operation'), 0);
  } finally {
    await fixture.close();
  }
});

test('member-finder and discovery candidates omit legacy Activity Operations', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    owner(fixture, () => {
      seedActivity(fixture.store, 'candidate-action', 'action');
      seedActivity(fixture.store, 'candidate-goal', 'goal');
      seedActivity(fixture.store, 'candidate-legacy-operation', 'operation');
      seedInboxOperation(fixture.store, 'candidate-normalized-operation');
    });

    const memberFinder = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'candidate-goal', triggerKind: 'goal_created', triggerRevision: 4, nowIso: NOW
    }));
    assert.deepEqual(pageItems(memberFinder), [
      'candidate-action', 'candidate-normalized-operation'
    ]);

    owner(fixture, () => fixture.store.noteGoalDiscoveryChanges({ count: 5, nowIso: NOW }));
    const [discovery] = fixture.store.ensureEligibleGoalDiscoveries({ nowIso: NOW });
    assert.deepEqual(pageItems(discovery), [
      'candidate-action', 'candidate-normalized-operation'
    ]);
  } finally {
    await fixture.close();
  }
});

function seedInboxOperation(store, id) {
  store.db.prepare(`
    INSERT INTO items (id, user_id, title, description, author, created_at_utc, updated_at_utc)
    VALUES (?, ?, ?, '', '', ?, ?)
  `).run(id, OWNER, id, NOW, NOW);
  const role = store.db.prepare(`
    INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
    SELECT ?, id, ?, 'active', '{}' FROM item_role_types WHERE title_system = 'inbox'
    RETURNING id
  `).get(id, NOW);
  store.db.prepare(`
    INSERT INTO inbox (
      id, title, record_type_id, preliminary_section, is_normalized, status,
      created_at_utc, updated_at_utc, user_id, item_roles_id
    ) VALUES (?, ?, 2, 'operation', 1, 'New', ?, ?, ?, ?)
  `).run(id, id, NOW, NOW, OWNER, role.id);
}

function pageItems(execution) {
  return execution.input_json.page_sets.items
    .flatMap((page) => page.items.map((item) => item.items_id))
    .sort();
}

function executionCount(fixture, subjectId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM workflow_executions
    WHERE subject_id = ? AND workflow_definition_id IN (
      'activity.classifier', 'goal.item-matcher', 'goal.member-finder', 'goal.discovery'
    )
  `).get(subjectId).count;
}
