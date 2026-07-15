import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from '../test-support/api.js';

const BASE = {
  agentId: 'goal.item-matcher',
  agentVersion: '1',
  status: 'done',
  aiTitle: 'Goal agent завершил вызов',
  flowId: '42',
  flowCommand: 'goal.item-matcher',
  traceId: 'trace-42',
  workflowId: 'goal.item-matcher:preview-a:42',
  runId: 'run-42',
  attemptNumber: 1,
  llmCallId: 'llm-call-42',
  jsonData: {
    schema: 'brai.goal_agent.ai_log.v1',
    status: 'completed',
    model: 'test-model',
    duration_ms: 12
  }
};

test('llm_call_id replay returns the existing row only for the same immutable call', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    const firstId = fixture.store.recordAiLog({ ...BASE, dt: '2026-07-13T12:00:00.000Z' });
    const replayId = fixture.store.recordAiLog({
      ...BASE,
      dt: '2026-07-13T12:01:00.000Z',
      jsonData: {
        duration_ms: 12,
        model: 'test-model',
        status: 'completed',
        schema: 'brai.goal_agent.ai_log.v1'
      }
    });

    assert.equal(replayId, firstId);
    assert.equal(countCallRows(fixture), 1);
    assert.equal(
      fixture.store.db.prepare('SELECT dt FROM ai_logs WHERE id = ?').get(firstId).dt,
      '2026-07-13T12:00:00.000Z'
    );
  } finally {
    await fixture.close();
  }
});

test('llm_call_id rejects conflicting workflow, run, model, status, or attempt metadata', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    const firstId = fixture.store.recordAiLog(BASE);
    const conflicts = [
      { workflowId: 'goal.item-matcher:preview-a:other' },
      { runId: 'run-other' },
      { jsonData: { ...BASE.jsonData, model: 'other-model' } },
      { status: 'failed' },
      { attemptNumber: 2 }
    ];

    for (const change of conflicts) {
      assert.throws(
        () => fixture.store.recordAiLog({ ...BASE, ...change }),
        (error) => error.code === 'idempotency_conflict' && error.status === 409
      );
      assert.equal(countCallRows(fixture), 1);
      assert.equal(fixture.store.db.prepare('SELECT id FROM ai_logs WHERE llm_call_id = ?').get(BASE.llmCallId).id, firstId);
    }
  } finally {
    await fixture.close();
  }
});

test('AI logs without llm_call_id remain append-only', async () => {
  const fixture = await createFixture(['2026-07-13T12:00:00.000Z']);
  try {
    const input = { ...BASE, llmCallId: null };
    const firstId = fixture.store.recordAiLog(input);
    const secondId = fixture.store.recordAiLog(input);

    assert.notEqual(secondId, firstId);
    assert.equal(fixture.store.db.prepare("SELECT count(*)::int AS count FROM ai_logs WHERE llm_call_id IS NULL AND agent_id = 'goal.item-matcher'").get().count, 2);
  } finally {
    await fixture.close();
  }
});

function countCallRows(fixture) {
  return fixture.store.db.prepare('SELECT count(*)::int AS count FROM ai_logs WHERE llm_call_id = ?').get(BASE.llmCallId).count;
}
