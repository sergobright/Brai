import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

export const INBOUND_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF_SIGNATURE = Buffer.from('%PDF-');
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
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
const INBOX_TITLE_HANDLER_ID = 'inbound.inbox.title_generator';
const DEFAULT_TITLE_PROMPT_TEMPLATE = [
  'Сгенерируй короткий русский заголовок для входящего сообщения.',
  'Верни только заголовок, без Markdown, кавычек и пояснений.',
  '',
  '{{text}}'
].join('\n');

export function inboundRequestTarget(req, body = {}) {
  return inboundTarget(body?.target ?? body?.destination)
    ?? inboundTarget(req.headers['x-brai-target'] ?? req.headers['x-brai-destination'])
    ?? 'inbox';
}

export function hasInboundApiKey(req, apiKey) {
  if (!apiKey) return false;
  return req.headers['x-brai-api-key'] === apiKey
    || req.headers['x-api-key'] === apiKey
    || req.headers.authorization === `Bearer ${apiKey}`;
}

function inboundTarget(value) {
  if (value == null || value === '') return null;
  const target = optionalText(value);
  if (target && !target.includes('/')) return target;
  throwStatus('invalid_target', 400);
}

export async function receiveInboxInbound({
  store,
  body,
  storageRoot,
  codexBin,
  codexModel,
  codexTimeoutMs,
  titleGenerator,
  nowDate
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
  const inboxId = stableId ? `inbound:inbox:${stableId}` : `inbound:inbox:${crypto.randomUUID()}`;
  const eventId = stableId ? `inbound:inbox:${stableId}:create` : `inbound:inbox:${crypto.randomUUID()}:create`;
  const existingInboxId = stableId ? store.inboxIdForEvent(eventId) : null;
  if (existingInboxId) {
    return { inbox_id: existingInboxId, created: false, attachment_links: [] };
  }

  const source = optionalText(body?.source) ?? 'inbound';
  const sourceKey = optionalText(body?.source_key) ?? '';
  const responseRequired = optionalBoolean(body?.response_required, 'invalid_response_required');
  const recordTypeId = inboundRecordTypeId(body?.record_type_id ?? body?.record_type);
  const relatedInboxId = referencesPreviousMessage(`${text}\n${descriptionText}`)
    ? store.latestInboxIdForInbound({ source, sourceKey })
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
      attachmentLinks.push(`/v1/inbox/attachments/${fileName}`);
    });
    const title = await generateTitle(text, {
      handler: store.getHandler(INBOX_TITLE_HANDLER_ID),
      codexBin,
      codexModel,
      codexTimeoutMs,
      titleGenerator
    });
    store.createInboundInboxItem({
      eventId,
      inboxId,
      title,
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

  return {
    inbox_id: inboxId,
    created: true,
    attachment_links: attachmentLinks
  };
}

export function serveInboxAttachment(req, res, url, storageRoot, sendJson) {
  const prefix = '/v1/inbox/attachments/';
  if (!url.pathname.startsWith(prefix)) return false;
  const name = decodeURIComponent(url.pathname.slice(prefix.length));
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
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
    return { bytes, extension: attachmentType.extension };
  });
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

function inboundRecordTypeId(value) {
  if (value == null) return 1;
  const number = Number(value);
  if (number === 1 || number === 2) return number;
  throwStatus('invalid_record_type', 400);
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

async function generateTitle(text, { handler, codexBin, codexModel, codexTimeoutMs, titleGenerator }) {
  const fallback = fallbackTitle(text);
  try {
    const title = titleGenerator
      ? await titleGenerator(text)
      : await codexTitle(text, {
        codexBin,
        codexModel: codexModel ?? optionalText(handler?.llm_model),
        promptTemplate: optionalBodyText(handler?.llm_prompt_template) ?? DEFAULT_TITLE_PROMPT_TEMPLATE,
        timeoutMs: Number.isFinite(codexTimeoutMs) ? codexTimeoutMs : handler?.llm_timeout_ms
      });
    return cleanTitle(title) || fallback;
  } catch {
    return fallback;
  }
}

function fallbackTitle(text) {
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

function codexTitle(text, { codexBin = 'codex', codexModel = null, promptTemplate, timeoutMs = 3000 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-inbound-title-'));
  const outputPath = path.join(tmp, 'title.txt');
  const prompt = renderPrompt(promptTemplate ?? DEFAULT_TITLE_PROMPT_TEMPLATE, text);
  const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 3000;

  return new Promise((resolve, reject) => {
    let settled = false;
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
      '--skip-git-repo-check',
      '--output-last-message',
      outputPath,
      '-'
    );
    const child = spawn(codexBin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error('codex_title_timeout'));
    }, timeout);

    child.once('error', (error) => finish(reject, error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error('codex_title_failed'));
        return;
      }
      finish(resolve, fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '');
    });
    child.stdin.end(prompt);

    function finish(callback, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      callback(value);
    }
  });
}

function renderPrompt(template, text) {
  return template.includes('{{text}}') ? template.replaceAll('{{text}}', text) : `${template.trim()}\n\n${text}`;
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
