import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { renderReleasePage } from '../../../deploy/scripts/release-page.mjs';

export function sendReleaseLoginPage(res, { status = 200, error = null } = {}) {
  const errorMarkup = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : '';
  sendHtml(
    res,
    status,
    `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Brai: релизы</title>
    <link rel="icon" href="data:,">
    <style>
      :root {
        color-scheme: dark;
        --bg: #0c1110;
        --panel: #121a18;
        --line: #2a3935;
        --text: #edf7f4;
        --muted: #9fb0ab;
        --accent: #4cc3ad;
        --accent-pressed: #3bb59f;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: var(--bg);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100dvh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px 18px;
        background: radial-gradient(circle at 22% 0%, rgb(76 195 173 / 16%), transparent 30rem), linear-gradient(135deg, #0c1110 0%, #121614 56%, #0a0e0d 100%);
      }
      main {
        width: min(380px, calc(100vw - 40px));
        border: 1px solid var(--line);
        border-radius: 8px;
        background: linear-gradient(145deg, rgb(255 255 255 / 7%), transparent 42%), var(--panel);
        padding: 28px;
        box-shadow: 0 24px 80px rgb(0 0 0 / 34%);
      }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
      .app-icon {
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
        border-radius: 8px;
        background: #e7f1f0;
        color: #0c1110;
        font-weight: 900;
      }
      .brand-name { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.35; }
      h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: 0; }
      p { margin: 0 0 18px; color: var(--muted); line-height: 1.5; }
      label { display: block; margin-bottom: 8px; font-weight: 700; }
      input {
        width: 100%;
        min-height: 48px;
        padding: 0 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgb(8 15 14 / 54%);
        color: var(--text);
        font: inherit;
      }
      input:focus { border-color: var(--accent); outline: 3px solid rgb(76 195 173 / 24%); }
      button {
        width: 100%;
        min-height: 48px;
        margin-top: 14px;
        border: 0;
        border-radius: 8px;
        background: var(--accent);
        color: #06110f;
        font: inherit;
        font-weight: 800;
        cursor: pointer;
      }
      button:hover { background: var(--accent-pressed); }
      button:active { transform: translateY(1px); }
      button:focus-visible { outline: 3px solid rgb(76 195 173 / 42%); outline-offset: 3px; }
      .error { color: #ff8f82; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <div class="app-icon" aria-hidden="true">B</div>
        <p class="brand-name">Brai<br>Приватные релизы</p>
      </div>
      <h1>Релизы Brai</h1>
      <p>Введите пароль релиза, чтобы скачать приватную Android-сборку.</p>
      ${errorMarkup}
      <form method="post" action="/dev-releases/login">
        <label for="password">Пароль</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
        <button type="submit">Открыть релизы</button>
      </form>
    </main>
  </body>
</html>`
  );
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(html);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function serveReleasePage(req, res, releaseDir, sendJson, { publicOnly = false, store = null } = {}) {
  if (!releaseDir) {
    recordReleaseFileLog(store, {
      status: 'failed',
      reason: 'releases_not_configured',
      requested: req.url
    });
    sendJson(req, res, 404, { error: 'releases_not_configured' });
    return;
  }

  const releaseIndex = readReleaseIndex(releaseDir);
  if (!releaseIndex) {
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  const data = publicOnly
    ? { ...releaseIndex, sections: { production: releaseIndex.sections?.production } }
    : releaseIndex;
  const body = Buffer.from(renderReleasePage(data, {
    downloadBase: publicOnly ? '/releases/download' : '/dev-releases'
  }));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

export async function serveReleaseDownload(req, res, releaseKey, releaseDir, sendJson, {
  limiter,
  store = null
} = {}) {
  const section = releaseSection(releaseDir, releaseKey);
  if (!section?.file) {
    recordReleaseFileLog(store, { status: 'failed', reason: 'not_found', requested: releaseKey });
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  const clientIp = releaseClientIp(req);
  if (!await consumeDownloadPoint(req, res, sendJson, limiter, store, releaseKey, clientIp)) return;
  serveApk(req, res, releaseDir, section.file, sendJson, store, { releaseKey, clientIp, sha256: section.sha256 });
}

export async function serveDeveloperReleaseFile(req, res, fileName, releaseDir, sendJson, { limiter, store = null } = {}) {
  const releaseIndex = readReleaseIndex(releaseDir);
  const section = Object.values(releaseIndex?.sections ?? {}).find((candidate) => candidate?.file === fileName);
  if (!section) {
    recordReleaseFileLog(store, { status: 'failed', reason: 'not_found', requested: fileName });
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  const clientIp = releaseClientIp(req);
  if (!await consumeDownloadPoint(req, res, sendJson, limiter, store, fileName, clientIp)) return;
  serveApk(req, res, releaseDir, fileName, sendJson, store, { clientIp, sha256: section.sha256 });
}

export async function serveLegacyProductionFile(req, res, fileName, releaseDir, sendJson, { limiter, store = null } = {}) {
  const production = releaseSection(releaseDir, 'production');
  if (!production?.file || production.file !== fileName) {
    recordReleaseFileLog(store, { status: 'failed', reason: 'not_found', requested: fileName });
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  const clientIp = releaseClientIp(req);
  if (!await consumeDownloadPoint(req, res, sendJson, limiter, store, fileName, clientIp)) return;
  serveApk(req, res, releaseDir, fileName, sendJson, store, { releaseKey: 'production', clientIp, sha256: production.sha256 });
}

async function consumeDownloadPoint(req, res, sendJson, limiter, store, requested, clientIp) {
  try {
    await limiter?.consume(clientIp);
    return true;
  } catch (rateLimit) {
    const retryAfter = Math.max(1, Math.ceil(Number(rateLimit?.msBeforeNext ?? 1000) / 1000));
    recordReleaseFileLog(store, { status: 'rate_limited', reason: 'download_limit', requested, clientIp });
    sendJson(req, res, 429, { error: 'rate_limited' }, { 'retry-after': String(retryAfter) });
    return false;
  }
}

function serveApk(req, res, releaseDir, requested, sendJson, store, { releaseKey = null, clientIp = null, sha256 = null } = {}) {
  if (!releaseDir) {
    sendJson(req, res, 404, { error: 'releases_not_configured' });
    return;
  }
  const root = path.resolve(releaseDir);
  const filePath = path.resolve(root, requested);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    recordReleaseFileLog(store, {
      status: 'failed',
      reason: 'forbidden',
      requested
    });
    sendJson(req, res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(filePath)) {
    recordReleaseFileLog(store, {
      status: 'failed',
      reason: 'not_found',
      requested
    });
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    recordReleaseFileLog(store, {
      status: 'failed',
      reason: 'not_file',
      requested
    });
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }

  if (!filePath.endsWith('.apk')) {
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }
  res.once('finish', () => recordReleaseFileLog(store, {
    status: 'done',
    requested,
    bytes: stat.size,
    releaseKey,
    clientIp
  }));
  res.writeHead(200, {
    'content-type': 'application/vnd.android.package-archive',
    'content-length': stat.size,
    'content-disposition': `attachment; filename="${path.basename(requested)}"`,
    ...(typeof sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sha256) ? { 'x-brai-apk-sha256': sha256.toLowerCase() } : {})
  });
  fs.createReadStream(filePath).pipe(res);
}

export function releaseClientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (isLoopback(peer)) {
    const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (net.isIP(forwarded)) return forwarded;
  }
  return peer || 'unknown';
}

function normalizeIp(value) {
  const ip = String(value ?? '');
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1';
}

function readReleaseIndex(releaseDir) {
  if (!releaseDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseDir, 'releases.json'), 'utf8'));
  } catch {
    return null;
  }
}

function releaseSection(releaseDir, releaseKey) {
  if (!['production', 'dev', 'a', 'b', 'c', 'd', 'e'].includes(releaseKey)) return null;
  return readReleaseIndex(releaseDir)?.sections?.[releaseKey] ?? null;
}

function recordReleaseFileLog(store, {
  status,
  reason = null,
  requested,
  bytes = null,
  releaseKey = null,
  clientIp = null
}) {
  try {
    store?.recordLog?.({
      source: 'release',
      operation: 'release.file_served',
      status: status === 'rate_limited' ? 'failed' : status,
      severityText: status === 'done' ? 'INFO' : 'WARN',
      reason: status === 'rate_limited' ? 'rate_limited' : reason,
      message: status === 'done' ? 'Release APK served' : status === 'rate_limited' ? 'Release APK rate limited' : 'Release file request failed',
      jsonData: {
        requested: safeReleaseRequestName(requested),
        extension: path.extname(requested || '').slice(1) || null,
        bytes,
        release_key: releaseKey,
        client_ip: clientIp,
        outcome: status,
        detail: reason
      }
    });
  } catch {
    // Release serving must not depend on optional logging.
  }
}

function safeReleaseRequestName(value) {
  return path.basename(String(value ?? '')).slice(0, 120) || null;
}
