import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { sendReleaseLoginPage, serveRelease } from './release-routes.js';
import { BrightOsStore, formatSession } from './store.js';

const BASE_JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-credentials': 'true'
};
const SESSION_COOKIE = 'bright_os_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export function createBrightOsServer({
  dbPath,
  token,
  webPassword = null,
  releasePassword = webPassword,
  sessionSecret = null,
  releaseDir = null,
  now = () => new Date(),
  logger = console
}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new BrightOsStore(dbPath);
  const sockets = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, jsonHeaders(req));
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(req, res, 200, { ok: true, service: 'bright-os-api' });
        return;
      }

      if (url.pathname === '/auth/session' && req.method === 'GET') {
        sendJson(req, res, 200, { authenticated: hasValidSession(req, sessionSecret, now()) });
        return;
      }

      if (url.pathname === '/auth/login' && req.method === 'POST') {
        const body = await readJson(req);
        if (!webPassword || body.password !== webPassword) {
          sendJson(req, res, 401, { error: 'invalid_password' });
          return;
        }

        const cookie = createSessionCookie(sessionSecret, now(), shouldUseSecureCookie(req));
        sendJson(req, res, 200, { authenticated: true }, { 'set-cookie': cookie });
        return;
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sendJson(req, res, 200, { authenticated: false }, {
          'set-cookie': clearSessionCookie(shouldUseSecureCookie(req))
        });
        return;
      }

      if (url.pathname === '/releases/login' && req.method === 'POST') {
        const password = await readPassword(req);
        if (!releasePassword || password !== releasePassword) {
          sendReleaseLoginPage(res, {
            status: 401,
            error: 'Неверный пароль'
          });
          return;
        }

        const cookie = createSessionCookie(sessionSecret, now(), shouldUseSecureCookie(req));
        redirect(res, '/releases/', { 'set-cookie': cookie });
        return;
      }

      if (url.pathname.startsWith('/releases')) {
        if (!hasValidSession(req, sessionSecret, now())) {
          if (req.method === 'GET' && (url.pathname === '/releases' || url.pathname === '/releases/')) {
            sendReleaseLoginPage(res);
          } else {
            redirect(res, '/releases/');
          }
          return;
        }
        serveRelease(req, res, url, releaseDir, sendJson);
        return;
      }

      if (!url.pathname.startsWith('/v1/')) {
        sendJson(req, res, 404, { error: 'not_found' });
        return;
      }

      if (!isAuthorized(req, token, url, sessionSecret, now)) {
        sendJson(req, res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/timer/state') {
        sendJson(req, res, 200, timerState(store, now()));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/events/sync') {
        const requestNow = now();
        const body = await readJson(req, { limit: 256 * 1024 });
        const result = store.syncTimerEvents({
          device: body.device,
          events: body.events,
          lastKnownServerTimeUtc: body.last_known_server_time_utc,
          nowIso: requestNow.toISOString()
        });
        const state = timerState(store, requestNow);
        const responseBody = { ...result, state };
        broadcast(sockets, { type: 'timer_synced', state });
        sendJson(req, res, 200, responseBody);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/v1/activities' || url.pathname === '/v1/actions')) {
        const state = activitiesState(store, now());
        sendJson(req, res, 200, url.pathname === '/v1/actions' ? actionsCompatState(state) : state);
        return;
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/v1/activities/events/sync' || url.pathname === '/v1/actions/events/sync')
      ) {
        const requestNow = now();
        const body = await readJson(req, { limit: 256 * 1024 });
        const result = store.syncActivityEvents({
          device: body.device,
          events: body.events,
          lastKnownServerTimeUtc: body.last_known_server_time_utc,
          nowIso: requestNow.toISOString()
        });
        const state = activitiesState(store, requestNow);
        const responseBody = {
          ...result,
          state: url.pathname === '/v1/actions/events/sync' ? actionsCompatState(state) : state
        };
        broadcast(sockets, {
          type: 'activities_synced',
          activities_state: state,
          actions_state: actionsCompatState(state)
        });
        sendJson(req, res, 200, responseBody);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/start') {
        const requestNow = now();
        const result = store.startTimer(requestNow.toISOString());
        const body = { ...timerState(store, requestNow), created: result.created };
        broadcast(sockets, { type: 'timer_started', state: body });
        sendJson(req, res, result.created ? 201 : 200, body);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/stop') {
        const requestNow = now();
        const result = store.stopTimer(requestNow.toISOString());
        const body = {
          ...timerState(store, requestNow),
          stopped: result.stopped,
          completed_session: formatSession(result.session)
        };
        if (result.stopped) {
          broadcast(sockets, { type: 'timer_stopped', state: body });
        }
        sendJson(req, res, result.stopped ? 200 : 409, body);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        sendJson(req, res, 200, store.listSessions({
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to')
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/goals/challenge') {
        const nowOverride = url.searchParams.get('now');
        const currentMs = nowOverride ? Date.parse(nowOverride) : now().getTime();
        sendJson(req, res, 200, store.challengeSummary(currentMs));
        return;
      }

      sendJson(req, res, 404, { error: 'not_found' });
    } catch (error) {
      logger.error(error);
      if (Number.isInteger(error.status)) {
        sendJson(req, res, error.status, { error: error.message });
        return;
      }
      sendJson(req, res, 500, { error: 'internal_error' });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/live' || !isAuthorized(req, token, url, sessionSecret, now)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      const currentActivitiesState = activitiesState(store, now());
      ws.send(JSON.stringify({
        type: 'connected',
        state: timerState(store, now()),
        activities_state: currentActivitiesState,
        actions_state: actionsCompatState(currentActivitiesState)
      }));
      ws.on('close', () => sockets.delete(ws));
      ws.on('error', () => sockets.delete(ws));
    });
  });

  return {
    server,
    store,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.close();
        wss.close(() => {
          server.close(() => {
            store.close();
            resolve();
          });
        });
      })
  };
}

export function timerState(store, nowDate) {
  const active = formatSession(store.getActiveSession());
  const nowIso = nowDate.toISOString();
  const elapsedSeconds = active
    ? Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(active.started_at_utc)) / 1000))
    : 0;
  return {
    server_time_utc: nowIso,
    server_revision: store.getServerRevision(),
    timezone: 'Europe/Moscow',
    active_session: active,
    elapsed_seconds: elapsedSeconds
  };
}

export function activitiesState(store, nowDate) {
  return {
    server_time_utc: nowDate.toISOString(),
    server_revision: store.getActivityServerRevision(),
    activities: store.listActivities(),
    archived_activities: store.listArchivedActivities()
  };
}

function actionsCompatState(state) {
  return {
    server_time_utc: state.server_time_utc,
    server_revision: state.server_revision,
    actions: state.activities
  };
}

function isAuthorized(req, token, parsedUrl = null, sessionSecret = null, now = () => new Date()) {
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;

  const url = parsedUrl ?? new URL(req.url ?? '/', 'http://localhost');
  if (url.searchParams.get('token') === token) return true;

  return hasValidSession(req, sessionSecret, now());
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...jsonHeaders(req), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function jsonHeaders(req) {
  const origin = req?.headers?.origin;
  if (typeof origin === 'string' && isAllowedCorsOrigin(origin)) {
    return {
      ...BASE_JSON_HEADERS,
      'access-control-allow-origin': origin,
      vary: 'Origin'
    };
  }
  return {
    ...BASE_JSON_HEADERS,
    'access-control-allow-origin': '*'
  };
}

function isAllowedCorsOrigin(origin) {
  if (origin === 'https://app.brightos.world') return true;
  if (origin === 'https://dev.brightos.world') return true;
  if (/^https:\/\/[a-e]\.test\.brightos\.world$/.test(origin)) return true;
  if (origin === 'https://previews.brightos.world') return true;
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'https://localhost' || origin === 'http://localhost') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, ...extraHeaders });
  res.end();
}

function broadcast(sockets, payload) {
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === 1) {
      socket.send(message);
    }
  }
}

async function readJson(req, { limit = 4096 } = {}) {
  const raw = await readRequestBody(req, { limit });
  return raw ? JSON.parse(raw) : {};
}

async function readPassword(req) {
  const raw = await readRequestBody(req);
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(raw).get('password') ?? '';
  }
  if (contentType.includes('application/json')) {
    return raw ? JSON.parse(raw).password ?? '' : '';
  }
  return raw;
}

async function readRequestBody(req, { limit = 4096 } = {}) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) {
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
  }
  return raw;
}

function hasValidSession(req, sessionSecret, nowDate) {
  if (!sessionSecret) return false;
  const cookies = parseCookies(req.headers.cookie ?? '');
  const value = cookies[SESSION_COOKIE];
  if (!value) return false;

  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expiresMs = Number(parts[1]);
  const signature = parts[2];
  if (!Number.isFinite(expiresMs) || expiresMs < nowDate.getTime()) return false;

  const expected = signSession(sessionSecret, expiresMs);
  return timingSafeEqual(signature, expected);
}

function createSessionCookie(sessionSecret, nowDate, secure) {
  if (!sessionSecret) throw new Error('session_secret_required');
  const expiresMs = nowDate.getTime() + SESSION_MAX_AGE_SECONDS * 1000;
  const signature = signSession(sessionSecret, expiresMs);
  const securePart = secure ? '; Secure' : '';
  const sameSite = secure ? 'None' : 'Lax';
  return `${SESSION_COOKIE}=v1.${expiresMs}.${signature}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_MAX_AGE_SECONDS}${securePart}`;
}

function clearSessionCookie(secure) {
  const securePart = secure ? '; Secure' : '';
  const sameSite = secure ? 'None' : 'Lax';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${securePart}`;
}

function signSession(sessionSecret, expiresMs) {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`v1.${expiresMs}`)
    .digest('base64url');
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function shouldUseSecureCookie(req) {
  const host = req.headers.host ?? '';
  return host.includes('brightos.world') || req.headers['x-forwarded-proto'] === 'https';
}
