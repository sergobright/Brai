const DEFAULT_TIMEOUT_MS = 15_000;
const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const PROVIDERS = Object.freeze({
  openai: {
    modelsUrl: 'https://api.openai.com/v1/models',
    completionUrl: 'https://api.openai.com/v1/responses',
    protocol: 'responses'
  },
  groq: {
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    completionUrl: 'https://api.groq.com/openai/v1/chat/completions',
    protocol: 'chat'
  },
  openrouter: {
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    validationUrl: 'https://openrouter.ai/api/v1/key',
    completionUrl: 'https://openrouter.ai/api/v1/chat/completions',
    protocol: 'chat'
  },
  gemini: {
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    completionUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    protocol: 'chat'
  }
});

export const SUPPORTED_USER_AI_PROVIDERS = Object.freeze(Object.keys(PROVIDERS));

export class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export async function listProviderModels({
  provider,
  apiKey,
  capability = null,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const { id, config, key } = providerRequest(provider, apiKey);
  const requestedCapability = optionalCapability(capability);
  const payload = await requestJson(config.modelsUrl, {
    headers: authHeaders(key),
    fetchImpl,
    timeoutMs,
    clientErrorCode: 'provider_unavailable',
    notFoundCode: 'provider_unavailable'
  });
  if (!Array.isArray(payload?.data)) throw new ProviderError('provider_unavailable');

  const seen = new Set();
  return payload.data.flatMap((entry) => {
    const modelId = cleanText(entry?.id ?? entry?.name).replace(/^models\//, '');
    if (!modelId || seen.has(modelId) || isNonGenerationModel(entry, modelId)) return [];
    const capabilities = modelCapabilities(entry, id, modelId);
    if (!capabilities.length) return [];
    if (requestedCapability && !capabilities.includes(requestedCapability)) return [];
    const parameters = stringArray(entry?.supported_parameters);
    const supportsStructuredOutput = parameters.length
      ? parameters.includes('response_format') || parameters.includes('structured_outputs')
      : null;
    if (requestedCapability === 'text' && supportsStructuredOutput === false) return [];
    seen.add(modelId);
    return [{
      id: modelId,
      name: cleanText(entry?.display_name ?? entry?.name) || modelId,
      capabilities,
      supportsStructuredOutput,
      provider: id
    }];
  });
}

export async function validateProviderKey(options) {
  const { id: provider, config, key } = providerRequest(options?.provider, options?.apiKey);
  if (config.validationUrl) {
    await requestJson(config.validationUrl, {
      headers: authHeaders(key),
      fetchImpl: options?.fetchImpl ?? fetch,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      clientErrorCode: 'invalid_key',
      notFoundCode: 'invalid_key'
    });
  }
  const models = await listProviderModels(options);
  return { provider, models };
}

export async function completeStructuredText({
  provider,
  apiKey,
  model,
  instructions = '',
  prompt,
  jsonSchema,
  schemaName = 'brai_output',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const { id, config, key } = providerRequest(provider, apiKey);
  const modelId = requiredModel(model);
  if (!jsonSchema || typeof jsonSchema !== 'object' || Array.isArray(jsonSchema)) {
    throw new ProviderError('capability_unsupported');
  }
  const schemaFormat = {
    name: safeSchemaName(schemaName),
    strict: true,
    schema: jsonSchema
  };
  const body = config.protocol === 'responses'
    ? {
        model: modelId,
        ...(cleanText(instructions) ? { instructions: cleanText(instructions) } : {}),
        input: cleanText(prompt),
        text: { format: { type: 'json_schema', ...schemaFormat } }
      }
    : {
        model: modelId,
        messages: chatMessages(instructions, cleanText(prompt)),
        response_format: { type: 'json_schema', json_schema: schemaFormat },
        ...(id === 'openrouter' ? { provider: { require_parameters: true } } : {})
      };
  const payload = await requestJson(config.completionUrl, {
    method: 'POST',
    headers: authHeaders(key, true),
    body: JSON.stringify(body),
    fetchImpl,
    timeoutMs
  });
  const text = config.protocol === 'responses' ? responseText(payload) : chatText(payload);
  if (!text) throw new ProviderError('provider_unavailable');
  return { text, provider: id, model: modelId };
}

export async function describeImage({
  provider,
  apiKey,
  model,
  instructions = '',
  prompt,
  imageDataUrl,
  imageDataUrls,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const { id, config, key } = providerRequest(provider, apiKey);
  const modelId = requiredModel(model);
  const images = validImageDataUrls(imageDataUrls ?? (imageDataUrl ? [imageDataUrl] : []));
  const requestPrompt = cleanText(prompt);
  const body = config.protocol === 'responses'
    ? {
        model: modelId,
        ...(cleanText(instructions) ? { instructions: cleanText(instructions) } : {}),
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: requestPrompt },
            ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' }))
          ]
        }]
      }
    : {
        model: modelId,
        messages: chatMessages(instructions, [
          { type: 'text', text: requestPrompt },
          ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ])
      };
  const payload = await requestJson(config.completionUrl, {
    method: 'POST',
    headers: authHeaders(key, true),
    body: JSON.stringify(body),
    fetchImpl,
    timeoutMs
  });
  const text = config.protocol === 'responses' ? responseText(payload) : chatText(payload);
  if (!text) throw new ProviderError('provider_unavailable');
  return { text, provider: id, model: modelId };
}

export async function probeProviderCapability(options) {
  const capability = optionalCapability(options?.capability);
  if (!capability) throw new ProviderError('capability_unsupported');
  if (capability === 'vision') {
    await describeImage({
      ...options,
      prompt: 'Reply with one short word describing whether an image is present.',
      imageDataUrl: TINY_PNG_DATA_URL,
      imageDataUrls: undefined
    });
  } else {
    const result = await completeStructuredText({
      ...options,
      instructions: 'Return only JSON that matches the schema.',
      prompt: 'Set ok to true.',
      schemaName: 'brai_capability_probe',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok']
      }
    });
    try {
      if (JSON.parse(result.text)?.ok !== true) throw new Error();
    } catch {
      throw new ProviderError('capability_unsupported');
    }
  }
  return { provider: providerId(options?.provider), model: requiredModel(options?.model), capability };
}

function providerRequest(provider, apiKey) {
  const id = providerId(provider);
  const key = cleanText(apiKey);
  if (!key) throw new ProviderError('invalid_key');
  return { id, config: PROVIDERS[id], key };
}

function providerId(value) {
  const id = cleanText(value).toLowerCase();
  if (!Object.hasOwn(PROVIDERS, id)) throw new ProviderError('provider_unavailable');
  return id;
}

function requiredModel(value) {
  const model = cleanText(value);
  if (!model || model.length > 240) throw new ProviderError('model_unavailable');
  return model;
}

function optionalCapability(value) {
  if (value == null || value === '') return null;
  const capability = cleanText(value).toLowerCase();
  if (capability !== 'text' && capability !== 'vision') throw new ProviderError('capability_unsupported');
  return capability;
}

function authHeaders(apiKey, json = false) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(json ? { 'content-type': 'application/json' } : {})
  };
}

function chatMessages(instructions, userContent) {
  return [
    ...(cleanText(instructions) ? [{ role: 'system', content: cleanText(instructions) }] : []),
    { role: 'user', content: userContent }
  ];
}

function modelCapabilities(entry, provider, modelId) {
  const declaredInputs = [
    ...stringArray(entry?.input_modalities),
    ...stringArray(entry?.architecture?.input_modalities),
    ...stringArray(entry?.modalities?.input)
  ].map((value) => value.toLowerCase());
  const declaredOutputs = [
    ...stringArray(entry?.output_modalities),
    ...stringArray(entry?.architecture?.output_modalities),
    ...stringArray(entry?.modalities?.output)
  ].map((value) => value.toLowerCase());
  if (declaredOutputs.length && !declaredOutputs.includes('text')) return [];
  if (!declaredInputs.length) return inferredModelCapabilities(provider, modelId);
  return [
    ...(declaredInputs.includes('text') ? ['text'] : []),
    ...(declaredInputs.includes('image') || declaredInputs.includes('vision') ? ['vision'] : [])
  ];
}

function isNonGenerationModel(entry, modelId) {
  const descriptor = [
    modelId,
    entry?.type,
    entry?.task,
    ...stringArray(entry?.capabilities)
  ].map(cleanText).filter(Boolean).join(' ').toLowerCase();
  return /embedding|whisper|transcri|moderation|dall[_.-]?e|gpt[_.-]?image|(?:^|[\/_.:-])imagen(?:$|[\/_.:-])|(?:^|[\/_.:-])veo(?:$|[\/_.:-])|lyria|(?:^|[\/_.:-])tts(?:$|[\/_.:-])|(?:^|[\/_.:-])speech(?:$|[\/_.:-])|realtime|audio/.test(descriptor);
}

function inferredModelCapabilities(provider, modelId) {
  const id = modelId.toLowerCase();
  const text = provider === 'openai'
    ? /^(?:gpt-|chatgpt-|o[1-9](?:-|$))/.test(id)
    : provider === 'gemini'
      ? /(?:^|\/)gemini-/.test(id)
      : provider === 'groq' || provider === 'openrouter';
  if (!text) return [];
  const vision = provider === 'openai'
    ? /^(?:gpt-(?:4o|4\.1)(?:-|$)|gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(id) || /vision/.test(id)
    : provider === 'gemini'
      ? /vision|gemini-(?:1\.5|2(?:\.|-)|3(?:\.|-))/.test(id)
      : /vision|llava|pixtral|(?:qwen[^/]*[-_.](?:vl|omni))|llama-3\.2[^/]*vision|llama-4[^/]*(?:scout|maverick)|gpt-(?:4o|4\.1)(?:-|$)|gpt-5(?:[.-]|$)|gemini-(?:1\.5|2(?:\.|-)|3(?:\.|-))/.test(id);
  return ['text', ...(vision ? ['vision'] : [])];
}

async function requestJson(url, {
  method = 'GET',
  headers,
  body,
  fetchImpl,
  timeoutMs,
  clientErrorCode = 'capability_unsupported',
  notFoundCode = 'model_unavailable'
}) {
  if (typeof fetchImpl !== 'function') throw new ProviderError('provider_unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), validTimeout(timeoutMs));
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) throw new ProviderError('provider_unavailable');
      }
    }
    if (!response.ok) {
      throw new ProviderError(httpErrorCode(response.status, payload, clientErrorCode, notFoundCode));
    }
    return payload;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw new ProviderError('provider_timeout');
    throw new ProviderError('provider_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

function httpErrorCode(status, payload, clientErrorCode, notFoundCode) {
  const upstreamCode = [
    payload?.error?.code,
    payload?.error?.type,
    payload?.error?.status,
    payload?.error?.message,
    payload?.error?.metadata?.error_type,
    payload?.error?.metadata?.provider_code,
    payload?.code
  ].map(cleanText).filter(Boolean).join(' ').toLowerCase();
  if (/auth|api.?key|unauthori[sz]ed|invalid.?token/.test(upstreamCode)) return 'invalid_key';
  if (/quota|rate.?limit|billing|credit|insufficient/.test(upstreamCode)) return 'quota_exceeded';
  if (/model.*(not.?found|invalid|unavailable)|unknown.?model/.test(upstreamCode)) return 'model_unavailable';
  if (/unsupported|not.?supported|capability|modality/.test(upstreamCode)) return 'capability_unsupported';
  if (status === 401) return 'invalid_key';
  if (status === 403) return clientErrorCode;
  if (status === 402 || status === 429) return 'quota_exceeded';
  if (status === 408 || status === 504) return 'provider_timeout';
  if (status === 404) return notFoundCode;
  if (status >= 400 && status < 500) return clientErrorCode;
  return 'provider_unavailable';
}

function chatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : cleanText(part?.text)).join('').trim();
}

function responseText(payload) {
  const direct = cleanText(payload?.output_text);
  if (direct) return direct;
  return (Array.isArray(payload?.output) ? payload.output : [])
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((content) => cleanText(content?.text))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function validImageDataUrls(values) {
  if (!Array.isArray(values) || !values.length) throw new ProviderError('capability_unsupported');
  const urls = values.map((value) => typeof value === 'string' ? value.trim() : '');
  if (urls.some((value) => !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value))) {
    throw new ProviderError('capability_unsupported');
  }
  return urls;
}

function safeSchemaName(value) {
  const name = cleanText(value);
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : 'brai_output';
}

function validTimeout(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
