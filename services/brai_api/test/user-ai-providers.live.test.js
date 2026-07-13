import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processActivityItem } from '../src/activity-normalization.js';
import { processInboxItem, receiveInbox } from '../src/inbox.js';
import { withUserScope } from '../src/user-scope.js';
import { actionEvent, createFixture, request } from '../test-support/api.js';

const LIVE = process.env.BRAI_LIVE_USER_AI_TEST === '1';
const OPENAI_KEY = process.env.BRAI_TEST_USER_OPENAI_API_KEY
  ?? process.env.BRAI_AIRWHISPER_OPENAI_API_KEY
  ?? process.env.OPENAI_API_KEY;
const GROQ_KEY = process.env.BRAI_TEST_USER_GROQ_API_KEY
  ?? process.env.BRAI_AIRWHISPER_GROQ_API_KEY
  ?? process.env.GROQ_API_KEY;
const OPENAI_VISION_MODEL = process.env.BRAI_TEST_USER_OPENAI_VISION_MODEL ?? 'gpt-4o-mini';
const GROQ_TEXT_MODEL = process.env.BRAI_TEST_USER_GROQ_TEXT_MODEL ?? 'openai/gpt-oss-20b';
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test('server test keys work through account storage and real provider capability probes', {
  skip: LIVE ? false : 'set BRAI_LIVE_USER_AI_TEST=1 to call real providers'
}, async () => {
  assert.ok(OPENAI_KEY, 'OpenAI server test key is required');
  assert.ok(GROQ_KEY, 'Groq server test key is required');
  const fixture = await createFixture(Array(20).fill('2026-07-13T16:00:00.000Z'));
  try {
    seedUser(fixture, 'live-provider-user');
    for (const [provider, apiKey] of [['openai', OPENAI_KEY], ['groq', GROQ_KEY]]) {
      const saved = await request(fixture.url, `/v1/ai/providers/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ api_key: apiKey })
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.provider.provider_id, provider);
      assert.equal(JSON.stringify(saved.body).includes(apiKey), false);
    }

    const groqModels = await request(fixture.url, '/v1/ai/providers/groq/models?capability=text');
    assert.equal(groqModels.status, 200);
    assert.ok(groqModels.body.models.some(({ id }) => id === GROQ_TEXT_MODEL));
    const openAiModels = await request(fixture.url, '/v1/ai/providers/openai/models?capability=vision');
    assert.equal(openAiModels.status, 200);
    assert.ok(openAiModels.body.models.some(({ id }) => id === OPENAI_VISION_MODEL));

    const external = await request(fixture.url, '/v1/ai/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        model_provider_mode: 'external',
        text: { provider_id: 'groq', model: GROQ_TEXT_MODEL },
        vision: { provider_id: 'openai', model: OPENAI_VISION_MODEL }
      })
    });
    assert.equal(external.status, 200);
    assert.equal(external.body.model_provider_mode, 'external');

    const providers = await request(fixture.url, '/v1/ai/providers');
    assert.equal(providers.status, 200);
    assert.deepEqual(providers.body.providers.map(({ provider_id }) => provider_id).sort(), ['groq', 'openai']);
    assert.equal(JSON.stringify(providers.body).includes(OPENAI_KEY), false);
    assert.equal(JSON.stringify(providers.body).includes(GROQ_KEY), false);
    const persisted = fixture.store.db.prepare(`
      SELECT provider_id, encrypted_api_key FROM user_provider_credentials ORDER BY provider_id
    `).all();
    assert.equal(persisted.length, 2);
    assert.equal(JSON.stringify(persisted).includes(OPENAI_KEY), false);
    assert.equal(JSON.stringify(persisted).includes(GROQ_KEY), false);
    const logs = fixture.store.db.prepare(`
      SELECT message, json_data FROM logs WHERE operation LIKE 'user_ai.%'
    `).all();
    assert.equal(JSON.stringify(logs).includes(OPENAI_KEY), false);
    assert.equal(JSON.stringify(logs).includes(GROQ_KEY), false);

    const storageRoot = await mkdtemp(join(tmpdir(), 'brai-live-user-ai-'));
    try {
      await withUserScope('live-provider-user', async () => {
        const received = await receiveInbox({
          store: fixture.store,
          storageRoot,
          nowDate: new Date('2026-07-13T16:01:00.000Z'),
          body: {
            text: 'Сохрани короткую заметку о синем тестовом изображении.',
            idempotency_key: 'live-provider-inbox',
            attachments: [{
              base64: PNG_BYTES.toString('base64'),
              mime: 'image/png',
              name: 'live.png'
            }]
          }
        });
        const inboxResult = await processInboxItem({
          store: fixture.store,
          inboxId: received.inbox_id,
          storageRoot,
          codexBin: '/missing/codex-must-not-run',
          externalAi: { fetch },
          nowDate: new Date('2026-07-13T16:01:01.000Z')
        });
        const imageLog = fixture.store.db.prepare(`
          SELECT status, json_data FROM ai_logs
          WHERE agent_id = 'inbox.image_describer' ORDER BY id DESC LIMIT 1
        `).get();
        assert.equal(inboxResult.ok, true, JSON.stringify({
          result: inboxResult,
          image_log: imageLog ? { ...imageLog, json_data: JSON.parse(imageLog.json_data) } : null
        }));

        const activitySync = await request(fixture.url, '/v1/activities/events/sync', {
          method: 'POST',
          body: JSON.stringify({
            device: { device_id: 'live-provider-device', platform: 'test' },
            events: [actionEvent(
              'live-provider-activity-create',
              1,
              'create',
              'live-provider-activity',
              '2026-07-13T16:01:02.000Z',
              {
                title: 'Проверить реальный внешний normalizer',
                description_md: 'Подтвердить, что Activity использует аккаунтную Groq-модель.'
              }
            )]
          })
        });
        assert.equal(activitySync.status, 200);
        const activityResult = await processActivityItem({
          store: fixture.store,
          activityId: 'live-provider-activity',
          codexBin: '/missing/codex-must-not-run',
          externalAi: { fetch },
          nowDate: new Date('2026-07-13T16:01:03.000Z')
        });
        assert.equal(activityResult.ok, true, JSON.stringify(activityResult));
      });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }

    const agentLogs = fixture.store.db.prepare(`
      SELECT agent_id, status, json_data FROM ai_logs
      WHERE agent_id IN ('inbox.image_describer', 'inbox.normalizer', 'activity.normalizer')
      ORDER BY id
    `).all().map((row) => ({ ...row, json_data: JSON.parse(row.json_data) }));
    assert.deepEqual(agentLogs.map(({ agent_id, status }) => [agent_id, status]), [
      ['inbox.image_describer', 'done'],
      ['inbox.normalizer', 'done'],
      ['activity.normalizer', 'done']
    ]);
    assert.deepEqual(agentLogs.map(({ json_data }) => [
      json_data.metadata.mode,
      json_data.metadata.provider,
      json_data.usage.model
    ]), [
      ['external', 'openai', OPENAI_VISION_MODEL],
      ['external', 'groq', GROQ_TEXT_MODEL],
      ['external', 'groq', GROQ_TEXT_MODEL]
    ]);
    assert.equal(JSON.stringify(agentLogs).includes(OPENAI_KEY), false);
    assert.equal(JSON.stringify(agentLogs).includes(GROQ_KEY), false);
  } finally {
    await fixture.close();
  }
});

function seedUser(fixture, id) {
  fixture.store.db.prepare(`
    INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
    VALUES (?, ?, ?, true, ?, ?)
  `).run(id, id, `${id}@example.test`, '2026-07-13T16:00:00.000Z', '2026-07-13T16:00:00.000Z');
  fixture.store.db.prepare(`
    INSERT INTO app_settings (key, value, updated_at_utc)
    VALUES ('primary_user_id', ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at_utc = excluded.updated_at_utc
  `).run(id, '2026-07-13T16:00:00.000Z');
}
