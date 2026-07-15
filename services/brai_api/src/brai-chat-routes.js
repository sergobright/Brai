import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeBraiChatError } from './brai-chat-sanitize.js';
import { scopedUserId } from './user-scope.js';

const THREAD_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)$/;
const THREAD_ACTION_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)\/(archive|restore)$/;
const THREAD_MESSAGES_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)\/messages$/;
const THREAD_EVENTS_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)\/events$/;
const THREAD_ATTACHMENTS_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)\/attachments$/;
const THREAD_STEER_PATH = /^\/v1\/brai-chat\/threads\/([^/]+)\/steer$/;
const ATTACHMENT_PATH = /^\/v1\/brai-chat\/attachments\/([^/]+)$/;
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
const STALE_ATTACHMENT_MS = 24 * 60 * 60 * 1_000;
const ATTACHMENT_REAP_LIMIT = 100;
const ATTACHMENT_SCAN_LIMIT = 500;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isBraiChatRoute(pathname) {
  return pathname === '/v1/brai-chat' || pathname.startsWith('/v1/brai-chat/');
}

export function createBraiChatUploadGate({ maxConcurrent = 2, maxPerUser = 2 } = {}) {
  const totalLimit = positiveInteger(maxConcurrent, 2);
  const userLimit = Math.min(totalLimit, positiveInteger(maxPerUser, 2));
  const activeByUser = new Map();
  let active = 0;
  return {
    tryAcquire(userId) {
      const userActive = activeByUser.get(userId) ?? 0;
      if (active >= totalLimit || userActive >= userLimit) return null;
      active += 1;
      activeByUser.set(userId, userActive + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const remaining = (activeByUser.get(userId) ?? 1) - 1;
        if (remaining > 0) activeByUser.set(userId, remaining);
        else activeByUser.delete(userId);
      };
    }
  };
}

export async function handleBraiChatRoute({
  req, res, url, store, runtime, vaultRoot, uploadGate, sendJson, readJson,
  now = () => new Date(), logger = console
}) {
  if (req.method === 'GET' && url.pathname === '/v1/brai-chat/models') {
    sendJson(req, res, 200, await modelCatalog(runtime));
    return;
  }

  if (url.pathname === '/v1/brai-chat/threads') {
    if (req.method === 'GET') {
      sendJson(req, res, 200, {
        threads: store.listBraiChatThreads({ archived: archiveParam(url, 'active') })
      });
      return;
    }
    if (req.method === 'POST') {
      await readJson(req, { limit: 1024 });
      sendJson(req, res, 201, { thread: store.createBraiChatThread({ nowIso: now().toISOString() }) });
      return;
    }
  }

  const threadMatch = url.pathname.match(THREAD_PATH);
  if (threadMatch) {
    const threadId = opaqueId(threadMatch[1]);
    if (req.method === 'GET') {
      sendThread(req, res, sendJson, store.getBraiChatThread(threadId));
      return;
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req, { limit: 16 * 1024 });
      const current = store.getBraiChatThread(threadId);
      if (!current) return sendThread(req, res, sendJson, null);
      const update = await validatedThreadUpdate(body, current, runtime);
      sendThread(req, res, sendJson, store.updateBraiChatThread(threadId, update, now().toISOString()));
      return;
    }
  }

  const actionMatch = url.pathname.match(THREAD_ACTION_PATH);
  if (req.method === 'POST' && actionMatch) {
    const thread = store.archiveBraiChatThread(
      opaqueId(actionMatch[1]), actionMatch[2] === 'archive', now().toISOString()
    );
    sendThread(req, res, sendJson, thread);
    return;
  }

  const messagesMatch = url.pathname.match(THREAD_MESSAGES_PATH);
  if (req.method === 'GET' && messagesMatch) {
    const result = store.listBraiChatMessages(opaqueId(messagesMatch[1]), {
      cursor: unsignedInteger(url.searchParams.get('cursor'), 0),
      limit: boundedLimit(url.searchParams.get('limit'), 50, 200)
    });
    if (!result) return notFound(req, res, sendJson);
    sendJson(req, res, 200, { messages: result.items, next_cursor: result.next_cursor });
    return;
  }

  const eventsMatch = url.pathname.match(THREAD_EVENTS_PATH);
  if (req.method === 'GET' && eventsMatch) {
    const result = store.replayBraiChatEvents(opaqueId(eventsMatch[1]), {
      after: unsignedInteger(url.searchParams.get('after'), 0),
      limit: boundedLimit(url.searchParams.get('limit'), 200, 500)
    });
    if (!result) return notFound(req, res, sendJson);
    sendJson(req, res, 200, { events: result.items, next_cursor: result.next_cursor });
    return;
  }

  const steerMatch = url.pathname.match(THREAD_STEER_PATH);
  if (req.method === 'POST' && steerMatch) {
    const threadId = opaqueId(steerMatch[1]);
    if (!store.getBraiChatThread(threadId)) return notFound(req, res, sendJson);
    if (typeof runtime?.steer !== 'function') throw httpError('brai_chat_runtime_unavailable', 503);
    const steer = validatedSteer(await readJson(req, { limit: 512 * 1024 }));
    try {
      await runtime.steer({
        store, userId: scopedUserId(), publicThreadId: threadId,
        messageId: steer.message_id, text: steer.text
      });
    } catch (error) {
      throw publicRuntimeError(error);
    }
    sendJson(req, res, 202, { accepted: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/brai-chat/search') {
    const query = url.searchParams.get('q') ?? '';
    if (!query.trim()) throw httpError('query_required', 400);
    sendJson(req, res, 200, {
      results: store.searchBraiChat(query, {
        archived: archiveParam(url, 'all'),
        limit: boundedLimit(url.searchParams.get('limit'), 20, 50)
      })
    });
    return;
  }

  const uploadMatch = url.pathname.match(THREAD_ATTACHMENTS_PATH);
  if (req.method === 'POST' && uploadMatch) {
    const threadId = opaqueId(uploadMatch[1]);
    if (!store.getBraiChatThread(threadId)) return notFound(req, res, sendJson);
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MULTIPART_BYTES) {
      throw httpError('attachments_too_large', 413);
    }
    const userId = scopedUserId();
    const releaseUpload = uploadGate?.tryAcquire(userId);
    if (!releaseUpload) throw httpError('chat_upload_busy', 429);
    reapStaleBraiChatAttachments({
      store, vaultRoot, userId: scopedUserId(), before: new Date(now().getTime() - STALE_ATTACHMENT_MS), logger
    });
    try {
      const files = validateImages(await readMultipart(req));
      const attachments = persistAttachments({
        store, vaultRoot, userId, threadId, files, nowIso: now().toISOString(), logger
      });
      sendJson(req, res, 201, { attachments });
    } finally {
      releaseUpload();
    }
    return;
  }

  const attachmentMatch = url.pathname.match(ATTACHMENT_PATH);
  if (req.method === 'GET' && attachmentMatch) {
    serveAttachment(req, res, store, vaultRoot, opaqueId(attachmentMatch[1]), sendJson);
    return;
  }
  if (req.method === 'DELETE' && attachmentMatch) {
    const attachment = store.deleteUnlinkedBraiChatAttachment(opaqueId(attachmentMatch[1]));
    if (!attachment) return notFound(req, res, sendJson);
    removeAttachmentFile(vaultRoot, scopedUserId(), attachment, logger);
    sendJson(req, res, 200, { deleted: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/brai-chat/runtime') {
    if (typeof runtime?.handleRequest !== 'function') throw httpError('brai_chat_runtime_unavailable', 503);
    try {
      await runtime.handleRequest({
        req, res, url, store, sendJson, readJson, userId: scopedUserId()
      });
    } catch (error) {
      throw publicRuntimeError(error);
    }
    return;
  }

  sendJson(req, res, 405, { error: 'method_not_allowed' });
}

async function modelCatalog(runtime) {
  if (typeof runtime?.listModels !== 'function') throw httpError('brai_chat_runtime_unavailable', 503);
  let raw;
  try {
    raw = await runtime.listModels({ userId: scopedUserId() });
  } catch (error) {
    throw publicRuntimeError(error);
  }
  const source = Array.isArray(raw) ? raw : raw?.models;
  if (!Array.isArray(source)) throw httpError('brai_chat_runtime_unavailable', 503);
  const models = source.map((model) => {
    const id = typeof model?.id === 'string' ? model.id.trim() : '';
    if (!id) return null;
    const efforts = Array.isArray(model.reasoning_efforts)
      ? [...new Set(model.reasoning_efforts.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
      : [];
    const defaultEffort = efforts.includes(model.default_reasoning_effort) ? model.default_reasoning_effort : efforts[0] ?? null;
    return {
      id,
      display_name: typeof model.display_name === 'string' && model.display_name.trim()
        ? model.display_name.trim() : id,
      reasoning_efforts: efforts,
      default_reasoning_effort: defaultEffort
    };
  }).filter(Boolean);
  const defaultModel = models.some((model) => model.id === raw?.default_model)
    ? raw.default_model : models[0]?.id ?? null;
  const selected = models.find((model) => model.id === defaultModel);
  return {
    models,
    default_model: defaultModel,
    default_reasoning_effort: selected?.default_reasoning_effort ?? null
  };
}

function publicRuntimeError(error) {
  if (Number.isInteger(error?.status) && /^[a-z0-9_]{1,80}$/.test(error?.message ?? '')) {
    return error;
  }
  const safe = safeBraiChatError(error);
  return httpError(safe.code, 503);
}

async function validatedThreadUpdate(body, current, runtime) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError('invalid_thread_update', 400);
  const allowed = new Set(['title', 'model', 'reasoning_effort']);
  if (!Object.keys(body).every((key) => allowed.has(key)) || Object.keys(body).length === 0) {
    throw httpError('invalid_thread_update', 400);
  }
  if (!Object.hasOwn(body, 'model') && !Object.hasOwn(body, 'reasoning_effort')) return body;
  const catalog = await modelCatalog(runtime);
  const modelId = Object.hasOwn(body, 'model') ? nullableString(body.model) : current.model;
  const model = modelId ? catalog.models.find((entry) => entry.id === modelId) : null;
  if (modelId && !model) throw httpError('invalid_model', 400);
  let reasoning = Object.hasOwn(body, 'reasoning_effort')
    ? nullableString(body.reasoning_effort) : current.reasoning_effort;
  if (reasoning && (!model || !model.reasoning_efforts.includes(reasoning))) {
    if (Object.hasOwn(body, 'reasoning_effort')) throw httpError('invalid_reasoning_effort', 400);
    reasoning = model?.default_reasoning_effort ?? null;
  }
  return { ...body, model: modelId, reasoning_effort: reasoning };
}

async function readMultipart(req) {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw httpError('multipart_required', 415);
  }
  try {
    const request = new Request('http://localhost/v1/brai-chat/attachments', {
      method: 'POST',
      headers: req.headers,
      body: Readable.toWeb(Readable.from(boundedBody(req))),
      duplex: 'half'
    });
    const form = await request.formData();
    return Promise.all([...form.values()]
      .filter((value) => typeof value !== 'string')
      .map(async (file) => ({ filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
  } catch (error) {
    if (error?.status) throw error;
    throw httpError('invalid_multipart', 400);
  }
}

async function* boundedBody(req) {
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_MULTIPART_BYTES) throw httpError('attachments_too_large', 413);
    yield bytes;
  }
}

function validateImages(files) {
  if (!files.length) throw httpError('attachments_required', 400);
  if (files.length > MAX_FILES) throw httpError('too_many_attachments', 400);
  let total = 0;
  return files.map((file) => {
    total += file.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw httpError('attachments_too_large', 413);
    const detected = detectImage(file.bytes);
    if (!detected) throw httpError('unsupported_attachment_format', 400);
    return { ...file, ...detected };
  });
}

function detectImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { media_type: 'image/png', extension: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { media_type: 'image/jpeg', extension: 'jpg' };
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return { media_type: 'image/webp', extension: 'webp' };
  }
  return null;
}

function persistAttachments({ store, vaultRoot, userId, threadId, files, nowIso, logger }) {
  const user = safeSegment(userId, 'invalid_vault_user_id');
  const thread = safeSegment(threadId, 'not_found', 404);
  const relativeDir = path.posix.join('Brai', 'Chat', thread);
  const directory = openVaultDirectory(vaultRoot, [user, 'Brai', 'Chat', thread]);
  const written = [];
  try {
    const metadata = files.map((file) => {
      const id = crypto.randomUUID();
      const relativePath = path.posix.join(relativeDir, id);
      const filePath = directory.path(id);
      let fd;
      try {
        fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT
          | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o660);
        written.push(id);
        if (!fdIsBeneath(fd, directory.rootFd) || !fs.fstatSync(fd).isFile()) {
          throw httpError('not_found', 404);
        }
        fs.writeFileSync(fd, file.bytes);
      } finally {
        if (fd != null) fs.closeSync(fd);
      }
      return {
        id,
        original_name: safeFilename(file.filename, `image.${file.extension}`),
        relative_path: relativePath,
        media_type: file.media_type,
        byte_size: file.bytes.length,
        checksum_sha256: crypto.createHash('sha256').update(file.bytes).digest('hex')
      };
    });
    const saved = store.addBraiChatAttachments(threadId, metadata, nowIso);
    if (!Array.isArray(saved) || saved.length !== metadata.length) throw httpError('not_found', 404);
    return saved;
  } catch (error) {
    let cleanupFailures = 0;
    for (const name of written) {
      try { fs.rmSync(directory.path(name), { force: true }); } catch { cleanupFailures += 1; }
    }
    if (cleanupFailures) {
      logger?.error?.('Brai chat attachment cleanup failed', {
        code: 'brai_chat_attachment_cleanup_failed', count: cleanupFailures
      });
    }
    throw error;
  } finally {
    directory.close();
  }
}

function openVaultDirectory(vaultRoot, segments, { create = true } = {}) {
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const fds = [];
  try {
    const rootFd = fs.openSync(path.resolve(vaultRoot), flags);
    fds.push(rootFd);
    let currentFd = rootFd;
    for (const segment of segments) {
      const child = `/proc/self/fd/${currentFd}/${safeSegment(segment, 'not_found', 404)}`;
      if (create) {
        try {
          fs.mkdirSync(child, { mode: 0o770 });
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
      currentFd = fs.openSync(child, flags);
      fds.push(currentFd);
      if (!fs.fstatSync(currentFd).isDirectory() || !fdIsBeneath(currentFd, rootFd)) {
        throw httpError('not_found', 404);
      }
    }
    return {
      rootFd,
      fd: currentFd,
      path: (name) => `/proc/self/fd/${currentFd}/${safeSegment(name, 'not_found', 404)}`,
      close: () => closeFds(fds)
    };
  } catch (error) {
    closeFds(fds);
    if (error?.code === 'ELOOP' || error?.code === 'ENOTDIR') throw httpError('not_found', 404);
    throw error;
  }
}

function fdIsBeneath(fd, rootFd) {
  const root = fs.realpathSync(`/proc/self/fd/${rootFd}`);
  const opened = fs.realpathSync(`/proc/self/fd/${fd}`);
  return opened === root || opened.startsWith(`${root}${path.sep}`);
}

function closeFds(fds) {
  for (const fd of fds.reverse()) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function serveAttachment(req, res, store, vaultRoot, attachmentId, sendJson) {
  const attachment = store.getBraiChatAttachment(attachmentId, { internal: true });
  if (!attachment) return notFound(req, res, sendJson);
  const user = safeSegment(scopedUserId(), 'invalid_vault_user_id');
  const thread = safeSegment(attachment.thread_id, 'not_found', 404);
  const file = safeSegment(attachment.id, 'not_found', 404);
  if (attachment.relative_path !== path.posix.join('Brai', 'Chat', thread, file)) {
    return notFound(req, res, sendJson);
  }
  let fd;
  let directory;
  try {
    directory = openVaultDirectory(vaultRoot, [user, 'Brai', 'Chat', thread], { create: false });
    fd = fs.openSync(directory.path(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== attachment.byte_size || !fdIsBeneath(fd, directory.rootFd)) {
      throw httpError('not_found', 404);
    }
  } catch {
    if (fd != null) fs.closeSync(fd);
    directory?.close();
    return notFound(req, res, sendJson);
  }
  directory.close();
  res.writeHead(200, {
    'content-type': attachment.media_type,
    'content-length': attachment.byte_size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    'cache-control': 'private, max-age=86400'
  });
  const stream = fs.createReadStream(null, { fd, autoClose: true });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export function reapStaleBraiChatAttachments({ store, vaultRoot, userId, before, logger }) {
  let removed = 0;
  try {
    const stale = store.takeStaleUnlinkedBraiChatAttachments(
      before.toISOString(), ATTACHMENT_REAP_LIMIT
    );
    for (const attachment of stale) {
      if (removeAttachmentFile(vaultRoot, userId, attachment, logger)) removed += 1;
    }
    removed += reapFileOrphans({
      store, vaultRoot, userId, beforeMs: before.getTime(),
      limit: ATTACHMENT_REAP_LIMIT - removed
    });
  } catch {
    logger?.error?.('Brai chat stale attachment cleanup failed', {
      code: 'brai_chat_stale_attachment_cleanup_failed'
    });
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function reapFileOrphans({ store, vaultRoot, userId, beforeMs, limit }) {
  if (limit <= 0) return 0;
  let chatDirectory;
  let threadEntries;
  let removed = 0;
  let scanned = 0;
  try {
    chatDirectory = openVaultDirectory(vaultRoot, [
      safeSegment(userId, 'invalid_vault_user_id'), 'Brai', 'Chat'
    ], { create: false });
    threadEntries = fs.opendirSync(`/proc/self/fd/${chatDirectory.fd}`);
    let threadEntry;
    while (removed < limit && scanned < ATTACHMENT_SCAN_LIMIT
      && (threadEntry = threadEntries.readSync())) {
      if (!threadEntry.isDirectory() || !/^[A-Za-z0-9_-]{1,200}$/.test(threadEntry.name)) continue;
      let threadDirectory;
      let fileEntries;
      try {
        threadDirectory = openVaultDirectory(vaultRoot, [
          userId, 'Brai', 'Chat', threadEntry.name
        ], { create: false });
        fileEntries = fs.opendirSync(`/proc/self/fd/${threadDirectory.fd}`);
        let fileEntry;
        while (removed < limit && scanned < ATTACHMENT_SCAN_LIMIT
          && (fileEntry = fileEntries.readSync())) {
          scanned += 1;
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileEntry.name)) continue;
          const filePath = threadDirectory.path(fileEntry.name);
          const stat = fs.lstatSync(filePath);
          if (stat.mtimeMs >= beforeMs || store.getBraiChatAttachment(fileEntry.name, { internal: true })) continue;
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        // A replaced directory is skipped; held dirfds prevent traversal.
      } finally {
        fileEntries?.closeSync();
        threadDirectory?.close();
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    threadEntries?.closeSync();
    chatDirectory?.close();
  }
  return removed;
}

function removeAttachmentFile(vaultRoot, userId, attachment, logger) {
  const user = safeSegment(userId, 'invalid_vault_user_id');
  const thread = safeSegment(attachment.thread_id, 'not_found', 404);
  const file = safeSegment(attachment.id, 'not_found', 404);
  if (attachment.relative_path !== path.posix.join('Brai', 'Chat', thread, file)) return false;
  let directory;
  try {
    directory = openVaultDirectory(vaultRoot, [user, 'Brai', 'Chat', thread], { create: false });
    fs.unlinkSync(directory.path(file));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    logger?.error?.('Brai chat attachment file removal failed', {
      code: 'brai_chat_attachment_file_removal_failed'
    });
    return false;
  } finally {
    directory?.close();
  }
}

function sendThread(req, res, sendJson, thread) {
  if (!thread) return notFound(req, res, sendJson);
  sendJson(req, res, 200, { thread });
}

function notFound(req, res, sendJson) {
  sendJson(req, res, 404, { error: 'not_found' });
}

function archiveParam(url, fallback) {
  const value = url.searchParams.get('archived') ?? fallback;
  if (!['active', 'archived', 'all'].includes(value)) throw httpError('invalid_archive_filter', 400);
  return value;
}

function opaqueId(value) {
  try {
    const id = decodeURIComponent(value);
    if (/^[A-Za-z0-9_-]{1,200}$/.test(id)) return id;
  } catch {
    // fall through
  }
  throw httpError('not_found', 404);
}

function safeSegment(value, code, status = 500) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw httpError(code, status);
  return value;
}

function safeFilename(value, fallback) {
  const name = path.basename(String(value ?? '').replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  return name || fallback;
}

function boundedLimit(value, fallback, max) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) throw httpError('invalid_limit', 400);
  return number;
}

function unsignedInteger(value, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw httpError('invalid_cursor', 400);
  return number;
}

function nullableString(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw httpError('invalid_thread_update', 400);
  return value.trim();
}

function validatedSteer(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'message_id') || !Object.hasOwn(body, 'text')
    || typeof body.message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(body.message_id)
    || typeof body.text !== 'string' || !body.text.trim()
    || Buffer.byteLength(body.text.trim(), 'utf8') > 64 * 1024) {
    throw httpError('invalid_steer_request', 400);
  }
  return { message_id: body.message_id, text: body.text.trim() };
}

function httpError(code, status) {
  const error = new Error(code);
  error.status = status;
  return error;
}
