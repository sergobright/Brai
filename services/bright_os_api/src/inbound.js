import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const INBOUND_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_TYPES = new Map([
  ['image/png', { extension: 'png', valid: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE) }],
  ['image/jpeg', { extension: 'jpg', valid: (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff }],
  ['image/webp', { extension: 'webp', valid: (bytes) => bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' }]
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function inboundPathTarget(pathname) {
  const prefix = '/v1/in/';
  if (!pathname.startsWith(prefix)) return null;
  const target = pathname.slice(prefix.length);
  return target && !target.includes('/') ? target : null;
}

export function hasInboundToken(req, token) {
  return Boolean(token) && req.headers.authorization === `Bearer ${token}`;
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
  const image = decodeImage(body);
  const nowIso = nowDate.toISOString();
  const idempotencyKey = optionalText(body?.idempotency_key);
  const stableId = idempotencyKey ? shortHash(idempotencyKey) : null;
  const inboxId = stableId ? `inbound:inbox:${stableId}` : `inbound:inbox:${crypto.randomUUID()}`;
  const eventId = stableId ? `inbound:inbox:${stableId}:create` : `inbound:inbox:${crypto.randomUUID()}:create`;
  const existingInboxId = stableId ? store.inboxIdForEvent(eventId) : null;
  if (existingInboxId) {
    return { inbox_id: existingInboxId, created: false, attachment_links: [] };
  }

  fs.mkdirSync(storageRoot, { recursive: true });
  const fileName = `${compactTimestamp(nowDate)}-${stableId ?? crypto.randomUUID()}.${image.extension}`;
  const filePath = path.join(storageRoot, fileName);
  const attachmentLink = `/v1/inbox/attachments/${fileName}`;

  try {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, image.bytes, { flag: 'wx' });
    const title = await generateTitle(text, { codexBin, codexModel, codexTimeoutMs, titleGenerator });
    store.createInboundInboxItem({
      eventId,
      inboxId,
      title,
      explanationText: text,
      attachmentLinks: [attachmentLink],
      source: optionalText(body?.source) ?? 'inbound',
      nowIso
    });
  } catch (error) {
    if (!stableId) fs.rmSync(filePath, { force: true });
    throw error;
  }

  return {
    inbox_id: inboxId,
    created: true,
    attachment_links: [attachmentLink]
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

function decodeImage(body) {
  const mime = optionalText(body?.image_mime);
  const imageType = IMAGE_TYPES.get(mime);
  if (!imageType) {
    const error = new Error('invalid_image_mime');
    error.status = 400;
    throw error;
  }

  const source = optionalText(body?.image_base64);
  if (!source || source.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source)) {
    const error = new Error('invalid_image');
    error.status = 400;
    throw error;
  }

  const bytes = Buffer.from(source, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    const error = new Error(bytes.length > MAX_IMAGE_BYTES ? 'image_too_large' : 'invalid_image');
    error.status = bytes.length > MAX_IMAGE_BYTES ? 413 : 400;
    throw error;
  }
  if (!imageType.valid(bytes)) {
    const error = new Error('invalid_image');
    error.status = 400;
    throw error;
  }
  return { bytes, extension: imageType.extension };
}

async function generateTitle(text, { codexBin, codexModel, codexTimeoutMs, titleGenerator }) {
  const fallback = fallbackTitle(text);
  try {
    const title = titleGenerator
      ? await titleGenerator(text)
      : await codexTitle(text, codexBin, codexModel, codexTimeoutMs);
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

function codexTitle(text, codexBin = 'codex', codexModel = null, timeoutMs = 3000) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-inbound-title-'));
  const outputPath = path.join(tmp, 'title.txt');
  const prompt = [
    'Сгенерируй короткий русский заголовок для входящего сообщения.',
    'Верни только заголовок, без Markdown, кавычек и пояснений.',
    '',
    text
  ].join('\n');

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
    }, timeoutMs);

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

function compactTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function contentTypeForName(name) {
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}
