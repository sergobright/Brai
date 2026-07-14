import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { loadGoalAgentVersionedContract } from '../src/goal-agent-catalog.js';
import { loadGoalAgentManifests } from '../src/goal-agent-workflow-runtime.js';
import { contextDeploymentVersion, effectiveAgentBuildId } from '../../brai_goal_agents/src/versioning.mjs';
import {
  NOW, OWNER, claimOwner, hasCode, owner, seedActivity
} from './goal-agent-test-support.js';

test('Goal-agent executions use versioned stable IDs and deterministic pages of at most 50', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    const manifests = await loadGoalAgentManifests();
    const matcherManifest = manifests.find((manifest) => manifest.id === 'goal.item-matcher');
    const matcherBuildId = effectiveAgentBuildId(matcherManifest);
    fixture.store.syncGoalAgentCatalog(manifests, NOW);
    owner(fixture, () => {
      seedActivity(fixture.store, 'paged-subject', 'action');
      for (let index = 0; index < 121; index += 1) {
        seedActivity(fixture.store, `paged-goal-${String(index).padStart(3, '0')}`, 'goal');
      }
      fixture.store.db.prepare(`
        INSERT INTO relation_types (
          id, user_id, key, title, status, is_system, created_by_actor_type,
          created_by_actor_id, created_at_utc, updated_at_utc
        ) VALUES
          ('owner-private-type', ?, 'owner-private', 'Owner private', 'active', 0, 'user', ?, ?, ?),
          ('foreign-private-type', 'foreign-owner', 'foreign-private', 'Foreign private', 'active', 0, 'user', 'foreign-owner', ?, ?)
      `).run(OWNER, OWNER, NOW, NOW, NOW, NOW);
    });

    const first = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-subject', triggerKind: 'classifier_resolved',
      triggerRevision: 42, skipClassifier: true, nowIso: NOW
    }));
    const replay = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-subject', triggerKind: 'classifier_resolved',
      triggerRevision: 42, skipClassifier: true, nowIso: NOW
    }));
    assert.equal(first.id, replay.id);
    assert.equal(first.workflow_id, replay.workflow_id);
    assert.match(first.workflow_id, /^brai:preview-c:agent:goal\.item-matcher:v1:/);
    assert.equal(first.workflow_definition_version, 1);
    assert.equal(first.contract_json.worker_build_id, matcherBuildId);
    assert.equal(
      first.input_json.execution_contract.context_worker_build_id,
      contextDeploymentVersion('preview-c').buildId
    );
    assert.match(matcherBuildId, /^goal-item-matcher\.v1\.[0-9a-f]{12}$/);
    assert.equal(fixture.store.db.prepare(`
      SELECT worker_build_id FROM workflow_definitions
      WHERE id = 'goal.item-matcher' AND version = 1
    `).get().worker_build_id, matcherBuildId);
    assert.equal(first.workflow_id.includes(OWNER), false);
    assert.equal(first.workflow_id.includes('paged-subject'), false);
    assert.equal(first.deployment_environment, 'preview-c');
    assert.deepEqual(first.input_json.page_sets.items.map((page) => page.items.length), [50, 50, 21]);
    assert.equal(first.input_json.page_sets.items.flatMap((page) => page.items).length, 121);
    assert.equal(first.input_json.trigger.domain_revision, 42);
    assert.equal(first.input_json.catalogs.relation_types.some((type) => type.id === 'part_of'), true);
    const relationTypeIds = first.input_json.catalogs.relation_types.map((type) => type.id);
    assert.equal(relationTypeIds.includes('owner-private-type'), true);
    assert.equal(relationTypeIds.includes('foreign-private-type'), false);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM workflow_executions WHERE workflow_id = ?
    `).get(first.workflow_id).count, 1);
    const differentTrigger = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-subject', triggerKind: 'stale_context_refresh',
      triggerRevision: 42, skipClassifier: true, nowIso: NOW
    }));
    assert.notEqual(differentTrigger.workflow_id, first.workflow_id);

    const queues = fixture.store.db.prepare(`
      SELECT task_queue FROM workflow_definitions
      WHERE id IN ('activity.classifier','goal.item-matcher','goal.member-finder','goal.discovery','goal.planner')
      ORDER BY id
    `).all().map((row) => row.task_queue);
    assert.equal(queues.length, 5);
    assert.equal(queues.every((queue) => queue.endsWith('-{environment}')), true);
    assert.equal(new Set(queues).size, 5);

    const classifier = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-subject', triggerKind: 'activity_changed', triggerRevision: 43, nowIso: NOW
    }));
    assert.equal(classifier.workflow_definition_id, 'activity.classifier');
    const memberFinder = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-goal-000', triggerKind: 'goal_created', triggerRevision: 43, nowIso: NOW
    }));
    assert.equal(memberFinder.workflow_definition_id, 'goal.member-finder');
    assert.equal(memberFinder.input_json.page_sets.items.every((page) => page.items.length <= 50), true);
    const planner = owner(fixture, () => fixture.store.requestGoalPlan({
      itemsId: 'paged-goal-000', triggerRevision: 43, nowIso: NOW
    }));
    assert.equal(planner.workflow_definition_id, 'goal.planner');
    assert.equal(planner.input_json.trigger.explicit_request, true);
    assert.equal(planner.input_json.page_sets.members.flatMap((page) => page.items).length, 0);

    fixture.store.configureGoalAgentEnvironment('dev');
    const otherEnvironment = owner(fixture, () => fixture.store.scheduleGoalAgentForActivity({
      itemsId: 'paged-subject', triggerKind: 'classifier_resolved',
      triggerRevision: 42, skipClassifier: true, nowIso: NOW
    }));
    assert.notEqual(otherEnvironment.workflow_id, first.workflow_id);
    assert.match(otherEnvironment.workflow_id, /^brai:dev:/);
    assert.deepEqual(
      fixture.store.listQueuedGoalAgentExecutions({ nowIso: NOW }).map((row) => row.deployment_environment),
      ['dev']
    );
    fixture.store.markGoalAgentExecutionStarted({
      executionId: first.id, runId: 'preview-run', nowIso: NOW
    });
    assert.equal(fixture.store.listRunningGoalAgentExecutions({ nowIso: NOW }).length, 0);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    assert.deepEqual(
      fixture.store.listRunningGoalAgentExecutions({ nowIso: NOW }).map((row) => row.deployment_environment),
      ['preview-c']
    );
    assert.throws(() => fixture.store.configureGoalAgentEnvironment('preview-z'),
      hasCode('invalid_environment', 500));
  } finally {
    await fixture.close();
  }
});

test('workflow definition v1 freezes its prompt/schema/build contract and rejects silent mutation', async () => {
  const fixture = await createFixture([NOW]);
  try {
    claimOwner(fixture);
    fixture.store.configureGoalAgentEnvironment('preview-c');
    const manifests = await loadGoalAgentManifests();
    fixture.store.syncGoalAgentCatalog(manifests, NOW);
    const before = fixture.store.db.prepare(`
      SELECT definition_contract_hash, frozen_at_utc, task_queue
      FROM workflow_definitions WHERE id = 'goal.planner' AND version = 1
    `).get();
    assert.equal(typeof before.definition_contract_hash, 'string');
    assert.equal(before.frozen_at_utc, NOW);
    assert.equal(before.task_queue, 'brai-agent-goal-planner-{environment}');
    const contract = loadGoalAgentVersionedContract(fixture.store, 'goal.planner', 1);
    const planner = manifests.find((manifest) => manifest.id === 'goal.planner');
    assert.equal(contract.model_env, planner.model_env);
    assert.equal(contract.default_model, planner.default_model);
    assert.equal(contract.timeout_ms, planner.timeout_ms);
    assert.deepEqual(contract.retry, planner.retry);
    assert.equal(contract.entrypoint, planner.entrypoint);
    assert.equal(contract.minimum_steps, planner.minimum_steps);
    assert.equal(contract.maximum_steps, planner.maximum_steps);
    assert.deepEqual(contract.steps_json, ['dispatch', 'invoke_agent', 'persist_decisions']);
    assert.deepEqual(contract.process_json.stages, ['dispatch', 'plan', 'persist_editable_draft']);
    assert.match(contract.diagram_mermaid, /Persist editable review-only plan/);
    fixture.store.syncGoalAgentCatalog(manifests, NOW);
    for (const mutate of [
      (manifest) => ({ ...manifest, default_model: 'silent-model-change' }),
      (manifest) => ({ ...manifest, retry: { schema_attempts: 2 } }),
      (manifest) => ({ ...manifest, timeout_ms: manifest.timeout_ms + 1 }),
      (manifest) => ({ ...manifest, maximum_steps: manifest.maximum_steps - 1 }),
      (manifest) => ({ ...manifest, entrypoint: `${manifest.entrypoint}.changed` })
    ]) {
      const changed = manifests.map((manifest) => manifest.id === 'goal.planner'
        ? mutate(manifest)
        : manifest);
      assert.throws(() => fixture.store.syncGoalAgentCatalog(changed, NOW),
        hasCode('goal_agent_definition_version_conflict', 503));
    }
    const processBefore = fixture.store.db.prepare(`
      SELECT process_json FROM workflow_definitions WHERE id = 'goal.planner' AND version = 1
    `).get().process_json;
    fixture.store.db.prepare(`
      UPDATE workflow_definitions SET process_json = jsonb_set(
        process_json, '{stages}', '["silent-process-change"]'::jsonb
      ) WHERE id = 'goal.planner' AND version = 1
    `).run();
    assert.throws(() => fixture.store.syncGoalAgentCatalog(manifests, NOW),
      hasCode('goal_agent_definition_version_conflict', 503));
    fixture.store.db.prepare(`
      UPDATE workflow_definitions SET process_json = ?::jsonb
      WHERE id = 'goal.planner' AND version = 1
    `).run(JSON.stringify(processBefore));
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT definition_contract_hash, frozen_at_utc, task_queue
      FROM workflow_definitions WHERE id = 'goal.planner' AND version = 1
    `).get(), before);
  } finally {
    await fixture.close();
  }
});
