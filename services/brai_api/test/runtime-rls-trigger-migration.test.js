import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

const LEGACY_MIGRATION = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../supabase/migrations/0005_runtime_schema_rls.sql'),
  'utf8'
);
const STABLE_MIGRATION = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../supabase/migrations/0014_stable_runtime_rls_trigger.sql'),
  'utf8'
);

test('RLS event trigger survives disposable preview schema cleanup', async () => {
  const databaseUrl = process.env.BRAI_TEST_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('BRAI_TEST_DATABASE_URL is required for API tests');

  const suffix = `${process.pid}_${Date.now()}`;
  const previewSchema = `brai_preview_rls_${suffix}`;
  const nextPreviewSchema = `brai_preview_rls_next_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${quoteIdent(previewSchema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdent(previewSchema)}`);
    await client.query(`
      CREATE TABLE schema_migrations (
        version integer PRIMARY KEY,
        applied_at_utc text NOT NULL,
        description text NOT NULL
      )
    `);
    await client.query(LEGACY_MIGRATION);
    await client.query(STABLE_MIGRATION);
    await client.query(`DROP SCHEMA ${quoteIdent(previewSchema)} CASCADE`);

    assert.deepEqual((await client.query(`
      SELECT n.nspname AS function_schema, e.evtenabled
      FROM pg_event_trigger AS e
      JOIN pg_proc AS p ON p.oid = e.evtfoid
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE e.evtname = 'brai_enable_rls_for_new_public_tables'
    `)).rows, [{ function_schema: 'public', evtenabled: 'O' }]);

    await client.query(`CREATE SCHEMA ${quoteIdent(nextPreviewSchema)}`);
    await client.query(`CREATE TABLE ${quoteIdent(nextPreviewSchema)}.protected_after_cleanup (id bigint)`);
    assert.equal((await client.query(`
      SELECT c.relrowsecurity
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'protected_after_cleanup'
    `, [nextPreviewSchema])).rows[0].relrowsecurity, true);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
