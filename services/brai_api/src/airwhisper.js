import { randomUUID } from 'node:crypto';

const GROQ_TRANSCRIPTIONS_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_POST_PROCESSING_PROMPT_CHARS = 4000;

export function airWhisperConfigFromEnv(env = process.env) {
  return {
    groqApiKey: env.BRAI_AIRWHISPER_GROQ_API_KEY ?? env.GROQ_API_KEY ?? '',
    transcriptionModel: env.BRAI_AIRWHISPER_TRANSCRIPTION_MODEL ?? env.GROQ_TRANSCRIPTION_MODEL ?? 'whisper-large-v3',
    transcriptionFallbackModel: env.BRAI_AIRWHISPER_TRANSCRIPTION_FALLBACK_MODEL ?? env.GROQ_TRANSCRIPTION_FALLBACK_MODEL ?? 'whisper-large-v3-turbo',
    transcriptionTimeoutMs: parsePositiveInt(env.BRAI_AIRWHISPER_TRANSCRIPTION_TIMEOUT_MS ?? env.GROQ_TRANSCRIPTION_TIMEOUT_MS, 60_000),
    postProcessingModel: env.BRAI_AIRWHISPER_POST_PROCESSING_MODEL ?? env.GROQ_POST_PROCESSING_MODEL ?? 'openai/gpt-oss-20b',
    postProcessingTimeoutMs: parsePositiveInt(env.BRAI_AIRWHISPER_POST_PROCESSING_TIMEOUT_MS ?? env.GROQ_POST_PROCESSING_TIMEOUT_MS, 60_000),
    openaiApiKey: env.BRAI_AIRWHISPER_OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '',
    openaiTranscriptionModel: env.BRAI_AIRWHISPER_OPENAI_TRANSCRIPTION_MODEL ?? env.OPENAI_TRANSCRIPTION_MODEL ?? 'gpt-4o-mini-transcribe',
    maxAudioBytes: parsePositiveInt(env.BRAI_AIRWHISPER_MAX_AUDIO_BYTES ?? env.MAX_AUDIO_BYTES, 25 * 1024 * 1024),
    maxRequestExtraBytes: parsePositiveInt(env.BRAI_AIRWHISPER_MAX_REQUEST_EXTRA_BYTES, 8 * 1024 * 1024)
  };
}

export function createAirWhisperRuntime(options = {}) {
  const config = { ...airWhisperConfigFromEnv({}), ...(options.config ?? {}) };
  return {
    config,
    deps: {
      transcribeAudio: (file) => transcribeAudio(file, config),
      postProcessTranscript: (text, prompt) =>
        postProcessWithGroq(text, prompt, {
          apiKey: config.groqApiKey,
          model: config.postProcessingModel,
          timeoutMs: config.postProcessingTimeoutMs
        }),
      generateContextReply: (command, contextJson) =>
        generateContextReplyWithGroq(command, contextJson, {
          apiKey: config.groqApiKey,
          model: config.postProcessingModel,
          timeoutMs: config.postProcessingTimeoutMs
        }),
      ...(options.deps ?? {})
    }
  };
}

export function isAirWhisperPublicRoute(pathname) {
  return [
    '/v1/health',
    '/v1/access/request',
    '/v1/dictate',
    '/v1/airwhisper/health',
    '/v1/airwhisper/access/request',
    '/v1/airwhisper/dictate'
  ].includes(pathname);
}

export function isAirWhisperAdminRoute(pathname) {
  return pathname === '/v1/airwhisper/admin/summary' ||
    pathname === '/v1/airwhisper/admin/settings' ||
    /^\/v1\/airwhisper\/admin\/tokens\/[^/]+\/revoke$/.test(pathname);
}

export async function handleAirWhisperPublicRoute({ req, res, url, store, runtime, sendJson }) {
  try {
    if (req.method === 'GET' && (url.pathname === '/v1/health' || url.pathname === '/v1/airwhisper/health')) {
      requireAirWhisperAccess(req, store);
      sendJson(req, res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/access/request' || url.pathname === '/v1/airwhisper/access/request')) {
      await handleAccessRequest({ req, res, store, sendJson });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/v1/dictate' || url.pathname === '/v1/airwhisper/dictate')) {
      const access = requireAirWhisperAccess(req, store);
      await handleDictate({ req, res, store, runtime, access, sendJson });
      return;
    }

    throw new AirWhisperHttpError(405, 'Method not allowed', 'method_not_allowed');
  } catch (error) {
    writeAirWhisperError(req, res, sendJson, error);
  }
}

export async function handleAirWhisperAdminRoute({ req, res, url, store, sendJson }) {
  try {
    if (req.method === 'GET' && url.pathname === '/v1/airwhisper/admin/summary') {
      sendJson(req, res, 200, store.airWhisperAdminSummary());
      return;
    }

    if (req.method === 'PUT' && url.pathname === '/v1/airwhisper/admin/settings') {
      const body = await readJsonBody(req, 64 * 1024);
      const settings = store.setAirWhisperRegistrationEnabled(Boolean(body.registrationEnabled));
      sendJson(req, res, 200, { settings });
      return;
    }

    const revokeMatch = url.pathname.match(/^\/v1\/airwhisper\/admin\/tokens\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      const token = store.revokeAirWhisperToken(decodeURIComponent(revokeMatch[1]));
      if (!token) throw new AirWhisperHttpError(404, 'Token not found', 'not_found');
      sendJson(req, res, 200, { id: token.id, status: token.status });
      return;
    }

    throw new AirWhisperHttpError(405, 'Method not allowed', 'method_not_allowed');
  } catch (error) {
    writeAirWhisperError(req, res, sendJson, error);
  }
}

export function requireAirWhisperAccess(req, store) {
  const token = bearerToken(req);
  const deviceId = headerValue(req, 'x-airwhisper-device-id');
  if (!token) throw new AirWhisperHttpError(401, 'Missing bearer token', 'unauthorized');
  if (!deviceId) throw new AirWhisperHttpError(400, 'Missing device id', 'missing_device_id');
  const access = store.authenticateAirWhisperAccess(token, deviceId, headerValue(req, 'x-airwhisper-client-version'));
  if (!access) throw new AirWhisperHttpError(401, 'Invalid bearer token', 'unauthorized');
  return access;
}

async function handleAccessRequest({ req, res, store, sendJson }) {
  if (!store.airWhisperSettings().registrationEnabled) {
    throw new AirWhisperHttpError(403, 'Пока регистрация новых пользователей приостановлена. Обратитесь в поддержку.', 'registration_paused');
  }

  const body = await readJsonBody(req, 64 * 1024);
  const displayName = stringField(body, 'displayName');
  const deviceId = stringField(body, 'deviceId');
  if (!displayName) throw new AirWhisperHttpError(400, 'Введите имя', 'display_name_required');
  if (!deviceId) throw new AirWhisperHttpError(400, 'Missing device id', 'missing_device_id');

  const issued = store.issueAirWhisperAccess({
    displayName,
    deviceId,
    clientVersion: stringField(body, 'clientVersion'),
    appPackage: stringField(body, 'appPackage'),
    source: 'self_service'
  });
  sendJson(req, res, 201, {
    token: issued.token,
    displayName: issued.record.displayName,
    status: issued.record.status
  });
}

async function handleDictate({ req, res, store, runtime, access, sendJson }) {
  const started = Date.now();
  const requestId = randomUUID();
  const { config, deps } = runtime;
  const clientVersion = headerValue(req, 'x-airwhisper-client-version');
  let audioBytes = 0;
  let audioDurationMs = 0;
  let transcriptionMs = 0;
  let postProcessingMs = 0;
  let provider = '';
  let model = '';
  let fallbackUsed = false;

  try {
    const contentType = headerValue(req, 'content-type');
    if (!contentType.startsWith('multipart/form-data')) {
      throw new AirWhisperHttpError(415, 'Expected multipart/form-data', 'unsupported_media_type');
    }
    const maxRequestBytes = config.maxAudioBytes + config.maxRequestExtraBytes;
    const contentLength = parseContentLength(req);
    if (contentLength !== null && contentLength > maxRequestBytes) {
      throw new AirWhisperHttpError(413, 'Request body is too large', 'request_too_large');
    }

    const body = await readBody(req, maxRequestBytes);
    const multipart = parseMultipart(body, parseBoundary(contentType));
    audioDurationMs = parseDurationMs(multipart.fields.audioDurationMs ?? multipart.fields.durationMs);
    const audio = multipart.files.find((file) => file.fieldName === 'audio' || file.fieldName === 'file');
    if (!audio) throw new AirWhisperHttpError(400, 'Missing audio file field', 'missing_audio');
    audioBytes = audio.data.length;
    if (audioBytes > config.maxAudioBytes) throw new AirWhisperHttpError(413, 'Audio file is too large', 'audio_too_large');
    if (!isAllowedAudio(audio)) throw new AirWhisperHttpError(415, 'Unsupported audio type', 'unsupported_audio');

    const transcribeStarted = Date.now();
    const transcription = await deps.transcribeAudio(audio);
    transcriptionMs = Date.now() - transcribeStarted;
    provider = transcription.provider;
    model = transcription.model;
    fallbackUsed = Boolean(transcription.fallbackUsed);
    let text = transcription.text;
    let postProcessed = false;
    let postProcessingModel = '';

    const postProcessingPrompt = postProcessingPromptField(multipart.fields);
    const normalizedContextJson = normalizedContextJsonField(multipart.fields);
    if (postProcessingPrompt && text.trim()) {
      const postProcessingStarted = Date.now();
      const processed = await deps.postProcessTranscript(text, postProcessingPrompt);
      postProcessingMs = Date.now() - postProcessingStarted;
      postProcessed = true;
      postProcessingModel = processed.model;
      text = processed.text;
    } else if (titleContextEnabled(multipart.fields) && normalizedContextJson && text.trim()) {
      const contextReplyStarted = Date.now();
      const generated = await deps.generateContextReply(text, normalizedContextJson);
      postProcessingMs = Date.now() - contextReplyStarted;
      postProcessed = true;
      postProcessingModel = generated.model;
      text = generated.text;
    }

    store.recordAirWhisperUsage({
      accessTokenId: access.id,
      success: true,
      audioBytes,
      audioDurationMs,
      provider,
      model,
      fallbackUsed,
      transcriptionMs,
      postProcessingMs,
      totalMs: Date.now() - started,
      transcriptChars: text.length,
      clientVersion
    });

    sendJson(req, res, 200, {
      text,
      requestId,
      provider,
      model,
      fallbackUsed,
      timings: {
        totalMs: Date.now() - started,
        transcriptionMs,
        postProcessingMs
      },
      postProcessed,
      postProcessingModel
    });
  } catch (error) {
    store.recordAirWhisperUsage({
      accessTokenId: access.id,
      success: false,
      errorCode: errorCode(error),
      audioBytes,
      audioDurationMs,
      provider,
      model,
      fallbackUsed,
      transcriptionMs,
      postProcessingMs,
      totalMs: Date.now() - started,
      transcriptChars: 0,
      clientVersion
    });
    throw error;
  }
}

async function transcribeAudio(file, config) {
  try {
    return await transcribeWithGroq(file, {
      apiKey: config.groqApiKey,
      model: config.transcriptionModel,
      fallbackModel: config.transcriptionFallbackModel,
      timeoutMs: config.transcriptionTimeoutMs
    });
  } catch (error) {
    if (!config.openaiApiKey) throw error;
    return transcribeWithOpenAI(file, {
      apiKey: config.openaiApiKey,
      model: config.openaiTranscriptionModel,
      timeoutMs: config.transcriptionTimeoutMs
    });
  }
}

async function transcribeWithGroq(file, options) {
  if (!options.apiKey) throw new UpstreamError('GROQ_API_KEY is not configured');
  try {
    const text = await requestGroqTranscription(file, options.model, options);
    if (text) return { text, provider: 'groq', model: options.model, fallbackUsed: false };
  } catch (error) {
    if (!options.fallbackModel || options.fallbackModel === options.model) throw error;
  }
  const text = await requestGroqTranscription(file, options.fallbackModel, options);
  if (text) return { text, provider: 'groq', model: options.fallbackModel, fallbackUsed: true };
  throw new UpstreamError('Transcription model returned empty text');
}

async function transcribeWithOpenAI(file, options) {
  if (!options.apiKey) throw new UpstreamError('OPENAI_API_KEY is not configured');
  const form = audioForm(file, options.model);
  const payload = await requestJson(OPENAI_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: form,
    timeoutMs: options.timeoutMs,
    timeoutMessage: 'OpenAI transcription model timed out'
  });
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) throw new UpstreamError('OpenAI transcription model returned empty text');
  return { text, provider: 'openai', model: options.model, fallbackUsed: true };
}

async function requestGroqTranscription(file, model, options) {
  const payload = await requestJson(GROQ_TRANSCRIPTIONS_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.apiKey}` },
    body: audioForm(file, model),
    timeoutMs: options.timeoutMs,
    timeoutMessage: 'Transcription model timed out'
  });
  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

async function postProcessWithGroq(text, prompt, options) {
  if (!options.apiKey) throw new UpstreamError('GROQ_API_KEY is not configured');
  const sourceText = text.trim();
  const instruction = prompt.trim();
  if (!sourceText) return { text: '', provider: 'groq', model: options.model };
  if (!instruction) throw new UpstreamError('Post-processing prompt is empty');
  return requestGroqChat(
    [
      {
        role: 'system',
        content: "You post-process speech transcripts. Follow the user's editing instruction, preserve the original meaning and language unless explicitly asked otherwise, and return only the final text."
      },
      {
        role: 'user',
        content: `Instruction:\n${instruction}\n\nTranscript:\n${sourceText}`
      }
    ],
    options,
    'Post-processing model timed out',
    'Post-processing model returned empty text'
  );
}

async function generateContextReplyWithGroq(command, contextJson, options) {
  if (!options.apiKey) throw new UpstreamError('GROQ_API_KEY is not configured');
  const instruction = command.trim();
  const context = contextJson.trim();
  if (!instruction) return { text: '', provider: 'groq', model: options.model };
  if (!context) throw new UpstreamError('Context JSON is empty');
  return requestGroqChat(
    [
      {
        role: 'system',
        content: "You write chat replies from Android screen JSON context. Use the visible conversation context and the user's spoken command. If asked to answer the last message, use the latest visible incoming message when possible. Return only the exact text to insert into the chat."
      },
      {
        role: 'user',
        content: `Visible context JSON:\n${context}\n\nSpoken command:\n${instruction}`
      }
    ],
    options,
    'Context reply model timed out',
    'Context reply model returned empty text'
  );
}

async function requestGroqChat(messages, options, timeoutMessage, emptyMessage) {
  const payload = await requestJson(GROQ_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: options.model, messages, temperature: 0.2 }),
    timeoutMs: options.timeoutMs,
    timeoutMessage
  });
  const text = extractChatText(payload);
  if (!text) throw new UpstreamError(emptyMessage);
  return { text, provider: 'groq', model: options.model };
}

async function requestJson(url, { method, headers, body, timeoutMs, timeoutMessage }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new UpstreamError(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const payload = await safeJson(response);
  if (!response.ok) {
    throw new UpstreamError(extractProviderError(payload));
  }
  return payload;
}

function audioForm(file, model) {
  const form = new FormData();
  const audioBuffer = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength);
  form.set('model', model);
  form.set('file', new Blob([audioBuffer], { type: file.contentType || 'audio/mp4' }), file.filename || 'audio.m4a');
  return form;
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function extractProviderError(payload) {
  return String(payload?.error?.message ?? payload?.message ?? payload?.raw ?? 'Upstream request failed').slice(0, 300);
}

function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('').trim();
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    let partStart = cursor + boundaryBuffer.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === '--') break;
    if (buffer.subarray(partStart, partStart + 2).toString() === '\r\n') partStart += 2;

    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundary === -1) break;
    let partEnd = nextBoundary;
    if (buffer.subarray(partEnd - 2, partEnd).toString() === '\r\n') partEnd -= 2;
    const part = buffer.subarray(partStart, partEnd);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const disposition = rawHeaders.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1] ?? '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1];
    if (!name) {
      cursor = nextBoundary;
      continue;
    }
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
    const contentType = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? 'application/octet-stream';

    if (filename !== undefined) {
      files.push({ fieldName: name, filename, contentType, data });
    } else {
      fields[name] = data.toString('utf8');
    }
    cursor = nextBoundary;
  }

  return { fields, files };
}

function parseBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new AirWhisperHttpError(400, 'Missing multipart boundary', 'missing_boundary');
  return boundary;
}

function isAllowedAudio(file) {
  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();
  return contentType.startsWith('audio/') ||
    contentType === 'application/octet-stream' ||
    ['.m4a', '.mp4', '.mpeg', '.mpga', '.mp3', '.wav', '.webm', '.aac'].some((ext) => filename.endsWith(ext));
}

function postProcessingPromptField(fields) {
  if (!truthyField(fields.postProcessingEnabled)) return '';
  const prompt = (fields.postProcessingPrompt ?? '').trim();
  if (!prompt) throw new AirWhisperHttpError(400, 'Missing post-processing prompt', 'post_processing_prompt_required');
  if (prompt.length > MAX_POST_PROCESSING_PROMPT_CHARS) {
    throw new AirWhisperHttpError(400, 'Post-processing prompt is too long', 'post_processing_prompt_too_long');
  }
  return prompt;
}

function titleContextEnabled(fields) {
  return truthyField(firstField(fields, ['headerContextEnabled', 'titleContextEnabled', 'conversationContextEnabled']));
}

function normalizedContextJsonField(fields) {
  const value = firstField(fields, ['normalizedContextJson']);
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? value : '';
  } catch {
    return '';
  }
}

function truthyField(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function firstField(fields, names) {
  for (const name of names) {
    const value = fields[name]?.trim();
    if (value) return value;
  }
  return '';
}

async function readJsonBody(req, maxBytes) {
  const body = (await readBody(req, maxBytes)).toString('utf8');
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AirWhisperHttpError(400, 'Expected JSON object', 'invalid_json');
    }
    return parsed;
  } catch (error) {
    if (error instanceof AirWhisperHttpError) throw error;
    throw new AirWhisperHttpError(400, 'Invalid JSON', 'invalid_json');
  }
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new AirWhisperHttpError(413, 'Request body is too large', 'request_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function bearerToken(req) {
  const authorization = req.headers.authorization ?? '';
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() ?? '';
  return value?.trim() ?? '';
}

function stringField(body, field) {
  const value = body[field];
  return typeof value === 'string' ? value.trim() : '';
}

function parseDurationMs(value) {
  const parsed = Number.parseInt(value ?? '0', 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseContentLength(req) {
  const value = headerValue(req, 'content-length');
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function errorCode(error) {
  if (!(error instanceof Error)) return 'internal_error';
  if (error.code === 'ECONNRESET' || error.code === 'ERR_HTTP_REQUEST_TIMEOUT' || error.message === 'aborted') {
    return 'request_aborted';
  }
  return error instanceof AirWhisperHttpError ? error.code : 'internal_error';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeAirWhisperError(req, res, sendJson, error) {
  if (error instanceof AirWhisperHttpError) {
    sendJson(req, res, error.status, { error: error.message, code: error.code });
    return;
  }
  sendJson(req, res, 500, { error: 'Internal error', code: 'internal_error' });
}

class AirWhisperHttpError extends Error {
  constructor(status, message, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class UpstreamError extends AirWhisperHttpError {
  constructor(message) {
    super(502, message, 'upstream_error');
  }
}
