import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = new URL('./complete-inbox-operations.sh', import.meta.url).pathname;

test('Inbox completion helper sends authenticated sequential updates and suppresses state', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, key: request.headers['x-brai-api-key'], body: raw && JSON.parse(raw) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ inbox_id: `inbox-${requests.length}`, status: 'Done', changed: requests.length === 1, state: { secret: 'must-not-leak' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await execFileAsync('bash', [helper, '--local', 'operation:agent-task:one', 'operation:agent-task:two'], {
      env: { ...process.env, BRAI_INBOX_API_KEY: 'test-key', BRAI_API_BASE_URL: `http://127.0.0.1:${address.port}` },
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((entry) => entry.body), [
      { idempotency_key: 'operation:agent-task:one', status: 'Done' },
      { idempotency_key: 'operation:agent-task:two', status: 'Done' },
    ]);
    assert.ok(requests.every((entry) => entry.key === 'test-key'));
    assert.doesNotMatch(result.stdout, /must-not-leak|test-key/);
    assert.deepEqual(result.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
      { key: 'operation:agent-task:one', inbox_id: 'inbox-1', status: 'Done', changed: true },
      { key: 'operation:agent-task:two', inbox_id: 'inbox-2', status: 'Done', changed: false },
    ]);
  } finally {
    server.close();
  }
});

test('legacy operation helper keeps soft deletion transactional and scoped', () => {
  const source = fs.readFileSync(new URL('./complete-operation-activities.sh', import.meta.url), 'utf8');
  assert.match(source, /--soft-delete/);
  assert.match(source, /await client\.query\("BEGIN"\)/);
  assert.match(source, /UPDATE activities SET deleted_at_utc/);
  assert.match(source, /UPDATE items SET deleted_at_utc/);
  assert.match(source, /UPDATE item_roles SET status = 'deleted'/);
  assert.match(source, /activity_type_id = 'operation'/);
  assert.match(source, /author = 'Codex'/);
});
