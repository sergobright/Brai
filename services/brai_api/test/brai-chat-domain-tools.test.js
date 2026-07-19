import assert from 'node:assert/strict';
import test from 'node:test';
import { SESSION_SECRET, createFixture, jsonRequest } from '../test-support/api.js';

test('Brai domain tools create user-scoped Action and Inbox records idempotently', async () => {
  let executeTool;
  const fixture = await createFixture([
    '2026-07-19T03:00:00.000Z',
    '2026-07-19T03:00:01.000Z',
    '2026-07-19T03:00:02.000Z',
    '2026-07-19T03:00:03.000Z',
  ], {
    sessionSecret: SESSION_SECRET,
    testEmailLogin: true,
    braiChatRuntime: {
      configureDomainTools(executor) {
        executeTool = executor;
      },
    },
  });

  try {
    const login = await jsonRequest(fixture.url, '/auth/test-email-login', {
      method: 'POST',
      headers: { origin: 'capacitor://localhost' },
      body: JSON.stringify({ email: 'tools@example.test' }),
    });
    assert.equal(login.status, 200);
    assert.equal(typeof executeTool, 'function');
    const userId = login.body.user.id;
    const common = {
      userId,
      publicThreadId: 'thread_tool_test',
      runId: 'run_tool_test',
    };

    const action = await executeTool({
      ...common,
      callId: 'call_action_1',
      tool: 'brai_create_action',
      arguments: {
        title: 'Позвонить маме',
        description: 'Обсудить праздник',
      },
    });
    const actionRetry = await executeTool({
      ...common,
      callId: 'call_action_1',
      tool: 'brai_create_action',
      arguments: {
        title: 'Позвонить маме',
        description: 'Обсудить праздник',
      },
    });
    assert.equal(action.success, true);
    assert.match(action.text, /создано/);
    assert.match(actionRetry.text, /уже существовало/);
    const activities = fixture.store.db.prepare(`
      SELECT title, description_md, activity_type_id
      FROM activities
      WHERE user_id = ? AND title = ?
    `).all(userId, 'Позвонить маме');
    assert.deepEqual(activities, [{
      title: 'Позвонить маме',
      description_md: 'Обсудить праздник',
      activity_type_id: 'action',
    }]);

    const inbox = await executeTool({
      ...common,
      callId: 'call_inbox_1',
      tool: 'brai_create_inbox',
      arguments: {
        text: 'Идея для поездки',
        description: 'Разобрать позже',
      },
    });
    const inboxRetry = await executeTool({
      ...common,
      callId: 'call_inbox_1',
      tool: 'brai_create_inbox',
      arguments: {
        text: 'Идея для поездки',
        description: 'Разобрать позже',
      },
    });
    assert.equal(inbox.success, true);
    assert.match(inbox.text, /создана/);
    assert.match(inboxRetry.text, /уже существовала/);
    const inboxRows = fixture.store.db.prepare(`
      SELECT title, description_text, explanation_text, source
      FROM inbox
      WHERE user_id = ? AND title = ?
    `).all(userId, 'Идея для поездки');
    assert.deepEqual(inboxRows, [{
      title: 'Идея для поездки',
      description_text: 'Разобрать позже',
      explanation_text: 'Идея для поездки',
      source: 'brai-chat',
    }]);
  } finally {
    await fixture.close();
  }
});
