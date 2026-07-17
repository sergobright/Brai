import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { createTestDatabase } from '../test-support/api.js';

const TABLES = [
  'brai_chat_attachments',
  'brai_chat_events',
  'brai_chat_messages',
  'brai_chat_threads'
];
const MIGRATION_SQL = fs.readFileSync(path.resolve(
  import.meta.dirname, '../../../supabase/migrations/0034_brai_codex_chat.sql'
), 'utf8');
const IDENTITY_MIGRATION_SQL = fs.readFileSync(path.resolve(
  import.meta.dirname, '../../../supabase/migrations/0036_brai_codex_identity.sql'
), 'utf8');

test('Brai chat migration is idempotent, described, RLS-protected and cascades account data', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(MIGRATION_SQL);
    await pool.query(MIGRATION_SQL);
    await pool.query(IDENTITY_MIGRATION_SQL);
    await pool.query(IDENTITY_MIGRATION_SQL);

    const tables = await pool.query(`
      SELECT c.relname, c.relrowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `, [TABLES]);
    assert.deepEqual(tables.rows.map((row) => row.relname), TABLES);
    assert.equal(tables.rows.every((row) => row.relrowsecurity), true);

    const activeColumns = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'brai_chat_threads'
        AND column_name = ANY($1::text[])
      ORDER BY column_name
    `, [[
      'active_codex_turn_id', 'active_turn_deadline_at_utc', 'active_turn_model',
      'active_turn_reasoning_effort', 'active_turn_started_at_utc', 'active_user_message_id'
    ]]);
    assert.deepEqual(activeColumns.rows.map((row) => row.column_name), [
      'active_codex_turn_id', 'active_turn_deadline_at_utc', 'active_turn_model',
      'active_turn_reasoning_effort', 'active_turn_started_at_utc', 'active_user_message_id'
    ]);

    const dispatchColumn = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'brai_chat_messages'
        AND column_name = 'dispatch_status'
    `);
    assert.equal(dispatchColumn.rows.length, 1);

    const descriptions = await pool.query(`
      SELECT table_name FROM table_descriptions
      WHERE table_name = ANY($1::text[]) ORDER BY table_name
    `, [TABLES]);
    assert.deepEqual(descriptions.rows.map((row) => row.table_name), TABLES);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM schema_migrations WHERE version = 67
    `)).rows[0].count, 1);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM schema_migrations WHERE version = 68
    `)).rows[0].count, 1);
    assert.equal((await pool.query(`
      SELECT count(*)::int AS count FROM schema_migrations WHERE version = 69
    `)).rows[0].count, 1);
    const titleAgent = (await pool.query(`
      SELECT id, version, target, kind, status, llm_provider, llm_model,
        llm_prompt_template, llm_timeout_ms, fallback_description, source_module,
        prompt_version, schema_version, runtime_service, metadata_json
      FROM agents WHERE id = 'brai.chat-title'
    `)).rows[0];
    assert.equal(titleAgent.version, '1');
    assert.equal(titleAgent.target, 'brai_chat_threads');
    assert.equal(titleAgent.kind, 'runtime');
    assert.equal(titleAgent.status, 'active');
    assert.equal(titleAgent.llm_provider, 'codex');
    assert.equal(titleAgent.llm_model, '');
    assert.match(titleAgent.llm_prompt_template, /основном языке диалога пользователя/);
    assert.equal(titleAgent.llm_timeout_ms, 30_000);
    assert.match(titleAgent.fallback_description, /оставляет «Новый чат»/);
    assert.equal(titleAgent.source_module, 'services/brai_codex_broker/src/broker.mjs');
    assert.equal(titleAgent.prompt_version, 'brai-chat-title.v1');
    assert.equal(titleAgent.schema_version, 'brai.chat-title.result.v1');
    assert.equal(titleAgent.runtime_service, 'brai-codex-broker');
    assert.equal(titleAgent.metadata_json.log_schema, 'brai.chat_title.ai_log.v1');
    const chatAgent = (await pool.query(`
      SELECT id, version, target, kind, status, llm_provider, llm_model,
        llm_prompt_template, llm_timeout_ms, fallback_description, source_module,
        prompt_version, schema_version, runtime_service, metadata_json
      FROM agents WHERE id = 'brai-codex'
    `)).rows[0];
    assert.equal(chatAgent.version, '1');
    assert.equal(chatAgent.target, 'brai_chat_threads');
    assert.equal(chatAgent.kind, 'runtime');
    assert.equal(chatAgent.status, 'active');
    assert.equal(chatAgent.llm_provider, 'codex');
    assert.equal(chatAgent.llm_model, 'GPT-5.6-Luna');
    assert.match(chatAgent.llm_prompt_template, /отладочном режиме/);
    assert.match(chatAgent.llm_prompt_template, /статический снимок/);
    assert.equal(chatAgent.llm_timeout_ms, 900_000);
    assert.match(chatAgent.fallback_description, /сохранённая история и черновик не удаляются/);
    assert.equal(chatAgent.source_module, 'services/brai_codex_broker/src/broker.mjs');
    assert.equal(chatAgent.prompt_version, 'brai-codex.identity.v1');
    assert.equal(chatAgent.schema_version, 'brai.chat.agui.v1');
    assert.equal(chatAgent.runtime_service, 'brai-codex-broker');
    assert.equal(chatAgent.metadata_json.log_schema, 'brai.chat.ai_log.v1');
    assert.equal(chatAgent.metadata_json.web_search, 'cached');
    assert.equal(chatAgent.metadata_json.live_search, false);
    assert.equal(chatAgent.metadata_json.arbitrary_network, false);
    await pool.query(`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES ('generated-title-owner', 'Owner', 'generated-title@example.test', true, now(), now());
      INSERT INTO brai_chat_threads (
        id, user_id, title, title_source, created_at_utc, updated_at_utc
      ) VALUES (
        'generated-title-thread', 'generated-title-owner', 'Смысловой заголовок',
        'generated', now()::text, now()::text
      )
    `);
    assert.equal((await pool.query(`
      SELECT title_source FROM brai_chat_threads WHERE id = 'generated-title-thread'
    `)).rows[0].title_source, 'generated');
    await pool.query(`DELETE FROM "user" WHERE id = 'generated-title-owner'`);

    const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND indexname = ANY($1::text[])
      ORDER BY indexname
    `, [[
      'idx_brai_chat_events_search',
      'idx_brai_chat_messages_search',
      'idx_brai_chat_threads_search'
    ]]);
    assert.equal(indexes.rows.length, 3);

    await seedOwnedGraph(pool);
    await assertCrossThreadAnchorsRejected(pool);
    await pool.query(`DELETE FROM "user" WHERE id = 'chat-cascade-owner'`);
    for (const table of TABLES) {
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0);
    }
  } finally {
    await pool.end();
    await database.drop();
  }
});

async function assertCrossThreadAnchorsRejected(pool) {
  await pool.query(`
    INSERT INTO brai_chat_threads (
      id, user_id, title, created_at_utc, updated_at_utc
    ) VALUES ('chat-cascade-thread-2', 'chat-cascade-owner', 'Другой чат', now()::text, now()::text)
  `);
  await assert.rejects(pool.query(`
    INSERT INTO brai_chat_events (
      id, user_id, brai_chat_threads_id, brai_chat_messages_id,
      idempotency_key, sequence, event_type, created_at_utc
    ) VALUES ('cross-thread-event', 'chat-cascade-owner', 'chat-cascade-thread-2',
      'chat-cascade-message', 'cross-event-key', 1, 'message', now()::text)
  `), (error) => error.code === '23503');
  await assert.rejects(pool.query(`
    INSERT INTO brai_chat_attachments (
      id, user_id, brai_chat_threads_id, brai_chat_messages_id, original_name,
      relative_path, verified_media_type, byte_size, checksum_sha256, created_at_utc
    ) VALUES ('cross-thread-attachment', 'chat-cascade-owner', 'chat-cascade-thread-2',
      'chat-cascade-message', 'cross.png', 'Brai/Chat/chat-cascade-thread-2/cross.png',
      'image/png', 8, repeat('b', 64), now()::text)
  `), (error) => error.code === '23503');
}

async function seedOwnedGraph(pool) {
  await pool.query(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES ('chat-cascade-owner', 'Owner', 'chat-cascade@example.test', true, now(), now());
    INSERT INTO brai_chat_threads (
      id, user_id, title, created_at_utc, updated_at_utc
    ) VALUES ('chat-cascade-thread', 'chat-cascade-owner', 'Чат', now()::text, now()::text);
    INSERT INTO brai_chat_messages (
      id, user_id, brai_chat_threads_id, idempotency_key, role, content,
      status, sequence, created_at_utc, updated_at_utc
    ) VALUES ('chat-cascade-message', 'chat-cascade-owner', 'chat-cascade-thread',
      'message-key', 'user', 'hello', 'completed', 1, now()::text, now()::text);
    INSERT INTO brai_chat_events (
      id, user_id, brai_chat_threads_id, brai_chat_messages_id,
      idempotency_key, sequence, event_type, created_at_utc
    ) VALUES ('chat-cascade-event', 'chat-cascade-owner', 'chat-cascade-thread',
      'chat-cascade-message', 'event-key', 1, 'message', now()::text);
    INSERT INTO brai_chat_attachments (
      id, user_id, brai_chat_threads_id, brai_chat_messages_id, original_name,
      relative_path, verified_media_type, byte_size, checksum_sha256, created_at_utc
    ) VALUES ('chat-cascade-attachment', 'chat-cascade-owner', 'chat-cascade-thread',
      'chat-cascade-message', 'image.png', 'Brai/Chat/chat-cascade-thread/image.png',
      'image/png', 8, repeat('a', 64), now()::text);
  `);
}
