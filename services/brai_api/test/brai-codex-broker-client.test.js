import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { BraiCodexBrokerClient } from '../src/brai-codex-broker-client.js';

test('broker client correlates responses and filters notifications', async (t) => {
  const socketPath = path.join(os.tmpdir(), `brai-broker-client-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      socket.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
      socket.write(`${JSON.stringify({
        method: 'notification',
        params: {
          userId: 'user-a',
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-a', turnId: 'turn-a', delta: 'Привет' }
        }
      })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = new BraiCodexBrokerClient({ socketPath });
  t.after(() => {
    client.close();
    server.close();
  });

  const notifications = [];
  const unsubscribe = client.subscribe({ userId: 'user-a', threadId: 'thread-a' }, (method, params) => {
    notifications.push({ method, params });
  });
  const result = await client.request('readiness', {});
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();

  assert.deepEqual(result, { ready: true });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, 'item/agentMessage/delta');
  assert.equal(notifications[0].params.delta, 'Привет');
});

test('broker client rejects invalid RPC methods before connecting', async () => {
  const client = new BraiCodexBrokerClient({ socketPath: '/does/not/exist' });
  await assert.rejects(client.request('../exec', {}), { code: 'BRAI_RPC_METHOD_INVALID' });
});

test('broker client emits one disconnect after an established socket closes', async (t) => {
  const socketPath = path.join(os.tmpdir(), `brai-broker-disconnect-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8').trim());
      socket.end(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const client = new BraiCodexBrokerClient({ socketPath });
  t.after(() => {
    client.close();
    server.close();
  });
  let disconnects = 0;
  client.on('disconnect', () => { disconnects += 1; });
  const disconnected = once(client, 'disconnect');

  assert.deepEqual(await client.request('readiness'), { ready: true });
  await disconnected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnects, 1);
});
