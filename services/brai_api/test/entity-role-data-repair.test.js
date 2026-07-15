import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const BEFORE_REPAIR = [
  '0001_brai_baseline.sql',
  '0010_agent_role_normalization_workflows.sql',
  '0011_inbox_workflow_reliability.sql',
  '0012_inbox_raw_input_preservation.sql',
  '0013_drop_legacy_event_tables.sql',
  '0015_runtime_settings_timezone_ai_provider.sql',
  '0016_admin_role_workflow_observability.sql',
  '0017_repair_workflow_observability_history.sql'
];
const REPAIR = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../supabase/migrations/0018_entity_role_data_repair.sql'),
  'utf8'
);

test('entity role repair backfills payload links, event links, flags, and stale rows idempotently', async () => {
  const database = await createTestDatabase(BEFORE_REPAIR);
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      SELECT set_config('brai.allow_legacy_operation_import', 'on', true);

      INSERT INTO activities (
        id, activity_type_id, title, description_md, author, reason, status,
        created_at_utc, updated_at_utc
      ) VALUES (
        'operation:repair-test', 'operation', 'Repair operation', 'Missing role link',
        'Codex', 'Regression fixture', 'New',
        '2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z'
      );

      INSERT INTO focus_sessions (id, created_at_utc, updated_at_utc, start_origin)
      VALUES ('focus-repair-test', '2026-07-12T11:00:00.000Z', '2026-07-12T12:00:00.000Z', 'focus');

      INSERT INTO items (id, title, description, author, created_at_utc, updated_at_utc)
      VALUES
        ('inbox-repair-test', 'Inbox repair', '', '', '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:00.000Z'),
        ('stale-focus', 'Focus session', '', '', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.000Z');

      WITH inbox_role AS (
        INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
        VALUES ('inbox-repair-test', 2, '2026-07-12T09:00:00.000Z', 'active', '{}')
        RETURNING id
      )
      INSERT INTO inbox (
        id, title, description_text, source, source_key, created_at_utc, updated_at_utc,
        is_normalized, item_roles_id
      )
      SELECT
        'inbox-repair-test', 'Inbox repair', 'Linked but flag is stale', 'manual', 'repair-test',
        '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:00.000Z', 0, id
      FROM inbox_role;

      INSERT INTO item_roles (items_id, item_role_types_id, active_from_utc, status, metadata_json)
      VALUES ('stale-focus', 3, '2026-07-12T08:00:00.000Z', 'active', '{}');

      INSERT INTO events (
        id, event_domain, event_id, event_type, event_action, title,
        subject_type, subject_id, actor_type, server_sequence, domain_sequence,
        status, occurred_at_utc, received_at_utc, payload_version, payload_json, created_at_utc
      ) VALUES
        (
          'activity:repair-status', 'activity', 'repair-status', 'set_status', 'activity.set_status',
          'Activity set_status', 'activity', 'operation:repair-test', 'user', 1, 1,
          'accepted', '2026-07-12T10:05:00.000Z', '2026-07-12T10:05:00.000Z', 1,
          '{"status":"Done"}', '2026-07-12T10:05:00.000Z'
        ),
        (
          'timer:repair-edit', 'timer', 'repair-edit', 'edit_session', 'timer.edit_session',
          'Timer edit_session', 'focus_session', 'focus-repair-test', 'user', 2, 1,
          'accepted', '2026-07-12T12:05:00.000Z', '2026-07-12T12:05:00.000Z', 1,
          '{"focus_session_id":"focus-repair-test"}', '2026-07-12T12:05:00.000Z'
        ),
        (
          'inbox:repair-update', 'inbox', 'repair-update', 'update_title', 'inbox.update_title',
          'Inbox update_title', 'inbox', 'inbox-repair-test', 'user', 3, 1,
          'accepted', '2026-07-12T09:05:00.000Z', '2026-07-12T09:05:00.000Z', 1,
          '{"title":"Inbox repair"}', '2026-07-12T09:05:00.000Z'
        );
    `);

    await pool.query(REPAIR);
    await pool.query(REPAIR);

    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM activities WHERE item_roles_id IS NULL')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM focus_sessions WHERE item_roles_id IS NULL')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM inbox WHERE item_roles_id IS NOT NULL AND is_normalized = 0')).rows[0].count, 0);
    assert.equal((await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE id IN ('activity:repair-status', 'timer:repair-edit', 'inbox:repair-update')
        AND item_roles_id IS NULL
    `)).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM item_roles WHERE items_id = 'stale-focus'")).rows[0].count, 0);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM items WHERE id = 'stale-focus'")).rows[0].count, 0);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations WHERE version = 58')).rows[0].count, 1);
  } finally {
    await pool.end();
    await database.drop();
  }
});
