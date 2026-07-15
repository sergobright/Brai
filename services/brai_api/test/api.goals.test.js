import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionEvent,
  createFixture,
  eventDomainCount,
  request
} from '../test-support/api.js';

test('goal create is projected separately from Action compatibility state', async () => {
  const fixture = await createFixture(['2026-07-13T10:00:00.000Z']);
  try {
    const response = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'goal-web', platform: 'web' },
        events: [actionEvent('goal-create', 1, 'create', 'goal-1', '2026-07-13T09:00:00.000Z', {
          title: 'Запустить Relations',
          activity_type_id: 'goal'
        })]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.state.activities.length, 0);
    assert.equal(response.body.state.goals.length, 1);
    assert.equal(response.body.state.goals[0].activity_type_id, 'goal');

    const actions = await request(fixture.url, '/v1/actions');
    assert.deepEqual(actions.body.actions, []);
  } finally {
    await fixture.close();
  }
});
test('Action to Goal type change keeps Item and Activity role identity', async () => {
  const fixture = await createFixture([
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T10:00:01.000Z',
    '2026-07-13T10:00:02.000Z'
  ]);
  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'goal-web', platform: 'web' },
        events: [actionEvent('action-create', 1, 'create', 'item-1', '2026-07-13T09:00:00.000Z', {
          title: 'Большая работа'
        })]
      })
    });
    const before = fixture.store.db
      .prepare('SELECT item_roles_id FROM activities WHERE id = ?')
      .get('item-1');

    const changed = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'goal-web', platform: 'web' },
        events: [
          actionEvent('action-done', 2, 'set_status', 'item-1', '2026-07-13T09:00:30.000Z', { status: 'Done' }),
          actionEvent('action-type', 3, 'set_type', 'item-1', '2026-07-13T09:01:00.000Z', {
            from_activity_type_id: 'action',
            to_activity_type_id: 'goal'
          })
        ]
      })
    });

    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.state.activities.length, 0);
    assert.equal(changed.body.state.goals[0].id, 'item-1');
    assert.equal(changed.body.state.goals[0].status, 'New');
    assert.equal(changed.body.state.goals[0].completed_at_utc, null);
    const after = fixture.store.db
      .prepare('SELECT activity_type_id, item_roles_id, status, completed_at_utc FROM activities WHERE id = ?')
      .get('item-1');
    assert.equal(after.activity_type_id, 'goal');
    assert.equal(after.item_roles_id, before.item_roles_id);
    assert.equal(after.status, 'New');
    assert.equal(after.completed_at_utc, null);
    assert.equal(eventDomainCount(fixture, 'activity'), 3);
  } finally {
    await fixture.close();
  }
});

test('stale type change is persisted as ignored', async () => {
  const fixture = await createFixture([
    '2026-07-13T10:00:00.000Z',
    '2026-07-13T10:00:01.000Z'
  ]);
  try {
    await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'goal-web', platform: 'web' },
        events: [actionEvent('goal-create', 1, 'create', 'goal-1', '2026-07-13T09:00:00.000Z', {
          title: 'Цель',
          activity_type_id: 'goal'
        })]
      })
    });

    const stale = await request(fixture.url, '/v1/activities/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'goal-web', platform: 'web' },
        events: [actionEvent('stale-type', 2, 'set_type', 'goal-1', '2026-07-13T09:01:00.000Z', {
          from_activity_type_id: 'action',
          to_activity_type_id: 'goal'
        })]
      })
    });

    assert.deepEqual(stale.body.ignored_events, [
      { event_id: 'stale-type', reason: 'stale_activity_type' }
    ]);
    assert.equal(stale.body.state.goals[0].activity_type_id, 'goal');
  } finally {
    await fixture.close();
  }
});
