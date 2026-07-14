import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderError,
  SUPPORTED_USER_AI_PROVIDERS,
  completeStructuredText,
  describeImage,
  listProviderModels,
  probeProviderCapability,
  validateProviderKey
} from '../src/user-ai-providers.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' } },
  required: ['answer']
};
const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

test('exports the four account providers and rejects unknown providers safely', async () => {
  assert.deepEqual(SUPPORTED_USER_AI_PROVIDERS, ['openai', 'groq', 'openrouter', 'gemini']);
  await assert.rejects(
    listProviderModels({ provider: 'custom', apiKey: 'fixture-key' }),
    (error) => safeError(error, 'provider_unavailable')
  );
  await assert.rejects(
    listProviderModels({ provider: 'openai', apiKey: '' }),
    (error) => safeError(error, 'invalid_key')
  );
});

test('lists normalized models, capabilities, and structured-output metadata', async () => {
  const calls = [];
  const models = await listProviderModels({
    provider: 'openrouter',
    apiKey: 'fixture-router-key',
    capability: 'vision',
    fetchImpl: capture(calls, {
      data: [
        {
          id: 'vendor/vision',
          name: 'Vision',
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['response_format']
        },
        { id: 'vendor/text', architecture: { input_modalities: ['text'] } },
        { id: 'vendor/vision', architecture: { input_modalities: ['image'] } }
      ]
    })
  });

  assert.deepEqual(models, [{
    id: 'vendor/vision',
    name: 'Vision',
    capabilities: ['text', 'vision'],
    supportsStructuredOutput: true,
    provider: 'openrouter'
  }]);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-router-key');

  const validation = await validateProviderKey({
    provider: 'openai',
    apiKey: 'fixture-openai-key',
    fetchImpl: capture([], { data: [{ id: 'gpt-4o-mini' }] })
  });
  assert.equal(validation.provider, 'openai');
  assert.deepEqual(validation.models[0].capabilities, ['text', 'vision']);
  assert.equal(validation.models[0].supportsStructuredOutput, null);

  const routerCalls = [];
  await validateProviderKey({
    provider: 'openrouter',
    apiKey: 'fixture-router-key',
    fetchImpl: async (url, init) => {
      routerCalls.push({ url: String(url), init });
      return jsonResponse(String(url).endsWith('/key') ? { data: { limit_remaining: 1 } } : { data: [] });
    }
  });
  assert.deepEqual(routerCalls.map((call) => call.url), [
    'https://openrouter.ai/api/v1/key',
    'https://openrouter.ai/api/v1/models'
  ]);
});

test('filters non-generation models and infers missing capabilities conservatively', async () => {
  const openAiPayload = {
    data: [
      { id: 'text-embedding-3-small' },
      { id: 'whisper-1' },
      { id: 'tts-1' },
      { id: 'omni-moderation-latest' },
      { id: 'gpt-image-1' },
      { id: 'gpt-3.5-turbo' },
      { id: 'gpt-4o-mini' },
      { id: 'future-unknown-model' }
    ]
  };
  const openAiVision = await listProviderModels({
    provider: 'openai',
    apiKey: 'fixture-key',
    capability: 'vision',
    fetchImpl: capture([], openAiPayload)
  });
  assert.deepEqual(openAiVision.map((model) => model.id), ['gpt-4o-mini']);

  const openAiText = await listProviderModels({
    provider: 'openai',
    apiKey: 'fixture-key',
    capability: 'text',
    fetchImpl: capture([], openAiPayload)
  });
  assert.deepEqual(openAiText.map((model) => model.id), ['gpt-3.5-turbo', 'gpt-4o-mini']);

  const groqText = await listProviderModels({
    provider: 'groq',
    apiKey: 'fixture-key',
    capability: 'text',
    fetchImpl: capture([], { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }] })
  });
  assert.deepEqual(groqText.map((model) => model.id), ['openai/gpt-oss-20b']);
});

test('prefers declared modalities over model-name vision heuristics', async () => {
  const models = await listProviderModels({
    provider: 'openai',
    apiKey: 'fixture-key',
    capability: 'vision',
    fetchImpl: capture([], {
      data: [
        { id: 'gpt-4o-text-only', input_modalities: ['text'], output_modalities: ['text'] },
        { id: 'gpt-4o-image-output', input_modalities: ['text', 'image'], output_modalities: ['image'] },
        { id: 'gpt-4o-mini', input_modalities: ['text', 'image'], output_modalities: ['text'] }
      ]
    })
  });
  assert.deepEqual(models.map((model) => model.id), ['gpt-4o-mini']);
});

test('uses OpenAI Responses for structured text and extracts output chunks', async () => {
  const calls = [];
  const result = await completeStructuredText({
    provider: 'openai',
    apiKey: 'fixture-openai-key',
    model: 'gpt-current',
    instructions: 'Return structured data.',
    prompt: 'Answer.',
    jsonSchema: SCHEMA,
    schemaName: 'answer_schema',
    fetchImpl: capture(calls, {
      output: [{ content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }]
    })
  });

  assert.deepEqual(result, { text: '{"answer":"ok"}', provider: 'openai', model: 'gpt-current' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-openai-key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'gpt-current');
  assert.equal(body.instructions, 'Return structured data.');
  assert.equal(body.input, 'Answer.');
  assert.deepEqual(body.text.format, {
    type: 'json_schema',
    name: 'answer_schema',
    strict: true,
    schema: SCHEMA
  });
});

test('uses compatible chat structured-output contracts for Groq, OpenRouter, and Gemini', async (t) => {
  const providers = [
    ['groq', 'https://api.groq.com/openai/v1/chat/completions'],
    ['openrouter', 'https://openrouter.ai/api/v1/chat/completions'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions']
  ];
  for (const [provider, url] of providers) {
    await t.test(provider, async () => {
      const calls = [];
      const result = await completeStructuredText({
        provider,
        apiKey: `fixture-${provider}-key`,
        model: `${provider}-model`,
        instructions: 'System.',
        prompt: 'User.',
        jsonSchema: SCHEMA,
        fetchImpl: capture(calls, { choices: [{ message: { content: '{"answer":"ok"}' } }] })
      });
      assert.equal(result.text, '{"answer":"ok"}');
      assert.equal(calls[0].url, url);
      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.messages, [
        { role: 'system', content: 'System.' },
        { role: 'user', content: 'User.' }
      ]);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.response_format.json_schema.type, undefined);
      assert.deepEqual(body.response_format.json_schema.schema, SCHEMA);
      assert.deepEqual(body.provider, provider === 'openrouter' ? { require_parameters: true } : undefined);
    });
  }
});

test('sends image data through Responses and compatible chat vision formats', async (t) => {
  await t.test('OpenAI Responses', async () => {
    const calls = [];
    const result = await describeImage({
      provider: 'openai',
      apiKey: 'fixture-key',
      model: 'gpt-vision',
      prompt: 'Describe.',
      imageDataUrls: [IMAGE, IMAGE],
      fetchImpl: capture(calls, { output_text: 'A pixel.' })
    });
    assert.equal(result.text, 'A pixel.');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.input[0].content[0].type, 'input_text');
    assert.equal(body.input[0].content[1].type, 'input_image');
    assert.equal(body.input[0].content[1].image_url, IMAGE);
    assert.equal(body.input[0].content[2].type, 'input_image');
  });

  await t.test('Gemini compatible chat', async () => {
    const calls = [];
    const result = await describeImage({
      provider: 'gemini',
      apiKey: 'fixture-key',
      model: 'gemini-vision',
      prompt: 'Describe.',
      imageDataUrl: IMAGE,
      fetchImpl: capture(calls, { choices: [{ message: { content: [{ text: 'A pixel.' }] } }] })
    });
    assert.equal(result.text, 'A pixel.');
    const content = JSON.parse(calls[0].init.body).messages[0].content;
    assert.deepEqual(content, [
      { type: 'text', text: 'Describe.' },
      { type: 'image_url', image_url: { url: IMAGE } }
    ]);
  });

  await assert.rejects(
    describeImage({
      provider: 'openai',
      apiKey: 'fixture-key',
      model: 'gpt-vision',
      prompt: 'Describe.',
      imageDataUrl: 'https://private.example/image.png'
    }),
    (error) => safeError(error, 'capability_unsupported')
  );
});

test('probes text and vision with real capability-shaped requests', async () => {
  const textCalls = [];
  assert.deepEqual(await probeProviderCapability({
    provider: 'groq',
    apiKey: 'fixture-key',
    model: 'text-model',
    capability: 'text',
    fetchImpl: capture(textCalls, { choices: [{ message: { content: '{"ok":true}' } }] })
  }), { provider: 'groq', model: 'text-model', capability: 'text' });
  assert.equal(JSON.parse(textCalls[0].init.body).response_format.json_schema.name, 'brai_capability_probe');

  const visionCalls = [];
  assert.deepEqual(await probeProviderCapability({
    provider: 'openai',
    apiKey: 'fixture-key',
    model: 'vision-model',
    capability: 'vision',
    fetchImpl: capture(visionCalls, { output_text: 'yes' })
  }), { provider: 'openai', model: 'vision-model', capability: 'vision' });
  assert.match(JSON.parse(visionCalls[0].init.body).input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test('maps upstream failures to safe codes without leaking keys or response bodies', async (t) => {
  const cases = [
    [401, { error: { message: 'leaked fixture-secret', code: 'invalid_api_key' } }, 'invalid_key'],
    [400, { error: { message: 'API key not valid: leaked fixture-secret' } }, 'invalid_key'],
    [403, { error: { message: 'leaked fixture-secret', metadata: { provider_code: 'insufficient_quota' } } }, 'quota_exceeded'],
    [403, { error: { message: 'leaked fixture-secret', metadata: { error_type: 'model_not_found' } } }, 'model_unavailable'],
    [403, { error: { message: 'leaked fixture-secret' } }, 'capability_unsupported'],
    [429, { error: { message: 'leaked fixture-secret' } }, 'quota_exceeded'],
    [404, { error: { message: 'leaked fixture-secret' } }, 'model_unavailable'],
    [422, { error: { message: 'leaked fixture-secret' } }, 'capability_unsupported'],
    [503, { error: { message: 'leaked fixture-secret' } }, 'provider_unavailable']
  ];
  for (const [status, payload, code] of cases) {
    await t.test(String(status), async () => {
      await assert.rejects(
        completeStructuredText({
          provider: 'groq',
          apiKey: 'fixture-secret',
          model: 'model',
          prompt: 'Prompt.',
          jsonSchema: SCHEMA,
          fetchImpl: async () => jsonResponse(payload, status)
        }),
        (error) => {
          assert.equal(error.message.includes('fixture-secret'), false);
          assert.equal(JSON.stringify(error).includes('fixture-secret'), false);
          return safeError(error, code);
        }
      );
    });
  }
  await assert.rejects(
    completeStructuredText({
      provider: 'groq',
      apiKey: 'fixture-secret',
      model: 'model',
      prompt: 'Prompt.',
      jsonSchema: SCHEMA,
      fetchImpl: async () => new Response('raw leaked fixture-secret', { status: 401 })
    }),
    (error) => safeError(error, 'invalid_key')
  );
});

test('turns aborts and network failures into safe availability errors', async () => {
  await assert.rejects(
    listProviderModels({
      provider: 'openai',
      apiKey: 'fixture-key',
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('timed out', 'AbortError')), { once: true });
      })
    }),
    (error) => safeError(error, 'provider_timeout')
  );
  await assert.rejects(
    listProviderModels({
      provider: 'openai',
      apiKey: 'fixture-key',
      fetchImpl: async () => { throw new Error('network leaked fixture-key'); }
    }),
    (error) => safeError(error, 'provider_unavailable')
  );
});

function capture(calls, payload, status = 200) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse(payload, status);
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function safeError(error, code) {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  return true;
}
