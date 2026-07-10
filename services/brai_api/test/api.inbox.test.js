import test from 'node:test';
import assert from 'node:assert/strict';
import { processInboxItem } from '../src/inbox.js';
import {
  createFixture,
  inboxEvent,
  request,
  eventDomainCount,
  tableCount,
  waitFor
} from '../test-support/api.js';

test('inbox sync is idempotent and returns canonical state', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z'
  ]);
  const body = {
    device: { device_id: 'web-device', platform: 'web' },
    events: [
      inboxEvent('inbox-create', 1, 'create', 'inbox-1', '2026-06-26T11:00:00.000Z', {
        title: '  Идея  ',
        description_md: 'первая строка'
      }),
      inboxEvent('inbox-description', 2, 'update_description', 'inbox-1', '2026-06-26T11:05:00.000Z', {
        description_md: '**важно**\r\nвторая'
      })
    ]
  };

  try {
    const first = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.acknowledged_event_ids, ['inbox-create', 'inbox-description']);
    assert.equal(first.body.server_revision, 2);
    assert.equal(first.body.state.inbox.length, 1);
    assert.equal(first.body.state.inbox[0].title, 'Идея');
    assert.equal(first.body.state.inbox[0].description_md, '**важно**\nвторая');
    assert.equal(first.body.state.inbox[0].record_type_id, 4);

    const second = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.server_revision, 2);
    assert.equal(eventDomainCount(fixture, 'inbox'), 2);

    const state = await request(fixture.url, '/v1/inbox');
    assert.equal(state.status, 200);
    assert.equal(state.body.inbox[0].id, 'inbox-1');
  } finally {
    await fixture.close();
  }
});

test('inbox sync deletes items without a foreign-key dependency on inbox rows', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('delete-missing', 1, 'delete', 'offline-created-later', '2026-06-26T10:00:00.000Z')
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ignored_events, []);
    assert.equal(tableCount(fixture, 'inbox'), 0);
    assert.equal(eventDomainCount(fixture, 'inbox'), 1);
  } finally {
    await fixture.close();
  }
});

test('inbox sync create schedules AI processing', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z',
    '2026-06-26T12:00:02.000Z'
  ], {
    inboxAutoProcess: true,
    inboxNormalizer: async ({ item, imageDescription, classes }) => {
      assert.equal(item.title, 'Разобрать заметку');
      assert.equal(item.description_md, 'сырой контекст');
      assert.equal(imageDescription, '');
      assert.ok(classes.some((entry) => entry.key === 'note'));
      return {
        title: 'Нормализованная заметка',
        description: 'Пользователь добавил заметку и хочет сохранить контекст.',
        class_key: 'note',
        normalization: 'UI create event обработан normalizer agent.'
      };
    }
  });

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('ui-inbox-create', 1, 'create', 'ui-inbox-1', '2026-06-26T11:00:00.000Z', {
            title: 'Разобрать заметку',
            description_md: 'сырой контекст'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.state.inbox[0].is_normalized, false);
    await waitFor(() => fixture.store.db.prepare('SELECT is_normalized FROM inbox WHERE id = ?').get('ui-inbox-1')?.is_normalized === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get('ui-inbox-1');
    assert.equal(item.title, 'Нормализованная заметка');
    assert.equal(item.preliminary_section, 'note');
    assert.ok(item.item_roles_id);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM items WHERE id = ?').get('ui-inbox-1').count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM item_roles WHERE items_id = ?').get('ui-inbox-1').count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE subject_id = ? AND item_roles_id = ?').get('ui-inbox-1', item.item_roles_id).count, 2);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get().count, 1);

    const workflow = await request(fixture.url, '/v1/inbox/ui-inbox-1/workflow');
    assert.equal(workflow.status, 200);
    assert.equal(workflow.body.execution.status, 'completed');
    assert.deepEqual(workflow.body.definition.steps, ['ingest', 'raw_normalizer', 'apply_normalized_raw']);
    assert.equal(workflow.body.attempts.length, 1);
    assert.equal(workflow.body.attempts[0].agent_id, 'inbox.normalizer');

    fixture.store.markInboxWorkflowStarted({
      inboxId: 'ui-inbox-1',
      workflowId: 'brai:inbox:ui-inbox-1',
      runId: 'late-start-update',
      nowIso: '2026-06-26T12:00:03.000Z'
    });
    const terminalExecution = fixture.store.getInboxWorkflowExecution('ui-inbox-1');
    assert.equal(terminalExecution.status, 'completed');
    assert.notEqual(terminalExecution.run_id, 'late-start-update');
  } finally {
    await fixture.close();
  }
});

test('inbox AI failure leaves item unnormalized', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z'
  ], {
    inboxAutoProcess: true,
    inboxNormalizer: async () => {
      throw new Error('model unavailable');
    }
  });

  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('ui-inbox-fail-create', 1, 'create', 'ui-inbox-fail', '2026-06-26T11:00:00.000Z', {
            title: 'Не должен нормализоваться',
            description_md: 'сырой контекст'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    await waitFor(() => fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get().count === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get('ui-inbox-fail');
    assert.equal(item.is_normalized, 0);
    assert.equal(item.title, 'Не должен нормализоваться');
    const log = fixture.store.db.prepare("SELECT status, json_data FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get();
    assert.equal(log.status, 'failed');
    assert.equal(JSON.parse(log.json_data).metadata.error, 'model unavailable');
    const state = await request(fixture.url, '/v1/inbox');
    assert.equal(state.body.inbox[0].ai_processing_status, 'failed');
    assert.equal(state.body.inbox[0].ai_processing_error, 'model unavailable');
  } finally {
    await fixture.close();
  }
});

test('inbox normalizer retries schema validation at most three real AI executions', async () => {
  let calls = 0;
  const validationErrors = [];
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z'], {
    inboxAutoProcess: true,
    inboxNormalizer: async ({ validationError }) => {
      calls += 1;
      validationErrors.push(validationError);
      return { title: '' };
    }
  });

  try {
    await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [inboxEvent('retry-create', 1, 'create', 'retry-inbox', '2026-06-26T11:00:00.000Z', { title: 'Retry me' })]
      })
    });
    await waitFor(() => fixture.store.db.prepare("SELECT status FROM workflow_executions WHERE raw_record_id = 'retry-inbox'").get()?.status === 'needs_review');
    assert.equal(calls, 3);
    assert.equal(validationErrors[0], '');
    assert.match(validationErrors[1], /^schema_validation_failed:/);
    assert.match(validationErrors[1], /"required"/);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE flow_id = 'retry-inbox'").get().count, 3);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = 'retry-inbox'").get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('inbox normalizer enforces the stored versioned output schema', async () => {
  let calls = 0;
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  try {
    await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [inboxEvent('schema-create', 1, 'create', 'schema-inbox', '2026-06-26T11:00:00.000Z', { title: 'Schema check' })]
      })
    });

    const result = await processInboxItem({
      store: fixture.store,
      inboxId: 'schema-inbox',
      storageRoot: '/tmp',
      normalizer: async ({ validationError }) => {
        calls += 1;
        if (calls === 1) {
          return {
            title: 'Valid title',
            description: 'Valid description',
            class_key: 'note',
            normalization: 'Valid normalization',
            unexpected: true
          };
        }
        assert.match(validationError, /additional_property/);
        return {
          title: 'Valid title',
          description: 'Valid description',
          class_key: 'note',
          normalization: 'Valid normalization'
        };
      },
      nowDate: new Date('2026-06-26T12:00:00.000Z')
    });

    assert.equal(result.ok, true);
    assert.equal(calls, 2);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE flow_id = 'schema-inbox'").get().count, 2);
  } finally {
    await fixture.close();
  }
});

test('active role uniqueness is enforced by Postgres', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  try {
    fixture.store.db.prepare(`
      INSERT INTO items (id, title, description, author, created_at_utc, updated_at_utc)
      VALUES ('unique-item', '', '', '', ?, ?)
    `).run('2026-06-26T12:00:00.000Z', '2026-06-26T12:00:00.000Z');
    fixture.store.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
      VALUES ('unique-item', 2, ?, 'active', '{}')
    `).run('2026-06-26T12:00:00.000Z');
    assert.throws(() => fixture.store.db.prepare(`
      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
      VALUES ('unique-item', 2, ?, 'active', '{}')
    `).run('2026-06-26T12:00:01.000Z'));
  } finally {
    await fixture.close();
  }
});

test('apply business errors stop without another LLM execution', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  let calls = 0;
  try {
    await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [inboxEvent('business-create', 1, 'create', 'business-inbox', '2026-06-26T11:00:00.000Z', { title: 'Business error' })]
      })
    });
    fixture.store.db.prepare(`
      UPDATE role_contracts
      SET workflow_definition_id = NULL, workflow_definition_version = NULL
      WHERE id = 'inbox'
    `).run();
    const result = await processInboxItem({
      store: fixture.store,
      inboxId: 'business-inbox',
      storageRoot: '/tmp',
      normalizer: async () => {
        calls += 1;
        return {
          title: 'Valid title',
          description: 'Valid description',
          class_key: 'note',
          normalization: 'Valid normalization'
        };
      },
      nowDate: new Date('2026-06-26T12:00:00.000Z')
    });
    assert.equal(result.reason, 'apply_failed');
    assert.equal(calls, 1);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE flow_id = 'business-inbox'").get().count, 1);
    assert.equal(fixture.store.db.prepare("SELECT status FROM workflow_executions WHERE raw_record_id = 'business-inbox'").get().status, 'failed');
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = 'business-inbox'").get().count, 0);
  } finally {
    await fixture.close();
  }
});
