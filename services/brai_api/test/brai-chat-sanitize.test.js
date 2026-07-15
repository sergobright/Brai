import assert from 'node:assert/strict';
import test from 'node:test';
import { EventType } from '@ag-ui/core';
import { CodexAguiNormalizer } from '../src/brai-codex-agui.js';
import { BRAI_CHAT_OUTPUT_LIMIT_BYTES, sanitizeBraiChatText } from '../src/brai-chat-sanitize.js';

test('chat sanitizer redacts credentials and server paths before truncation', () => {
  const safe = sanitizeBraiChatText(`Authorization: Bearer secret-token\nAPI_KEY=topsecret\n/srv/projects/brai/private ${'я'.repeat(80_000)}`);

  assert.equal(safe.includes('secret-token'), false);
  assert.equal(safe.includes('topsecret'), false);
  assert.equal(safe.includes('/srv/projects'), false);
  assert.ok(Buffer.byteLength(safe, 'utf8') <= BRAI_CHAT_OUTPUT_LIMIT_BYTES);
  assert.match(safe, /Вывод обрезан/);
});

test('chat sanitizer redacts URI credentials, callback secrets, env secrets, and arbitrary auth headers', () => {
  const openAiToken = ['sk', 'testvalue1234567890'].join('-');
  const githubToken = ['ghp', 'testvalue1234567890'].join('_');
  const privateKeyBegin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const privateKeyEnd = ['-----END', 'PRIVATE KEY-----'].join(' ');
  const secrets = [
    'uri-user', 'uri-password', 'callback-code', 'callback-state', 'aws-secret-value',
    'custom-token-value', 'custom-secret-value', 'nonstandard-auth-value',
    openAiToken, githubToken,
    'eyJheader123.payload456.signature789', 'private-key-material'
  ];
  const safe = sanitizeBraiChatText([
    'postgres://uri-user:uri-password@database.internal:5432/app',
    'https://callback.example/finish?code=callback-code&state=callback-state',
    'AWS_SECRET_ACCESS_KEY=aws-secret-value',
    'BRAI_CUSTOM_TOKEN=custom-token-value',
    'INTERNAL_SECRET: custom-secret-value',
    'Authorization: Token nonstandard-auth-value',
    `${openAiToken} ${githubToken}`,
    'eyJheader123.payload456.signature789',
    `${privateKeyBegin}\nprivate-key-material\n${privateKeyEnd}`
  ].join('\n'));

  for (const secret of secrets) assert.equal(safe.includes(secret), false, secret);
  assert.match(safe, /database\.internal/);
  assert.doesNotMatch(safe, /\d+\[скрыто\]/);
});

test('adapter drops raw reasoning and exposes only safe summaries', () => {
  const normalizer = new CodexAguiNormalizer({ publicThreadId: 'public-thread', runId: 'run-1' });

  assert.deepEqual(normalizer.translate('item/reasoning/textDelta', { delta: 'private chain of thought' }), []);
  const [summary] = normalizer.translate('item/reasoning/summaryTextDelta', {
    itemId: 'reasoning-1',
    summaryIndex: 0,
    delta: 'Проверяю безопасный вариант'
  });
  assert.equal(summary.type, EventType.CUSTOM);
  assert.equal(summary.name, 'brai.reasoning_summary.v1');
  assert.equal(JSON.stringify(summary).includes('chain of thought'), false);
});

test('adapter preserves AG-UI message ordering without duplicating completed text', () => {
  const normalizer = new CodexAguiNormalizer({ publicThreadId: 'public-thread', runId: 'run-1' });
  const events = [
    ...normalizer.translate('turn/started', { turn: { id: 'codex-turn' } }),
    ...normalizer.translate('item/started', { item: { type: 'agentMessage', id: 'message-1', text: '' } }),
    ...normalizer.translate('item/agentMessage/delta', { itemId: 'message-1', delta: 'Привет' }),
    ...normalizer.translate('item/completed', { item: { type: 'agentMessage', id: 'message-1', text: 'Привет' } }),
    ...normalizer.translate('turn/completed', { turn: { status: 'completed' } })
  ];

  assert.deepEqual(events.map((event) => event.type), [
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.CUSTOM,
    EventType.RUN_FINISHED
  ]);
});

test('adapter exposes sanitized command details and bounded tool result', () => {
  const normalizer = new CodexAguiNormalizer({ publicThreadId: 'public-thread', runId: 'run-1' });
  const privateHomePath = ['/home', 'mark', 'private'].join('/');
  const output = `token=secret ${privateHomePath} ${'x'.repeat(70_000)}`;
  const events = [
    ...normalizer.translate('item/started', {
      item: { type: 'commandExecution', id: 'tool-1', command: 'cat /srv/secret', status: 'inProgress' }
    }),
    ...normalizer.translate('item/commandExecution/outputDelta', { itemId: 'tool-1', delta: output }),
    ...normalizer.translate('item/completed', {
      item: { type: 'commandExecution', id: 'tool-1', command: 'cat /srv/secret', status: 'completed' }
    })
  ];
  const serialized = JSON.stringify(events);
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);

  assert.equal(serialized.includes(privateHomePath), false);
  assert.equal(serialized.includes('/srv/secret'), false);
  assert.equal(serialized.includes('token=secret'), false);
  assert.ok(Buffer.byteLength(result.content, 'utf8') <= BRAI_CHAT_OUTPUT_LIMIT_BYTES);
});

test('adapter applies one total output limit per streaming item and drops later deltas', () => {
  const normalizer = new CodexAguiNormalizer({ publicThreadId: 'public-thread', runId: 'run-1' });
  const commandEvents = [];
  const messageEvents = [];

  for (let index = 0; index < 5; index += 1) {
    commandEvents.push(...normalizer.translate('item/commandExecution/outputDelta', {
      itemId: 'tool-many-deltas', delta: 'c'.repeat(20_000)
    }));
    messageEvents.push(...normalizer.translate('item/agentMessage/delta', {
      itemId: 'message-many-deltas', delta: 'м'.repeat(20_000)
    }));
  }

  const commandOutput = commandEvents.map((event) => event.value.delta).join('');
  const messageOutput = messageEvents
    .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
    .map((event) => event.delta)
    .join('');
  for (const output of [commandOutput, messageOutput]) {
    assert.ok(Buffer.byteLength(output, 'utf8') <= BRAI_CHAT_OUTPUT_LIMIT_BYTES);
    assert.equal(output.match(/Вывод обрезан/g)?.length, 1);
  }
  assert.equal(normalizer.translate('item/commandExecution/outputDelta', {
    itemId: 'tool-many-deltas', delta: 'never-published'
  }).length, 0);
  assert.equal(normalizer.translate('item/agentMessage/delta', {
    itemId: 'message-many-deltas', delta: 'never-published'
  }).length, 0);
});
