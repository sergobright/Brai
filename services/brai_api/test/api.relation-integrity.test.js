import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { createFixture } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const OWNER = 'relation-integrity-owner';
const NOW = '2026-07-13T18:00:00.000Z';

test('duplicate sync events use the canonical Relation subject for invariant repair', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'canonical-action', 'action', 'Done');
      seedActivity(fixture.store, 'canonical-goal', 'goal', 'Done');
      fixture.store.createRelation({
        id: 'canonical-relation', relationTypeId: 'part_of',
        sourceItemsId: 'canonical-action', targetItemsId: 'canonical-goal',
        operationId: 'canonical-create', actorType: 'user', nowIso: NOW
      });
    });

    const synced = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'canonical-device', platform: 'web' },
      events: [relationEvent('canonical-duplicate-event', 'duplicate-relation')],
      nowIso: NOW
    }));

    assert.deepEqual(synced.acknowledged_event_ids, ['canonical-duplicate-event']);
    assert.deepEqual(synced.ignored_events, []);
    assert.deepEqual(synced.reopened_goal_ids, ['canonical-goal']);
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM context_discovery_watermarks WHERE user_id = ?
    `).get(OWNER).count, 0);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT subject_id, status FROM events
      WHERE event_domain = 'relation' AND event_id = 'canonical-duplicate-event'
    `).get(), { subject_id: 'canonical-relation', status: 'accepted' });
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('canonical-goal')).status, 'New');
  } finally {
    await fixture.close();
  }
});

test('Relation sync rolls back until Goal invariant repair succeeds', async () => {
  const fixture = await createFixture([NOW]);
  const originalRecheck = fixture.store.recheckGoalsForRelationEvent;
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'rollback-action-a', 'action', 'Done');
      seedActivity(fixture.store, 'rollback-action-b', 'action', 'Done');
      seedActivity(fixture.store, 'rollback-goal', 'goal', 'Done');
      for (const [id, sourceItemsId, position] of [
        ['rollback-relation-a', 'rollback-action-a', 0],
        ['rollback-relation-b', 'rollback-action-b', 1]
      ]) fixture.store.createRelation({
        id, relationTypeId: 'part_of', sourceItemsId, targetItemsId: 'rollback-goal',
        position, operationId: `create:${id}`, actorType: 'user', nowIso: NOW
      });
    });
    fixture.store.recheckGoalsForRelationEvent = () => { throw new Error('forced_goal_recheck_failure'); };
    assert.throws(() => owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'rollback-device', platform: 'web' },
      events: [endRelationEvent()], nowIso: NOW
    })), /forced_goal_recheck_failure/);
    assert.equal(relationStatus(fixture, 'rollback-relation-a'), 'active');
    assert.equal(eventCount(fixture, 'rollback-end-event'), 0);
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('rollback-goal')).status, 'Done');

    fixture.store.recheckGoalsForRelationEvent = originalRecheck;
    const retry = owned(fixture, () => fixture.store.syncRelationEvents({
      device: { device_id: 'rollback-device', platform: 'web' },
      events: [endRelationEvent()], nowIso: NOW
    }));
    assert.deepEqual(retry.reopened_goal_ids, ['rollback-goal']);
    assert.equal(relationStatus(fixture, 'rollback-relation-a'), 'ended');
    assert.equal(eventCount(fixture, 'rollback-end-event'), 1);
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('rollback-goal')).status, 'New');
  } finally {
    fixture.store.recheckGoalsForRelationEvent = originalRecheck;
    await fixture.close();
  }
});

test('internal Relation provenance is owner-scoped and forbidden for user actors', async () => {
  const fixture = await createFixture([NOW]);
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'provenance-action', 'action', 'New');
      seedActivity(fixture.store, 'provenance-goal', 'goal', 'New');
    });
    const ownDecision = recordDecision(fixture.store, OWNER, 1);
    const foreignDecision = recordDecision(fixture.store, 'foreign-integrity-owner', 2);
    const input = {
      relationTypeId: 'part_of', sourceItemsId: 'provenance-action',
      targetItemsId: 'provenance-goal', nowIso: NOW
    };

    assert.throws(() => owned(fixture, () => fixture.store.createRelation({
      ...input, id: 'manual-provenance-relation', operationId: 'manual-provenance',
      originDecisionId: ownDecision.id, actorType: 'user'
    })), (error) => error?.code === 'origin_decision_id_reserved' && error?.status === 400);
    assert.throws(() => owned(fixture, () => fixture.store.createRelation({
      ...input, id: 'foreign-provenance-relation', operationId: 'foreign-provenance',
      originDecisionId: foreignDecision.id, actorType: 'agent', actorId: 'goal.item-matcher'
    })), (error) => error?.code === 'origin_decision_not_found' && error?.status === 404);

    const trusted = owned(fixture, () => fixture.store.createRelation({
      ...input, id: 'trusted-provenance-relation', operationId: 'trusted-provenance',
      originDecisionId: ownDecision.id, actorType: 'agent', actorId: 'goal.item-matcher'
    }));
    assert.equal(trusted.duplicate, false);
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT user_id, origin_decision_id, created_by_actor_type FROM relations WHERE id = ?
    `).get(trusted.relation.id), {
      user_id: OWNER, origin_decision_id: ownDecision.id, created_by_actor_type: 'agent'
    });
    assert.equal(fixture.store.db.prepare(`
      SELECT count(*)::int AS count FROM relations
      WHERE id IN ('manual-provenance-relation', 'foreign-provenance-relation')
    `).get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('concurrent Relation creates serialize one Goal list and keep dense positions', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const lockClient = await pool.connect();
  const workers = [];
  let transactionOpen = false;
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'race-action-a', 'action', 'New');
      seedActivity(fixture.store, 'race-action-b', 'action', 'New');
      seedActivity(fixture.store, 'race-goal', 'goal', 'New');
    });
    await lockClient.query('BEGIN');
    transactionOpen = true;
    await lockClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      JSON.stringify([OWNER, 'part_of', 'race-goal'])
    ]);

    workers.push(
      relationWorker(fixture.databaseUrl, 'race-relation-a', 'race-action-a'),
      relationWorker(fixture.databaseUrl, 'race-relation-b', 'race-action-b')
    );
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const resultPromises = workers.map((worker) => waitForWorkerMessage(worker, 'result'));
    workers.forEach((worker) => worker.postMessage('create'));
    assert.equal(await Promise.race([
      Promise.all(resultPromises).then(() => 'completed'),
      delay(100).then(() => 'blocked')
    ]), 'blocked');

    await lockClient.query('COMMIT');
    transactionOpen = false;
    const results = await Promise.all(resultPromises);
    assert.equal(results.every((result) => result.ok && result.outcome.duplicate === false), true);
    const rows = fixture.store.db.prepare(`
      SELECT id, position FROM relations
      WHERE user_id = ? AND relation_types_id = 'part_of' AND target_items_id = 'race-goal'
      ORDER BY position, id
    `).all(OWNER);
    assert.deepEqual(rows.map((row) => row.position), [0, 1]);
    assert.deepEqual(new Set(rows.map((row) => row.id)), new Set(['race-relation-a', 'race-relation-b']));
  } finally {
    if (transactionOpen) await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

test('Goal completion serializes with concurrent membership creation', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const lockClient = await pool.connect();
  const workers = [];
  let transactionOpen = false;
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'completion-action-a', 'action', 'Done');
      seedActivity(fixture.store, 'completion-action-b', 'action', 'Done');
      seedActivity(fixture.store, 'completion-action-new', 'action', 'New');
      seedActivity(fixture.store, 'completion-goal', 'goal', 'New');
      createMembership(fixture.store, 'completion-relation-a', 'completion-action-a', 'completion-goal', 0);
      createMembership(fixture.store, 'completion-relation-b', 'completion-action-b', 'completion-goal', 1);
    });
    await lockGoalList(lockClient, 'completion-goal');
    transactionOpen = true;
    workers.push(
      activityWorker(fixture.databaseUrl, 'completion-goal-device', actionEvent(
        'completion-goal-done', 'completion-goal', { status: 'Done' }
      )),
      relationWorker(fixture.databaseUrl, 'completion-relation-new', 'completion-action-new', 'completion-goal')
    );
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const resultPromises = workers.map((worker) => waitForWorkerResult(worker));
    workers[0].postMessage('sync');
    workers[1].postMessage('create');
    assert.equal(await Promise.race([
      Promise.all(resultPromises).then(() => 'completed'), delay(100).then(() => 'blocked')
    ]), 'blocked');
    await lockClient.query('COMMIT');
    transactionOpen = false;
    const [, relationResult] = await Promise.all(resultPromises);
    const goal = owned(fixture, () => fixture.store.getActivityItem('completion-goal'));
    const eligible = owned(fixture, () => fixture.store.goalCompletionState('completion-goal').eligible);
    assert.equal(goal.status === 'Done' && !eligible, false);
    if (goal.status === 'Done') assert.equal(relationResult.error?.code, 'goal_member_not_done');
    else assert.equal(relationResult.ok, true);
  } finally {
    if (transactionOpen) await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

test('Goal completion serializes with a concurrent member reopen', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const lockClient = await pool.connect();
  const workers = [];
  let transactionOpen = false;
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'reopen-action-a', 'action', 'Done');
      seedActivity(fixture.store, 'reopen-action-b', 'action', 'Done');
      seedActivity(fixture.store, 'reopen-goal', 'goal', 'New');
      createMembership(fixture.store, 'reopen-relation-a', 'reopen-action-a', 'reopen-goal', 0);
      createMembership(fixture.store, 'reopen-relation-b', 'reopen-action-b', 'reopen-goal', 1);
    });
    await lockGoalList(lockClient, 'reopen-goal');
    transactionOpen = true;
    workers.push(
      activityWorker(fixture.databaseUrl, 'reopen-goal-device', actionEvent(
        'reopen-goal-done', 'reopen-goal', { status: 'Done' }
      )),
      activityWorker(fixture.databaseUrl, 'reopen-member-device', actionEvent(
        'reopen-member-new', 'reopen-action-a', { status: 'New' }
      ))
    );
    await Promise.all(workers.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const resultPromises = workers.map((worker) => waitForWorkerResult(worker));
    workers.forEach((worker) => worker.postMessage('sync'));
    assert.equal(await Promise.race([
      Promise.all(resultPromises).then(() => 'completed'), delay(100).then(() => 'blocked')
    ]), 'blocked');
    await lockClient.query('COMMIT');
    transactionOpen = false;
    assert.equal((await Promise.all(resultPromises)).every((result) => result.ok), true);
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('reopen-action-a')).status, 'New');
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('reopen-goal')).status, 'New');
  } finally {
    if (transactionOpen) await lockClient.query('ROLLBACK').catch(() => {});
    lockClient.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

test('Relation create, member reopen, and Goal completion acquire the user mutation lock first', async () => {
  const fixture = await createFixture([NOW]);
  const pool = fixture.openDatabasePool();
  const domainClient = await pool.connect();
  const rowClient = await pool.connect();
  const observer = await pool.connect();
  const workers = [];
  let domainOpen = false;
  let rowOpen = false;
  try {
    owned(fixture, () => {
      seedActivity(fixture.store, 'three-way-action-a', 'action', 'Done');
      seedActivity(fixture.store, 'three-way-action-b', 'action', 'Done');
      seedActivity(fixture.store, 'three-way-source', 'action', 'Done');
      seedActivity(fixture.store, 'three-way-goal', 'goal', 'New');
      createMembership(fixture.store, 'three-way-relation-a', 'three-way-action-a', 'three-way-goal', 0);
      createMembership(fixture.store, 'three-way-relation-b', 'three-way-action-b', 'three-way-goal', 1);
    });

    await rowClient.query('BEGIN');
    rowOpen = true;
    await rowClient.query("SELECT id FROM activities WHERE id = 'three-way-source' FOR UPDATE");
    await domainClient.query('BEGIN');
    domainOpen = true;
    await domainClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      JSON.stringify([OWNER, 'relations', 'mutations'])
    ]);

    const relation = relationWorker(
      fixture.databaseUrl, 'three-way-relation-new', 'three-way-source', 'three-way-goal'
    );
    workers.push(relation);
    await waitForWorkerMessage(relation, 'ready');
    const relationTx = waitForWorkerMessage(relation, 'transaction');
    const relationResult = waitForWorkerResult(relation);
    relation.postMessage('create');
    const relationPid = (await relationTx).pid;
    await waitForLockState(observer, relationPid, waitingOnlyOnUserLock);

    await domainClient.query('COMMIT');
    domainOpen = false;
    await waitForLockState(observer, relationPid, waitingOnPayloadWithUserAndListLocks);

    const mutations = [
      activityWorker(fixture.databaseUrl, 'three-way-source-device', actionEvent(
        'three-way-source-new', 'three-way-source', { status: 'New' }
      )),
      activityWorker(fixture.databaseUrl, 'three-way-goal-device', actionEvent(
        'three-way-goal-done', 'three-way-goal', { status: 'Done' }
      ))
    ];
    workers.push(...mutations);
    await Promise.all(mutations.map((worker) => waitForWorkerMessage(worker, 'ready')));
    const mutationTxs = mutations.map((worker) => waitForWorkerMessage(worker, 'transaction'));
    const mutationResults = mutations.map((worker) => waitForWorkerResult(worker));
    mutations.forEach((worker) => worker.postMessage('sync'));
    const mutationPids = (await Promise.all(mutationTxs)).map((message) => message.pid);
    await Promise.all(mutationPids.map((pid) => waitForLockState(observer, pid, waitingOnlyOnUserLock)));

    await rowClient.query('COMMIT');
    rowOpen = false;
    const results = await Promise.all([relationResult, ...mutationResults]);
    assert.equal(results.every((result) => result.ok), true, JSON.stringify(results));
    assert.equal(relationStatus(fixture, 'three-way-relation-new'), 'active');
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('three-way-source')).status, 'New');
    assert.equal(owned(fixture, () => fixture.store.getActivityItem('three-way-goal')).status, 'New');
    assert.equal(owned(fixture, () => fixture.store.goalCompletionState('three-way-goal').eligible), false);
  } finally {
    if (domainOpen) await domainClient.query('ROLLBACK').catch(() => {});
    if (rowOpen) await rowClient.query('ROLLBACK').catch(() => {});
    domainClient.release();
    rowClient.release();
    observer.release();
    await pool.end();
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
    await fixture.close();
  }
});

function relationWorker(databaseUrl, id, sourceItemsId, targetItemsId = 'race-goal') {
  return new Worker(new URL('../test-support/relation-concurrency-worker.js', import.meta.url), {
    workerData: {
      databaseUrl, userId: OWNER,
      input: {
        id, relationTypeId: 'part_of', sourceItemsId, targetItemsId,
        position: 0, operationId: `operation:${id}`, actorType: 'user', nowIso: NOW
      }
    }
  });
}

function activityWorker(databaseUrl, deviceId, event) {
  return new Worker(new URL('../test-support/activity-concurrency-worker.js', import.meta.url), {
    workerData: {
      databaseUrl, userId: OWNER,
      input: { device: { device_id: deviceId, platform: 'web' }, events: [event], nowIso: NOW }
    }
  });
}

function actionEvent(eventId, activityId, payload) {
  return {
    event_id: eventId, client_sequence: 1, change_type: 'set_status',
    activity_id: activityId, occurred_at_utc: NOW, payload
  };
}

function createMembership(store, id, sourceItemsId, targetItemsId, position) {
  return store.createRelation({
    id, relationTypeId: 'part_of', sourceItemsId, targetItemsId, position,
    operationId: `operation:${id}`, actorType: 'user', nowIso: NOW
  });
}

async function lockGoalList(client, goalId) {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    JSON.stringify([OWNER, 'part_of', goalId])
  ]);
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      if (message.ok === false) reject(Object.assign(new Error(message.error?.message), message.error));
      else resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => {
      cleanup(); reject(new Error(`relation_worker_exit:${code}`));
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function waitForWorkerResult(worker) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== 'result') return;
      cleanup(); resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => { cleanup(); reject(new Error(`relation_worker_exit:${code}`)); };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function owned(fixture, callback) {
  return withUserScope(OWNER, callback);
}

function seedActivity(store, id, type, status) {
  store.db.prepare(`
    INSERT INTO activities (
      id, activity_type_id, title, description_md, author, reason, status,
      created_at_utc, updated_at_utc, completed_at_utc, user_id
    ) VALUES (?, ?, ?, '', '', '', ?, ?, ?, ?, ?)
  `).run(id, type, id, status, NOW, NOW, status === 'Done' ? NOW : null, OWNER);
  store.ensureActivityRoleLink({
    id, title: id, description_md: '', author: '', created_at_utc: NOW,
    updated_at_utc: NOW, deleted_at_utc: null
  });
  const activity = store.getActivityItem(id);
  store.insertEventRecord({
    id: `activity:seed-${id}`, eventId: `seed-${id}`,
    eventDomain: 'activity', eventType: 'create', eventAction: 'activity.create',
    title: 'Activity create', itemsId: id, itemRolesId: activity.item_roles_id,
    subjectType: 'activity', subjectId: id, actorType: 'user', actorId: OWNER,
    occurredAtUtc: NOW, receivedAtUtc: NOW, status: 'accepted',
    payloadVersion: 1,
    payloadJson: JSON.stringify({ title: id, activity_type_id: type })
  });
}

function relationEvent(eventId, relationId) {
  return {
    event_id: eventId, client_sequence: 1, change_type: 'create', relation_id: relationId,
    occurred_at_utc: NOW, base_server_revision: 0, payload_version: 1,
    payload: {
      relation_type_id: 'part_of', source_items_id: 'canonical-action',
      target_items_id: 'canonical-goal', operation_id: 'duplicate-create'
    }
  };
}

function endRelationEvent() {
  return {
    event_id: 'rollback-end-event', client_sequence: 1, change_type: 'end',
    relation_id: 'rollback-relation-a', occurred_at_utc: NOW, payload_version: 1,
    payload: { reason: 'removed_by_user', operation_id: 'rollback-end' }
  };
}

function relationStatus(fixture, relationId) {
  return fixture.store.db.prepare('SELECT status FROM relations WHERE id = ?').get(relationId).status;
}

function eventCount(fixture, eventId) {
  return fixture.store.db.prepare(`
    SELECT count(*)::int AS count FROM events WHERE event_domain = 'relation' AND event_id = ?
  `).get(eventId).count;
}

function recordDecision(store, userId, triggerRevision) {
  return withUserScope(userId, () => {
    const agent = store.getAgent('goal.item-matcher');
    return store.recordContextDecision({
      agentId: agent.id, agentVersion: agent.version,
      promptVersion: agent.prompt_version, model: 'test-model', schemaVersion: agent.schema_version,
      decisionKind: 'relation_add', triggerRevision, confidence: 0.8,
      rationale: 'Owner provenance regression', evidence: [],
      proposal: { relation_type_id: 'part_of', source_items_id: 'unused-action', target_items_id: 'unused-goal' },
      nowIso: NOW
    }).decision;
  });
}

async function waitForLockState(client, pid, predicate) {
  const deadline = Date.now() + 3000;
  let state;
  while (Date.now() < deadline) {
    state = (await client.query(`
      SELECT a.wait_event_type, a.wait_event,
        count(*) FILTER (WHERE l.locktype = 'advisory' AND l.granted)::int AS advisory_granted,
        count(*) FILTER (WHERE l.locktype = 'advisory' AND NOT l.granted)::int AS advisory_waiting
      FROM pg_stat_activity a LEFT JOIN pg_locks l ON l.pid = a.pid
      WHERE a.pid = $1 GROUP BY a.wait_event_type, a.wait_event
    `, [pid])).rows[0];
    if (state && predicate(state)) return state;
    await delay(10);
  }
  assert.fail(`backend_lock_state_timeout:${pid}:${JSON.stringify(state)}`);
}

function waitingOnlyOnUserLock(state) {
  return state.wait_event === 'advisory'
    && state.advisory_granted === 0 && state.advisory_waiting === 1;
}

function waitingOnPayloadWithUserAndListLocks(state) {
  return state.wait_event_type === 'Lock' && state.wait_event !== 'advisory'
    && state.advisory_granted >= 2 && state.advisory_waiting === 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
