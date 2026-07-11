import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const BEFORE_CLEANUP = [
  '0001_brai_baseline.sql',
  '0010_agent_role_normalization_workflows.sql',
  '0011_inbox_workflow_reliability.sql',
  '0012_inbox_raw_input_preservation.sql'
];
const CLEANUP = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../supabase/migrations/0013_drop_legacy_event_tables.sql'),
  'utf8'
);

test('legacy event cleanup backfills missing rows and drops all three tables idempotently', async () => {
  const database = await createTestDatabase(BEFORE_CLEANUP);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      INSERT INTO timer_devices (device_id, platform, created_at_utc, last_seen_at_utc)
      VALUES ('cleanup-device', 'web', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z');

      INSERT INTO timer_events (
        event_id, device_id, client_sequence, server_sequence, type, occurred_at_utc,
        received_at_utc, local_timer_id, status, payload_version, metadata_json
      ) VALUES (
        'timer-cleanup', 'cleanup-device', 1, 1, 'start',
        '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z',
        'local-timer', 'accepted', 1, '{"source":"test"}'
      );

      INSERT INTO activity_events (
        event_id, device_id, client_sequence, server_sequence, activity_id,
        change_type, occurred_at_utc, received_at_utc, payload_json, status, payload_version
      ) VALUES (
        'activity-cleanup', 'cleanup-device', 1, 1, NULL, 'create',
        '2026-07-10T12:00:01.000Z', '2026-07-10T12:00:01.000Z',
        '{"title":"Action"}', 'accepted', 1
      );

      INSERT INTO inbox_events (
        event_id, device_id, client_sequence, server_sequence, inbox_id, type,
        occurred_at_utc, received_at_utc, payload_json, status, payload_version
      ) VALUES (
        'inbox-cleanup', 'cleanup-device', 1, 1, 'cleanup-inbox', 'create',
        '2026-07-10T12:00:02.000Z', '2026-07-10T12:00:02.000Z',
        '{"title":"Inbox"}', 'accepted', 1
      );

      INSERT INTO activities (
        id, title, status, created_at_utc, updated_at_utc, last_event_id
      ) VALUES
        ('cleanup-operation-a', 'Operation A', 'New', '2026-07-10T11:00:00.000Z', '2026-07-10T12:00:00.000Z', 'manual:shared-operation-cleanup'),
        ('cleanup-operation-b', 'Operation B', 'New', '2026-07-10T11:30:00.000Z', '2026-07-10T12:30:00.000Z', 'manual:shared-operation-cleanup');
    `);

    await pool.query(CLEANUP);
    await pool.query(CLEANUP);

    assert.deepEqual((await pool.query(`
      SELECT event_domain, event_id, domain_sequence, payload_json::jsonb AS payload
      FROM events
      WHERE event_id IN ('timer-cleanup', 'activity-cleanup', 'inbox-cleanup')
      ORDER BY event_domain
    `)).rows, [
      { event_domain: 'activity', event_id: 'activity-cleanup', domain_sequence: 1, payload: { title: 'Action' } },
      { event_domain: 'inbox', event_id: 'inbox-cleanup', domain_sequence: 1, payload: { title: 'Inbox' } },
      { event_domain: 'timer', event_id: 'timer-cleanup', domain_sequence: 1, payload: { source: 'test' } }
    ]);
    assert.deepEqual((await pool.query(`
      SELECT
        to_regclass(format('%I.%I', current_schema(), 'timer_events')) AS timer,
        to_regclass(format('%I.%I', current_schema(), 'activity_events')) AS activity,
        to_regclass(format('%I.%I', current_schema(), 'inbox_events')) AS inbox
    `)).rows[0], { timer: null, activity: null, inbox: null });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = 54')).rows[0].count, 1);
    assert.deepEqual((await pool.query(`
      SELECT event_type, subject_type, payload_json::jsonb AS payload
      FROM events
      WHERE event_domain = 'activity' AND event_id = 'manual:shared-operation-cleanup'
    `)).rows, [{
      event_type: 'reference_backfill',
      subject_type: 'activity_list',
      payload: {
        source: 'legacy_activity_last_event_reference',
        activity_ids: ['cleanup-operation-a', 'cleanup-operation-b']
      }
    }]);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('legacy event cleanup aborts on field parity conflict without dropping data', async () => {
  const database = await createTestDatabase(BEFORE_CLEANUP);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      INSERT INTO timer_devices (device_id, platform, created_at_utc, last_seen_at_utc)
      VALUES ('conflict-device', 'web', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z');
      INSERT INTO timer_events (
        event_id, device_id, client_sequence, server_sequence, type, occurred_at_utc,
        received_at_utc, status, payload_version, metadata_json
      ) VALUES (
        'timer-conflict', 'conflict-device', 1, 1, 'start',
        '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z', 'accepted', 1, '{}'
      );
      INSERT INTO events (
        id, event_domain, event_id, event_type, event_action, title, subject_type,
        actor_type, actor_id, device_id, client_sequence, server_sequence,
        domain_sequence, status, occurred_at_utc, received_at_utc, payload_version,
        payload_json, created_at_utc
      ) VALUES (
        'timer:timer-conflict', 'timer', 'timer-conflict', 'start', 'timer.start',
        'Wrong title', 'timer', 'user', 'conflict-device', 'conflict-device', 1, 1, 1,
        'accepted', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z', 1,
        '{}', '2026-07-10T12:00:00.000Z'
      );
    `);

    await assert.rejects(pool.query(CLEANUP), /field parity conflict/);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM timer_events')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = 54')).rows[0].count, 0);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('legacy event cleanup uses restricted drops and rolls back when a dependency exists', async () => {
  const database = await createTestDatabase(BEFORE_CLEANUP);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query('CREATE VIEW legacy_timer_dependency AS SELECT event_id FROM timer_events');

    await assert.rejects(pool.query(CLEANUP), /cannot drop table timer_events because other objects depend on it/);
    assert.notEqual((await pool.query(`SELECT to_regclass(format('%I.%I', current_schema(), 'timer_events')) AS name`)).rows[0].name, null);
    assert.notEqual((await pool.query(`SELECT to_regclass(format('%I.%I', current_schema(), 'activity_events')) AS name`)).rows[0].name, null);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = 54')).rows[0].count, 0);
  } finally {
    await pool.end();
    await database.drop();
  }
});
