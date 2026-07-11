import test from 'node:test';
import assert from 'node:assert/strict';
import { processInboxItem } from '../src/inbox.js';
import { withUserScope } from '../src/user-scope.js';
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
    assert.equal(first.body.state.inbox[0].explanation_text, 'Идея');
    assert.equal(first.body.state.inbox[0].source, 'brai-app');
    assert.equal(first.body.state.inbox[0].source_key, 'web-device');
    assert.equal(first.body.state.inbox[0].record_type_id, 4);
    assert.deepEqual(
      fixture.store.listQueuedInboxWorkflowStarts().map((entry) => entry.inbox_id),
      ['inbox-1']
    );

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

test('inbox sync rejects client normalization outside the workflow', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  try {
    const response = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('raw-create', 1, 'create', 'raw-inbox', '2026-06-26T11:00:00.000Z', {
            title: 'Raw item',
            ingest_idempotency_hash: 'forged-key-hash',
            ingest_payload_hash: 'forged-payload-hash'
          }),
          inboxEvent('forged-normalize', 2, 'normalize', 'raw-inbox', '2026-06-26T11:01:00.000Z', {
            title: 'Forged normalized item',
            is_normalized: true
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.ignored_events, [{ event_id: 'forged-normalize', reason: 'invalid_type' }]);
    assert.equal(response.body.state.inbox[0].title, 'Raw item');
    assert.equal(response.body.state.inbox[0].is_normalized, false);
    assert.equal(response.body.state.inbox[0].item_roles_id, null);
    assert.equal(fixture.store.getInboxIngestFingerprint('raw-inbox').ingest_payload_hash, null);
    assert.equal(tableCount(fixture, 'items'), 0);
    assert.equal(tableCount(fixture, 'item_roles'), 0);
  } finally {
    await fixture.close();
  }
});

test('inbox create cannot claim another user\'s raw record id', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  try {
    const first = withUserScope('owner-a', () => fixture.store.syncInboxEvents({
      device: { device_id: 'owner-a-device', platform: 'web' },
      events: [inboxEvent('owner-a-create', 1, 'create', 'shared-inbox-id', '2026-06-26T11:00:00.000Z', { title: 'Owner A' })],
      nowIso: '2026-06-26T12:00:00.000Z'
    }));
    assert.deepEqual(first.ignored_events, []);

    const second = withUserScope('owner-b', () => fixture.store.syncInboxEvents({
      device: { device_id: 'owner-b-device', platform: 'web' },
      events: [inboxEvent('owner-b-create', 1, 'create', 'shared-inbox-id', '2026-06-26T11:01:00.000Z', { title: 'Owner B' })],
      nowIso: '2026-06-26T12:00:00.000Z'
    }));
    assert.deepEqual(second.ignored_events, [{ event_id: 'owner-b-create', reason: 'inbox_id_conflict' }]);
    assert.equal(withUserScope('owner-a', () => fixture.store.getInboxItem('shared-inbox-id').title), 'Owner A');
    assert.equal(withUserScope('owner-b', () => fixture.store.getInboxItem('shared-inbox-id')), null);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*)::int AS count FROM workflow_executions WHERE raw_record_id = 'shared-inbox-id'").get().count, 1);
  } finally {
    await fixture.close();
  }
});

test('inbox sync create schedules AI processing', async () => {
  const fixture = await createFixture([
    '2026-06-26T12:00:00.000Z',
    '2026-06-26T12:00:01.000Z',
    '2026-06-26T12:00:02.000Z',
    '2026-06-26T12:00:03.000Z'
  ], {
    inboxAutoProcess: true,
    inboxNormalizer: async ({ item, imageDescription, classes }) => {
      assert.equal(item.title, 'Разобрать заметку');
      assert.equal(item.explanation_text, 'Разобрать заметку');
      assert.equal(item.description_md, 'сырой контекст после правки');
      assert.equal(imageDescription, '');
      assert.ok(classes.some((entry) => entry.key === 'note'));
      return {
        title: 'Нормализованная «заметка',
        description: 'Пользователь добавил заметку и хочет сохранить контекст.',
        class_key: 'note',
        class_title: '',
        class_description: '',
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
          }),
          inboxEvent('ui-inbox-description', 2, 'update_description', 'ui-inbox-1', '2026-06-26T11:01:00.000Z', {
            description_md: 'сырой контекст после правки'
          })
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.state.inbox[0].is_normalized, false);
    await waitFor(() => fixture.store.db.prepare('SELECT is_normalized FROM inbox WHERE id = ?').get('ui-inbox-1')?.is_normalized === 1);

    const item = fixture.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get('ui-inbox-1');
    assert.equal(item.title, 'Нормализованная заметка');
    assert.equal(item.explanation_text, 'Разобрать заметку');
    assert.equal(item.source, 'brai-app');
    assert.equal(item.source_key, 'web-device');
    assert.equal(item.preliminary_section, 'note');
    assert.ok(item.item_roles_id);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM items WHERE id = ?').get('ui-inbox-1').count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM item_roles WHERE items_id = ?').get('ui-inbox-1').count, 1);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE subject_id = ? AND item_roles_id = ?').get('ui-inbox-1', item.item_roles_id).count, 3);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE agent_id = 'inbox.normalizer'").get().count, 1);

    const initialEvent = fixture.store.db.prepare('SELECT event_type, item_roles_id, payload_json FROM events WHERE id = ?').get(item.initial_event_id);
    assert.equal(initialEvent.event_type, 'create');
    assert.equal(initialEvent.item_roles_id, item.item_roles_id);
    assert.equal(JSON.parse(initialEvent.payload_json).title, 'Разобрать заметку');
    const normalizedEvent = fixture.store.db.prepare("SELECT payload_json FROM events WHERE subject_id = ? AND event_type = 'normalized'").get('ui-inbox-1');
    assert.deepEqual(JSON.parse(normalizedEvent.payload_json), {
      schema: 'brai.inbox.normalized-event.v1',
      workflow_id: 'brai:inbox:ui-inbox-1',
      title: 'Нормализованная заметка',
      description_md: 'Пользователь добавил заметку и хочет сохранить контекст.',
      preliminary_section: 'note',
      class_title: '',
      class_description: '',
      normalization_text: '## Разбор\n\nUI create event обработан normalizer agent.',
      is_normalized: true
    });

    const execution = fixture.store.getInboxWorkflowExecution('ui-inbox-1');
    const repeatedApply = fixture.store.applyNormalizedInbox({
      inboxId: 'ui-inbox-1',
      workflowId: execution.workflow_id,
      runId: execution.run_id,
      normalized: {
        title: 'Нормализованная заметка',
        description: 'Пользователь добавил заметку и хочет сохранить контекст.',
        classKey: 'note',
        classTitle: '',
        classDescription: ''
      },
      normalizationText: '## Разбор\n\nUI create event обработан normalizer agent.',
      nowIso: '2026-06-26T12:00:02.000Z'
    });
    assert.equal(repeatedApply.idempotent, true);
    assert.throws(() => fixture.store.applyNormalizedInbox({
      inboxId: 'ui-inbox-1',
      workflowId: execution.workflow_id,
      runId: execution.run_id,
      normalized: {
        title: 'Другой результат',
        description: 'Пользователь добавил заметку и хочет сохранить контекст.',
        classKey: 'note',
        classTitle: '',
        classDescription: ''
      },
      normalizationText: '## Разбор\n\nUI create event обработан normalizer agent.',
      nowIso: '2026-06-26T12:00:02.000Z'
    }), /idempotency_conflict/);

    const replay = await request(fixture.url, '/v1/inbox/events/sync', {
      method: 'POST',
      body: JSON.stringify({
        device: { device_id: 'web-device', platform: 'web' },
        events: [
          inboxEvent('ui-inbox-description-after-normalize', 3, 'update_description', 'ui-inbox-1', '2026-06-26T12:01:00.000Z', {
            description_md: 'Пользователь уточнил описание после AI.'
          })
        ]
      })
    });
    assert.equal(replay.status, 200);
    const replayedItem = replay.body.state.inbox[0];
    assert.equal(replayedItem.title, 'Нормализованная заметка');
    assert.equal(replayedItem.description_md, 'Пользователь уточнил описание после AI.');
    assert.equal(replayedItem.preliminary_section, 'note');
    assert.equal(replayedItem.is_normalized, true);
    assert.equal(replayedItem.item_roles_id, item.item_roles_id);
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM events WHERE subject_id = ? AND item_roles_id = ?').get('ui-inbox-1', item.item_roles_id).count, 4);

    const workflow = await request(fixture.url, '/v1/inbox/ui-inbox-1/workflow');
    assert.equal(workflow.status, 200);
    assert.equal(workflow.body.execution.status, 'completed');
    assert.equal(workflow.body.definition.version, 3);
    assert.equal(workflow.body.definition.output_schema_version, 'brai.inbox.normalized.v3');
    assert.deepEqual(workflow.body.definition.steps, [
      'ingest',
      'dispatch',
      'prepare_raw',
      'image_describer',
      'raw_normalizer',
      'apply_normalized_raw',
      'terminal_reconcile'
    ]);
    assert.equal(workflow.body.attempts.length, 1);
    assert.equal(workflow.body.attempts[0].agent_id, 'inbox.normalizer');
    assert.equal(workflow.body.attempts[0].agent_version, '5');
    assert.deepEqual(workflow.body.step_states.find((step) => step.id === 'image_describer'), {
      id: 'image_describer',
      state: 'skipped',
      reason: 'not_required'
    });
    assert.deepEqual(workflow.body.step_states.find((step) => step.id === 'raw_normalizer'), {
      id: 'raw_normalizer',
      state: 'completed',
      reason: null
    });

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

test('empty Inbox semantic input becomes needs_review without an AI execution', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);
  try {
    fixture.store.db.prepare(`
      INSERT INTO inbox (id, title, created_at_utc, updated_at_utc)
      VALUES ('empty-inbox', '', ?, ?)
    `).run('2026-06-26T12:00:00.000Z', '2026-06-26T12:00:00.000Z');
    fixture.store.ensureInboxWorkflowExecution({
      inboxId: 'empty-inbox',
      nowIso: '2026-06-26T12:00:00.000Z'
    });

    const result = await processInboxItem({
      store: fixture.store,
      inboxId: 'empty-inbox',
      storageRoot: '/tmp',
      normalizer: async () => assert.fail('normalizer must not run'),
      nowDate: new Date('2026-06-26T12:00:00.000Z')
    });

    assert.deepEqual(result, { skipped: true, reason: 'raw_input_empty' });
    assert.deepEqual(fixture.store.db.prepare(`
      SELECT status, current_step, last_error
      FROM workflow_executions WHERE raw_record_id = 'empty-inbox'
    `).get(), {
      status: 'needs_review',
      current_step: 'prepare_raw',
      last_error: 'raw_input_empty'
    });
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*)::int AS count FROM ai_logs WHERE flow_id = 'empty-inbox'").get().count, 0);
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
            class_title: '',
            class_description: '',
            normalization: 'Valid normalization',
            unexpected: true
          };
        }
        assert.match(validationError, /additional_property/);
        return {
          title: 'Valid title',
          description: 'Valid description',
          class_key: 'note',
          class_title: '',
          class_description: '',
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
      INSERT INTO items (id, title, description, author, created_at_utc, updated_at_utc)
      VALUES ('business-inbox', 'Existing entity', '', '', ?, ?)
    `).run('2026-06-26T11:30:00.000Z', '2026-06-26T11:30:00.000Z');
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
          class_title: '',
          class_description: '',
          normalization: 'Valid normalization'
        };
      },
      nowDate: new Date('2026-06-26T12:00:00.000Z')
    });
    assert.equal(result.reason, 'apply_failed');
    assert.equal(calls, 1);
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM ai_logs WHERE flow_id = 'business-inbox'").get().count, 1);
    const execution = fixture.store.db.prepare("SELECT status, last_error FROM workflow_executions WHERE raw_record_id = 'business-inbox'").get();
    assert.equal(execution.status, 'failed');
    assert.equal(execution.last_error, 'item_id_conflict');
    assert.equal(fixture.store.db.prepare("SELECT title FROM items WHERE id = 'business-inbox'").get().title, 'Existing entity');
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM item_roles WHERE items_id = 'business-inbox'").get().count, 0);
  } finally {
    await fixture.close();
  }
});
