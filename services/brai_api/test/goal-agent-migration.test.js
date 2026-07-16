import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const AGENTS = [
  'activity.classifier', 'goal.discovery', 'goal.item-matcher',
  'goal.member-finder', 'goal.planner'
];

test('0025 registers five isolated agent/workflow contracts and remains idempotent', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    const agents = (await pool.query(`
      SELECT id, prompt_version, schema_version, task_queue_base, runtime_service,
        source_module, metadata_json
      FROM agents WHERE id = ANY($1::text[]) ORDER BY id
    `, [AGENTS])).rows;
    assert.deepEqual(agents.map((row) => row.id), AGENTS);
    for (const agent of agents) {
      assert.ok(agent.prompt_version);
      assert.ok(agent.schema_version);
      assert.match(agent.task_queue_base, /^brai-agent-/);
      assert.match(agent.runtime_service, /^brai-agent-/);
      assert.match(agent.source_module, new RegExp(`${agent.id.replace('.', '\\.')}\\.json$`));
      assert.equal(typeof agent.metadata_json, 'object');
    }

    const definitions = (await pool.query(`
      SELECT id, task_queue, input_schema_version, output_schema_version,
        input_schema_json, output_schema_json, process_json, diagram_mermaid
      FROM workflow_definitions WHERE id = ANY($1::text[]) ORDER BY id
    `, [AGENTS])).rows;
    assert.deepEqual(definitions.map((row) => row.id), AGENTS);
    for (const definition of definitions) {
      assert.match(definition.task_queue, /^brai-agent-.+-\{environment\}$/);
      assert.ok(definition.input_schema_version);
      assert.ok(definition.output_schema_version);
      assert.ok(json(definition.input_schema_json).required.includes('agent_id'));
      assert.equal(json(definition.process_json).agent_id, definition.id);
      assert.match(definition.diagram_mermaid, /^flowchart LR/);
    }
    assert.equal(new Set(definitions.map((row) => row.diagram_mermaid)).size, 5);

    const versionColumns = (await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'workflow_definitions'
        AND column_name IN ('definition_contract_json','definition_contract_hash',
          'worker_deployment_name_base','worker_build_id','frozen_at_utc')
      ORDER BY column_name
    `)).rows.map((row) => row.column_name);
    assert.deepEqual(versionColumns, [
      'definition_contract_hash', 'definition_contract_json', 'frozen_at_utc',
      'worker_build_id', 'worker_deployment_name_base'
    ]);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'context_discovery_watermarks'
        AND column_name = 'active_range_first_change_at_utc'
    `)).rows[0].count, 1);

    const schema = (await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND (
        (table_name = 'workflow_executions'
          AND column_name IN ('context_capability_hash','deployment_environment','input_json','result_json'))
        OR (table_name = 'ai_logs' AND column_name = 'llm_call_id')
      ) ORDER BY column_name
    `)).rows.map((row) => row.column_name);
    assert.deepEqual(schema, [
      'context_capability_hash', 'deployment_environment', 'input_json', 'llm_call_id', 'result_json'
    ]);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_constraint
      WHERE conname = 'workflow_executions_context_capability_hash_check'
        AND connamespace = current_schema()::regnamespace
    `)).rows[0].count, 1);
    const unique = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = 'idx_ai_logs_llm_call_id'
    `);
    assert.equal(unique.rowCount, 1);
    assert.match(unique.rows[0].indexdef, /UNIQUE/);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM schema_migrations WHERE version = 65
    `)).rows[0].count, 1);
    const descriptions = (await pool.query(`
      SELECT table_name FROM table_descriptions
      WHERE table_name IN ('agents','workflow_executions','ai_logs') ORDER BY table_name
    `)).rows.map((row) => row.table_name);
    assert.deepEqual(descriptions, ['agents', 'ai_logs', 'workflow_executions']);

    const migration = fs.readFileSync(path.resolve(
      import.meta.dirname, '../../../supabase/migrations/0029_goal_agent_workflows.sql'
    ), 'utf8');
    await pool.query(migration);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM agents WHERE id = ANY($1::text[])
    `, [AGENTS])).rows[0].count, 5);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM workflow_definitions WHERE id = ANY($1::text[])
    `, [AGENTS])).rows[0].count, 5);
  } finally {
    await pool.end();
    await database.drop();
  }
});

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}
