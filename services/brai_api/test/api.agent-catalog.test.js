import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { SESSION_SECRET, createFixture, jsonRequest } from '../test-support/api.js';
import { withUserScope } from '../src/user-scope.js';

const TIMES = [
  '2026-07-19T02:00:00.000Z',
  '2026-07-19T02:00:01.000Z',
  '2026-07-19T02:00:02.000Z',
  '2026-07-19T02:00:03.000Z',
  '2026-07-19T02:00:04.000Z',
];

test('only the primary account can change an optional agent global status', async () => {
  const sentOtps = new Map();
  const fixture = await createFixture(TIMES, {
    sessionSecret: SESSION_SECRET,
    sendOtp: ({ email, otp }) => sentOtps.set(email, otp),
    goalAgentCatalogActive: false,
  });
  const login = async (email) => {
    const sent = await jsonRequest(fixture.url, '/auth/otp/send', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const verified = await jsonRequest(fixture.url, '/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ email, otp: sentOtps.get(email) }),
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.headers.get('set-cookie');
  };

  try {
    const primaryCookie = await login('primary@example.test');
    const secondaryCookie = await login('secondary@example.test');
    const primaryCatalog = await jsonRequest(fixture.url, '/v1/agents', {
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
    });
    const secondaryCatalog = await jsonRequest(fixture.url, '/v1/agents', {
      headers: { cookie: secondaryCookie, origin: 'capacitor://localhost' },
    });
    assert.equal(primaryCatalog.status, 200);
    assert.equal(primaryCatalog.body.can_manage_agents, true);
    assert.equal(secondaryCatalog.status, 200);
    assert.equal(secondaryCatalog.body.can_manage_agents, false);
    const optional = primaryCatalog.body.agents.find((agent) => agent.id === 'activity.classifier');
    assert.deepEqual({
      enabled: optional.enabled,
      status: optional.status,
      toggleable: optional.toggleable,
    }, {
      enabled: false,
      status: 'inactive',
      toggleable: true,
    });

    const secondaryToggle = await jsonRequest(fixture.url, '/v1/agents/activity.classifier/status', {
      method: 'PATCH',
      headers: { cookie: secondaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(secondaryToggle.status, 403);
    assert.equal(secondaryToggle.body.error, 'primary_account_required');

    const enabled = await jsonRequest(fixture.url, '/v1/agents/activity.classifier/status', {
      method: 'PATCH',
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.agent.enabled, true);
    fixture.store.db.prepare(`
      UPDATE agents SET status = 'inactive', metadata_json = '{}'::jsonb
      WHERE id = 'activity.classifier'
    `).run();
    fixture.store.db.exec(fs.readFileSync(
      new URL('../../../supabase/migrations/0037_primary_agent_controls.sql', import.meta.url),
      'utf8',
    ));
    const restoredAfterSeed = fixture.store.getCatalogAgent('activity.classifier');
    assert.equal(restoredAfterSeed.enabled, true);
    assert.equal(restoredAfterSeed.toggleable, true);
    const secondaryAfter = await jsonRequest(fixture.url, '/v1/agents', {
      headers: { cookie: secondaryCookie, origin: 'capacitor://localhost' },
    });
    assert.equal(
      secondaryAfter.body.agents.find((agent) => agent.id === 'goal.discovery').enabled,
      false,
      'global state must be visible to every account',
    );
    assert.equal(
      secondaryAfter.body.agents.find((agent) => agent.id === 'activity.classifier').enabled,
      true,
      'global state must be visible to every account',
    );

    const userId = fixture.store.primaryUserId();
    const queuedExecution = fixture.store.db.prepare(`
      INSERT INTO workflow_executions (
        workflow_definition_id, workflow_definition_version, workflow_id,
        subject_kind, subject_id, trigger_kind, trigger_revision,
        status, current_step, attempt_count, created_at_utc, updated_at_utc,
        user_id, deployment_environment
      ) VALUES (
        'activity.classifier', 1, 'agent-toggle-queued',
        'item', 'agent-toggle-action', 'test', 1,
        'queued', 'dispatch', 0, ?, ?, ?, 'prod'
      ) RETURNING status, workflow_definition_id
    `).get(TIMES[0], TIMES[0], userId);
    assert.equal(queuedExecution.status, 'queued');

    const locked = await jsonRequest(fixture.url, '/v1/agents/brai-codex/status', {
      method: 'PATCH',
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, 'agent_status_locked');

    const restored = await jsonRequest(fixture.url, '/v1/agents/activity.classifier/status', {
      method: 'PATCH',
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.agent.enabled, false);
    assert.equal(
      withUserScope(userId, () => fixture.store.listQueuedGoalAgentExecutions({
        nowIso: TIMES.at(-1),
      })).length,
      0,
      'globally disabled agents must not dispatch already queued work',
    );

    const reenabled = await jsonRequest(fixture.url, '/v1/agents/activity.classifier/status', {
      method: 'PATCH',
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(reenabled.status, 200);
    assert.equal(
      withUserScope(userId, () => fixture.store.listQueuedGoalAgentExecutions({
        nowIso: TIMES.at(-1),
      })).length,
      1,
    );
    await jsonRequest(fixture.url, '/v1/agents/activity.classifier/status', {
      method: 'PATCH',
      headers: { cookie: primaryCookie, origin: 'capacitor://localhost' },
      body: JSON.stringify({ enabled: false }),
    });
  } finally {
    await fixture.close();
  }
});
