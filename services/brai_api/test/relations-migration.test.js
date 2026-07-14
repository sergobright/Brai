import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const migrationPath = path.resolve(
  import.meta.dirname,
  '../../../supabase/migrations/0027_relations_goal_catalog.sql'
);

test('Relations migration is additive, idempotent, and seeds only the v1 contracts', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(fs.readFileSync(migrationPath, 'utf8'));

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN ('relation_types', 'relation_type_endpoint_rules', 'relations')
      ORDER BY table_name
    `);
    assert.deepEqual(tables.rows.map((row) => row.table_name).sort(), [
      'relation_type_endpoint_rules',
      'relation_types',
      'relations'
    ]);

    const activityTypes = await pool.query('SELECT id FROM activity_types ORDER BY id');
    assert.deepEqual(activityTypes.rows.map((row) => row.id), ['action', 'goal', 'operation']);
    const roleTypes = await pool.query('SELECT title_system FROM item_role_types ORDER BY title_system');
    assert.deepEqual(roleTypes.rows.map((row) => row.title_system), ['activity', 'focus_session', 'inbox']);

    const relationType = await pool.query(`
      SELECT id, user_id, key, directionality, is_ordered, status, is_system
      FROM relation_types WHERE id = 'part_of'
    `);
    assert.deepEqual(relationType.rows[0], {
      id: 'part_of',
      user_id: null,
      key: 'part_of',
      directionality: 'directed',
      is_ordered: 1,
      status: 'active',
      is_system: 1
    });
    const rules = await pool.query(`
      SELECT source_role_key, source_type_key, target_role_key, target_type_key
      FROM relation_type_endpoint_rules
      WHERE relation_types_id = 'part_of'
      ORDER BY source_role_key
    `);
    assert.deepEqual(rules.rows, [
      {
        source_role_key: 'activity',
        source_type_key: 'action',
        target_role_key: 'activity',
        target_type_key: 'goal'
      },
      {
        source_role_key: 'inbox',
        source_type_key: 'operation',
        target_role_key: 'activity',
        target_type_key: 'goal'
      }
    ]);

    const eventConstraint = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'events'::regclass AND conname = 'events_event_domain_check'
    `);
    assert.match(eventConstraint.rows[0].definition, /relation/);
    assert.equal(
      (await pool.query("SELECT last_value FROM sequence_counters WHERE name = 'events.domain_sequence.relation'"))
        .rows[0].last_value,
      0
    );

    const rls = await pool.query(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('relation_types', 'relation_type_endpoint_rules', 'relations')
      ORDER BY relname
    `);
    assert.equal(rls.rows.every((row) => row.relrowsecurity), true);
    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'relations'
    `);
    assert.equal(indexes.rows.some((row) => row.indexname === 'idx_relations_one_active_edge'), true);
    assert.equal(indexes.rows.some((row) => row.indexname === 'idx_relations_target_position'), true);

    const relationColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'relations'
        AND column_name = 'ended_operation_id'
    `);
    assert.equal(relationColumns.rowCount, 1);
    const rawQueueIndex = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'activities'
        AND indexname = 'idx_activities_raw_queue'
    `);
    assert.match(rawQueueIndex.rows[0].indexdef, /goal/);

    const activityContract = await pool.query(`
      SELECT lifecycle_json::text AS lifecycle_json
      FROM role_contracts WHERE id = 'activity'
    `);
    assert.match(activityContract.rows[0].lifecycle_json, /goal/);
    const normalizer = await pool.query(`
      SELECT summary, input_description, llm_prompt_template
      FROM agents WHERE id = 'activity.normalizer'
    `);
    assert.match(normalizer.rows[0].summary, /goal/);
    assert.match(normalizer.rows[0].input_description, /goal/);
    assert.match(normalizer.rows[0].llm_prompt_template, /новые Operations принадлежат Inbox/);

    const metadata = await pool.query(`
      SELECT table_name FROM table_descriptions
      WHERE table_name IN ('relation_types', 'relation_type_endpoint_rules', 'relations')
      ORDER BY table_name
    `);
    assert.deepEqual(metadata.rows.map((row) => row.table_name).sort(), [
      'relation_type_endpoint_rules',
      'relation_types',
      'relations'
    ]);
    const activityDescription = await pool.query(`
      SELECT long_description FROM table_descriptions WHERE table_name = 'activities'
    `);
    assert.match(activityDescription.rows[0].long_description, /Raw Activity action\/goal/);
    assert.match(activityDescription.rows[0].long_description, /новые Operations принадлежат Inbox/);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM relations')).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE version = 63')).rows[0].count, 1);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('Relations schema rejects inconsistent ownership and temporal rows', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await assert.rejects(
      pool.query(`
        INSERT INTO relation_types (
          id, user_id, key, title, directionality, source_label, target_label,
          is_ordered, status, is_system, created_by_actor_type, created_at_utc, updated_at_utc
        ) VALUES ('bad-system', 'owner', 'bad', 'Bad', 'symmetric', '', '', 0, 'active', 1, 'system', now()::text, now()::text)
      `),
      /relation_types_check/
    );

    await pool.query(`
      INSERT INTO items (id, user_id, title, created_at_utc, updated_at_utc)
      VALUES
        ('same-item', 'owner', 'Same', now()::text, now()::text),
        ('other-item', 'owner', 'Other', now()::text, now()::text)
    `);
    await assert.rejects(
      pool.query(`
        INSERT INTO relations (
          id, user_id, relation_types_id, source_items_id, target_items_id,
          status, active_from_utc, operation_id, created_by_actor_type,
          metadata_json, created_at_utc, updated_at_utc
        ) VALUES (
          'same-edge', 'owner', 'part_of', 'same-item', 'same-item', 'active',
          now()::text, 'operation:same', 'user', '{}', now()::text, now()::text
        )
      `),
      /relations_check/
    );
    await assert.rejects(
      pool.query(`
        INSERT INTO relations (
          id, user_id, relation_types_id, source_items_id, target_items_id,
          status, active_from_utc, active_to_utc, operation_id,
          created_by_actor_type, metadata_json, created_at_utc, updated_at_utc
        ) VALUES (
          'broken-end', 'owner', 'part_of', 'same-item', 'other-item', 'ended',
          now()::text, now()::text, 'operation:end', 'user', '{}', now()::text, now()::text
        )
      `),
      /relations_check/
    );
  } finally {
    await pool.end();
    await database.drop();
  }
});
