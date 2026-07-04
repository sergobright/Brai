import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  INBOUND_BODY_LIMIT_BYTES,
  hasInboundApiKey,
  inboundRequestTarget,
  receiveInboxInbound,
  serveInboxAttachment
} from './inbound.js';
import { createBraiAuth } from './auth.js';
import {
  createAirWhisperRuntime,
  handleAirWhisperAdminRoute,
  handleAirWhisperPublicRoute,
  isAirWhisperAdminRoute,
  isAirWhisperPublicRoute,
  requireAirWhisperAccess
} from './airwhisper.js';
import { sendReleaseLoginPage, serveRelease } from './release-routes.js';
import { BraiStore, formatFocusInterval, formatSession } from './store.js';
import { scopedUserId, withUserScope } from './user-scope.js';

const BASE_JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key,x-brai-api-key,x-brai-target,x-brai-destination,x-airwhisper-device-id,x-airwhisper-client-version',
  'access-control-allow-credentials': 'true'
};
const SESSION_COOKIE = 'brai_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createBraiServer({
  dbPath,
  token,
  webPassword = null,
  releasePassword = webPassword,
  sessionSecret = null,
  releaseDir = null,
  inboundApiKey = null,
  inboundToken = null,
  betterAuthSecret = sessionSecret,
  betterAuthUrl = null,
  resendApiKey = null,
  authFromEmail = null,
  sendOtp = null,
  inboundStorageRoot = path.join(path.dirname(dbPath), 'inbox-attachments'),
  codexBin = 'codex',
  codexModel = null,
  codexTimeoutMs = null,
  inboundTitleGenerator = null,
  airWhisper = {},
  now = () => new Date(),
  logger = console
}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const store = new BraiStore(dbPath);
  const airWhisperRuntime = createAirWhisperRuntime(airWhisper);
  const authRuntime = createBraiAuth({
    dbPath,
    secret: betterAuthSecret ?? sessionSecret ?? 'brai-local-auth-secret-for-local-development-only',
    baseURL: betterAuthUrl,
    resendApiKey,
    fromEmail: authFromEmail ?? undefined,
    sendOtp
  });
  const { auth } = authRuntime;
  const sockets = new Set();
  const inboundHandlers = new Map([
    ['inbox', {
      receive: (body, requestNow) => receiveInboxInbound({
        store,
        body,
        storageRoot: inboundStorageRoot,
        codexBin,
        codexModel,
        codexTimeoutMs,
        titleGenerator: inboundTitleGenerator,
        nowDate: requestNow
      })
    }]
  ]);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, jsonHeaders(req));
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(req, res, 200, { ok: true, service: 'brai-api' });
        return;
      }

      if (url.pathname === '/auth/session' && req.method === 'GET') {
        const session = await betterAuthSession(req, auth);
        if (session?.user) {
          sendJson(req, res, 200, { authenticated: true, user: publicAuthUser(session.user) });
          return;
        }
        if (hasValidSession(req, sessionSecret, now())) {
          sendJson(req, res, 200, { authenticated: true, user: publicAuthUser(store.primaryUser()) });
          return;
        }
        sendJson(req, res, 200, { authenticated: false, user: null });
        return;
      }

      if (url.pathname === '/auth/otp/send' && req.method === 'POST') {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        if (!email) {
          sendJson(req, res, 400, { error: 'email_required' });
          return;
        }
        const response = await auth.api.sendVerificationOTP({
          body: { email, type: 'sign-in' },
          headers: requestHeaders(req),
          asResponse: true
        });
        await relayAuthResponse(req, res, response);
        return;
      }

      if (url.pathname === '/auth/otp/verify' && req.method === 'POST') {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
        if (!email || !otp) {
          sendJson(req, res, 400, { error: 'email_otp_required' });
          return;
        }
        const response = await auth.api.signInEmailOTP({
          body: { email, otp, name: cleanName(body.name) ?? email },
          headers: requestHeaders(req),
          asResponse: true
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (response.ok && payload?.user?.id) {
          store.claimFirstUser(payload.user.id, now().toISOString());
        }
        relayAuthText(req, res, response, text, payload);
        return;
      }

      if (url.pathname === '/auth/login' && req.method === 'POST') {
        const body = await readJson(req);
        if (!webPassword || body.password !== webPassword) {
          sendJson(req, res, 401, { error: 'invalid_password' });
          return;
        }

        const cookie = createSessionCookie(sessionSecret, now(), shouldUseSecureCookie(req));
        sendJson(req, res, 200, { authenticated: true, user: publicAuthUser(store.primaryUser()) }, { 'set-cookie': cookie });
        return;
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const cookies = [clearSessionCookie(shouldUseSecureCookie(req))];
        try {
          const response = await auth.api.signOut({
            headers: requestHeaders(req),
            asResponse: true
          });
          cookies.push(...setCookieHeaders(response.headers));
        } catch {
          // Legacy cookie cleanup still completes logout for clients that never had Better Auth.
        }
        sendJson(req, res, 200, { authenticated: false, user: null }, { 'set-cookie': cookies });
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

      if (url.pathname === '/v1/') {
        if (!hasInboundApiKey(req, inboundApiKey ?? inboundToken)) {
          sendJson(req, res, 401, { error: 'unauthorized' });
          return;
        }

        const requestNow = now();
        const body = req.method === 'POST' ? await readJson(req, { limit: INBOUND_BODY_LIMIT_BYTES }) : {};
        const target = inboundRequestTarget(req, body);
        const inboundHandler = target ? inboundHandlers.get(target) : null;
        if (!target || !inboundHandler) {
          sendJson(req, res, 404, { error: 'unsupported_target' });
          return;
        }

        if (req.method === 'GET') {
          sendJson(req, res, 200, { ok: true, target });
          return;
        }

        if (req.method === 'POST') {
          const ownerUserId = store.primaryUserId();
          const result = await withUserScope(ownerUserId, () => inboundHandler.receive(body, requestNow));
          const state = await withUserScope(ownerUserId, () => inboxState(store, requestNow));
          broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
          sendJson(req, res, result.created ? 201 : 200, { ok: true, target, ...result, state });
          return;
        }

        sendJson(req, res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (url.pathname === '/v1/in' || url.pathname.startsWith('/v1/in/')) {
        sendJson(req, res, 404, { error: 'not_found' });
        return;
      }

      if (url.pathname === '/v1/brai-cmd/inbox') {
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        const access = requireAirWhisperAccess(req, store);
        const requestNow = now();
        const body = await readJson(req, { limit: INBOUND_BODY_LIMIT_BYTES });
        const ownerUserId = store.primaryUserId();
        const inboundBody = {
          ...body,
          target: 'inbox',
          source: typeof body.source === 'string' && body.source.trim() ? body.source : 'brai-cmd',
          source_key: typeof body.source_key === 'string' && body.source_key.trim() ? body.source_key : access.id,
          record_type_id: body.record_type_id ?? 1
        };
        const result = await withUserScope(ownerUserId, () => inboundHandlers.get('inbox').receive(inboundBody, requestNow));
        const state = await withUserScope(ownerUserId, () => inboxState(store, requestNow));
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
        sendJson(req, res, result.created ? 201 : 200, { ok: true, target: 'inbox', ...result, state });
        return;
      }

      if (isAirWhisperPublicRoute(url.pathname)) {
        await handleAirWhisperPublicRoute({ req, res, url, store, runtime: airWhisperRuntime, sendJson });
        return;
      }

      const authContext = await authenticateRequest(req, token, url, sessionSecret, now, auth, store);
      if (!authContext.authorized) {
        sendJson(req, res, 401, { error: 'unauthorized' });
        return;
      }
      if (requiresTrustedOrigin(req, authContext) && !isTrustedAppOrigin(req.headers.origin)) {
        sendJson(req, res, 403, { error: 'forbidden_origin' });
        return;
      }

      if (isAirWhisperAdminRoute(url.pathname)) {
        await handleAirWhisperAdminRoute({ req, res, url, store, sendJson });
        return;
      }

      await withUserScope(authContext.userId, async () => {
      if (req.method === 'GET' && url.pathname === '/v1/timer/state') {
        sendJson(req, res, 200, timerState(store, now()));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/version') {
        sendJson(req, res, 200, versionState(store, now(), releaseDir));
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
        broadcast(sockets, { type: 'timer_synced', state }, scopedUserId());
        sendJson(req, res, 200, responseBody);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/v1/activities' || url.pathname === '/v1/actions')) {
        const state = activitiesState(store, now());
        sendJson(req, res, 200, url.pathname === '/v1/actions' ? actionsCompatState(state) : state);
        return;
      }

      if (req.method === 'GET' && serveInboxAttachment(req, res, url, inboundStorageRoot, sendJson, store)) {
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/inbox') {
        sendJson(req, res, 200, inboxState(store, now()));
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
        }, scopedUserId());
        sendJson(req, res, 200, responseBody);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/inbox/events/sync') {
        const requestNow = now();
        const body = await readJson(req, { limit: 256 * 1024 });
        const result = store.syncInboxEvents({
          device: body.device,
          events: body.events,
          lastKnownServerTimeUtc: body.last_known_server_time_utc,
          nowIso: requestNow.toISOString()
        });
        const state = inboxState(store, requestNow);
        const responseBody = { ...result, state };
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, scopedUserId());
        sendJson(req, res, 200, responseBody);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/start') {
        const requestNow = now();
        const result = store.startTimer(requestNow.toISOString());
        const body = { ...timerState(store, requestNow), created: result.created };
        broadcast(sockets, { type: 'timer_started', state: body }, scopedUserId());
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
          broadcast(sockets, { type: 'timer_stopped', state: body }, scopedUserId());
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
      });
      return;
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
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const authContext = await authenticateRequest(req, token, url, sessionSecret, now, auth, store);
      if (url.pathname !== '/v1/live' || !authContext.authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = authContext.userId;
        sockets.add(ws);
        withUserScope(authContext.userId, () => {
          const currentActivitiesState = activitiesState(store, now());
          ws.send(JSON.stringify({
            type: 'connected',
            state: timerState(store, now()),
            activities_state: currentActivitiesState,
            actions_state: actionsCompatState(currentActivitiesState),
            inbox_state: inboxState(store, now())
          }));
        });
        ws.on('close', () => sockets.delete(ws));
        ws.on('error', () => sockets.delete(ws));
      });
    })().catch(() => {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
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
            authRuntime.close();
            store.close();
            resolve();
          });
        });
      })
  };
}

export function timerState(store, nowDate) {
  const active = formatSession(store.getActiveSession());
  const activeInterval = formatFocusInterval(store.getActiveInterval());
  const nowIso = nowDate.toISOString();
  const elapsedSeconds = active
    ? Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(active.started_at_utc)) / 1000))
    : 0;
  const activeIntervalElapsedSeconds = activeInterval
    ? Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(activeInterval.started_at_utc)) / 1000))
    : 0;
  return {
    server_time_utc: nowIso,
    server_revision: store.getServerRevision(),
    timezone: 'Europe/Moscow',
    active_session: active,
    elapsed_seconds: elapsedSeconds,
    active_interval: activeInterval,
    active_interval_elapsed_seconds: activeIntervalElapsedSeconds,
    active_activity_id: activeInterval?.activity_id ?? null,
    active_session_start_origin: active?.start_origin ?? null,
    active_session_started_by_activity_id: active?.started_by_activity_id ?? null
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

export function versionState(store, nowDate, releaseDir = null) {
  const appVersion = store.currentAppVersion();
  const targetApk = latestApkRelease(releaseDir);
  const otaVersion = latestOtaVersion(releaseDir) ?? appVersion.version;
  return {
    server_time_utc: nowDate.toISOString(),
    ...appVersion,
    version: otaVersion,
    ota_version: otaVersion,
    target_apk: targetApk,
    apk_release: targetApk
  };
}

function latestOtaVersion(releaseDir) {
  if (!releaseDir) return null;
  try {
    const manifestPath = path.join(path.dirname(releaseDir), 'mobile-update', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return normalizeOtaVersion(manifest.otaVersion);
  } catch {
    return null;
  }
}

function latestApkRelease(releaseDir) {
  if (!releaseDir) return null;
  try {
    const releaseIndex = JSON.parse(fs.readFileSync(path.join(releaseDir, 'releases.json'), 'utf8'));
    const production = releaseIndex.sections?.production;
    const apkVersion = Number(production?.apkVersion ?? production?.version);
    if (!production?.file || !Number.isInteger(apkVersion) || apkVersion <= 0) return null;
    return {
      file: production.file,
      version: apkVersion,
      version_code: Number.isInteger(production.versionCode) ? production.versionCode : apkVersion,
      release_key: production.releaseKey ?? 'production',
      apk_build_kind: production.apkBuildKind ?? 'stable',
      preview_iteration: Number.isInteger(production.previewIteration) ? production.previewIteration : null,
      release_url: '/releases/',
      published_at: production.publishedAt ?? null,
      capabilities: Array.isArray(production.capabilities) ? production.capabilities : []
    };
  } catch {
    return null;
  }
}

function normalizeOtaVersion(value) {
  const match = String(value ?? '').match(/^(\d+)\.(\d+)\.(\d+)(?:\.|\b|[+_-])/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function inboxState(store, nowDate) {
  return {
    server_time_utc: nowDate.toISOString(),
    server_revision: store.getInboxServerRevision(),
    inbox: store.listInbox()
  };
}

function actionsCompatState(state) {
  return {
    server_time_utc: state.server_time_utc,
    server_revision: state.server_revision,
    actions: state.activities
  };
}

async function authenticateRequest(req, token, parsedUrl, sessionSecret, now, auth, store) {
  const session = await betterAuthSession(req, auth);
  if (session?.user?.id) {
    return { authorized: true, sessionBased: true, userId: session.user.id, user: publicAuthUser(session.user) };
  }

  if (hasLegacyToken(req, token, parsedUrl)) {
    const primary = store.primaryUser();
    return { authorized: true, sessionBased: false, userId: primary?.id ?? null, user: publicAuthUser(primary) };
  }

  if (hasValidSession(req, sessionSecret, now())) {
    const primary = store.primaryUser();
    return { authorized: true, sessionBased: true, userId: primary?.id ?? null, user: publicAuthUser(primary) };
  }

  return { authorized: false, sessionBased: false, userId: null, user: null };
}

async function betterAuthSession(req, auth) {
  try {
    const response = await auth.api.getSession({
      headers: requestHeaders(req),
      asResponse: true
    });
    if (!response.ok) return null;
    return parseJson(await response.text());
  } catch {
    return null;
  }
}

function hasLegacyToken(req, token, parsedUrl = null) {
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;

  const url = parsedUrl ?? new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get('token') === token;
}

function publicAuthUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? user.email ?? ''
  };
}

function requestHeaders(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return headers;
}

async function relayAuthResponse(req, res, response) {
  relayAuthText(req, res, response, await response.text());
}

function relayAuthText(req, res, response, text, parsed = parseJson(text)) {
  const cookies = setCookieHeaders(response.headers);
  const extraHeaders = cookies.length > 0 ? { 'set-cookie': cookies } : {};
  if (response.ok && parsed?.user?.id) {
    sendJson(req, res, response.status, { authenticated: true, user: publicAuthUser(parsed.user) }, extraHeaders);
    return;
  }
  const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
  res.writeHead(response.status, { ...jsonHeaders(req), ...extraHeaders, 'content-type': contentType });
  res.end(text || JSON.stringify({ ok: response.ok }));
}

function setCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const cookie = headers.get('set-cookie');
  return cookie ? [cookie] : [];
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function cleanEmail(value) {
  return typeof value === 'string' && value.trim().includes('@') ? value.trim().toLowerCase() : null;
}

function cleanName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : null;
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...jsonHeaders(req), ...extraHeaders });
  res.end(JSON.stringify(body));
}

function jsonHeaders(req) {
  const origin = req?.headers?.origin;
  const pathname = requestPathname(req);
  if (typeof origin === 'string' && isAllowedCorsOrigin(origin, pathname)) {
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

function requestPathname(req) {
  try {
    return new URL(req?.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function isAllowedCorsOrigin(origin, pathname = '/') {
  if (origin === 'https://brightos.world') return pathname === '/auth/session';
  if (isTrustedAppOrigin(origin)) return true;
  if (origin === 'https://previews.brightos.world') return true;
  return false;
}

function isTrustedAppOrigin(origin) {
  if (origin === 'https://app.brightos.world') return true;
  if (origin === 'https://dev.brightos.world') return true;
  if (/^https:\/\/[a-e]\.test\.brightos\.world$/.test(origin)) return true;
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'https://localhost' || origin === 'http://localhost') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function requiresTrustedOrigin(req, authContext) {
  return authContext.sessionBased && STATE_CHANGING_METHODS.has(req.method ?? '');
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, ...extraHeaders });
  res.end();
}

function broadcast(sockets, payload, targetUserId = null) {
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    if (targetUserId && socket.userId !== targetUserId) continue;
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
