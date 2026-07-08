import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';

export const INBOX_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIGNATURE = Buffer.from('%PDF-');
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const IMAGE_PREVIEW_SUFFIX = '.thumb.jpg';
const IMAGE_PREVIEW_MAX_PX = 640;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ATTACHMENT_TYPES = new Map([
  ['image/png', { extension: 'png', valid: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE) }],
  ['image/jpeg', { extension: 'jpg', valid: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/webp', { extension: 'webp', valid: (bytes) => bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' }],
  ['image/gif', { extension: 'gif', valid: (bytes) => bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a' }],
  ['application/pdf', { extension: 'pdf', valid: (bytes) => bytes.subarray(0, 5).equals(PDF_SIGNATURE) }],
  ['text/plain', { extension: 'txt', valid: validUtf8Text }],
  ['text/markdown', { extension: 'md', valid: validUtf8Text }],
  ['text/csv', { extension: 'csv', valid: validUtf8Text }],
  ['application/json', { extension: 'json', valid: validJson }],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', { extension: 'docx', valid: validZip }],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { extension: 'xlsx', valid: validZip }],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', { extension: 'pptx', valid: validZip }]
]);
for (const [mime, type] of ATTACHMENT_TYPES) type.mime = mime;
const CONTENT_TYPES_BY_EXTENSION = new Map(
  [...ATTACHMENT_TYPES.values()].map((type) => [type.extension, type.mime]).filter(([extension]) => extension)
);
const INBOX_IMAGE_AGENT_ID = 'inbox.image_describer';
const INBOX_NORMALIZER_AGENT_ID = 'inbox.normalizer';
const DEFAULT_IMAGE_PROMPT_TEMPLATE = [
  'Опиши изображение для Inbox на русском языке.',
  'Нужно детальное, фактическое описание: что видно, какой интерфейс/экран, важные тексты, объекты, состояния, числа и возможный пользовательский контекст.',
  'Не выдумывай невидимые детали. Верни только описание.'
].join('\n');
const DEFAULT_NORMALIZER_PROMPT_TEMPLATE = [
  'Разбери Inbox-запись на русском языке.',
  'Нужно сопоставить голосовой транскрипт, текстовый контекст и описание картинки.',
  'Верни только JSON без Markdown с полями:',
  '{"title":"короткий заголовок до 80 символов","description":"понятное описание чего хотел пользователь","class_key":"ключ класса","class_title":"русское название класса если ключ новый","class_description":"краткое описание класса если ключ новый","normalization":"технический разбор"}',
  '',
  'Доступные классы:',
  '{{classes}}',
  '',
  'Транскрипт:',
  '{{text}}',
  '',
  'Текстовый контекст:',
  '{{description}}',
  '',
  'Описание картинки:',
  '{{image_description}}'
].join('\n');

export function inboxRequestTarget(req, body = {}) {
  const target = inboxTarget(body?.target ?? body?.destination)
    ?? inboxTarget(req.headers['x-brai-target'] ?? req.headers['x-brai-destination']);
  if (!target) return 'inbox';
  return target === 'inbox' ? 'inbox' : null;
}

export function hasInboxApiKey(req, apiKey) {
  if (!apiKey) return false;
  return req.headers['x-brai-api-key'] === apiKey
    || req.headers['x-api-key'] === apiKey
    || req.headers.authorization === `Bearer ${apiKey}`;
}

function inboxTarget(value) {
  if (value == null || value === '') return null;
  const target = optionalText(value);
  if (target && !target.includes('/')) return target;
  throwStatus('invalid_target', 400);
}

export async function receiveInbox({
  store,
  body,
  storageRoot,
  nowDate,
  logContext = {}
}) {
  try {
    return await receiveInboxInner({ store, body, storageRoot, nowDate, logContext });
  } catch (error) {
    recordInboxIngestFailure(store, { nowIso: nowDate.toISOString(), body, logContext, error });
    throw error;
  }
}

async function receiveInboxInner({
  store,
  body,
  storageRoot,
  nowDate,
  logContext
}) {
  const text = requiredText(body?.text, 'text_required');
  const descriptionText = optionalBodyText(body?.description_text)
    ?? optionalBodyText(body?.description)
    ?? structuredBodyText(body?.description)
    ?? optionalBodyText(body?.content_text)
    ?? structuredBodyText(body?.description_json)
    ?? structuredBodyText(body?.content)
    ?? '';
  const attachments = decodeAttachments(body);
  const nowIso = nowDate.toISOString();
  const idempotencyKey = optionalText(body?.idempotency_key);
  const stableId = idempotencyKey ? shortHash(idempotencyKey) : null;
  const inboxId = stableId ? `inbox:api:${stableId}` : `inbox:api:${crypto.randomUUID()}`;
  const eventId = stableId ? `inbox:api:${stableId}:create` : `inbox:api:${crypto.randomUUID()}:create`;
  const source = optionalText(body?.source) ?? 'inbox';
  const sourceKey = optionalText(body?.source_key) ?? '';
  const existingInboxId = stableId ? store.inboxIdForEvent(eventId) : null;
  if (existingInboxId) {
    recordInboxIngestLog(store, {
      nowIso,
      body,
      attachments,
      source,
      sourceKey,
      recordTypeId: safeInboxRecordTypeId(body?.record_type_id ?? body?.record_type),
      responseRequired: safeOptionalBoolean(body?.response_required),
      idempotencyKey,
      logContext,
      inboxId: existingInboxId,
      eventId,
      created: false,
      reason: 'duplicate'
    });
    return { inbox_id: existingInboxId, created: false, attachment_links: [] };
  }

  const responseRequired = optionalBoolean(body?.response_required, 'invalid_response_required');
  const recordTypeId = inboxRecordTypeId(body?.record_type_id ?? body?.record_type);
  const relatedInboxId = referencesPreviousMessage(`${text}\n${descriptionText}`)
    ? store.latestInboxIdForInbox({ source, sourceKey })
    : null;
  const attachmentLinks = [];
  const writtenPaths = [];

  try {
    if (attachments.length > 0) fs.mkdirSync(storageRoot, { recursive: true });
    attachments.forEach((attachment, index) => {
      const suffix = String(index + 1).padStart(2, '0');
      const fileName = `${compactTimestamp(nowDate)}-${stableId ?? crypto.randomUUID()}-${suffix}.${attachment.extension}`;
      const filePath = path.join(storageRoot, fileName);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, attachment.bytes, { flag: 'wx' });
        writtenPaths.push(filePath);
      }
      if (attachment.mime?.startsWith('image/')) {
        const previewPath = path.join(storageRoot, imagePreviewName(fileName));
        const previewExisted = fs.existsSync(previewPath);
        if (createImagePreview(filePath, previewPath)) writtenPaths.push(previewPath);
        else if (!previewExisted) {
          safeRecordLog(store, {
            dt: nowIso,
            source: 'inbox',
            operation: 'inbox.attachment_preview',
            status: 'failed',
            severityText: 'WARN',
            reason: 'preview_failed',
            message: 'Inbox attachment preview failed',
            jsonData: {
              attachment_index: index + 1,
              mime: attachment.mime,
              route: logContext.route ?? null
            }
          });
        }
      }
      attachmentLinks.push(`/v1/inbox/attachments/${fileName}`);
    });
    store.createInboxApiItem({
      eventId,
      inboxId,
      title: initialTitle(text),
      descriptionText,
      explanationText: text,
      attachmentLinks,
      source,
      sourceKey,
      responseRequired,
      relatedInboxId,
      recordTypeId,
      nowIso
    });
  } catch (error) {
    for (const filePath of writtenPaths) fs.rmSync(filePath, { force: true });
    throw error;
  }

  recordInboxIngestLog(store, {
    nowIso,
    body,
    attachments,
    source,
    sourceKey,
    recordTypeId,
    responseRequired,
    idempotencyKey,
    logContext,
    inboxId,
    eventId,
    created: true
  });
  return {
    inbox_id: inboxId,
    created: true,
    attachment_links: attachmentLinks
  };
}

function recordInboxIngestLog(store, {
  nowIso,
  body,
  attachments,
  source,
  sourceKey,
  recordTypeId,
  responseRequired,
  idempotencyKey,
  logContext,
  inboxId,
  eventId,
  created,
  reason = null
}) {
  safeRecordLog(store, {
    dt: nowIso,
    source: 'inbox',
    operation: 'inbox.ingest',
    status: created ? 'done' : 'skipped',
    itemsId: inboxId,
    eventDomain: 'inbox',
    eventId,
    reason,
    message: created ? 'Inbox item ingested' : 'Inbox ingest skipped',
    jsonData: {
      route: logContext.route ?? null,
      client_source: source,
      source_key_present: Boolean(sourceKey),
      text_present: typeof body?.text === 'string' && body.text.trim().length > 0,
      description_present: Boolean(body?.description_text || body?.description || body?.content_text || body?.description_json || body?.content),
      response_required: responseRequired === true,
      record_type_id: recordTypeId,
      idempotency_key_present: Boolean(idempotencyKey),
      created,
      attachment_count: attachments.length,
      attachment_bytes: attachments.reduce((sum, attachment) => sum + attachment.bytes.length, 0),
      image_count: attachments.filter((attachment) => attachment.mime?.startsWith('image/')).length,
      legacy_image_present: body?.image_base64 !== undefined || body?.image_mime !== undefined
    }
  });
}

function recordInboxIngestFailure(store, { nowIso, body, logContext, error }) {
  safeRecordLog(store, {
    dt: nowIso,
    source: 'inbox',
    operation: 'inbox.ingest',
    status: 'failed',
    severityText: 'WARN',
    reason: error instanceof Error ? error.message : 'inbox_ingest_failed',
    message: 'Inbox ingest rejected',
    jsonData: {
      route: logContext.route ?? null,
      status_code: Number.isInteger(error?.status) ? error.status : null,
      target_present: Boolean(body?.target || body?.destination),
      text_present: typeof body?.text === 'string' && body.text.trim().length > 0,
      attachments_present: Array.isArray(body?.attachments) ? body.attachments.length > 0 : body?.attachments !== undefined,
      legacy_image_present: body?.image_base64 !== undefined || body?.image_mime !== undefined,
      idempotency_key_present: Boolean(optionalText(body?.idempotency_key)),
      response_required_present: body?.response_required !== undefined
    }
  });
}

function safeRecordLog(store, input) {
  try {
    store.recordLog?.(input);
  } catch {
    // Logging must not change Inbox ingest semantics.
  }
}

export async function processInboxItem({
  store,
  inboxId,
  storageRoot,
  codexBin,
  codexModel,
  codexFallbackModel,
  codexTimeoutMs,
  imageDescriber,
  normalizer,
  nowDate = new Date()
}) {
  if (!tryInboxLock(store, inboxId)) return { skipped: true, reason: 'locked' };
  try {
    const item = store.getInboxItem(inboxId);
    if (!item || item.deleted_at_utc || item.is_normalized) {
      return { skipped: true, reason: item ? 'already_normalized' : 'missing' };
    }

    const imageAgent = store.getAgent(INBOX_IMAGE_AGENT_ID);
    const imagePaths = imagePathsForItem(item, storageRoot);
    let imageDescription = '';
    if (imagePaths.length > 0) {
      const imageResult = await describeImages({
        agent: imageAgent,
        codexBin,
        codexModel,
        codexFallbackModel,
        codexTimeoutMs,
        imageDescriber,
        imagePaths
      });
      imageDescription = imageResult.text;
      recordInboxImageAiLog(store, {
        agent: imageAgent,
        dt: nowDate.toISOString(),
        status: imageResult.status,
        inboxId,
        imagePaths,
        imageDescription,
        error: imageResult.error,
        model: imageResult.model,
        durationMs: imageResult.durationMs
      });
      if (imageResult.status !== 'done') return { ok: false, reason: 'image_description_failed' };
      store.createInboxNormalizationEvent({
        inboxId,
        payload: {
          normalization_text: normalizeBlocks({
            imageDescription,
            analysis: item.normalization_text
          })
        },
        nowIso: nowDate.toISOString()
      });
    }

    const freshItem = store.getInboxItem(inboxId) ?? item;
    const classes = store.listInboxClasses();
    const normalizerAgent = store.getAgent(INBOX_NORMALIZER_AGENT_ID);
    const normalizeResult = await normalizeInbox({
      agent: normalizerAgent,
      codexBin,
      codexModel,
      codexFallbackModel,
      codexTimeoutMs,
      normalizer,
      item: freshItem,
      classes,
      imageDescription
    });
    if (normalizeResult.status !== 'done') {
      recordInboxNormalizerAiLog(store, {
        agent: normalizerAgent,
        dt: nowDate.toISOString(),
        status: normalizeResult.status,
        inboxId,
        item: freshItem,
        classes,
        imageDescription,
        output: normalizeResult.output,
        error: normalizeResult.error,
        model: normalizeResult.model,
        durationMs: normalizeResult.durationMs
      });
      return { ok: false, reason: 'normalizer_failed' };
    }
    const knownClass = classes.find((entry) => entry.key === normalizeResult.classKey);
    if (!knownClass) {
      store.upsertInboxClass({
        key: normalizeResult.classKey,
        title: normalizeResult.classTitle || normalizeResult.classKey,
        description: normalizeResult.classDescription || 'Класс предложен AI-разбором Inbox.',
        status: 'candidate',
        createdByAgentId: INBOX_NORMALIZER_AGENT_ID,
        nowIso: nowDate.toISOString()
      });
    }
    const normalizationText = normalizeBlocks({
      imageDescription,
      analysis: normalizeResult.normalization
    });
    store.createInboxNormalizationEvent({
      inboxId,
      payload: {
        title: normalizeResult.title,
        description_md: normalizeResult.description,
        preliminary_section: normalizeResult.classKey,
        normalization_text: normalizationText,
        is_normalized: true
      },
      nowIso: nowDate.toISOString()
    });
    recordInboxNormalizerAiLog(store, {
      agent: normalizerAgent,
      dt: nowDate.toISOString(),
      status: normalizeResult.status,
      inboxId,
      item: freshItem,
      classes,
      imageDescription,
      output: {
        title: normalizeResult.title,
        description: normalizeResult.description,
        classKey: normalizeResult.classKey,
        normalization: normalizationText
      },
      error: normalizeResult.error,
      model: normalizeResult.model,
      durationMs: normalizeResult.durationMs
    });
    return { ok: true, image_described: imagePaths.length > 0, class_key: normalizeResult.classKey };
  } finally {
    unlockInbox(store, inboxId);
  }
}

export function serveInboxAttachment(req, res, url, storageRoot, sendJson, store = null) {
  const prefix = '/v1/inbox/attachments/';
  if (!url.pathname.startsWith(prefix)) return false;
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
    sendJson(req, res, 404, { error: 'not_found' });
    return true;
  }
  if (store && !store.canReadInboxAttachment(name)) {
    sendJson(req, res, 404, { error: 'not_found' });
    return true;
  }

  const root = path.resolve(storageRoot);
  const filePath = path.resolve(root, name);
  if (!filePath.startsWith(root + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(req, res, 404, { error: 'not_found' });
    return true;
  }

  res.writeHead(200, {
    'content-type': contentTypeForName(name),
    'cache-control': 'private, max-age=86400'
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

export function imagePreviewName(name) {
  return `${name}${IMAGE_PREVIEW_SUFFIX}`;
}

export function originalNameForImagePreview(name) {
  return name.endsWith(IMAGE_PREVIEW_SUFFIX) ? name.slice(0, -IMAGE_PREVIEW_SUFFIX.length) : null;
}

function requiredText(value, message) {
  const text = optionalText(value);
  if (text) return text;
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalBodyText(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function structuredBodyText(value) {
  if (value == null || typeof value === 'string') return optionalBodyText(value);
  return JSON.stringify(value, null, 2);
}

function decodeAttachments(body) {
  const rawAttachments = [];
  if (body?.image_base64 !== undefined || body?.image_mime !== undefined) {
    rawAttachments.push({
      base64: body.image_base64,
      mime: body.image_mime,
      legacyImage: true
    });
  }

  if (body?.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) throwStatus('invalid_attachments', 400);
    for (const attachment of body.attachments) rawAttachments.push(attachment);
  }

  if (rawAttachments.length > MAX_ATTACHMENTS) throwStatus('too_many_attachments', 400);

  let totalBytes = 0;
  return rawAttachments.map((raw) => {
    const legacyImage = raw?.legacyImage === true;
    const mime = optionalText(raw?.mime ?? raw?.file_mime ?? raw?.image_mime);
    const attachmentType = ATTACHMENT_TYPES.get(mime);
    if (!attachmentType) {
      throwStatus(legacyImage ? 'invalid_image_mime' : 'unsupported_attachment_mime', 400);
    }

    const source = optionalText(raw?.base64 ?? raw?.file_base64 ?? raw?.data_base64);
    const bytes = decodeBase64(source);
    if (!bytes) throwStatus(legacyImage ? 'invalid_image' : 'invalid_attachment', 400);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throwStatus(legacyImage ? 'image_too_large' : 'attachment_too_large', 413);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throwStatus('attachments_too_large', 413);
    if (!attachmentType.valid(bytes)) throwStatus(legacyImage ? 'invalid_image' : 'invalid_attachment', 400);
    return { bytes, extension: attachmentType.extension, mime };
  });
}

function createImagePreview(filePath, previewPath) {
  if (fs.existsSync(previewPath)) return false;
  const result = spawnSync(process.env.BRAI_THUMBNAIL_FFMPEG_BIN ?? 'ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${IMAGE_PREVIEW_MAX_PX},iw)':'min(${IMAGE_PREVIEW_MAX_PX},ih)':force_original_aspect_ratio=decrease`,
    '-q:v',
    '5',
    previewPath
  ], { timeout: 5000 });
  if (result.status === 0 && fs.existsSync(previewPath)) return true;
  fs.rmSync(previewPath, { force: true });
  return false;
}

function decodeBase64(value) {
  if (!value) return null;
  const source = value.replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
  if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) return null;
  const bytes = Buffer.from(source, 'base64');
  return bytes.length > 0 ? bytes : null;
}

function validUtf8Text(bytes) {
  if (bytes.includes(0)) return false;
  try {
    UTF8_DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function validJson(bytes) {
  if (!validUtf8Text(bytes)) return false;
  try {
    JSON.parse(bytes.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

function validZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]);
}

function optionalBoolean(value, message) {
  if (value == null) return false;
  if (value === true || value === 'true' || value === 1) return true;
  if (value === false || value === 'false' || value === 0) return false;
  throwStatus(message, 400);
}

function safeOptionalBoolean(value) {
  try {
    return optionalBoolean(value, 'invalid_response_required');
  } catch {
    return null;
  }
}

function inboxRecordTypeId(value) {
  if (value == null) return 1;
  const number = Number(value);
  if (number === 1 || number === 2) return number;
  throwStatus('invalid_record_type', 400);
}

function safeInboxRecordTypeId(value) {
  try {
    return inboxRecordTypeId(value);
  } catch {
    return null;
  }
}

function referencesPreviousMessage(value) {
  const text = value.toLocaleLowerCase('ru');
  return /(предыдущ|прошл|previous|last)/.test(text) && /(прикреп|добав|attach|append)/.test(text);
}

function throwStatus(message, status) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function describeImages({ agent, codexBin, codexModel, codexFallbackModel, codexTimeoutMs, imageDescriber, imagePaths }) {
  const startedAt = Date.now();
  const model = codexModel ?? optionalText(agent?.llm_model) ?? '';
  try {
    const result = imageDescriber
      ? { text: await imageDescriber({ imagePaths }), model }
      : await codexTextWithModelRetry({
        codexBin,
        codexModel: model || null,
        codexFallbackModel,
        promptTemplate: optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_IMAGE_PROMPT_TEMPLATE,
        timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
        images: imagePaths
      });
    const clean = cleanText(result.text);
    const durationMs = Date.now() - startedAt;
    if (!clean) return { text: '', status: 'failed', error: 'empty_image_description', model: result.model, durationMs };
    if (imageDescriptionRefused(clean)) return { text: '', status: 'failed', error: 'image_description_refused', model: result.model, durationMs };
    return { text: clean, status: 'done', error: '', model: result.model, durationMs };
  } catch (error) {
    return { text: '', status: 'failed', error: errorText(error), model, durationMs: Date.now() - startedAt };
  }
}

async function normalizeInbox({ agent, codexBin, codexModel, codexFallbackModel, codexTimeoutMs, normalizer, item, classes, imageDescription }) {
  const startedAt = Date.now();
  const model = codexModel ?? optionalText(agent?.llm_model) ?? '';
  try {
    const result = normalizer
      ? { text: await normalizer({ item, classes, imageDescription }), model }
      : await codexTextWithModelRetry({
        codexBin,
        codexModel: model || null,
        codexFallbackModel,
        promptTemplate: renderNormalizerPrompt(
          optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_NORMALIZER_PROMPT_TEMPLATE,
          item,
          classes,
          imageDescription
        ),
        timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms
      });
    const parsed = typeof result.text === 'string' ? parseNormalizerJson(result.text) : result.text;
    const normalized = cleanNormalization(parsed);
    return { ...normalized, status: 'done', error: '', model: result.model, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'failed',
      error: errorText(error),
      model,
      durationMs: Date.now() - startedAt,
      output: {
        title: '',
        description: '',
        classKey: '',
        normalization: ''
      }
    };
  }
}

function cleanNormalization(value) {
  const normalized = {
    title: cleanTitle(value?.title),
    description: cleanText(value?.description),
    classKey: cleanClassKey(value?.class_key ?? value?.classKey),
    classTitle: cleanText(value?.class_title ?? value?.classTitle),
    classDescription: cleanText(value?.class_description ?? value?.classDescription),
    normalization: cleanText(value?.normalization)
  };
  if (!normalized.title || !normalized.description || !normalized.classKey || !normalized.normalization) {
    throw new Error('invalid_normalizer_output');
  }
  return normalized;
}

function renderNormalizerPrompt(template, item, classes, imageDescription) {
  return template
    .replaceAll('{{classes}}', JSON.stringify(classes, null, 2))
    .replaceAll('{{text}}', item.explanation_text || '')
    .replaceAll('{{description}}', item.description_md || '')
    .replaceAll('{{image_description}}', imageDescription || '');
}

function parseNormalizerJson(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(text);
}

function recordInboxImageAiLog(store, { agent, dt, status, inboxId, imagePaths, imageDescription, error, model, durationMs }) {
  store.recordAiLog({
    agentId: INBOX_IMAGE_AGENT_ID,
    agentVersion: agent?.version ?? '',
    dt,
    status,
    aiTitle: status === 'done' ? 'Описал картинку Inbox' : 'Не описал картинку Inbox',
    flowId: inboxId,
    flowCommand: 'describe_image',
    jsonData: {
      schema: 'brai.ai_log.v1',
      inputs: [
        { ref: 'inbox.id', value: inboxId },
        { ref: 'inbox.attachments.images', value: imagePaths.map((filePath) => path.basename(filePath)) }
      ],
      outputs: [
        { ref: 'inbox.normalization_text.image_description', value: imageDescription }
      ],
      usage: usageBlock(model),
      timings_ms: timingsBlock(durationMs),
      metadata: { error: error || null }
    }
  });
}

function recordInboxNormalizerAiLog(store, { agent, dt, status, inboxId, item, classes, imageDescription, output, error, model, durationMs }) {
  store.recordAiLog({
    agentId: INBOX_NORMALIZER_AGENT_ID,
    agentVersion: agent?.version ?? '',
    dt,
    status,
    aiTitle: status === 'done' ? 'Разобрал Inbox-запись' : 'Не разобрал Inbox-запись',
    flowId: inboxId,
    flowCommand: 'normalize',
    jsonData: {
      schema: 'brai.ai_log.v1',
      inputs: [
        { ref: 'inbox.id', value: inboxId },
        { ref: 'inbox.explanation_text', value: item.explanation_text || '' },
        { ref: 'inbox.description_text', value: item.description_md || '' },
        { ref: 'inbox.normalization_text.image_description', value: imageDescription || '' },
        { ref: 'inbox_classes.keys', value: classes.map((entry) => entry.key) }
      ],
      outputs: [
        { ref: 'inbox.title', value: output.title },
        { ref: 'inbox.description_text', value: output.description },
        { ref: 'inbox.preliminary_section', value: output.classKey },
        { ref: 'inbox.normalization_text', value: output.normalization }
      ],
      usage: usageBlock(model),
      timings_ms: timingsBlock(durationMs),
      metadata: {
        error: error || null
      }
    }
  });
}

function initialTitle(text) {
  return cleanTitle(text.split(/\s+/).slice(0, 7).join(' ')) || 'Входящее';
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'«“”]+|["'»“”]+$/g, '')
    .slice(0, 80)
    .trim() ?? '';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 8000) : '';
}

function cleanClassKey(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z][a-z0-9_-]{1,62}$/.test(text) ? text : '';
}

function normalizeBlocks({ imageDescription, analysis }) {
  return [
    imageDescription ? `## Описание картинки\n\n${imageDescription}` : '',
    analysis ? `## Разбор\n\n${analysis}` : ''
  ].filter(Boolean).join('\n\n').trim();
}

async function codexTextWithModelRetry({ codexFallbackModel = null, ...input }) {
  const models = [input.codexModel ?? null];
  if (codexFallbackModel && codexFallbackModel !== input.codexModel) models.push(codexFallbackModel);
  let lastError = null;
  for (const model of models) {
    try {
      return { text: await codexText({ ...input, codexModel: model }), model: model ?? '' };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('codex_inbox_failed');
}

function codexText({ codexBin = 'codex', codexModel = null, promptTemplate, timeoutMs = 3000, images = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbox-ai-'));
  const outputPath = path.join(tmp, 'output.txt');
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 3000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const args = [
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never'
    ];
    if (codexModel) args.push('--model', codexModel);
    args.push(
      'exec',
      '--ephemeral',
      '--skip-git-repo-check'
    );
    if (images.length > 0) {
      args.push('--cd', os.tmpdir());
      for (const imagePath of images) args.push('--image', imagePath);
    }
    args.push(
      '--output-last-message',
      outputPath,
      '-'
    );
    const child = spawn(codexBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('codex_inbox_timeout'));
    }, timeout);

    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(cleanCodexError(stderr) || 'codex_inbox_failed'));
        return;
      }
      finish(resolve, fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '');
    });
    child.stdin.end(promptTemplate);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      callback(value);
    }
  });
}

function usageBlock(model) {
  const clean = cleanText(model);
  return clean ? { model: clean } : {};
}

function timingsBlock(durationMs) {
  return Number.isFinite(durationMs) ? { total: Math.max(0, Math.round(durationMs)) } : {};
}

function imageDescriptionRefused(value) {
  const text = value.toLocaleLowerCase('ru');
  return /^(к сожалению,?\s*)?(я\s+)?(не могу|не удалось|не способен|cannot|can't|unable).{0,160}(изображ|картин|image|файл|file|обработ|разобрат|access|read)/i.test(text);
}

function cleanCodexError(value) {
  return cleanText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
}

function errorText(error) {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function compactTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function contentTypeForName(name) {
  const extension = name.split('.').pop();
  if (extension && CONTENT_TYPES_BY_EXTENSION.has(extension)) return CONTENT_TYPES_BY_EXTENSION.get(extension);
  return 'application/octet-stream';
}

function imagePathsForItem(item, storageRoot) {
  const root = path.resolve(storageRoot);
  return item.attachment_links
    .filter((link) => /\.(gif|jpe?g|png|webp)(?:$|\?)/i.test(link))
    .map((link) => decodeURIComponent(path.basename(link.split('?')[0] ?? link)))
    .filter((name) => /^[a-zA-Z0-9_.-]+$/.test(name))
    .map((name) => path.resolve(root, name))
    .filter((filePath) => filePath.startsWith(root + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile());
}

function tryInboxLock(store, inboxId) {
  try {
    const value = store.db
      .prepare('SELECT pg_try_advisory_lock(hashtext(?)) AS locked')
      .get(`inbox:${inboxId}`)?.locked;
    return value === true || value === 1;
  } catch {
    return true;
  }
}

function unlockInbox(store, inboxId) {
  try {
    store.db
      .prepare('SELECT pg_advisory_unlock(hashtext(?))')
      .get(`inbox:${inboxId}`);
  } catch {
    // Some local adapters do not expose PostgreSQL advisory lock functions.
  }
}
