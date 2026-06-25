import fs from 'node:fs';
import path from 'node:path';

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
    <title>Bright OS: релизы</title>
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
        <p class="brand-name">Bright OS<br>Приватные релизы</p>
      </div>
      <h1>Релизы Bright OS</h1>
      <p>Введите пароль релиза, чтобы скачать приватную Android-сборку.</p>
      ${errorMarkup}
      <form method="post" action="/releases/login">
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

export function serveRelease(req, res, url, releaseDir, sendJson) {
  if (!releaseDir) {
    sendJson(req, res, 404, { error: 'releases_not_configured' });
    return;
  }

  const relative = decodeURIComponent(url.pathname.replace(/^\/releases\/?/, ''));
  const requested = relative === '' ? 'index.html' : relative;
  const root = path.resolve(releaseDir);
  const filePath = path.resolve(root, requested);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    sendJson(req, res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(req, res, 404, { error: 'not_found' });
    return;
  }

  const contentType = filePath.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : filePath.endsWith('.apk')
      ? 'application/vnd.android.package-archive'
      : 'application/octet-stream';
  res.writeHead(200, { 'content-type': contentType });
  fs.createReadStream(filePath).pipe(res);
}
