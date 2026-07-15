import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = new URL('./complete-inbox-operations.sh', import.meta.url).pathname;
const createHelper = new URL('./create-inbox-operation.sh', import.meta.url).pathname;
const legacyCreateHelper = new URL('./create-operation-activity.sh', import.meta.url).pathname;

test('Inbox create helper and deprecated alias send bounded authenticated API writes', async () => {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ method: request.method, url: request.url, key: request.headers['x-brai-api-key'], body: raw && JSON.parse(raw) });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ inbox_id: `inbox-${requests.length}`, created: requests.length === 1, state: { secret: 'must-not-leak' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const operationArgs = [
    '--local',
    '--id', 'operation:agent-task:inbox-helper',
    '--title', 'Inbox helper check',
    '--reason', 'The legacy write path must stay closed.',
    '--description', 'Create the operation through the authenticated Inbox API.',
  ];
  try {
    const address = server.address();
    const env = { ...process.env, BRAI_INBOX_API_KEY: 'test-key', BRAI_API_BASE_URL: `http://127.0.0.1:${address.port}` };
    const direct = await execFileAsync('bash', [createHelper, ...operationArgs], { env });
    const alias = await execFileAsync('bash', [legacyCreateHelper, ...operationArgs], { env });

    assert.equal(requests.length, 2);
    assert.ok(requests.every((entry) => entry.method === 'POST' && entry.url === '/v1/' && entry.key === 'test-key'));
    assert.deepEqual(requests[0].body, {
      target: 'inbox',
      record_type_id: 2,
      source: 'codex',
      idempotency_key: 'operation:agent-task:inbox-helper',
      preliminary_section: 'operation',
      text: 'Inbox helper check',
      description: 'Create the operation through the authenticated Inbox API.\n\n## Почему задача появилась\n\nThe legacy write path must stay closed.',
    });
    assert.deepEqual(requests[1].body, requests[0].body);
    assert.deepEqual(JSON.parse(direct.stdout), {
      key: 'operation:agent-task:inbox-helper', inbox_id: 'inbox-1', status: 'New', created: true,
    });
    assert.deepEqual(JSON.parse(alias.stdout), {
      key: 'operation:agent-task:inbox-helper', inbox_id: 'inbox-2', status: 'New', created: false,
    });
    assert.match(alias.stderr, /Deprecated: create-operation-activity\.sh/);
    assert.doesNotMatch(`${direct.stdout}${direct.stderr}${alias.stdout}${alias.stderr}`, /must-not-leak|test-key/);
  } finally {
    server.close();
  }
});

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

test('deprecated create helper is a SQL-free compatibility shim', () => {
  const source = fs.readFileSync(legacyCreateHelper, 'utf8');
  assert.match(source, /exec "\$SCRIPT_DIR\/create-inbox-operation\.sh" "\$@"/);
  assert.doesNotMatch(source, /INSERT INTO|BRAI_DATABASE_URL|new Pool/);
});
