import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

test('workflow v2 migration preserves every persisted v1 execution pin', async () => {
  const database = await createTestDatabase([
    '0001_brai_baseline.sql',
    '0010_agent_role_normalization_workflows.sql'
  ]);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id, run_id,
        role_contract_id, raw_record_id, status, current_step, attempt_count,
        last_error, started_at_utc, completed_at_utc, created_at_utc, updated_at_utc, user_id
      ) VALUES
        ('inbox.raw-normalization', 1, 'migration:queued', NULL, 'inbox', 'queued-v1', 'queued', 'ingest', 0, NULL, NULL, NULL, '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z', NULL),
        ('inbox.raw-normalization', 1, 'migration:running', 'run-v1', 'inbox', 'running-v1', 'running', 'raw_normalizer', 1, NULL, '2026-07-10T12:00:01.000Z', NULL, '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:01.000Z', NULL),
        ('inbox.raw-normalization', 1, 'migration:completed', 'done-v1', 'inbox', 'completed-v1', 'completed', 'apply_normalized_raw', 1, NULL, '2026-07-10T12:00:01.000Z', '2026-07-10T12:00:02.000Z', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:02.000Z', NULL)
    `);
    const migration = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../supabase/migrations/0011_inbox_workflow_reliability.sql'),
      'utf8'
    );
    await pool.query(migration);
    await pool.query(migration);

    const executions = (await pool.query(`
      SELECT workflow_id, workflow_definition_version, status, run_id
      FROM workflow_executions
      ORDER BY workflow_id
    `)).rows;
    assert.deepEqual(executions, [
      { workflow_id: 'migration:completed', workflow_definition_version: 1, status: 'completed', run_id: 'done-v1' },
      { workflow_id: 'migration:queued', workflow_definition_version: 1, status: 'queued', run_id: null },
      { workflow_id: 'migration:running', workflow_definition_version: 1, status: 'running', run_id: 'run-v1' }
    ]);
    assert.deepEqual((await pool.query(`
      SELECT version, status
      FROM workflow_definitions
      WHERE id = 'inbox.raw-normalization'
      ORDER BY version
    `)).rows, [
      { version: 1, status: 'retired' },
      { version: 2, status: 'active' }
    ]);
    assert.deepEqual((await pool.query(`
      SELECT workflow_definition_version, output_schema_version
      FROM role_contracts
      WHERE id = 'inbox'
    `)).rows[0], {
      workflow_definition_version: 2,
      output_schema_version: 'brai.inbox.normalized.v2'
    });
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('workflow v3 migration restores raw UI input and flags empty-input normalization', async () => {
  const database = await createTestDatabase([
    '0001_brai_baseline.sql',
    '0010_agent_role_normalization_workflows.sql',
    '0011_inbox_workflow_reliability.sql'
  ]);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      INSERT INTO timer_devices (device_id, platform, created_at_utc, last_seen_at_utc)
      VALUES ('web-device', 'web', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z');

      INSERT INTO events (
        id, event_domain, event_id, event_type, event_action, title, subject_type,
        subject_id, actor_type, actor_id, device_id, client_sequence, server_sequence,
        domain_sequence, status, occurred_at_utc, received_at_utc, payload_version,
        payload_json, created_at_utc
      ) VALUES (
        'inbox:raw-create', 'inbox', 'raw-create', 'create', 'inbox.create', 'Inbox create',
        'inbox', 'broken-inbox', 'user', 'web-device', 'web-device', 1, 1, 1,
        'accepted', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z', 1,
        '{"title":"Хочу полсушать песенку Катюша","description_md":""}',
        '2026-07-10T12:00:00.000Z'
      );

      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id, run_id,
        role_contract_id, raw_record_id, status, current_step, attempt_count,
        last_error, started_at_utc, completed_at_utc, created_at_utc, updated_at_utc
      ) VALUES (
        'inbox.raw-normalization', 2, 'brai:inbox:broken-inbox', 'run-broken',
        'inbox', 'broken-inbox', 'completed', 'apply_normalized_raw', 1,
        NULL, '2026-07-10T12:00:01.000Z', '2026-07-10T12:00:02.000Z',
        '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:02.000Z'
      );

      INSERT INTO inbox (
        id, title, description_text, source, source_key, explanation_text,
        created_at_utc, updated_at_utc, initial_event_id, workflow_execution_id
      ) SELECT
        'broken-inbox', 'Пустая запись Inbox',
        'Во входящей записи нет транскрипта, текстового контекста и описания картинки.',
        '', '', '', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:02.000Z',
        'inbox:raw-create', id
      FROM workflow_executions WHERE workflow_id = 'brai:inbox:broken-inbox';

      INSERT INTO ai_logs (
        agent_id, agent_version, dt, status, json_data, ai_title, flow_id,
        flow_command, workflow_id, run_id, attempt_number
      ) VALUES (
        'inbox.normalizer', '3', '2026-07-10T12:00:01.000Z', 'done',
        '{"inputs":[{"ref":"inbox.explanation_text","value":""},{"ref":"inbox.description_text","value":""},{"ref":"inbox.normalization_text.image_description","value":""}]}',
        'Разобрал Inbox-запись', 'broken-inbox', 'normalize',
        'brai:inbox:broken-inbox', 'run-broken', 1
      );
    `);

    const migration = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../supabase/migrations/0012_inbox_raw_input_preservation.sql'),
      'utf8'
    );
    await pool.query(migration);
    await pool.query(migration);

    assert.deepEqual((await pool.query(`
      SELECT explanation_text, source, source_key
      FROM inbox WHERE id = 'broken-inbox'
    `)).rows[0], {
      explanation_text: 'Хочу полсушать песенку Катюша',
      source: 'brai-app',
      source_key: 'web-device'
    });
    assert.deepEqual((await pool.query(`
      SELECT workflow_definition_version, status, current_step, last_error
      FROM workflow_executions WHERE workflow_id = 'brai:inbox:broken-inbox'
    `)).rows[0], {
      workflow_definition_version: 2,
      status: 'needs_review',
      current_step: 'raw_normalizer',
      last_error: 'normalized_without_raw_input'
    });
    assert.deepEqual((await pool.query(`
      SELECT version, status FROM workflow_definitions
      WHERE id = 'inbox.raw-normalization' ORDER BY version
    `)).rows, [
      { version: 1, status: 'retired' },
      { version: 2, status: 'retired' },
      { version: 3, status: 'active' }
    ]);
    assert.deepEqual((await pool.query(`
      SELECT workflow_definition_version, input_schema_version, output_schema_version
      FROM role_contracts WHERE id = 'inbox'
    `)).rows[0], {
      workflow_definition_version: 3,
      input_schema_version: 'brai.inbox.raw.v2',
      output_schema_version: 'brai.inbox.normalized.v3'
    });
    assert.equal((await pool.query("SELECT version FROM agents WHERE id = 'inbox.normalizer'")).rows[0].version, '4');
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('workflow observability migration adds process json and telemetry tables idempotently', async () => {
  const database = await createTestDatabase([
    '0001_brai_baseline.sql',
    '0010_agent_role_normalization_workflows.sql',
    '0011_inbox_workflow_reliability.sql',
    '0012_inbox_raw_input_preservation.sql',
    '0013_drop_legacy_event_tables.sql'
  ]);
  const pool = new Pool({ connectionString: database.url });
  try {
    const migration = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../supabase/migrations/0016_admin_role_workflow_observability.sql'),
      'utf8'
    );
    await pool.query(migration);
    await pool.query(migration);

    const definitions = (await pool.query(`
      SELECT version, process_json->'steps' AS steps
      FROM workflow_definitions
      WHERE id = 'inbox.raw-normalization'
      ORDER BY version
    `)).rows;
    assert.deepEqual(definitions.map((row) => row.version), [1, 2, 3]);
    assert(definitions.every((row) => Array.isArray(row.steps) && row.steps.length > 0));
    assert.deepEqual((await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'workflow_executions'
        AND column_name = 'trace_status'
    `)).rows, [{ column_name: 'trace_status' }]);
    assert.equal((await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_name IN ('workflow_execution_steps', 'workflow_worker_heartbeats')
    `)).rows[0].count, 2);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = 56")).rows[0].count, 1);
  } finally {
    await pool.end();
    await database.drop();
  }
});
