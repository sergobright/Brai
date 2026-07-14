import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createFixture, createTestDatabase } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const NOW = '2026-07-13T14:00:00.000Z';

test('user AI migration backfills colliding flow ids by agent domain', async () => {
  const database = await createTestDatabase();
  const pool = new Pool({ connectionString: database.url });
  try {
    await pool.query(`
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES
        ('migration-inbox-owner', 'Inbox owner', 'migration-inbox@example.test', true, '${NOW}', '${NOW}'),
        ('migration-activity-owner', 'Activity owner', 'migration-activity@example.test', true, '${NOW}', '${NOW}');

      INSERT INTO inbox (id, title, created_at_utc, updated_at_utc, user_id)
      VALUES ('shared-domain-flow', 'Inbox', '${NOW}', '${NOW}', 'migration-inbox-owner');

      INSERT INTO activities (
        id, activity_type_id, title, status, created_at_utc, updated_at_utc, user_id
      ) VALUES (
        'shared-domain-flow', 'action', 'Activity', 'New', '${NOW}', '${NOW}', 'migration-activity-owner'
      );

      INSERT INTO ai_logs (
        agent_id, agent_version, dt, status, json_data, ai_title, flow_id, flow_command
      ) VALUES
        ('inbox.normalizer', '6', '${NOW}', 'done', '{}', 'Inbox log', 'shared-domain-flow', 'normalize'),
        ('activity.normalizer', '2', '${NOW}', 'done', '{}', 'Activity log', 'shared-domain-flow', 'normalize');
    `);

    const migration = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../supabase/migrations/0026_user_ai_provider_credentials.sql'),
      'utf8'
    );
    await pool.query(migration);

    assert.deepEqual((await pool.query(`
      SELECT agent_id, user_id
      FROM ai_logs
      WHERE flow_id = 'shared-domain-flow'
      ORDER BY agent_id
    `)).rows, [
      { agent_id: 'activity.normalizer', user_id: 'migration-activity-owner' },
      { agent_id: 'inbox.normalizer', user_id: 'migration-inbox-owner' }
    ]);
  } finally {
    await pool.end();
    await database.drop();
  }
});

test('ai logs are written and listed only in their user scope', async () => {
  const fixture = await createFixture([NOW]);
  try {
    seedUser(fixture, 'ai-owner-a');
    seedUser(fixture, 'ai-owner-b');

    withUserScope('ai-owner-a', () => fixture.store.recordAiLog(aiLog('flow-a', 'Owner A')));
    withUserScope('ai-owner-b', () => fixture.store.recordAiLog(aiLog('flow-b', 'Owner B')));

    assert.deepEqual(
      fixture.store.db.prepare('SELECT flow_id, user_id FROM ai_logs ORDER BY flow_id').all(),
      [
        { flow_id: 'flow-a', user_id: 'ai-owner-a' },
        { flow_id: 'flow-b', user_id: 'ai-owner-b' }
      ]
    );
    assert.deepEqual(
      withUserScope('ai-owner-a', () => fixture.store.listAiLogs()).map((row) => row.flow_id),
      ['flow-a']
    );
    assert.deepEqual(
      withUserScope('ai-owner-b', () => fixture.store.listAiLogs()).map((row) => row.flow_id),
      ['flow-b']
    );
  } finally {
    await fixture.close();
  }
});

test('credential responses omit plaintext and audit logs omit plaintext and key hints', async () => {
  const fixture = await createFixture([NOW]);
  const apiKey = 'sk-user-audit-secret-7391';
  const replacementKey = 'sk-user-replacement-secret-8426';
  try {
    seedUser(fixture, 'credential-owner');

    const saved = withUserScope('credential-owner', () => fixture.store.putUserProviderCredential({
      providerId: 'openai',
      apiKey,
      verifiedAt: NOW,
      nowIso: NOW
    }));

    assert.equal(Object.hasOwn(saved, 'api_key'), false);
    assert.equal(JSON.stringify(saved).includes(apiKey), false);
    assert.equal(saved.key_hint, '7391');

    withUserScope('credential-owner', () => {
      fixture.store.putUserProviderCredential({
        providerId: 'openai',
        apiKey: replacementKey,
        verifiedAt: NOW,
        nowIso: NOW
      });
      fixture.store.deleteUserProviderCredential('openai', NOW);
    });

    const auditRows = fixture.store.db.prepare(`
      SELECT operation, message, json_data
      FROM logs
      WHERE operation LIKE 'user_ai.provider_%'
      ORDER BY id
    `).all();
    assert.deepEqual(auditRows.map((row) => row.operation), [
      'user_ai.provider_add',
      'user_ai.provider_replace',
      'user_ai.provider_delete'
    ]);
    assert.equal(JSON.stringify(auditRows).includes(apiKey), false);
    assert.equal(JSON.stringify(auditRows).includes(replacementKey), false);
    assert.equal(JSON.stringify(auditRows).includes('7391'), false);
    assert.equal(JSON.stringify(auditRows).includes('8426'), false);
    assert.deepEqual(auditRows.map((row) => JSON.parse(row.json_data)), [
      { provider_id: 'openai' },
      { provider_id: 'openai' },
      { provider_id: 'openai' }
    ]);
  } finally {
    await fixture.close();
  }
});

test('optional audit logging failures do not break credential mutations', async () => {
  const fixture = await createFixture([NOW]);
  const originalRecordLog = fixture.store.recordLog;
  try {
    seedUser(fixture, 'mutation-owner');
    fixture.store.recordLog = () => {
      throw new Error('audit unavailable');
    };

    withUserScope('mutation-owner', () => {
      fixture.store.putUserProviderCredential({
        providerId: 'groq',
        apiKey: 'gsk-initial-secret-1111',
        verifiedAt: NOW,
        nowIso: NOW
      });
      fixture.store.putUserProviderCredential({
        providerId: 'groq',
        apiKey: 'gsk-replacement-secret-2222',
        verifiedAt: NOW,
        nowIso: NOW
      });
      fixture.store.setUserAiSettings({
        model_provider_mode: 'external',
        text: { provider_id: 'groq', model: 'text-model' },
        vision: { provider_id: 'groq', model: 'vision-model' }
      }, NOW);
      fixture.store.setUserAiSettings({ model_provider_mode: 'internal' }, NOW);
      fixture.store.deleteUserProviderCredential('groq', NOW);
    });

    assert.equal(fixture.store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM user_provider_credentials
      WHERE user_id = 'mutation-owner'
    `).get().count, 0);
    assert.equal(withUserScope('mutation-owner', () => fixture.store.userAiSettings()).model_provider_mode, 'internal');
  } finally {
    fixture.store.recordLog = originalRecordLog;
    await fixture.close();
  }
});

function aiLog(flowId, title) {
  return {
    agentId: 'inbox.normalizer',
    agentVersion: '6',
    dt: NOW,
    status: 'done',
    aiTitle: title,
    flowId,
    flowCommand: 'normalize',
    jsonData: { mode: 'external', provider: 'openai', model: 'test-model' }
  };
}

function seedUser(fixture, id) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (?, ?, ?, true, ?, ?)
  `).run(id, id, `${id}@example.test`, NOW, NOW);
}
