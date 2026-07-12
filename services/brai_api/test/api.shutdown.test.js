import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { TOKEN, createFixture, onceOpen } from '../test-support/api.js';

test('API close terminates live sockets and is idempotent', async () => {
  const fixture = await createFixture(['2026-07-11T22:00:00.000Z'], { shutdownGraceMs: 100 });
  const ws = new WebSocket(`${fixture.wsUrl}/v1/live?token=${TOKEN}`);
  await onceOpen(ws);
  const socketClosed = once(ws, 'close');

  const started = Date.now();
  await Promise.all([fixture.runtime.close(), fixture.runtime.close()]);
  await socketClosed;
  assert.ok(Date.now() - started < 1000);
  assert.equal(ws.readyState, WebSocket.CLOSED);

  await fixture.close();
});
