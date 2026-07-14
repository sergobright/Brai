import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const CONTEXT_TABLES = [
  'context_audit_batches',
  'context_audit_items',
  'context_decisions',
  'context_discovery_watermarks',
  'context_notifications',
  'context_operations',
  'context_policies',
  'context_policy_labels'
];
const CONTEXT_MIGRATION_SQL = fs.readFileSync(path.resolve(
  import.meta.dirname, '../../../supabase/migrations/0028_context_decision_calibration.sql'
), 'utf8');

test('context migration installs documented RLS-protected calibration schema', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    const tables = await pool.query(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `, [CONTEXT_TABLES]);
    assert.deepEqual(tables.rows.map((row) => row.relname), CONTEXT_TABLES);
    assert.equal(tables.rows.every((row) => row.relrowsecurity), true);

    const descriptions = await pool.query(`
      SELECT table_name FROM table_descriptions
      WHERE table_name = ANY($1::text[]) ORDER BY table_name
    `, [CONTEXT_TABLES]);
    assert.deepEqual(descriptions.rows.map((row) => row.table_name), CONTEXT_TABLES);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS count FROM schema_migrations WHERE version = 64')).rows[0].count,
      1
    );
    await assertOwnerScopedOperationConstraints(pool);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('context migration upgrades and idempotently preserves owner-scoped operation keys', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      ALTER TABLE context_decisions
        DROP CONSTRAINT context_decisions_resulting_owner_operation_fkey,
        DROP CONSTRAINT context_decisions_compensation_owner_operation_fkey;
      ALTER TABLE context_operations
        DROP CONSTRAINT context_operations_original_owner_operation_fkey,
        DROP CONSTRAINT context_operations_pkey;
      ALTER TABLE context_operations
        ADD CONSTRAINT context_operations_pkey PRIMARY KEY (id),
        ADD CONSTRAINT context_operations_user_id_id_key UNIQUE (user_id, id),
        ADD CONSTRAINT context_operations_original_operation_id_fkey
          FOREIGN KEY (original_operation_id) REFERENCES context_operations(id);
      ALTER TABLE context_decisions
        ADD CONSTRAINT context_decisions_resulting_operation_id_fkey
          FOREIGN KEY (resulting_operation_id) REFERENCES context_operations(id),
        ADD CONSTRAINT context_decisions_compensation_operation_id_fkey
          FOREIGN KEY (compensation_operation_id) REFERENCES context_operations(id);
    `);

    await pool.query(CONTEXT_MIGRATION_SQL);
    await pool.query(CONTEXT_MIGRATION_SQL);
    await assertOwnerScopedOperationConstraints(pool);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('context migration replaces global Relation provenance and preserves only owner-valid links', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await seedRelationProvenance(pool);
    await pool.query(`
      ALTER TABLE relations DROP CONSTRAINT relations_origin_decision_id_fkey;
      ALTER TABLE relations ADD CONSTRAINT relations_origin_decision_id_fkey
        FOREIGN KEY (origin_decision_id) REFERENCES context_decisions(id)
        DEFERRABLE INITIALLY DEFERRED;
      INSERT INTO relations (
        id, user_id, relation_types_id, source_items_id, target_items_id, status,
        active_from_utc, operation_id, origin_decision_id, created_by_actor_type,
        metadata_json, created_at_utc, updated_at_utc
      ) VALUES
        ('provenance-valid', 'provenance-owner-a', 'part_of', 'provenance-a-source',
          'provenance-a-target', 'active', now()::text, 'valid-operation',
          'provenance-decision-a', 'agent', '{}', now()::text, now()::text),
        ('provenance-cross-owner', 'provenance-owner-b', 'part_of', 'provenance-b-source',
          'provenance-b-target', 'active', now()::text, 'cross-operation',
          'provenance-decision-a', 'agent', '{}', now()::text, now()::text);
    `);

    await pool.query(CONTEXT_MIGRATION_SQL);
    await pool.query(CONTEXT_MIGRATION_SQL);
    await assertOwnerScopedOperationConstraints(pool);
    assert.deepEqual((await pool.query(`
      SELECT id, origin_decision_id FROM relations
      WHERE id IN ('provenance-valid', 'provenance-cross-owner') ORDER BY id
    `)).rows, [
      { id: 'provenance-cross-owner', origin_decision_id: null },
      { id: 'provenance-valid', origin_decision_id: 'provenance-decision-a' }
    ]);
    await assert.rejects(pool.query(`
      INSERT INTO relations (
        id, user_id, relation_types_id, source_items_id, target_items_id, status,
        active_from_utc, operation_id, origin_decision_id, created_by_actor_type,
        metadata_json, created_at_utc, updated_at_utc
      ) VALUES ('provenance-rejected', 'provenance-owner-b', 'part_of',
        'provenance-b-source-2', 'provenance-b-target-2', 'active', now()::text,
        'rejected-operation', 'provenance-decision-a', 'agent', '{}', now()::text, now()::text)
    `), /relations_origin_decision_id_fkey/);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('workflow execution ledger accepts typed subjects without fake raw records', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    const definition = (await pool.query(`
      SELECT id, version FROM workflow_definitions ORDER BY updated_at_utc DESC LIMIT 1
    `)).rows[0];
    const inserted = await pool.query(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id,
        role_contract_id, raw_record_id, subject_kind, subject_id, trigger_kind,
        watermark_from, watermark_to, status, current_step, created_at_utc,
        updated_at_utc, user_id
      ) VALUES ($1, $2, 'goal-discovery:test', NULL, NULL, 'user', 'user-1',
        'relevant_changes', 10, 15, 'queued', 'dispatch', now()::text, now()::text, 'user-1')
      RETURNING subject_kind, subject_id, raw_record_id, watermark_from, watermark_to
    `, [definition.id, definition.version]);
    assert.deepEqual(inserted.rows[0], {
      subject_kind: 'user',
      subject_id: 'user-1',
      raw_record_id: null,
      watermark_from: '10',
      watermark_to: '15'
    });

    await assert.rejects(pool.query(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id,
        role_contract_id, raw_record_id, status, current_step, created_at_utc, updated_at_utc
      ) VALUES ($1, $2, 'invalid:no-subject', NULL, NULL, 'queued', 'dispatch', now()::text, now()::text)
    `, [definition.id, definition.version]), /workflow_executions_subject_contract_check/);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('policy state and exact execution contract are enforced by Postgres', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    const agentId = (await pool.query('SELECT id FROM agents ORDER BY id LIMIT 1')).rows[0].id;
    const base = [
      'policy-1', 'user-1', agentId, '1', 'prompt-1', 'model-1', 'schema-1',
      'relation_add', 'shadow', null
    ];
    await pool.query(`
      INSERT INTO context_policies (
        id, user_id, agent_id, agent_version, prompt_version, model,
        schema_version, decision_kind, state, active_threshold,
        created_at_utc, updated_at_utc
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()::text,now()::text)
    `, base);
    await assert.rejects(pool.query(`
      INSERT INTO context_policies (
        id, user_id, agent_id, agent_version, prompt_version, model,
        schema_version, decision_kind, state, created_at_utc, updated_at_utc
      ) VALUES ('bad-active','user-2',$1,'1','p','m','s','relation_add','active',now()::text,now()::text)
    `, [agentId]), /context_policies_check/);
    await assert.rejects(pool.query(`
      INSERT INTO context_policies (
        id, user_id, agent_id, agent_version, prompt_version, model,
        schema_version, decision_kind, state, created_at_utc, updated_at_utc
      ) VALUES ('duplicate-key','user-1',$1,'1','prompt-1','model-1','schema-1','relation_add','shadow',now()::text,now()::text)
    `, [agentId]), /context_policies_user_id_agent_id_agent_version_prompt_vers_key/);
  } finally {
    await pool.end();
    await database.drop();
  }
});

async function assertOwnerScopedOperationConstraints(pool) {
  const result = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = ANY($1::text[])
      AND conrelid IN ('context_operations'::regclass, 'context_decisions'::regclass, 'relations'::regclass)
    ORDER BY conname
  `, [[
    'context_operations_pkey',
    'context_operations_original_owner_operation_fkey',
    'context_decisions_resulting_owner_operation_fkey',
    'context_decisions_compensation_owner_operation_fkey',
    'context_decisions_user_id_id_key',
    'relations_origin_decision_id_fkey'
  ]]);
  const constraints = Object.fromEntries(result.rows.map((row) => [row.conname, row.definition]));
  assert.equal(constraints.context_operations_pkey, 'PRIMARY KEY (user_id, id)');
  assert.match(
    constraints.context_operations_original_owner_operation_fkey ?? '',
    /^FOREIGN KEY \(user_id, original_operation_id\) REFERENCES context_operations\(user_id, id\)/
  );
  assert.match(
    constraints.context_decisions_resulting_owner_operation_fkey ?? '',
    /^FOREIGN KEY \(user_id, resulting_operation_id\) REFERENCES context_operations\(user_id, id\)/
  );
  assert.match(
    constraints.context_decisions_compensation_owner_operation_fkey ?? '',
    /^FOREIGN KEY \(user_id, compensation_operation_id\) REFERENCES context_operations\(user_id, id\)/
  );
  assert.equal(constraints.context_decisions_user_id_id_key, 'UNIQUE (user_id, id)');
  assert.match(
    constraints.relations_origin_decision_id_fkey ?? '',
    /^FOREIGN KEY \(user_id, origin_decision_id\) REFERENCES context_decisions\(user_id, id\) DEFERRABLE INITIALLY DEFERRED$/
  );
}

async function seedRelationProvenance(pool) {
  const agent = (await pool.query("SELECT * FROM agents WHERE id = 'goal.item-matcher'")).rows[0];
  await pool.query(`
    INSERT INTO context_policies (
      id, user_id, agent_id, agent_version, prompt_version, model, schema_version,
      decision_kind, state, created_at_utc, updated_at_utc
    ) VALUES
      ('provenance-policy-a', 'provenance-owner-a', $1, $2, $3, 'test-model', $4,
        'relation_add', 'shadow', now()::text, now()::text),
      ('provenance-policy-b', 'provenance-owner-b', $1, $2, $3, 'test-model', $4,
        'relation_add', 'shadow', now()::text, now()::text);
  `, [agent.id, agent.version, agent.prompt_version, agent.schema_version]);
  await pool.query(`
    INSERT INTO context_decisions (
      id, user_id, policies_id, agent_id, agent_version, prompt_version, model,
      schema_version, decision_kind, proposal_hash, confidence, rationale,
      evidence_json, proposal_json, evaluated_policy_state, status, created_at_utc, updated_at_utc
    ) VALUES
      ('provenance-decision-a', 'provenance-owner-a', 'provenance-policy-a', $1, $2, $3,
        'test-model', $4, 'relation_add', 'hash-a', 0.8, '', '[]', '{}', 'shadow',
        'pending', now()::text, now()::text),
      ('provenance-decision-b', 'provenance-owner-b', 'provenance-policy-b', $1, $2, $3,
        'test-model', $4, 'relation_add', 'hash-b', 0.8, '', '[]', '{}', 'shadow',
        'pending', now()::text, now()::text);
  `, [agent.id, agent.version, agent.prompt_version, agent.schema_version]);
  await pool.query(`
    INSERT INTO items (id, user_id, title, created_at_utc, updated_at_utc) VALUES
      ('provenance-a-source', 'provenance-owner-a', 'A source', now()::text, now()::text),
      ('provenance-a-target', 'provenance-owner-a', 'A target', now()::text, now()::text),
      ('provenance-b-source', 'provenance-owner-b', 'B source', now()::text, now()::text),
      ('provenance-b-target', 'provenance-owner-b', 'B target', now()::text, now()::text),
      ('provenance-b-source-2', 'provenance-owner-b', 'B source 2', now()::text, now()::text),
      ('provenance-b-target-2', 'provenance-owner-b', 'B target 2', now()::text, now()::text);
  `);
}
