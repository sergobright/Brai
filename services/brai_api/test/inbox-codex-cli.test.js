import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_INBOX_CODEX_BIN,
  DEFAULT_INBOX_CODEX_MODEL,
  describeInboxImagesForWorkflow,
  normalizeInboxRawForWorkflow
} from '../src/inbox.js';
import { withUserScope } from '../src/user-scope.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'description', 'class_key', 'class_title', 'class_description', 'normalization'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', minLength: 1, maxLength: 8000 },
    class_key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,62}$' },
    class_title: { type: 'string', maxLength: 8000 },
    class_description: { type: 'string', maxLength: 8000 },
    normalization: { type: 'string', minLength: 1, maxLength: 8000 }
  },
  additionalProperties: false
};

const VALID_OUTPUT = {
  title: 'Купить пушистого кота',
  description: 'Пользователь хочет купить пушистого кота.',
  class_key: 'wish',
  class_title: '',
  class_description: '',
  normalization: 'Запись распознана как желание.'
};

const LEGACY_OUTPUT_SCHEMA = {
  ...OUTPUT_SCHEMA,
  required: ['title', 'description', 'class_key', 'normalization']
};
const CODEX_SECRET_ENV_KEYS = [
  'BETTER_AUTH_SECRET',
  'BRAI_DATABASE_URL',
  'BRAI_INBOX_API_KEY',
  'BRAI_INBOX_GROQ_API_KEY',
  'BRAI_INBOX_OPENAI_API_KEY',
  'BRAI_SESSION_SECRET',
  'BRAI_USER_PROVIDER_ENCRYPTION_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY'
];

test('Inbox text normalizer runs isolated Codex exec with the stored schema and parses JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-cli-test-'));
  const restoreEnvironment = installCodexTestEnvironment(root);
  const capturePath = path.join(root, 'capture.json');
  const codexBin = fakeCodex(root, capturePath, { output: JSON.stringify(VALID_OUTPUT) });
  const store = normalizerStore();
  try {
    const result = await normalizeInboxRawForWorkflow({
      store,
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      attempt: 1,
      codexBin,
      codexTimeoutMs: 1_000
    });

    assert.equal(result.ok, true);
    assert.equal(result.normalized.title, VALID_OUTPUT.title);
    assert.equal(result.normalized.classKey, 'wish');

    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    const execIndex = capture.args.indexOf('exec');
    const cliCwd = argument(capture.args, '--cd');
    assert.ok(execIndex > 0);
    assert.equal(argument(capture.args, '--sandbox'), 'read-only');
    assert.equal(argument(capture.args, '--ask-for-approval'), 'never');
    assert.equal(argument(capture.args, '--model'), DEFAULT_INBOX_CODEX_MODEL);
    assert.ok(capture.args.indexOf('--ignore-user-config') > execIndex);
    assert.ok(capture.args.indexOf('--ephemeral') > execIndex);
    assert.ok(capture.args.indexOf('--skip-git-repo-check') > execIndex);
    assert.deepEqual(configValues(capture.args), [
      'model_reasoning_effort="low"',
      'model_verbosity="low"',
      `model_instructions_file=${JSON.stringify(capture.instructionsPath)}`,
      'features.apps=false',
      'features.image_generation=false',
      'features.shell_tool=false',
      'features.unified_exec=false',
      'features.multi_agent=false',
      'web_search="disabled"',
      'tools_view_image=false'
    ]);
    assert.equal(capture.args.at(-1), '-');
    assert.match(cliCwd, /^\/tmp\/brai-inbox-ai-/);
    assert.equal(capture.cwd, cliCwd);
    assert.equal(path.dirname(capture.schemaPath), cliCwd);
    assert.equal(path.dirname(capture.outputPath), cliCwd);
    assert.deepEqual(capture.schema, OUTPUT_SCHEMA);
    assert.equal(capture.schemaMode, 0o600);
    assert.equal(capture.instructionsMode, 0o600);
    assert.match(capture.instructions, /deterministic JSON normalizer/);
    assert.match(capture.prompt, /Хочу купить пушистого кота/);
    assert.match(capture.prompt, /Сохраняй исходное намерение пользователя/);
    assertSanitizedCodexEnvironment(capture.environmentKeys);
    assert.equal(fs.existsSync(cliCwd), false);
    assert.equal(store.logs.length, 1);
    assert.equal(store.logs[0].jsonData.usage.model, DEFAULT_INBOX_CODEX_MODEL);
  } finally {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox Codex timeout kills the process and removes its temporary directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-cli-timeout-'));
  const capturePath = path.join(root, 'capture.json');
  const codexBin = fakeCodex(root, capturePath, { hang: true });
  try {
    const result = await normalizeInboxRawForWorkflow({
      store: normalizerStore(),
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      attempt: 1,
      codexBin,
      codexTimeoutMs: 500
    });

    assert.equal(result.ok, false);
    assert.equal(result.validationFailed, false);
    assert.equal(result.error, 'codex_inbox_timeout');
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(fs.existsSync(argument(capture.args, '--cd')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox rejects invalid Codex JSON after cleaning up the schema workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-cli-json-'));
  const capturePath = path.join(root, 'capture.json');
  const codexBin = fakeCodex(root, capturePath, { output: 'not-json' });
  try {
    const result = await normalizeInboxRawForWorkflow({
      store: normalizerStore(),
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      attempt: 1,
      codexBin,
      codexTimeoutMs: 1_000
    });

    assert.equal(result.ok, false);
    assert.equal(result.validationFailed, true);
    assert.match(result.error, /Unexpected token|JSON/);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(fs.existsSync(argument(capture.args, '--cd')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox records a failed AI attempt when local Codex exits unsuccessfully', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-cli-refusal-'));
  const capturePath = path.join(root, 'capture.json');
  const codexBin = fakeCodex(root, capturePath, {
    exitCode: 1,
    stderr: 'ERROR: model refused the structured request'
  });
  const store = normalizerStore();
  try {
    const result = await normalizeInboxRawForWorkflow({
      store,
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      attempt: 1,
      codexBin,
      codexTimeoutMs: 1_000
    });

    assert.equal(result.ok, false);
    assert.equal(result.validationFailed, false);
    assert.match(result.error, /model refused the structured request/);
    assert.equal(store.logs.length, 1);
    assert.equal(store.logs[0].status, 'failed');
    assert.match(store.logs[0].jsonData.metadata.error, /model refused the structured request/);
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(fs.existsSync(argument(capture.args, '--cd')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox Codex defaults point at the installed local CLI and mini model', () => {
  assert.equal(DEFAULT_INBOX_CODEX_BIN, '/srv/opt/codex-cli/bin/codex');
  assert.equal(DEFAULT_INBOX_CODEX_MODEL, 'gpt-5.4-mini');
});

test('Inbox image describer uses the same isolated Codex exec and sanitized environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-image-cli-test-'));
  const restoreEnvironment = installCodexTestEnvironment(root);
  const capturePath = path.join(root, 'capture.json');
  const imagePath = path.join(root, 'image.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const codexBin = fakeCodex(root, capturePath, { output: 'На изображении виден тестовый экран.' });
  const logs = [];
  const store = {
    getInboxItem: () => ({
      id: 'inbox-1',
      attachment_links: ['/v1/inbox/attachments/image.png']
    }),
    markInboxWorkflowStep: () => true,
    getAgent: () => ({ version: '4', llm_model: '', llm_prompt_template: null, llm_timeout_ms: 1_000 }),
    userAiSettings: () => ({ model_provider_mode: 'internal', text: null, vision: null }),
    recordAiLog: (entry) => logs.push(entry)
  };
  try {
    const result = await describeInboxImagesForWorkflow({
      store,
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      storageRoot: root,
      codexBin,
      codexModel: DEFAULT_INBOX_CODEX_MODEL,
      codexTimeoutMs: 1_000
    });

    assert.equal(result.ok, true);
    assert.equal(result.imageDescription, 'На изображении виден тестовый экран.');
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    const execIndex = capture.args.indexOf('exec');
    const cliCwd = argument(capture.args, '--cd');
    assert.ok(execIndex > 0);
    assert.equal(argument(capture.args, '--sandbox'), 'read-only');
    assert.equal(argument(capture.args, '--ask-for-approval'), 'never');
    assert.equal(argument(capture.args, '--model'), DEFAULT_INBOX_CODEX_MODEL);
    assert.ok(capture.args.indexOf('--ignore-user-config') > execIndex);
    assert.ok(capture.args.indexOf('--ephemeral') > execIndex);
    assert.equal(argument(capture.args, '--image'), imagePath);
    assert.deepEqual(configValues(capture.args), expectedIsolationConfig(capture));
    assert.equal(capture.cwd, cliCwd);
    assert.match(cliCwd, /^\/tmp\/brai-inbox-ai-/);
    assert.match(capture.instructions, /deterministic image describer/);
    assert.match(capture.instructions, /Do not use tools/);
    assert.equal(capture.instructionsMode, 0o600);
    assertSanitizedCodexEnvironment(capture.environmentKeys);
    assert.equal(fs.existsSync(cliCwd), false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].jsonData.metadata.mode, 'internal');
  } finally {
    restoreEnvironment();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Inbox external text normalizer uses Groq GPT OSS 120B with JSON schema', async () => {
  let captured = null;
  const result = await withUserScope('user-1', () => normalizeInboxRawForWorkflow({
    store: normalizerStore({
      settings: {
        model_provider_mode: 'external',
        text: { provider_id: 'groq', model: 'openai/gpt-oss-120b' },
        vision: { provider_id: 'openai', model: 'gpt-4.1-mini' }
      },
      credentials: { groq: 'test-groq-key' }
    }),
    inboxId: 'inbox-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    attempt: 1,
    externalAi: {
      fetch: async (url, options) => {
        captured = {
          url,
          headers: options.headers,
          body: JSON.parse(options.body)
        };
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(VALID_OUTPUT) } }]
        }), { status: 200 });
      }
    },
    codexTimeoutMs: 1_000
  }));

  assert.equal(result.ok, true);
  assert.equal(result.normalized.classKey, 'wish');
  assert.equal(captured.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured.headers.authorization, 'Bearer test-groq-key');
  assert.equal(captured.body.model, 'openai/gpt-oss-120b');
  assert.equal(captured.body.response_format.type, 'json_schema');
  assert.deepEqual(captured.body.response_format.json_schema.schema, OUTPUT_SCHEMA);
});

test('Inbox external image describer uses OpenAI 4.1 mini with image input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-openai-image-test-'));
  const imagePath = path.join(root, 'image.png');
  fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let captured = null;
  const store = {
    getInboxItem: () => ({
      id: 'inbox-1',
      attachment_links: ['/v1/inbox/attachments/image.png']
    }),
    markInboxWorkflowStep: () => true,
    getAgent: () => ({ version: '2', llm_model: '', llm_prompt_template: null, llm_timeout_ms: 1_000 }),
    userAiSettings: () => ({
      model_provider_mode: 'external',
      text: { provider_id: 'groq', model: 'openai/gpt-oss-120b' },
      vision: { provider_id: 'openai', model: 'gpt-4.1-mini' }
    }),
    getUserProviderCredential: (provider) => provider === 'openai'
      ? { provider_id: provider, api_key: 'test-openai-key' }
      : null,
    recordAiLog: () => undefined
  };
  try {
    const result = await withUserScope('user-1', () => describeInboxImagesForWorkflow({
      store,
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      storageRoot: root,
      externalAi: {
        fetch: async (url, options) => {
          captured = {
            url,
            headers: options.headers,
            body: JSON.parse(options.body)
          };
          return new Response(JSON.stringify({
            output_text: 'На изображении виден тестовый экран.'
          }), { status: 200 });
        }
      },
      codexTimeoutMs: 1_000
    }));

    assert.equal(result.ok, true);
    assert.equal(result.imageDescription, 'На изображении виден тестовый экран.');
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.headers.authorization, 'Bearer test-openai-key');
    assert.equal(captured.body.model, 'gpt-4.1-mini');
    assert.equal(captured.body.input[0].content[0].type, 'input_text');
    assert.equal(captured.body.input[0].content[1].type, 'input_image');
    assert.match(captured.body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a pinned v1 execution keeps local Codex isolation without silently adopting the v2 strict schema', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-codex-cli-v1-'));
  const capturePath = path.join(root, 'capture.json');
  const output = {
    title: VALID_OUTPUT.title,
    description: VALID_OUTPUT.description,
    class_key: VALID_OUTPUT.class_key,
    normalization: VALID_OUTPUT.normalization
  };
  const codexBin = fakeCodex(root, capturePath, { output: JSON.stringify(output) });
  try {
    const result = await normalizeInboxRawForWorkflow({
      store: normalizerStore({ workflowVersion: 1, outputSchema: LEGACY_OUTPUT_SCHEMA }),
      inboxId: 'inbox-1',
      workflowId: 'workflow-1',
      runId: 'run-1',
      attempt: 1,
      codexBin,
      codexTimeoutMs: 1_000
    });

    assert.equal(result.ok, true);
    assert.equal(result.normalized.classTitle, '');
    assert.equal(result.normalized.classDescription, '');
    const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(capture.args.includes('--output-schema'), false);
    assert.equal(capture.schemaPath, null);
    assert.equal(capture.schema, null);
    assert.ok(capture.args.includes('--ignore-user-config'));
    assert.match(capture.cwd, /^\/tmp\/brai-inbox-ai-/);
    assert.match(capture.instructions, /deterministic JSON normalizer/);
    assert.equal(fs.existsSync(capture.cwd), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function normalizerStore({ workflowVersion = 3, outputSchema = OUTPUT_SCHEMA, settings = null, credentials = {} } = {}) {
  const logs = [];
  return {
    logs,
    getInboxItem: () => ({
      id: 'inbox-1',
      title: 'Купить кота',
      explanation_text: 'Хочу купить пушистого кота',
      description_md: '',
      deleted_at_utc: null,
      item_roles_id: null
    }),
    markInboxWorkflowStep: () => true,
    listInboxClasses: () => [{ key: 'wish', title: 'Желание' }],
    getInboxWorkflowExecution: () => ({ workflow_definition_version: workflowVersion }),
    getInboxWorkflowOutputSchema: () => outputSchema,
    userAiSettings: () => settings ?? { model_provider_mode: 'internal', text: null, vision: null },
    getUserProviderCredential: (provider) => credentials[provider]
      ? { provider_id: provider, api_key: credentials[provider] }
      : null,
    getAgent: () => ({ version: '4', llm_model: '', llm_prompt_template: null, llm_timeout_ms: 1_000 }),
    recordAiLog: (entry) => logs.push(entry)
  };
}

function fakeCodex(root, capturePath, { output = '', hang = false, exitCode = 0, stderr = '' } = {}) {
  const file = path.join(root, 'fake-codex');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const schemaPath = value('--output-schema');
const outputPath = value('--output-last-message');
const instructionsConfig = args.filter((arg, index) => args[index - 1] === '-c').find((entry) => entry.startsWith('model_instructions_file='));
const instructionsPath = JSON.parse(instructionsConfig.slice('model_instructions_file='.length));
const prompt = fs.readFileSync(0, 'utf8');
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    args,
    cwd: process.cwd(),
    schemaPath,
    outputPath,
    instructionsPath,
    schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null,
    schemaMode: schemaPath ? fs.statSync(schemaPath).mode & 0o777 : null,
    instructions: fs.readFileSync(instructionsPath, 'utf8'),
    instructionsMode: fs.statSync(instructionsPath).mode & 0o777,
    environmentKeys: Object.keys(process.env).sort(),
    prompt
  }));
  if (${JSON.stringify(hang)}) {
    setInterval(() => {}, 10_000);
    return;
  }
  if (${JSON.stringify(exitCode)} !== 0) {
    fs.writeSync(2, ${JSON.stringify(stderr)});
    process.exit(${JSON.stringify(exitCode)});
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, ${JSON.stringify(output)});
`);
  fs.chmodSync(file, 0o700);
  return file;
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configValues(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') values.push(args[index + 1]);
  }
  return values;
}

function expectedIsolationConfig(capture) {
  return [
    'model_reasoning_effort="low"',
    'model_verbosity="low"',
    `model_instructions_file=${JSON.stringify(capture.instructionsPath)}`,
    'features.apps=false',
    'features.image_generation=false',
    'features.shell_tool=false',
    'features.unified_exec=false',
    'features.multi_agent=false',
    'web_search="disabled"',
    'tools_view_image=false'
  ];
}

function installCodexTestEnvironment(root) {
  const keys = [...CODEX_SECRET_ENV_KEYS, 'CODEX_HOME'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  for (const [index, key] of CODEX_SECRET_ENV_KEYS.entries()) {
    process.env[key] = `codex-child-secret-sentinel-${index}`;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function assertSanitizedCodexEnvironment(environmentKeys) {
  assert.ok(environmentKeys.includes('CODEX_HOME'));
  assert.ok(environmentKeys.includes('HOME'));
  assert.ok(environmentKeys.includes('PATH'));
  for (const key of CODEX_SECRET_ENV_KEYS) assert.equal(environmentKeys.includes(key), false, key);
}
