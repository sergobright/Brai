import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const MIGRATION = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../supabase/migrations/0031_agent_operations_inbox_guard.sql'),
  'utf8'
);

test('agent operation migration blocks only new legacy Activity writes', async () => {
  const databaseUrl = process.env.BRAI_TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('BRAI_TEST_DATABASE_URL is required for API tests');

  const schema = `brai_agent_operation_guard_${process.pid}_${Date.now()}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`);
    await client.query(`
      CREATE TABLE activities (
        id text PRIMARY KEY,
        activity_type_id text NOT NULL,
        author text NOT NULL,
        status text NOT NULL,
        deleted_at_utc text
      );
      CREATE TABLE table_descriptions (
        table_name text PRIMARY KEY,
        title text NOT NULL,
        short_description text NOT NULL,
        long_description text NOT NULL,
        updated_at_utc text NOT NULL
      );
      CREATE TABLE schema_migrations (
        version integer PRIMARY KEY,
        applied_at_utc text NOT NULL,
        description text NOT NULL
      );
    `);

    await client.query(MIGRATION);
    await client.query(MIGRATION);

    await client.query(`INSERT INTO activities VALUES ('action:user:one', 'action', 'User', 'New', NULL)`);
    await client.query(`INSERT INTO activities VALUES ('goal:user:one', 'goal', 'User', 'New', NULL)`);
    await client.query(`INSERT INTO activities VALUES ('operation:product:one', 'operation', 'Product', 'New', NULL)`);

    await expectRejected(client, `INSERT INTO activities VALUES ('operation:legacy:codex', 'operation', 'Codex', 'New', NULL)`);
    await expectRejected(client, `INSERT INTO activities VALUES ('operation:agent-task:any-author', 'operation', 'System', 'New', NULL)`);

    await client.query(`SELECT set_config('brai.allow_legacy_operation_import', 'on', true)`);
    await client.query(`INSERT INTO activities VALUES ('operation:agent-task:historical', 'operation', 'Codex', 'New', NULL)`);
    await client.query(`SELECT set_config('brai.allow_legacy_operation_import', 'off', true)`);
    await client.query(`
      UPDATE activities
      SET status = 'Done', deleted_at_utc = '2026-07-15T00:00:00.000Z'
      WHERE id = 'operation:agent-task:historical'
    `);

    assert.deepEqual((await client.query(`
      SELECT status, deleted_at_utc
      FROM activities
      WHERE id = 'operation:agent-task:historical'
    `)).rows, [{ status: 'Done', deleted_at_utc: '2026-07-15T00:00:00.000Z' }]);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM schema_migrations WHERE version = 67`)).rows[0].count, 1);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

async function expectRejected(client, sql) {
  await client.query('SAVEPOINT rejected_agent_operation');
  await assert.rejects(client.query(sql), /agent_operations_belong_to_inbox/);
  await client.query('ROLLBACK TO SAVEPOINT rejected_agent_operation');
  await client.query('RELEASE SAVEPOINT rejected_agent_operation');
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
