import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import {
  DEFAULT_INBOX_IMAGE_MODEL,
  DEFAULT_INBOX_TEXT_MODEL
} from './store-app-settings.js';
import { INBOX_WORKFLOW_DEFINITION_VERSION } from './store-workflows.js';
import { scopedUserId } from './user-scope.js';

export const INBOX_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_INBOX_CODEX_BIN = '/srv/opt/codex-cli/bin/codex';
export const DEFAULT_INBOX_CODEX_MODEL = 'gpt-5.4-mini';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
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
const INBOX_OPERATION_CLASS = 'operation';
const DEFAULT_IMAGE_PROMPT_TEMPLATE = [
  'Опиши изображение для Inbox на русском языке.',
  'Нужно детальное, фактическое описание: что видно, какой интерфейс/экран, важные тексты, объекты, состояния, числа и возможный пользовательский контекст.',
  'Не выдумывай невидимые детали. Верни только описание.'
].join('\n');
const DEFAULT_NORMALIZER_PROMPT_TEMPLATE = [
  'Разбери Inbox-запись на русском языке.',
  'Нужно сопоставить голосовой транскрипт, текстовый контекст и описание картинки.',
  'Сохраняй исходное намерение пользователя и все названные им сущности, имена и названия.',
  'Исправляй очевидные опечатки, но не меняй смысл.',
  'Если хотя бы один вход непустой, не называй запись пустой и не утверждай, что контекст отсутствует.',
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
const DEFAULT_NORMALIZER_CODEX_INSTRUCTIONS = [
  'You are a deterministic JSON normalizer.',
  "Follow the user's task exactly and return one JSON object matching the provided output schema.",
  'Do not use tools, browse, inspect files, or add commentary.'
].join(' ');

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

export function inboxIngestIdempotencyHash(idempotencyKey) {
  const key = optionalText(idempotencyKey);
  return key ? fullHash(`${scopedUserId() ?? 'unclaimed'}\0${key}`) : null;
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
  const ingestIdempotencyHash = inboxIngestIdempotencyHash(idempotencyKey);
  const stableId = ingestIdempotencyHash?.slice(0, 32) ?? null;
  const inboxId = stableId ? `inbox:api:${stableId}` : `inbox:api:${crypto.randomUUID()}`;
  const eventId = stableId ? `inbox:api:${stableId}:create` : `inbox:api:${crypto.randomUUID()}:create`;
  const source = optionalText(body?.source) ?? 'inbox';
  const responseRequired = optionalBoolean(body?.response_required, 'invalid_response_required');
  const recordTypeId = inboxRecordTypeId(body?.record_type_id ?? body?.record_type);
  const preliminarySection = inboxPreliminarySection(body?.preliminary_section, recordTypeId);
  if (preliminarySection === INBOX_OPERATION_CLASS && !idempotencyKey) {
    throwStatus('operation_idempotency_key_required', 400);
  }
  const sourceKey = optionalText(body?.source_key) ?? (preliminarySection === INBOX_OPERATION_CLASS ? idempotencyKey : '');
  const ingestPayloadHash = fullHash(JSON.stringify({
    text,
    descriptionText,
    source,
    sourceKey,
    responseRequired,
    recordTypeId,
    preliminarySection,
    attachments: attachments.map((attachment) => ({ mime: attachment.mime, sha256: fullHash(attachment.bytes) }))
  }));
  const existingInboxId = stableId ? store.inboxIdForEvent(eventId) : null;
  if (existingInboxId) {
    const existing = store.getInboxIngestFingerprint(existingInboxId);
    if (existing?.ingest_payload_hash && existing.ingest_payload_hash !== ingestPayloadHash) {
      throwStatus('idempotency_conflict', 409);
    }
    recordInboxIngestLog(store, {
      nowIso,
      body,
      attachments,
      source,
      sourceKey,
      recordTypeId,
      preliminarySection,
      responseRequired,
      idempotencyKey,
      logContext,
      inboxId: existingInboxId,
      eventId,
      created: false,
      reason: 'duplicate'
    });
    return { inbox_id: existingInboxId, created: false, attachment_links: [] };
  }

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
    const created = store.createInboxApiItem({
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
      preliminarySection,
      ingestIdempotencyHash,
      ingestPayloadHash,
      nowIso
    });
    if (!created.accepted_event) {
      const existing = store.getInboxIngestFingerprint(inboxId);
      if (existing?.ingest_payload_hash && existing.ingest_payload_hash !== ingestPayloadHash) {
        throwStatus('idempotency_conflict', 409);
      }
      for (const filePath of writtenPaths) fs.rmSync(filePath, { force: true });
      recordInboxIngestLog(store, {
        nowIso,
        body,
        attachments,
        source,
        sourceKey,
        recordTypeId,
        preliminarySection,
        responseRequired,
        idempotencyKey,
        logContext,
        inboxId,
        eventId,
        created: false,
        reason: 'duplicate'
      });
      return { inbox_id: inboxId, created: false, attachment_links: [] };
    }
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
    preliminarySection,
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
  preliminarySection,
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
      preliminary_section: preliminarySection || null,
      operation_inbox: preliminarySection === INBOX_OPERATION_CLASS,
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
  externalAi = {},
  imageDescriber,
  normalizer,
  nowDate = new Date()
}) {
  if (!tryInboxLock(store, inboxId)) return { skipped: true, reason: 'locked' };
  try {
    const execution = store.ensureInboxWorkflowExecution({ inboxId, nowIso: nowDate.toISOString() });
    const workflowId = execution.workflow_id;
    const runId = execution.run_id ?? `inline:${crypto.randomUUID()}`;
    const prepared = prepareInboxNormalization({ store, inboxId, workflowId, runId, storageRoot, nowDate });
    if (prepared.skipped) return prepared;

    let imageDescription = '';
    if (prepared.imageRequired) {
      const imageResult = await describeInboxImagesForWorkflow({
        store,
        inboxId,
        workflowId,
        runId,
        storageRoot,
        codexBin,
        codexModel,
        codexTimeoutMs,
        externalAi,
        imageDescriber,
        nowDate
      });
      if (!imageResult.ok) {
        store.failInboxWorkflow({ inboxId, workflowId, runId, reason: imageResult.error, step: 'image_describer', nowIso: nowDate.toISOString() });
        return { ok: false, reason: 'image_description_failed' };
      }
      imageDescription = imageResult.imageDescription;
    }

    let validationError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await normalizeInboxRawForWorkflow({
        store,
        inboxId,
        workflowId,
        runId,
        attempt,
        validationError,
        imageDescription,
        codexBin,
        codexModel: attempt > 1 && codexFallbackModel ? codexFallbackModel : codexModel,
        codexTimeoutMs,
        externalAi,
        normalizer,
        nowDate
      });
      if (result.ok) {
        try {
          const applied = applyNormalizedInboxForWorkflow({
            store,
            inboxId,
            workflowId,
            runId,
            normalized: result.normalized,
            imageDescription,
            nowDate
          });
          return {
            ...applied,
            image_described: prepared.imageRequired,
            class_key: applied.class_key ?? result.normalized.classKey
          };
        } catch (error) {
          store.failInboxWorkflow({
            inboxId,
            workflowId,
            runId,
            reason: errorText(error),
            step: 'apply_normalized_raw',
            attemptCount: attempt,
            nowIso: nowDate.toISOString()
          });
          return { ok: false, reason: 'apply_failed' };
        }
      }
      if (!result.validationFailed) {
        store.failInboxWorkflow({
          inboxId,
          workflowId,
          runId,
          reason: result.error,
          attemptCount: attempt,
          nowIso: nowDate.toISOString()
        });
        return { ok: false, reason: 'normalizer_failed' };
      }
      validationError = result.error;
    }

    store.failInboxWorkflow({
      inboxId,
      workflowId,
      runId,
      reason: validationError || 'normalizer_validation_failed',
      needsReview: true,
      attemptCount: 3,
      nowIso: nowDate.toISOString()
    });
    return { ok: false, reason: 'normalizer_validation_failed' };
  } finally {
    unlockInbox(store, inboxId);
  }
}

export function prepareInboxNormalization({ store, inboxId, workflowId, runId, storageRoot, nowDate = new Date() }) {
  const item = store.getInboxItem(inboxId);
  if (!item || item.deleted_at_utc || item.item_roles_id) {
    return { skipped: true, reason: item?.item_roles_id ? 'already_normalized' : item ? 'deleted' : 'missing' };
  }
  const active = store.markInboxWorkflowStep({
    inboxId,
    workflowId,
    runId,
    step: 'prepare_raw',
    nowIso: nowDate.toISOString()
  });
  if (!active) return { skipped: true, reason: 'workflow_not_active' };
  const imageRequired = imagePathsForItem(item, storageRoot).length > 0;
  if (!rawInboxText(item) && !cleanText(item.description_md) && !imageRequired) {
    store.failInboxWorkflow({
      inboxId,
      workflowId,
      runId,
      reason: 'raw_input_empty',
      step: 'prepare_raw',
      needsReview: true,
      nowIso: nowDate.toISOString()
    });
    return { skipped: true, reason: 'raw_input_empty' };
  }
  store.recordInboxWorkflowStepFinished?.({
    inboxId,
    workflowId,
    runId,
    stepKey: 'prepare_raw',
    status: 'completed',
    nowIso: nowDate.toISOString(),
    metadataJson: { image_required: imageRequired }
  });
  if (!imageRequired) {
    store.recordInboxWorkflowStepSkipped?.({
      inboxId,
      workflowId,
      runId,
      stepKey: 'image_describer',
      reason: 'not_required',
      nowIso: nowDate.toISOString()
    });
  }
  return { ok: true, imageRequired };
}

export async function describeInboxImagesForWorkflow({
  store,
  inboxId,
  workflowId,
  runId,
  storageRoot,
  codexBin,
  codexModel,
  codexTimeoutMs,
  externalAi = {},
  imageDescriber,
  nowDate = new Date()
}) {
  const item = store.getInboxItem(inboxId);
  const imagePaths = item ? imagePathsForItem(item, storageRoot) : [];
  if (!item || imagePaths.length === 0) return { ok: true, imageDescription: '' };
  const active = store.markInboxWorkflowStep({
    inboxId,
    workflowId,
    runId,
    step: 'image_describer',
    attemptCount: 1,
    nowIso: nowDate.toISOString()
  });
  if (!active) return { ok: false, error: 'workflow_not_active' };
  const agent = store.getAgent(INBOX_IMAGE_AGENT_ID);
  const result = await describeImages({
    agent,
    settings: store.appSettings?.(),
    codexBin,
    codexModel,
    codexTimeoutMs,
    externalAi,
    imageDescriber,
    imagePaths
  });
  const aiLogId = recordInboxImageAiLog(store, {
    agent,
    dt: nowDate.toISOString(),
    status: result.status,
    inboxId,
    imagePaths,
    imageDescription: result.text,
    error: result.error,
    model: result.model,
    durationMs: result.durationMs,
    workflowId,
    runId,
    attemptNumber: 1
  });
  store.recordInboxWorkflowStepFinished?.({
    inboxId,
    workflowId,
    runId,
    stepKey: 'image_describer',
    status: result.status === 'done' ? 'completed' : 'failed',
    aiLogId,
    errorCode: result.error || null,
    errorSummary: result.error || null,
    nowIso: nowDate.toISOString(),
    metadataJson: { model: result.model, duration_ms: result.durationMs }
  });
  return result.status === 'done'
    ? { ok: true, imageDescription: result.text }
    : { ok: false, error: result.error || 'image_description_failed' };
}

export async function normalizeInboxRawForWorkflow({
  store,
  inboxId,
  workflowId,
  runId,
  attempt,
  validationError = '',
  imageDescription = '',
  codexBin,
  codexModel,
  codexTimeoutMs,
  externalAi = {},
  normalizer,
  nowDate = new Date()
}) {
  const item = store.getInboxItem(inboxId);
  if (!item || item.deleted_at_utc || item.item_roles_id) {
    return { ok: false, validationFailed: false, error: item?.item_roles_id ? 'already_normalized' : 'raw_record_missing' };
  }
  const active = store.markInboxWorkflowStep({
    inboxId,
    workflowId,
    runId,
    step: 'raw_normalizer',
    attemptCount: attempt,
    nowIso: nowDate.toISOString()
  });
  if (!active) return { ok: false, validationFailed: false, error: 'workflow_not_active' };
  const classes = store.listInboxClasses();
  const execution = store.getInboxWorkflowExecution(inboxId);
  const workflowVersion = execution?.workflow_definition_version;
  const outputSchema = store.getInboxWorkflowOutputSchema(workflowVersion);
  if (!outputSchema) {
    return { ok: false, validationFailed: false, error: 'workflow_output_schema_missing' };
  }
  const agent = store.getAgent(INBOX_NORMALIZER_AGENT_ID);
  const result = await normalizeInbox({
    agent,
    settings: store.appSettings?.(),
    codexBin,
    codexModel,
    codexTimeoutMs,
    externalAi,
    normalizer,
    item,
    classes,
    imageDescription,
    validationError,
    outputSchema,
    strictOutputSchema: workflowVersion >= 2 && workflowVersion <= INBOX_WORKFLOW_DEFINITION_VERSION
  });
  const aiLogId = recordInboxNormalizerAiLog(store, {
    agent,
    dt: nowDate.toISOString(),
    status: result.status === 'done' ? 'done' : 'failed',
    inboxId,
    item,
    classes,
    imageDescription,
    output: result.status === 'done' ? result : result.output,
    error: result.error,
    model: result.model,
    durationMs: result.durationMs,
    workflowId,
    runId,
    attemptNumber: attempt
  });
  store.recordInboxWorkflowStepFinished?.({
    inboxId,
    workflowId,
    runId,
    stepKey: 'raw_normalizer',
    attempt,
    status: result.status === 'done' ? 'completed' : 'failed',
    aiLogId,
    errorCode: result.error || null,
    errorSummary: result.error || null,
    nowIso: nowDate.toISOString(),
    metadataJson: {
      model: result.model,
      duration_ms: result.durationMs,
      validation_failed: result.validationFailed === true
    }
  });
  return result.status === 'done'
    ? { ok: true, normalized: result }
    : { ok: false, validationFailed: result.validationFailed === true, error: result.error };
}

export function applyNormalizedInboxForWorkflow({
  store,
  inboxId,
  workflowId,
  runId,
  normalized,
  imageDescription = '',
  deferTerminal = false,
  nowDate = new Date()
}) {
  store.markInboxWorkflowStep({
    inboxId,
    workflowId,
    runId,
    step: 'apply_normalized_raw',
    nowIso: nowDate.toISOString()
  });
  const result = store.applyNormalizedInbox({
    inboxId,
    workflowId,
    runId,
    normalized,
    normalizationText: normalizeBlocks({ imageDescription, analysis: normalized.normalization }),
    deferTerminal,
    nowIso: nowDate.toISOString()
  });
  store.recordInboxWorkflowStepFinished?.({
    inboxId,
    workflowId,
    runId,
    stepKey: 'apply_normalized_raw',
    status: 'completed',
    nowIso: nowDate.toISOString(),
    metadataJson: {
      items_id: result.items_id,
      item_roles_id: result.item_roles_id,
      idempotent: result.idempotent === true
    }
  });
  if (!deferTerminal) {
    store.recordInboxWorkflowStepStarted?.({
      inboxId,
      workflowId,
      runId,
      stepKey: 'terminal_reconcile',
      nowIso: nowDate.toISOString(),
      metadataJson: { inline: true }
    });
    store.recordInboxWorkflowStepFinished?.({
      inboxId,
      workflowId,
      runId,
      stepKey: 'terminal_reconcile',
      status: 'skipped',
      errorCode: 'inline_execution',
      errorSummary: 'inline_execution',
      nowIso: nowDate.toISOString(),
      metadataJson: { inline: true }
    });
  }
  return result;
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

function inboxRecordTypeId(value) {
  if (value == null) return 1;
  const number = Number(value);
  if (number === 1 || number === 2) return number;
  throwStatus('invalid_record_type', 400);
}

function inboxPreliminarySection(value, recordTypeId) {
  const raw = optionalText(value);
  if (!raw) return '';
  const key = cleanClassKey(raw);
  if (key !== INBOX_OPERATION_CLASS || recordTypeId !== 2) {
    throwStatus('invalid_preliminary_section', 400);
  }
  return key;
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

async function describeImages({ agent, settings, codexBin, codexModel, codexTimeoutMs, externalAi, imageDescriber, imagePaths }) {
  const startedAt = Date.now();
  const external = settings?.model_provider_mode === 'external';
  const model = external
    ? cleanText(settings?.inbox_image_model) || DEFAULT_INBOX_IMAGE_MODEL
    : codexModel ?? optionalText(agent?.llm_model) ?? '';
  try {
    const result = imageDescriber
      ? { text: await imageDescriber({ imagePaths }), model }
      : external
        ? { text: await openAiImageText({
            apiKey: externalAi?.openaiApiKey,
            fetchImpl: externalAi?.fetch,
            model,
            promptTemplate: optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_IMAGE_PROMPT_TEMPLATE,
            timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
            imagePaths
          }), model }
      : { text: await codexText({
        codexBin,
        codexModel: model || null,
        promptTemplate: optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_IMAGE_PROMPT_TEMPLATE,
        timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
        images: imagePaths
      }), model };
    const clean = cleanText(result.text);
    const durationMs = Date.now() - startedAt;
    if (!clean) return { text: '', status: 'failed', error: 'empty_image_description', model: result.model, durationMs };
    if (imageDescriptionRefused(clean)) return { text: '', status: 'failed', error: 'image_description_refused', model: result.model, durationMs };
    return { text: clean, status: 'done', error: '', model: result.model, durationMs };
  } catch (error) {
    return { text: '', status: 'failed', error: errorText(error), model, durationMs: Date.now() - startedAt };
  }
}

export async function normalizeJsonWithAgent({
  agent,
  settings,
  codexBin,
  codexModel,
  codexTimeoutMs,
  externalAi,
  normalizer,
  normalizerInput,
  promptTemplate,
  outputSchema,
  strictOutputSchema,
  cleanOutput,
  defaultCodexModel = DEFAULT_INBOX_CODEX_MODEL,
  externalTextModel = null,
  schemaName = 'raw_normalization',
  timeoutPrefix = 'raw'
}) {
  const startedAt = Date.now();
  const external = settings?.model_provider_mode === 'external';
  const model = external
    ? cleanText(externalTextModel) || DEFAULT_INBOX_TEXT_MODEL
    : codexModel ?? optionalText(agent?.llm_model) ?? defaultCodexModel;
  let result;
  try {
    result = normalizer
      ? { text: await normalizer(normalizerInput), model }
      : external
        ? { text: await groqText({
            apiKey: externalAi?.groqApiKey,
            fetchImpl: externalAi?.fetch,
            model,
            promptTemplate,
            timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
            outputSchema: strictOutputSchema ? outputSchema : null,
            schemaName,
            timeoutMessage: `groq_${timeoutPrefix}_timeout`,
            emptyResponseMessage: `groq_${timeoutPrefix}_empty_response`
          }), model }
        : { text: await codexText({
          codexBin,
          codexModel: model || null,
          promptTemplate,
          timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
          outputSchema: strictOutputSchema ? outputSchema : null,
          normalizerMode: true,
          timeoutMessage: `codex_${timeoutPrefix}_timeout`,
          failureMessage: `codex_${timeoutPrefix}_failed`
        }), model };
  } catch (error) {
    return failedJsonNormalization(errorText(error), model, Date.now() - startedAt, false);
  }
  try {
    const parsed = typeof result.text === 'string' ? parseNormalizerJson(result.text) : result.text;
    validateJsonSchema(parsed, outputSchema);
    const normalized = cleanOutput(parsed);
    return { ...normalized, status: 'done', error: '', model: result.model, durationMs: Date.now() - startedAt };
  } catch (error) {
    return failedJsonNormalization(errorText(error), result.model, Date.now() - startedAt, true, result.text);
  }
}

async function normalizeInbox({
  agent,
  settings,
  codexBin,
  codexModel,
  codexTimeoutMs,
  externalAi,
  normalizer,
  item,
  classes,
  imageDescription,
  validationError,
  outputSchema,
  strictOutputSchema
}) {
  const startedAt = Date.now();
  const external = settings?.model_provider_mode === 'external';
  const model = external
    ? cleanText(settings?.inbox_text_model) || DEFAULT_INBOX_TEXT_MODEL
    : codexModel ?? optionalText(agent?.llm_model) ?? DEFAULT_INBOX_CODEX_MODEL;
  let result;
  try {
    result = normalizer
      ? { text: await normalizer({ item, classes, imageDescription, validationError }), model }
      : external
        ? { text: await groqText({
            apiKey: externalAi?.groqApiKey,
            fetchImpl: externalAi?.fetch,
            model,
            promptTemplate: renderNormalizerPrompt(
              optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_NORMALIZER_PROMPT_TEMPLATE,
              item,
              classes,
              imageDescription,
              validationError
            ),
            timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
            outputSchema: strictOutputSchema ? outputSchema : null
          }), model }
      : { text: await codexText({
        codexBin,
        codexModel: model || null,
        promptTemplate: renderNormalizerPrompt(
          optionalBodyText(agent?.llm_prompt_template) ?? DEFAULT_NORMALIZER_PROMPT_TEMPLATE,
          item,
          classes,
          imageDescription,
          validationError
        ),
        timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : agent?.llm_timeout_ms,
        outputSchema: strictOutputSchema ? outputSchema : null,
        normalizerMode: true
      }), model };
  } catch (error) {
    return failedNormalization(errorText(error), model, Date.now() - startedAt, false);
  }
  try {
    const parsed = typeof result.text === 'string' ? parseNormalizerJson(result.text) : result.text;
    validateJsonSchema(parsed, outputSchema);
    const normalized = cleanNormalization(parsed);
    return { ...normalized, status: 'done', error: '', model: result.model, durationMs: Date.now() - startedAt };
  } catch (error) {
    return failedNormalization(errorText(error), result.model, Date.now() - startedAt, true);
  }
}

function validateJsonSchema(value, schema) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ path: '$', code: 'type', expected: 'object' });
  } else {
    const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of Array.isArray(schema?.required) ? schema.required : []) {
      if (!(key in value)) errors.push({ path: `$.${key}`, code: 'required' });
    }
    if (schema?.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push({ path: `$.${key}`, code: 'additional_property' });
      }
    }
    for (const [key, rule] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const candidate = value[key];
      if (rule?.type === 'string' && typeof candidate !== 'string') {
        errors.push({ path: `$.${key}`, code: 'type', expected: 'string' });
        continue;
      }
      if (typeof candidate === 'string') {
        if (Number.isInteger(rule?.minLength) && candidate.length < rule.minLength) {
          errors.push({ path: `$.${key}`, code: 'minLength', expected: rule.minLength });
        }
        if (Number.isInteger(rule?.maxLength) && candidate.length > rule.maxLength) {
          errors.push({ path: `$.${key}`, code: 'maxLength', expected: rule.maxLength });
        }
        if (typeof rule?.pattern === 'string' && !new RegExp(rule.pattern).test(candidate)) {
          errors.push({ path: `$.${key}`, code: 'pattern', expected: rule.pattern });
        }
      }
    }
  }
  if (errors.length > 0) throw new Error(`schema_validation_failed:${JSON.stringify(errors.slice(0, 10))}`);
}

function failedNormalization(error, model, durationMs, validationFailed) {
  return {
    status: 'failed',
    validationFailed,
    error,
    model,
    durationMs,
    output: { title: '', description: '', classKey: '', normalization: '' }
  };
}

function failedJsonNormalization(error, model, durationMs, validationFailed, output = null) {
  return {
    status: 'failed',
    validationFailed,
    error,
    model,
    durationMs,
    output
  };
}

function cleanNormalization(value) {
  const normalized = {
    title: cleanNormalizedTitle(value?.title),
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

function cleanNormalizedTitle(value) {
  const title = cleanTitle(value);
  const guillemets = title.match(/[«»]/g)?.length ?? 0;
  return guillemets % 2 === 0 ? title : title.replace(/[«»]/g, '');
}

function renderNormalizerPrompt(template, item, classes, imageDescription, validationError = '') {
  const basePrompt = template
    .replaceAll('{{classes}}', JSON.stringify(classes, null, 2))
    .replaceAll('{{text}}', rawInboxText(item))
    .replaceAll('{{description}}', item.description_md || '')
    .replaceAll('{{image_description}}', imageDescription || '')
    .replaceAll('{{validation_error}}', validationError || '');
  const preliminarySection = cleanClassKey(item?.preliminary_section);
  const prompt = preliminarySection
    ? `${basePrompt}\n\nПредварительный тип из ingest: ${preliminarySection}. Если он задан, верни его как class_key.`
    : basePrompt;
  return validationError
    ? `${prompt}\n\nОшибка валидации предыдущего ответа:\n${validationError}\nИсправь JSON и верни только валидный объект.`
    : prompt;
}

function rawInboxText(item) {
  return cleanText(item?.explanation_text) || cleanText(item?.title);
}

function parseNormalizerJson(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(text);
}

function recordInboxImageAiLog(store, {
  agent, dt, status, inboxId, imagePaths, imageDescription, error, model, durationMs,
  workflowId, runId, attemptNumber
}) {
  return store.recordAiLog({
    agentId: INBOX_IMAGE_AGENT_ID,
    agentVersion: agent?.version ?? '',
    dt,
    status,
    aiTitle: status === 'done' ? 'Описал картинку Inbox' : 'Не описал картинку Inbox',
    flowId: inboxId,
    flowCommand: 'describe_image',
    workflowId,
    runId,
    attemptNumber,
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

function recordInboxNormalizerAiLog(store, {
  agent, dt, status, inboxId, item, classes, imageDescription, output, error, model, durationMs,
  workflowId, runId, attemptNumber
}) {
  return store.recordAiLog({
    agentId: INBOX_NORMALIZER_AGENT_ID,
    agentVersion: agent?.version ?? '',
    dt,
    status,
    aiTitle: status === 'done' ? 'Разобрал Inbox-запись' : 'Не разобрал Inbox-запись',
    flowId: inboxId,
    flowCommand: 'normalize',
    workflowId,
    runId,
    attemptNumber,
    jsonData: {
      schema: 'brai.ai_log.v1',
      inputs: [
        { ref: 'inbox.id', value: inboxId },
        { ref: 'inbox.explanation_text', value: rawInboxText(item) },
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

async function groqText({
  apiKey,
  fetchImpl = fetch,
  model,
  promptTemplate,
  timeoutMs = 3000,
  outputSchema = null,
  schemaName = 'inbox_normalization',
  timeoutMessage = 'groq_inbox_timeout',
  emptyResponseMessage = 'groq_inbox_empty_response'
}) {
  if (!apiKey) throw new Error('GROQ_API_KEY is not configured');
  const body = {
    model,
    messages: [
      { role: 'system', content: DEFAULT_NORMALIZER_CODEX_INSTRUCTIONS },
      { role: 'user', content: promptTemplate }
    ],
    temperature: 0
  };
  if (outputSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        schema: outputSchema
      }
    };
  }
  const payload = await requestJson(GROQ_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body),
    timeoutMs,
    timeoutMessage,
    fetchImpl
  });
  const text = extractChatText(payload);
  if (!text) throw new Error(emptyResponseMessage);
  return text;
}

async function openAiImageText({ apiKey, fetchImpl = fetch, model, promptTemplate, timeoutMs = 3000, imagePaths }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const payload = await requestJson(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: promptTemplate },
            ...imagePaths.map((imagePath) => ({
              type: 'input_image',
              image_url: imageDataUrl(imagePath),
              detail: 'auto'
            }))
          ]
        }
      ]
    }),
    timeoutMs,
    timeoutMessage: 'openai_image_inbox_timeout',
    fetchImpl
  });
  const text = extractResponseText(payload);
  if (!text) throw new Error('openai_image_empty_response');
  return text;
}

async function requestJson(url, { method, headers, body, timeoutMs, timeoutMessage, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const payload = text ? parseJson(text) ?? { raw: text } : {};
  if (!response.ok) throw new Error(providerError(payload) || `provider_http_${response.status}`);
  return payload;
}

function extractChatText(payload) {
  return cleanText(payload?.choices?.[0]?.message?.content);
}

function extractResponseText(payload) {
  const direct = cleanText(payload?.output_text);
  if (direct) return direct;
  const chunks = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      const text = cleanText(content?.text);
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n').trim();
}

function imageDataUrl(imagePath) {
  const extension = path.extname(imagePath).slice(1).toLowerCase();
  const mime = CONTENT_TYPES_BY_EXTENSION.get(extension) ?? 'image/png';
  return `data:${mime};base64,${fs.readFileSync(imagePath).toString('base64')}`;
}

function providerError(payload) {
  return cleanText(payload?.error?.message) || cleanText(payload?.message) || cleanText(payload?.raw);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function codexText({
  codexBin = DEFAULT_INBOX_CODEX_BIN,
  codexModel = DEFAULT_INBOX_CODEX_MODEL,
  promptTemplate,
  timeoutMs = 3000,
  images = [],
  outputSchema = null,
  normalizerMode = false,
  timeoutMessage = 'codex_inbox_timeout',
  failureMessage = 'codex_inbox_failed'
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbox-ai-'));
  const outputPath = path.join(tmp, 'output.txt');
  const schemaPath = outputSchema ? path.join(tmp, 'output-schema.json') : null;
  const isolatedNormalizer = normalizerMode || Boolean(outputSchema);
  const instructionsPath = isolatedNormalizer ? path.join(tmp, 'model-instructions.txt') : null;
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 3000;
  const executable = !codexBin || codexBin === 'codex' ? DEFAULT_INBOX_CODEX_BIN : codexBin;

  if (isolatedNormalizer) {
    try {
      if (schemaPath) fs.writeFileSync(schemaPath, JSON.stringify(outputSchema), { mode: 0o600 });
      fs.writeFileSync(instructionsPath, DEFAULT_NORMALIZER_CODEX_INSTRUCTIONS, { mode: 0o600 });
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    const args = [];
    if (isolatedNormalizer) {
      args.push(
        '-c', 'model_reasoning_effort="low"',
        '-c', 'model_verbosity="low"',
        '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`,
        '-c', 'features.apps=false',
        '-c', 'features.image_generation=false',
        '-c', 'features.shell_tool=false',
        '-c', 'features.unified_exec=false',
        '-c', 'features.multi_agent=false',
        '-c', 'web_search="disabled"',
        '-c', 'tools_view_image=false'
      );
    }
    args.push('--sandbox', 'read-only', '--ask-for-approval', 'never');
    if (codexModel) args.push('--model', codexModel);
    args.push(
      'exec',
      '--ephemeral'
    );
    if (isolatedNormalizer) {
      args.push(
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--cd', tmp
      );
      if (schemaPath) args.push('--output-schema', schemaPath);
    } else {
      args.push('--skip-git-repo-check');
    }
    if (!schemaPath && images.length > 0) {
      args.push('--cd', os.tmpdir());
      for (const imagePath of images) args.push('--image', imagePath);
    }
    args.push(
      '--output-last-message',
      outputPath,
      '-'
    );
    let child;
    try {
      child = spawn(executable, args, {
        cwd: isolatedNormalizer ? tmp : undefined,
        detached: true,
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      killProcessGroup(child);
      finish(reject, new Error(timeoutMessage));
    }, timeout);

    child.stdin?.on('error', () => {});
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(cleanCodexError(stderr) || failureMessage));
        return;
      }
      try {
        finish(resolve, fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '');
      } catch (error) {
        finish(reject, error);
      }
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

function killProcessGroup(child) {
  try {
    if (Number.isInteger(child.pid) && child.pid > 0) {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
  } catch {}
  try {
    child.kill('SIGKILL');
  } catch {}
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

function fullHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
