import fs from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  INBOX_BODY_LIMIT_BYTES,
  hasInboxApiKey,
  inboxIngestIdempotencyHash,
  inboxRequestTarget,
  processInboxItem,
  receiveInbox,
  serveInboxAttachment
} from './inbox.js';
import { processActivityItem } from './activity-normalization.js';
import { createBraiAuth, OTP_EXPIRES_IN_SECONDS, OTP_RESEND_AFTER_SECONDS, OTP_RESEND_STRATEGY } from './auth.js';
import {
  createBraiCmdRuntime,
  handleBraiCmdAdminRoute,
  handleBraiCmdPublicRoute,
  isBraiCmdAdminRoute,
  isBraiCmdPublicRoute,
  requireBraiCmdAccess
} from './brai-cmd.js';
import { sendReleaseLoginPage, serveRelease } from './release-routes.js';
import { BraiStore, formatFocusInterval, formatSession } from './store.js';
import { scopedUserId, withUserScope } from './user-scope.js';
import {
  handleNativeProviderSync,
  handleUserAiRoute,
  isNativeProviderSyncRoute,
  isUserAiRoute
} from './user-ai-routes.js';

const BASE_JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-api-key,x-brai-api-key,x-brai-target,x-brai-destination,x-brai-cmd-device-id,x-brai-cmd-client-version,x-airwhisper-device-id,x-airwhisper-client-version',
  'access-control-allow-credentials': 'true'
};
const SESSION_COOKIE = 'brai_session';
const RELEASE_SESSION_COOKIE = 'brai_release_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DRAW_SCENE_LIMIT_BYTES = 15 * 1024 * 1024;
const BRAI_CMD_FUNCTION_DISABLED_CODE = 'function_disabled';
const BRAI_CMD_FUNCTION_DISABLED_MESSAGE_KEY = 'message.function.disabled.default';
const BRAI_CMD_CHAT_PREFIX = 'Добавить в контекст контакта';
const BRAI_CMD_ACCOUNT_ACTIVATE_PATH = '/v1/brai-cmd/account-access/activate';
const BRAI_CMD_ACCESS_REVOKE_PATH = '/v1/brai-cmd/access/revoke-self';

export function createBraiServer({
  databaseUrl,
  dataRoot = path.join(process.cwd(), 'data'),
  token,
  webPassword = null,
  releasePassword = null,
  sessionSecret = null,
  releaseDir = null,
  inboxApiKey = null,
  vaultRoot = null,
  syncthingGuiAddress = null,
  syncthingApiKey = null,
  syncthingFolderIdPrefix = 'vault-user-',
  prepareUserVault = null,
  betterAuthSecret = sessionSecret,
  betterAuthUrl = null,
  resendApiKey = null,
  authFromEmail = null,
  sendOtp = null,
  inboxStorageRoot = path.join(dataRoot, 'inbox-attachments'),
  codexBin = 'codex',
  codexModel = null,
  codexFallbackModel = null,
  codexTimeoutMs = null,
  userAiEncryptionKey = null,
  userAiFetch = fetch,
  inboxExternalAi = {},
  inboxImageDescriber = null,
  inboxNormalizer = null,
  inboxWorkflowStarter = null,
  inboxAutoProcess = true,
  activityNormalizer = null,
  activityWorkflowStarter = null,
  activityAutoProcess = true,
  braiCmd = {},
  branch = process.env.BRAI_BRANCH || null,
  commit = process.env.BRAI_COMMIT || null,
  databaseBranch = process.env.BRAI_SUPABASE_BRANCH || null,
  testEmailLogin = false,
  shutdownGraceMs = 5000,
  now = () => new Date(),
  logger = console
}) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const store = new BraiStore(databaseUrl);
  store.logger = logger;
  store.configureUserAiEncryptionKey(userAiEncryptionKey);
  const braiCmdRuntime = createBraiCmdRuntime(braiCmd);
  const resolvedVaultRoot =
    typeof vaultRoot === 'string' && vaultRoot.trim()
      ? vaultRoot
      : path.resolve(dataRoot, '..', 'vault');
  const ensureUserVault = prepareUserVault ?? createUserVaultPreparer({
    vaultRoot: resolvedVaultRoot,
    syncthingGuiAddress,
    syncthingApiKey,
    syncthingFolderIdPrefix,
    logger
  });
  const authRuntime = createBraiAuth({
    databaseUrl,
    secret: betterAuthSecret ?? sessionSecret ?? 'brai-local-auth-secret-for-local-development-only',
    baseURL: betterAuthUrl,
    resendApiKey,
    fromEmail: authFromEmail ?? undefined,
    sendOtp
  });
  const { auth, testEmailLogin: betterAuthTestEmailLogin } = authRuntime;
  const sockets = new Set();
  const receiveInboxRequest = (body, requestNow, logContext = {}) => receiveInbox({
    store,
    body,
    storageRoot: inboxStorageRoot,
    nowDate: requestNow,
    logContext
  });
  const processInboxLater = ({ ownerUserId, inboxId }) => {
    if (!inboxAutoProcess || !inboxId) return;
    setTimeout(() => {
      void withUserScope(ownerUserId, async () => {
        const started = inboxWorkflowStarter
          ? await inboxWorkflowStarter({ ownerUserId, inboxId })
          : await processInboxItem({
              store,
              inboxId,
              storageRoot: inboxStorageRoot,
              codexBin,
              codexModel,
              codexFallbackModel,
              codexTimeoutMs,
              externalAi: { fetch: userAiFetch },
              imageDescriber: inboxImageDescriber,
              normalizer: inboxNormalizer,
              nowDate: now()
            });
        if (started?.completion) await started.completion;
        const state = inboxState(store, now());
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
      }).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let queuedForRetry = false;
        let terminalReconcilePending = false;
        try {
          withUserScope(ownerUserId, () => {
            const execution = store.getInboxWorkflowExecution(inboxId);
            if (inboxWorkflowStarter && execution?.status === 'queued') {
              queuedForRetry = true;
              recordRuntimeLog(store, logger, {
                source: 'workflow',
                operation: 'inbox.workflow_dispatch',
                status: 'failed',
                severityText: 'ERROR',
                reason: errorMessage,
                message: 'Inbox workflow dispatch failed; queued for retry',
                jsonData: {
                  inbox_id: inboxId,
                  workflow_id: execution.workflow_id,
                  workflow_status: execution.status,
                  retry_scheduled: true
                }
              });
              return;
            }
            if (inboxWorkflowStarter && execution?.status === 'running') {
              terminalReconcilePending = true;
              recordRuntimeLog(store, logger, {
                source: 'workflow',
                operation: 'inbox.workflow_completion_observer',
                status: 'failed',
                severityText: 'WARN',
                reason: errorMessage,
                message: 'Inbox workflow completion observer failed; durable reconciliation remains active',
                jsonData: {
                  inbox_id: inboxId,
                  workflow_id: execution.workflow_id,
                  run_id: execution.run_id,
                  workflow_status: execution.status,
                  terminal_reconcile_pending: true
                }
              });
              return;
            }
            if (execution) {
              store.failInboxWorkflow({
                inboxId,
                workflowId: execution.workflow_id,
                runId: execution.run_id,
                reason: errorMessage,
                step: execution.current_step,
                nowIso: now().toISOString()
              });
            }
          });
        } catch (statusError) {
          logger.error?.('Inbox workflow failure status update failed', {
            error: statusError instanceof Error ? statusError.message : String(statusError),
            inboxId
          });
        }
        const message = queuedForRetry
          ? 'Inbox workflow dispatch failed; queued for retry'
          : terminalReconcilePending
            ? 'Inbox workflow completion observer failed; durable reconciliation remains active'
            : 'Inbox AI processing failed';
        logger.error?.(message, {
          error: errorMessage,
          inboxId
        });
      });
    }, 0);
  };
  const processActivityLater = ({ ownerUserId, activityId }) => {
    if (!activityAutoProcess || !activityId) return;
    setTimeout(() => {
      void withUserScope(ownerUserId, async () => {
        const started = activityWorkflowStarter
          ? await activityWorkflowStarter({ ownerUserId, activityId })
          : await processActivityItem({
              store,
              activityId,
              codexBin,
              codexModel,
              codexFallbackModel,
              codexTimeoutMs,
              externalAi: { fetch: userAiFetch },
              normalizer: activityNormalizer,
              nowDate: now()
            });
        if (started?.completion) await started.completion;
        const state = activitiesState(store, now());
        broadcast(sockets, {
          type: 'activities_synced',
          activities_state: state,
          actions_state: actionsCompatState(state)
        }, ownerUserId);
      }).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        let queuedForRetry = false;
        let terminalReconcilePending = false;
        try {
          withUserScope(ownerUserId, () => {
            const execution = store.getActivityWorkflowExecution(activityId);
            if (activityWorkflowStarter && execution?.status === 'queued') {
              queuedForRetry = true;
              recordRuntimeLog(store, logger, {
                source: 'workflow',
                operation: 'activity.workflow_dispatch',
                status: 'failed',
                severityText: 'ERROR',
                reason: errorMessage,
                message: 'Activity workflow dispatch failed; queued for retry',
                jsonData: {
                  activity_id: activityId,
                  workflow_id: execution.workflow_id,
                  workflow_status: execution.status,
                  retry_scheduled: true
                }
              });
              return;
            }
            if (activityWorkflowStarter && execution?.status === 'running') {
              terminalReconcilePending = true;
              recordRuntimeLog(store, logger, {
                source: 'workflow',
                operation: 'activity.workflow_completion_observer',
                status: 'failed',
                severityText: 'WARN',
                reason: errorMessage,
                message: 'Activity workflow completion observer failed; durable reconciliation remains active',
                jsonData: {
                  activity_id: activityId,
                  workflow_id: execution.workflow_id,
                  run_id: execution.run_id,
                  workflow_status: execution.status,
                  terminal_reconcile_pending: true
                }
              });
              return;
            }
            if (execution) {
              store.failActivityWorkflow({
                activityId,
                workflowId: execution.workflow_id,
                runId: execution.run_id,
                reason: errorMessage,
                step: execution.current_step,
                nowIso: now().toISOString()
              });
            }
          });
        } catch (statusError) {
          logger.error?.('Activity workflow failure status update failed', {
            error: statusError instanceof Error ? statusError.message : String(statusError),
            activityId
          });
        }
        const message = queuedForRetry
          ? 'Activity workflow dispatch failed; queued for retry'
          : terminalReconcilePending
            ? 'Activity workflow completion observer failed; durable reconciliation remains active'
            : 'Activity AI processing failed';
        logger.error?.(message, {
          error: errorMessage,
          activityId
        });
      });
    }, 0);
  };

  const server = http.createServer(async (req, res) => {
    const requestStartedAt = Date.now();
    const traceId = crypto.randomUUID();
    let requestPath = req.url ?? '/';
    let requestUserId = null;
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, jsonHeaders(req));
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      requestPath = url.pathname;
      res.setHeader('x-brai-trace-id', traceId);
      res.on('finish', () => {
        try {
          store.recordLog({
            traceId,
            source: 'api',
            operation: `${req.method ?? 'GET'} ${requestPath}`,
            status: res.statusCode >= 500 ? 'failed' : 'done',
            severityText: res.statusCode >= 500 ? 'ERROR' : 'INFO',
            durationMs: Date.now() - requestStartedAt,
            userId: requestUserId,
            message: `${res.statusCode} ${requestPath}`,
            jsonData: {
              method: req.method ?? 'GET',
              path: requestPath,
              status_code: res.statusCode
            }
          });
        } catch (error) {
          logger.error?.('request log failed', { error: error instanceof Error ? error.message : String(error) });
        }
      });
      if (req.method === 'GET' && url.pathname === '/health') {
        store.db.prepare('SELECT 1 AS ok').get();
        sendJson(req, res, 200, {
          ok: true,
          service: 'brai-api',
          database: { dialect: 'postgres', branch: databaseBranch },
          branch,
          commit
        });
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

      if (url.pathname === '/auth/test-email-login' && req.method === 'POST') {
        if (!testEmailLogin) {
          sendJson(req, res, 404, { error: 'not_found' });
          return;
        }
        if (!isTestEmailLoginOrigin(req.headers.origin)) {
          sendJson(req, res, 403, { error: 'origin_not_allowed' });
          return;
        }
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        if (!email) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.test_email_login',
            status: 'failed',
            severityText: 'WARN',
            reason: 'email_required',
            message: 'Test email login rejected',
            jsonData: { route: url.pathname, email_present: Boolean(email) }
          });
          sendJson(req, res, 400, { error: 'email_required' });
          return;
        }

        const primaryUser = store.primaryUser();
        const existingUser = primaryUser ?? store.getAuthUserByEmail(email);
        const signInEmail = existingUser?.email || email;
        const signInName = existingUser?.name || cleanName(body.name) || signInEmail;
        let response;
        try {
          response = await betterAuthTestEmailLogin({
            email: signInEmail,
            name: signInName,
            headers: requestHeaders(req)
          });
        } catch (error) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.test_email_login',
            status: 'failed',
            severityText: 'ERROR',
            reason: 'provider_exception',
            message: 'Test email login provider failed',
            jsonData: { route: url.pathname, error_name: error instanceof Error ? error.name : 'Error' }
          });
          throw error;
        }
        const text = await response.text();
        const payload = parseJson(text);
        let vaultPrepared = null;
        let preliminaryLinked = false;
        if (response.ok && payload?.user?.id) {
          const finalized = await prepareSignedInAuthUser({
            store,
            logger,
            traceId,
            route: url.pathname,
            operation: 'auth.test_email_login',
            payload,
            preliminaryContext: authPreliminaryContext(body),
            ensureUserVault,
            now
          });
          if (!finalized.ok) {
            sendJson(req, res, finalized.status, finalized.body);
            return;
          }
          vaultPrepared = finalized.vaultPrepared;
          preliminaryLinked = finalized.preliminaryLinked;
        }
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.test_email_login',
          status: response.ok ? 'done' : 'failed',
          severityText: response.ok ? 'INFO' : 'WARN',
          userId: response.ok ? payload?.user?.id : null,
          reason: response.ok ? null : 'provider_rejected',
          message: 'Test email login completed',
          jsonData: {
            route: url.pathname,
            status_code: response.status,
            user_created_or_authenticated: Boolean(payload?.user?.id),
            vault_prepared: vaultPrepared,
            preliminary_linked: preliminaryLinked
          }
        });
        relayAuthText(req, res, response, text, payload);
        return;
      }

      if (url.pathname === '/auth/otp/send' && req.method === 'POST') {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        if (!email) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.otp_send',
            status: 'failed',
            severityText: 'WARN',
            reason: 'email_required',
            message: 'OTP send rejected',
            jsonData: { route: url.pathname, email_present: Boolean(body.email) }
          });
          sendJson(req, res, 400, { error: 'email_required' });
          return;
        }
        let response;
        try {
          response = await auth.api.sendVerificationOTP({
            body: { email, type: 'sign-in' },
            headers: requestHeaders(req),
            asResponse: true
          });
        } catch (error) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.otp_send',
            status: 'failed',
            severityText: 'ERROR',
            reason: 'provider_exception',
            message: 'OTP send provider failed',
            jsonData: { route: url.pathname, error_name: error instanceof Error ? error.name : 'Error' }
          });
          throw error;
        }
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.otp_send',
          status: response.ok ? 'done' : 'failed',
          severityText: response.ok ? 'INFO' : 'WARN',
          reason: response.ok ? null : 'provider_rejected',
          message: 'OTP send completed',
          jsonData: { route: url.pathname, status_code: response.status, email_present: true }
        });
        const text = await response.text();
        const payload = parseJson(text);
        if (response.ok && payload && typeof payload === 'object') {
          sendJson(req, res, response.status, {
            ...payload,
            expires_in_seconds: OTP_EXPIRES_IN_SECONDS,
            resend_after_seconds: OTP_RESEND_AFTER_SECONDS,
            resend_strategy: OTP_RESEND_STRATEGY
          });
          return;
        }
        relayAuthText(req, res, response, text, payload);
        return;
      }

      if (url.pathname === '/auth/otp/verify' && req.method === 'POST') {
        const body = await readJson(req);
        const email = cleanEmail(body.email);
        const otp = typeof body.otp === 'string' ? body.otp.trim() : '';
        if (!email || !otp) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.otp_verify',
            status: 'failed',
            severityText: 'WARN',
            reason: 'email_otp_required',
            message: 'OTP verify rejected',
            jsonData: { route: url.pathname, email_present: Boolean(email), otp_present: Boolean(otp) }
          });
          sendJson(req, res, 400, { error: 'email_otp_required' });
          return;
        }
        const existingUser = store.getAuthUserByEmail(email);
        const signInName = existingUser?.name || cleanName(body.name) || email;
        let response;
        try {
          response = await auth.api.signInEmailOTP({
            body: { email, otp, name: signInName },
            headers: requestHeaders(req),
            asResponse: true
          });
        } catch (error) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.otp_verify',
            status: 'failed',
            severityText: 'ERROR',
            reason: 'provider_exception',
            message: 'OTP verify provider failed',
            jsonData: { route: url.pathname, error_name: error instanceof Error ? error.name : 'Error' }
          });
          throw error;
        }
        const text = await response.text();
        const payload = parseJson(text);
        let vaultPrepared = null;
        let preliminaryLinked = false;
        if (response.ok && payload?.user?.id) {
          const finalized = await prepareSignedInAuthUser({
            store,
            logger,
            traceId,
            route: url.pathname,
            operation: 'auth.otp_verify',
            payload,
            preliminaryContext: authPreliminaryContext(body),
            ensureUserVault,
            now
          });
          if (!finalized.ok) {
            sendJson(req, res, finalized.status, finalized.body);
            return;
          }
          vaultPrepared = finalized.vaultPrepared;
          preliminaryLinked = finalized.preliminaryLinked;
        }
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.otp_verify',
          status: response.ok ? 'done' : 'failed',
          severityText: response.ok ? 'INFO' : 'WARN',
          userId: response.ok ? payload?.user?.id : null,
          reason: response.ok ? null : 'provider_rejected',
          message: 'OTP verify completed',
          jsonData: {
            route: url.pathname,
            status_code: response.status,
            user_created_or_authenticated: Boolean(payload?.user?.id),
            vault_prepared: vaultPrepared,
            preliminary_linked: preliminaryLinked
          }
        });
        relayAuthText(req, res, response, text, payload);
        return;
      }

      if (url.pathname === '/auth/login' && req.method === 'POST') {
        const body = await readJson(req);
        if (!webPassword || body.password !== webPassword) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.login',
            status: 'failed',
            severityText: 'WARN',
            reason: 'invalid_password',
            message: 'Legacy auth login rejected',
            jsonData: { route: url.pathname, password_present: Boolean(body.password) }
          });
          sendJson(req, res, 401, { error: 'invalid_password' });
          return;
        }

        const cookie = createSessionCookie(sessionSecret, now(), shouldUseSecureCookie(req));
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.login',
          status: 'done',
          message: 'Legacy auth login completed',
          jsonData: { route: url.pathname, secure_cookie: shouldUseSecureCookie(req) }
        });
        sendJson(req, res, 200, { authenticated: true, user: publicAuthUser(store.primaryUser()) }, { 'set-cookie': cookie });
        return;
      }

      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        const cookies = [clearSessionCookie(shouldUseSecureCookie(req))];
        let signOutFailed = false;
        try {
          const response = await auth.api.signOut({
            headers: requestHeaders(req),
            asResponse: true
          });
          cookies.push(...setCookieHeaders(response.headers));
        } catch {
          signOutFailed = true;
          // Legacy cookie cleanup still completes logout for clients that never had Better Auth.
        }
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.logout',
          status: 'done',
          reason: signOutFailed ? 'better_auth_signout_failed' : null,
          message: 'Auth logout completed',
          jsonData: { route: url.pathname, legacy_cookie_cleared: true }
        });
        sendJson(req, res, 200, { authenticated: false, user: null }, { 'set-cookie': cookies });
        return;
      }

      if (url.pathname === '/releases/login' && req.method === 'POST') {
        const password = await readPassword(req);
        if (!releasePassword || password !== releasePassword) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'release',
            operation: 'release.login',
            status: 'failed',
            severityText: 'WARN',
            reason: 'invalid_password',
            message: 'Release login rejected',
            jsonData: { route: url.pathname, password_present: Boolean(password) }
          });
          sendReleaseLoginPage(res, {
            status: 401,
            error: 'Неверный пароль'
          });
          return;
        }

        const cookie = createSessionCookie(
          sessionSecret,
          now(),
          shouldUseSecureCookie(req),
          RELEASE_SESSION_COOKIE
        );
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'release',
          operation: 'release.login',
          status: 'done',
          message: 'Release login completed',
          jsonData: { route: url.pathname, secure_cookie: shouldUseSecureCookie(req) }
        });
        redirect(res, '/releases/', { 'set-cookie': cookie });
        return;
      }

      if (url.pathname.startsWith('/releases')) {
        if (!hasValidSession(req, sessionSecret, now(), RELEASE_SESSION_COOKIE)) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.denied',
            status: 'failed',
            severityText: 'WARN',
            reason: 'release_session_required',
            message: 'Release request denied',
            jsonData: {
              method: req.method ?? 'GET',
              path: url.pathname,
              session_cookie_present: Boolean(req.headers.cookie)
            }
          });
          if (req.method === 'GET' && (url.pathname === '/releases' || url.pathname === '/releases/')) {
            sendReleaseLoginPage(res);
          } else {
            redirect(res, '/releases/');
          }
          return;
        }
        serveRelease(req, res, url, releaseDir, sendJson, store);
        return;
      }

      if (!url.pathname.startsWith('/v1/')) {
        sendJson(req, res, 404, { error: 'not_found' });
        return;
      }

      if (url.pathname === '/v1/') {
        if (!hasInboxApiKey(req, inboxApiKey)) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.denied',
            status: 'failed',
            severityText: 'WARN',
            reason: 'invalid_inbox_api_key',
            message: 'Inbox API request unauthorized',
            jsonData: {
              method: req.method ?? 'GET',
              path: url.pathname,
              api_key_header_present: Boolean(req.headers['x-brai-api-key'] || req.headers['x-api-key']),
              bearer_present: Boolean(req.headers.authorization)
            }
          });
          sendJson(req, res, 401, { error: 'unauthorized' });
          return;
        }

        const requestNow = now();
        const body = req.method === 'POST' ? await readJson(req, { limit: INBOX_BODY_LIMIT_BYTES }) : {};
        const target = inboxRequestTarget(req, body);
        if (target !== 'inbox') {
          sendJson(req, res, 404, { error: 'unsupported_target' });
          return;
        }

        if (req.method === 'GET') {
          sendJson(req, res, 200, { ok: true, target });
          return;
        }

        if (req.method === 'POST') {
          const ownerUserId = store.primaryUserId();
          const result = await withUserScope(ownerUserId, () => receiveInboxRequest(body, requestNow, { route: url.pathname }));
          const state = await withUserScope(ownerUserId, () => inboxState(store, requestNow));
          broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
          sendJson(req, res, result.created ? 201 : 200, { ok: true, target, ...result, state });
          if (result.created) processInboxLater({ ownerUserId, inboxId: result.inbox_id });
          return;
        }

        sendJson(req, res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (url.pathname === '/v1/in' || url.pathname.startsWith('/v1/in/')) {
        sendJson(req, res, 404, { error: 'not_found' });
        return;
      }

      if (url.pathname === '/v1/inbox/status') {
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        if (!hasInboxApiKey(req, inboxApiKey)) {
          recordRuntimeLog(store, logger, {
            traceId,
            source: 'auth',
            operation: 'auth.denied',
            status: 'failed',
            severityText: 'WARN',
            reason: 'invalid_inbox_api_key',
            message: 'Inbox status API request unauthorized',
            jsonData: {
              method: req.method ?? 'POST',
              path: url.pathname,
              api_key_header_present: Boolean(req.headers['x-brai-api-key'] || req.headers['x-api-key']),
              bearer_present: Boolean(req.headers.authorization)
            }
          });
          sendJson(req, res, 401, { error: 'unauthorized' });
          return;
        }
        const requestNow = now();
        const body = await readJson(req, { limit: 4096 });
        const ownerUserId = store.primaryUserId();
        const result = await withUserScope(ownerUserId, () => store.setInboxApiStatus({
          ingestIdempotencyHash: inboxIngestIdempotencyHash(body.idempotency_key),
          status: body.status,
          nowIso: requestNow.toISOString()
        }));
        const state = await withUserScope(ownerUserId, () => inboxState(store, requestNow));
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
        sendJson(req, res, 200, { ok: true, target: 'inbox', ...result, state });
        return;
      }

      if (url.pathname === '/v1/brai-cmd/inbox') {
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        const access = requireBraiCmdAccess(req, store);
        const requestNow = now();
        const body = await readJson(req, { limit: INBOX_BODY_LIMIT_BYTES });
        if (!store.braiCmdFunctionEnabled?.(braiCmdInboxFunctionKey(body))) {
          sendBraiCmdFunctionDisabled(req, res, store, sendJson);
          return;
        }
        const ownerUserId = access.userId ?? store.primaryUserId();
        const inboxBody = {
          ...body,
          target: 'inbox',
          source: typeof body.source === 'string' && body.source.trim() ? body.source : 'brai-cmd',
          source_key: typeof body.source_key === 'string' && body.source_key.trim() ? body.source_key : access.id,
          record_type_id: body.record_type_id ?? 1
        };
        const result = await withUserScope(ownerUserId, () => receiveInboxRequest(inboxBody, requestNow, { route: url.pathname }));
        const state = await withUserScope(ownerUserId, () => inboxState(store, requestNow));
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
        const notice = store.braiCmdNotice(
          result.created ? 'message.inbox.created.default' : 'message.inbox.duplicate.default',
          'success'
        );
        sendJson(req, res, result.created ? 201 : 200, { ok: true, target: 'inbox', ...result, state, notice });
        if (result.created) processInboxLater({ ownerUserId, inboxId: result.inbox_id });
        return;
      }

      if (url.pathname === BRAI_CMD_ACCOUNT_ACTIVATE_PATH) {
        assertNativeBraiCmdTransport(req);
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        const currentAccess = requireBraiCmdAccess(req, store);
        const body = await readJson(req, { limit: 4096 });
        const linkToken = firstTextField(body, ['link_token', 'linkToken']);
        if (!linkToken) {
          sendJson(req, res, 400, { error: 'link_token_required' });
          return;
        }
        const issued = store.activateBraiCmdAccountLink({
          linkToken,
          currentAccess,
          nowIso: now().toISOString()
        });
        requestUserId = issued.record.userId;
        sendJson(req, res, 201, {
          token: issued.token,
          status: issued.record.status,
          expires_at_utc: issued.record.expiresAt,
          account_user_id: issued.record.userId
        });
        return;
      }

      if (url.pathname === BRAI_CMD_ACCESS_REVOKE_PATH) {
        assertNativeBraiCmdTransport(req);
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        const access = requireBraiCmdAccess(req, store);
        requestUserId = access.userId;
        store.revokeBraiCmdToken(access.id);
        sendJson(req, res, 200, { ok: true, status: 'revoked' });
        return;
      }

      if (isNativeProviderSyncRoute(url.pathname)) {
        assertNativeBraiCmdTransport(req);
        const access = requireBraiCmdAccess(req, store);
        requestUserId = access.userId;
        await withUserScope(access.userId, () => handleNativeProviderSync({
          req,
          res,
          access,
          store,
          sendJson,
          readJson,
          fetchImpl: userAiFetch,
          now
        }));
        return;
      }

      if (isBraiCmdPublicRoute(url.pathname)) {
        await handleBraiCmdPublicRoute({ req, res, url, store, runtime: braiCmdRuntime, sendJson });
        return;
      }

      const authContext = await authenticateRequest(req, token, url, sessionSecret, now, auth, store);
      requestUserId = authContext.userId;
      if (!authContext.authorized) {
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.denied',
          status: 'failed',
          severityText: 'WARN',
          reason: 'unauthorized',
          message: 'API request unauthorized',
          jsonData: {
            method: req.method ?? 'GET',
            path: url.pathname,
            bearer_present: Boolean(req.headers.authorization),
            session_cookie_present: Boolean(req.headers.cookie)
          }
        });
        sendJson(req, res, 401, { error: 'unauthorized' });
        return;
      }
      if (requiresTrustedOrigin(req, authContext) && !isTrustedAppOrigin(req.headers.origin)) {
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.denied',
          status: 'failed',
          severityText: 'WARN',
          userId: authContext.userId,
          reason: 'forbidden_origin',
          message: 'API request forbidden by origin policy',
          jsonData: {
            method: req.method ?? 'GET',
            path: url.pathname,
            session_based: Boolean(authContext.sessionBased),
            origin_present: Boolean(req.headers.origin)
          }
        });
        sendJson(req, res, 403, { error: 'forbidden_origin' });
        return;
      }

      if (isBraiCmdAdminRoute(url.pathname)) {
        await withUserScope(authContext.userId, () => handleBraiCmdAdminRoute({ req, res, url, store, sendJson }));
        return;
      }

      await withUserScope(authContext.userId, async () => {
      if (isUserAiRoute(url.pathname)) {
        await handleUserAiRoute({
          req,
          res,
          url,
          store,
          sendJson,
          readJson,
          fetchImpl: userAiFetch,
          now
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/brai-cmd/device-token') {
        const body = await readJson(req, { limit: 16 * 1024 });
        const deviceId = firstTextField(body, ['deviceId', 'device_id']);
        if (!deviceId) {
          sendJson(req, res, 400, { error: 'device_id_required' });
          return;
        }
        if (deviceId.length > 200) {
          sendJson(req, res, 400, { error: 'invalid_device_id' });
          return;
        }
        const issued = store.issueBraiCmdAccountLink({
          displayName: authContext.user?.name || authContext.user?.email || 'Brai',
          deviceId,
          userId: authContext.userId,
          clientVersion: firstTextField(body, ['clientVersion', 'client_version']),
          appPackage: firstTextField(body, ['appPackage', 'app_package']),
          nowIso: now().toISOString()
        });
        sendJson(req, res, 201, {
          token: issued.token,
          status: 'pending',
          expires_at_utc: issued.record.expiresAt
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/settings') {
        sendJson(req, res, 200, settingsState(store, inboxExternalAi));
        return;
      }

      if (['POST', 'PUT', 'PATCH'].includes(req.method) && url.pathname === '/v1/settings') {
        const requestNow = now();
        const body = await readJson(req, { limit: 64 * 1024 });
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(req, res, 400, { error: 'invalid_settings_payload' });
          return;
        }
        store.setAppSettings(body, requestNow.toISOString());
        sendJson(req, res, 200, settingsState(store, inboxExternalAi));
        return;
      }

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

      if (req.method === 'GET' && serveInboxAttachment(req, res, url, inboxStorageRoot, sendJson, store)) {
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/inbox') {
        sendJson(req, res, 200, inboxState(store, now()));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/draws') {
        sendJson(req, res, 200, { draws: listDrawScenes(resolvedVaultRoot) });
        return;
      }

      const drawRenameMatch = url.pathname.match(/^\/v1\/draws\/([^/]+)\/rename$/);
      if (drawRenameMatch) {
        if (req.method !== 'POST') {
          sendJson(req, res, 405, { error: 'method_not_allowed' });
          return;
        }
        const body = await readJson(req, { limit: 4096 });
        const scene = renameDrawScene(resolvedVaultRoot, drawSceneFileName(drawRenameMatch[1]), drawSceneFileName(body.name));
        sendJson(req, res, 200, scene);
        return;
      }

      const drawMatch = url.pathname.match(/^\/v1\/draws\/([^/]+)$/);
      if (drawMatch) {
        const fileName = drawSceneFileName(drawMatch[1]);
        if (req.method === 'GET') {
          const scene = readDrawScene(resolvedVaultRoot, fileName);
          sendJson(req, res, scene ? 200 : 404, scene ?? { error: 'not_found' });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJson(req, { limit: DRAW_SCENE_LIMIT_BYTES });
          const scene = writeDrawScene(resolvedVaultRoot, fileName, body.scene ?? body);
          sendJson(req, res, 200, scene);
          return;
        }
        sendJson(req, res, 405, { error: 'method_not_allowed' });
        return;
      }

      const inboxWorkflowMatch = req.method === 'GET'
        ? url.pathname.match(/^\/v1\/inbox\/([^/]+)\/workflow$/)
        : null;
      if (inboxWorkflowMatch) {
        const inboxId = decodeURIComponent(inboxWorkflowMatch[1]);
        const details = store.getInboxWorkflowDetails(inboxId);
        sendJson(req, res, details ? 200 : 404, details ?? { error: 'not_found' });
        return;
      }

      const activityWorkflowMatch = req.method === 'GET'
        ? url.pathname.match(/^\/v1\/(?:activities|actions)\/([^/]+)\/workflow$/)
        : null;
      if (activityWorkflowMatch) {
        const activityId = decodeURIComponent(activityWorkflowMatch[1]);
        const details = store.getActivityWorkflowDetails(activityId);
        sendJson(req, res, details ? 200 : 404, details ?? { error: 'not_found' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/events') {
        sendJson(req, res, 200, { events: store.listEvents({ limit: url.searchParams.get('limit') }) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/logs') {
        sendJson(req, res, 200, { logs: store.listLogs({ limit: url.searchParams.get('limit') }) });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/ai-logs') {
        sendJson(req, res, 200, { logs: store.listAiLogs({ limit: url.searchParams.get('limit') }) });
        return;
      }

      if (
        req.method === 'POST' &&
        (url.pathname === '/v1/activities/events/sync' || url.pathname === '/v1/actions/events/sync')
      ) {
        const requestNow = now();
        const ownerUserId = scopedUserId();
        const body = await readJson(req, { limit: 256 * 1024 });
        const activityIdsToProcess = createdActivityIds(body.events);
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
        }, ownerUserId);
        sendJson(req, res, 200, responseBody);
        for (const activityId of activityIdsToProcess) processActivityLater({ ownerUserId, activityId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/inbox/events/sync') {
        const requestNow = now();
        const ownerUserId = scopedUserId();
        const body = await readJson(req, { limit: 256 * 1024 });
        const inboxIdsToProcess = createdInboxIds(body.events);
        const result = store.syncInboxEvents({
          device: body.device,
          events: body.events,
          lastKnownServerTimeUtc: body.last_known_server_time_utc,
          nowIso: requestNow.toISOString()
        });
        const state = inboxState(store, requestNow);
        const responseBody = { ...result, state };
        broadcast(sockets, { type: 'inbox_synced', inbox_state: state }, ownerUserId);
        sendJson(req, res, 200, responseBody);
        for (const inboxId of inboxIdsToProcess) processInboxLater({ ownerUserId, inboxId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/start') {
        const requestNow = now();
        const result = store.startTimer(requestNow.toISOString());
        const body = { ...timerState(store, requestNow), created: result.created };
        recordRuntimeLog(store, logger, {
          traceId,
          dt: requestNow.toISOString(),
          source: 'timer',
          operation: 'timer.start_endpoint',
          status: result.created ? 'done' : 'skipped',
          reason: result.created ? null : 'already_active',
          message: result.created ? 'Timer started from endpoint' : 'Timer start skipped',
          jsonData: {
            created: Boolean(result.created),
            active_session_id: result.session?.id ?? null,
            server_revision: body.server_revision
          }
        });
        broadcast(sockets, { type: 'timer_started', state: body }, scopedUserId());
        sendJson(req, res, result.created ? 201 : 200, body);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/timer/stop') {
        const requestNow = now();
        const result = store.stopTimer(requestNow.toISOString());
        const settings = store.appSettings();
        const body = {
          ...timerState(store, requestNow),
          stopped: result.stopped,
          completed_session: formatSession(result.session, settings.display_timezone)
        };
        if (result.stopped) {
          broadcast(sockets, { type: 'timer_stopped', state: body }, scopedUserId());
        }
        recordRuntimeLog(store, logger, {
          traceId,
          dt: requestNow.toISOString(),
          source: 'timer',
          operation: 'timer.stop_endpoint',
          status: result.stopped ? 'done' : 'skipped',
          reason: result.stopped ? null : 'no_active_session',
          message: result.stopped ? 'Timer stopped from endpoint' : 'Timer stop skipped',
          jsonData: {
            stopped: Boolean(result.stopped),
            completed_session_id: result.session?.id ?? null,
            duration_seconds: result.session?.duration_seconds ?? null,
            server_revision: body.server_revision
          }
        });
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

  const connections = new Set();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const traceId = crypto.randomUUID();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const authContext = await authenticateRequest(req, token, url, sessionSecret, now, auth, store);
      if (url.pathname !== '/v1/live' || !authContext.authorized) {
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.websocket',
          status: 'failed',
          severityText: 'WARN',
          reason: url.pathname === '/v1/live' ? 'unauthorized' : 'wrong_path',
          message: 'WebSocket upgrade rejected',
          jsonData: { path: url.pathname, authorized: Boolean(authContext.authorized) }
        });
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = authContext.userId;
        sockets.add(ws);
        recordRuntimeLog(store, logger, {
          traceId,
          source: 'auth',
          operation: 'auth.websocket',
          status: 'done',
          userId: authContext.userId,
          message: 'WebSocket connected',
          jsonData: { path: url.pathname }
        });
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
      recordRuntimeLog(store, logger, {
        source: 'auth',
        operation: 'auth.websocket',
        status: 'failed',
        severityText: 'WARN',
        reason: 'upgrade_error',
        message: 'WebSocket upgrade failed'
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    });
  });

  let closePromise = null;
  return {
    server,
    store,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        await new Promise((resolve) => {
          const forceClose = setTimeout(() => {
            server.closeAllConnections?.();
            for (const connection of connections) connection.destroy();
          }, shutdownGraceMs);
          forceClose.unref();
          server.close(() => {
            clearTimeout(forceClose);
            resolve();
          });
          server.closeIdleConnections?.();
        });
        await authRuntime.close();
        store.close();
      })();
      return closePromise;
    }
  };
}

export function timerState(store, nowDate) {
  const settings = store.appSettings();
  const active = formatSession(store.getActiveSession(), settings.display_timezone);
  const activeInterval = formatFocusInterval(store.getActiveInterval(), settings.display_timezone);
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
    timezone: settings.display_timezone,
    active_session: active,
    elapsed_seconds: elapsedSeconds,
    active_interval: activeInterval,
    active_interval_elapsed_seconds: activeIntervalElapsedSeconds,
    active_activity_id: activeInterval?.activity_id ?? null,
    active_session_start_origin: active?.start_origin ?? null,
    active_session_started_by_activity_id: active?.started_by_activity_id ?? null
  };
}

export function settingsState(store, inboxExternalAi = {}) {
  return {
    ...store.appSettings(),
    external_ai: {
      groq_configured: Boolean(inboxExternalAi.groqApiKey),
      openai_configured: Boolean(inboxExternalAi.openaiApiKey)
    }
  };
}

export function activitiesState(store, nowDate) {
  const activities = store.listActivities();
  const archivedActivities = store.listArchivedActivities();
  return {
    server_time_utc: nowDate.toISOString(),
    server_revision: store.getActivityServerRevision(),
    activities: addActivityAiProcessingState(activities),
    archived_activities: addActivityAiProcessingState(archivedActivities)
  };
}

function addActivityAiProcessingState(activities) {
  return activities.map((item) => {
    if (item.workflow_status === 'failed' || item.workflow_status === 'needs_review') {
      return {
        ...item,
        ai_processing_status: item.workflow_status,
        ai_processing_error: item.workflow_last_error || 'Ошибка AI-обработки'
      };
    }
    if (item.workflow_status === 'queued' || item.workflow_status === 'running') {
      return { ...item, ai_processing_status: 'running', ai_processing_error: null };
    }
    return {
      ...item,
      ai_processing_status: null,
      ai_processing_error: null
    };
  });
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
  const inbox = store.listInbox();
  return {
    server_time_utc: nowDate.toISOString(),
    server_revision: store.getInboxServerRevision(),
    inbox: addInboxAiProcessingState(store, inbox)
  };
}

function addInboxAiProcessingState(store, inbox) {
  return inbox.map((item) => {
    if (item.workflow_status === 'failed' || item.workflow_status === 'needs_review') {
      return {
        ...item,
        ai_processing_status: item.workflow_status,
        ai_processing_error: item.workflow_last_error || 'Ошибка AI-обработки'
      };
    }
    if (item.workflow_status === 'queued' || item.workflow_status === 'running') {
      return { ...item, ai_processing_status: 'running', ai_processing_error: null };
    }
    return {
      ...item,
      ai_processing_status: null,
      ai_processing_error: null
    };
  });
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

async function prepareSignedInAuthUser({ store, logger, traceId, route, operation, payload, preliminaryContext = {}, ensureUserVault, now }) {
  let vaultPrepared = true;
  try {
    await ensureUserVault({ userId: payload.user.id, email: payload.user.email });
  } catch (error) {
    vaultPrepared = false;
    logger.error?.('Failed to prepare user vault', {
      error: error instanceof Error ? error.message : String(error),
      userId: payload.user.id
    });
    recordRuntimeLog(store, logger, {
      traceId,
      source: 'auth',
      operation,
      status: 'failed',
      severityText: 'ERROR',
      userId: payload.user.id,
      reason: 'vault_prepare_failed',
      message: 'Auth sign-in vault preparation failed',
      jsonData: { route, error_name: error instanceof Error ? error.name : 'Error' }
    });
  }
  const signedInAt = now().toISOString();
  store.claimFirstUser(payload.user.id, signedInAt);
  let preliminaryLinked = false;
  try {
    const preliminary = store.finalizeBraiCmdPreliminaryUser({
      userId: payload.user.id,
      preliminaryUserId: preliminaryContext.preliminaryUserId,
      preliminaryClaimToken: preliminaryContext.preliminaryClaimToken,
      deviceFingerprint: preliminaryContext.deviceFingerprint,
      nowIso: signedInAt
    });
    preliminaryLinked = Boolean(preliminary.linked);
  } catch (error) {
    recordRuntimeLog(store, logger, {
      traceId,
      source: 'auth',
      operation,
      status: 'failed',
      severityText: 'WARN',
      userId: payload.user.id,
      reason: 'preliminary_finalize_failed',
      message: 'Auth sign-in preliminary finalization failed',
      jsonData: { route, error_name: error instanceof Error ? error.name : 'Error' }
    });
  }
  return { ok: true, vaultPrepared, preliminaryLinked };
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

function authPreliminaryContext(body) {
  return {
    preliminaryUserId: cleanName(body.preliminaryUserId),
    preliminaryClaimToken: cleanName(body.preliminaryClaimToken),
    deviceFingerprint: cleanName(body.deviceFingerprint)
  };
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
  if (typeof origin === 'string') return BASE_JSON_HEADERS;
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
  if (origin === 'https://brai.one') return pathname === '/auth/session';
  if (isTrustedAppOrigin(origin)) return true;
  return false;
}

function isTrustedAppOrigin(origin) {
  if (origin === 'https://app.brai.one') return true;
  if (origin === 'https://dev.brai.one') return true;
  if (/^https:\/\/[a-e]\.test\.brai\.one$/.test(origin)) return true;
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'https://localhost' || origin === 'http://localhost') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function isTestEmailLoginOrigin(origin) {
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'https://dev.brai.one' || origin === 'https://dev.brightos.world') return true;
  if (/^https:\/\/[a-e]\.test\.brai\.one$/.test(origin ?? '')) return true;
  if (/^https:\/\/[a-e]\.test\.brightos\.world$/.test(origin ?? '')) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');
}

function requiresTrustedOrigin(req, authContext) {
  return authContext.sessionBased && STATE_CHANGING_METHODS.has(req.method ?? '');
}

function assertNativeBraiCmdTransport(req) {
  // Node's native fetch adds Sec-Fetch-Mode alone; browsers also send Site/Dest (and POST Origin).
  const browserMetadataPresent = Boolean(
    req.headers?.['sec-fetch-site'] || req.headers?.['sec-fetch-dest'] || req.headers?.['sec-fetch-user']
  );
  if (req.headers?.origin || browserMetadataPresent) {
    const error = new Error('native_transport_required');
    error.status = 403;
    throw error;
  }
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(303, { location, ...extraHeaders });
  res.end();
}

function braiCmdInboxFunctionKey(body) {
  const explicit = firstTextField(body, ['brai_cmd_function', 'braiCmdFunction', 'function_key', 'functionKey']);
  if (explicit) return explicit;

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const hasAttachments = Array.isArray(body?.attachments) && body.attachments.length > 0;
  const hasContext = body?.description_json && typeof body.description_json === 'object' && !Array.isArray(body.description_json);
  if (hasAttachments && text === 'Скриншот') return 'screenshot_inbox';
  if (hasAttachments) return 'screenshot_voice_inbox';
  if (hasContext && text.startsWith(BRAI_CMD_CHAT_PREFIX)) return 'chat_context_inbox';
  if (hasContext) return 'save_context_inbox';
  return 'idea_voice_inbox';
}

function firstTextField(body, names) {
  for (const name of names) {
    const value = body?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function sendBraiCmdFunctionDisabled(req, res, store, sendJson) {
  const notice = store.braiCmdNotice?.(BRAI_CMD_FUNCTION_DISABLED_MESSAGE_KEY, 'error') ?? {
    key: BRAI_CMD_FUNCTION_DISABLED_MESSAGE_KEY,
    text: 'Функция временно недоступна',
    tone: 'error'
  };
  sendJson(req, res, 403, {
    error: notice.text,
    code: BRAI_CMD_FUNCTION_DISABLED_CODE,
    notice
  });
}

function recordRuntimeLog(store, logger, input) {
  try {
    store.recordLog(input);
  } catch (error) {
    logger.error?.('runtime log failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function listDrawScenes(vaultRoot) {
  const drawsDir = ensureScopedDrawsDir(vaultRoot);
  return fs.readdirSync(drawsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.excalidraw'))
    .map((entry) => drawSceneSummary(drawsDir, entry.name))
    .sort((left, right) => right.updated_at_utc.localeCompare(left.updated_at_utc) || left.name.localeCompare(right.name));
}

function readDrawScene(vaultRoot, fileName) {
  const drawsDir = ensureScopedDrawsDir(vaultRoot);
  const filePath = safeDrawScenePath(drawsDir, fileName);
  if (!fs.existsSync(filePath)) return null;
  const scene = normalizeDrawScene(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  return { ...drawSceneSummary(drawsDir, fileName), scene };
}

function writeDrawScene(vaultRoot, fileName, scene) {
  const drawsDir = ensureScopedDrawsDir(vaultRoot);
  const filePath = safeDrawScenePath(drawsDir, fileName);
  const nextScene = normalizeDrawScene(scene);
  fs.writeFileSync(filePath, JSON.stringify(nextScene));
  return { ...drawSceneSummary(drawsDir, fileName), scene: nextScene };
}

function renameDrawScene(vaultRoot, fromName, toName) {
  const drawsDir = ensureScopedDrawsDir(vaultRoot);
  const fromPath = safeDrawScenePath(drawsDir, fromName);
  const toPath = safeDrawScenePath(drawsDir, toName);
  if (!fs.existsSync(fromPath)) {
    const error = new Error('not_found');
    error.status = 404;
    throw error;
  }
  if (fromPath !== toPath && fs.existsSync(toPath)) {
    const error = new Error('draw_exists');
    error.status = 409;
    throw error;
  }
  if (fromPath !== toPath) fs.renameSync(fromPath, toPath);
  const scene = normalizeDrawScene(JSON.parse(fs.readFileSync(toPath, 'utf8')));
  return { ...drawSceneSummary(drawsDir, toName), scene };
}

function ensureScopedDrawsDir(vaultRoot) {
  const userId = scopedUserId();
  if (!userId) {
    const error = new Error('user_required');
    error.status = 409;
    throw error;
  }
  const safeUserId = validateVaultUserId(userId);
  const userDir = path.resolve(vaultRoot, safeUserId);
  const drawsDir = path.join(userDir, 'Draws');
  ensureDirectoryMode(drawsDir, 0o2770);
  return drawsDir;
}

function drawSceneFileName(value) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(String(value ?? ''));
  } catch {
    const error = new Error('invalid_draw_name');
    error.status = 400;
    throw error;
  }
  const trimmed = decoded.trim();
  const fileName = trimmed.endsWith('.excalidraw') ? trimmed : `${trimmed}.excalidraw`;
  if (!/^[^/\\\0]{1,120}\.excalidraw$/u.test(fileName) || fileName.startsWith('.') || fileName.includes('..')) {
    const error = new Error('invalid_draw_name');
    error.status = 400;
    throw error;
  }
  return fileName;
}

function safeDrawScenePath(drawsDir, fileName) {
  const filePath = path.resolve(drawsDir, fileName);
  const root = `${path.resolve(drawsDir)}${path.sep}`;
  if (!filePath.startsWith(root)) {
    const error = new Error('invalid_draw_name');
    error.status = 400;
    throw error;
  }
  return filePath;
}

function drawSceneSummary(drawsDir, fileName) {
  const stat = fs.statSync(safeDrawScenePath(drawsDir, fileName));
  return {
    name: fileName,
    title: fileName.replace(/\.excalidraw$/, ''),
    updated_at_utc: stat.mtime.toISOString(),
    size_bytes: stat.size
  };
}

function normalizeDrawScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    const error = new Error('invalid_draw_scene');
    error.status = 400;
    throw error;
  }
  const appState = scene.appState && typeof scene.appState === 'object' && !Array.isArray(scene.appState)
    ? { ...scene.appState }
    : {};
  delete appState.collaborators;
  return {
    ...scene,
    type: 'excalidraw',
    version: Number.isFinite(scene.version) ? scene.version : 2,
    source: typeof scene.source === 'string' ? scene.source : 'brai',
    elements: Array.isArray(scene.elements) ? scene.elements : [],
    appState,
    files: scene.files && typeof scene.files === 'object' && !Array.isArray(scene.files) ? scene.files : {}
  };
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

function createdInboxIds(events) {
  const ids = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'create') continue;
    const id = typeof event.inbox_id === 'string' ? event.inbox_id.trim() : '';
    if (id) ids.add(id);
  }
  return ids;
}

function createdActivityIds(events) {
  const ids = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    if ((event?.change_type ?? event?.type) !== 'create') continue;
    const id = typeof event.activity_id === 'string'
      ? event.activity_id.trim()
      : typeof event.action_id === 'string'
        ? event.action_id.trim()
        : '';
    if (id) ids.add(id);
  }
  return ids;
}

async function readJson(req, { limit = 4096 } = {}) {
  const raw = await readRequestBody(req, { limit });
  return raw ? parseJsonBody(raw) : {};
}

async function readPassword(req) {
  const raw = await readRequestBody(req);
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return new URLSearchParams(raw).get('password') ?? '';
  }
  if (contentType.includes('application/json')) {
    return raw ? parseJsonBody(raw).password ?? '' : '';
  }
  return raw;
}

function parseJsonBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('invalid_json');
    error.status = 400;
    throw error;
  }
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

function hasValidSession(req, sessionSecret, nowDate, cookieName = SESSION_COOKIE) {
  if (!sessionSecret) return false;
  const cookies = parseCookies(req.headers.cookie ?? '');
  const value = cookies[cookieName];
  if (!value) return false;

  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const expiresMs = Number(parts[1]);
  const signature = parts[2];
  if (!Number.isFinite(expiresMs) || expiresMs < nowDate.getTime()) return false;

  const expected = signSession(sessionSecret, expiresMs);
  return timingSafeEqual(signature, expected);
}

function createSessionCookie(sessionSecret, nowDate, secure, cookieName = SESSION_COOKIE) {
  if (!sessionSecret) throw new Error('session_secret_required');
  const expiresMs = nowDate.getTime() + SESSION_MAX_AGE_SECONDS * 1000;
  const signature = signSession(sessionSecret, expiresMs);
  const securePart = secure ? '; Secure' : '';
  const sameSite = secure ? 'None' : 'Lax';
  return `${cookieName}=v1.${expiresMs}.${signature}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${SESSION_MAX_AGE_SECONDS}${securePart}`;
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
  return host.includes('brai.one') || req.headers['x-forwarded-proto'] === 'https';
}

export function createUserVaultPreparer({
  vaultRoot = null,
  syncthingGuiAddress = null,
  syncthingApiKey = null,
  syncthingFolderIdPrefix = 'vault-user-',
  syncthingBin = 'syncthing',
  runSyncthingCli = defaultRunSyncthingCli
} = {}) {
  const root = typeof vaultRoot === 'string' && vaultRoot.trim() ? path.resolve(vaultRoot) : '';
  return async ({ userId, email }) => {
    if (!root) return;
    const safeUserId = validateVaultUserId(userId);
    const label = cleanEmail(email) ?? safeUserId;
    ensureDirectoryMode(root, 0o2770);

    const folderPath = path.join(root, safeUserId);
    ensureDirectoryMode(folderPath, 0o2770);
    if (!fs.statSync(folderPath).isDirectory()) {
      throw new Error('vault_user_path_not_directory');
    }

    if (!syncthingApiKey) return;

    const baseArgs = [
      syncthingBin,
      'cli',
      `--gui-address=${syncthingGuiAddress || '127.0.0.1:8384'}`,
      `--gui-apikey=${syncthingApiKey}`
    ];
    const folderId = `${syncthingFolderIdPrefix}${safeUserId}`;
    const listedFolders = await runSyncthingCli([...baseArgs, 'config', 'folders', 'list']);
    const hasFolder = listedFolders
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .includes(folderId);

    if (!hasFolder) {
      await runSyncthingCli([
        ...baseArgs,
        'config',
        'folders',
        'add',
        `--id=${folderId}`,
        `--label=${label}`,
        `--path=${folderPath}`,
        '--type=sendreceive'
      ]);
      return;
    }

    await runSyncthingCli([...baseArgs, 'config', 'folders', folderId, 'label', 'set', label]);
    await runSyncthingCli([...baseArgs, 'config', 'folders', folderId, 'path', 'set', folderPath]);
  };
}

function validateVaultUserId(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error('invalid_vault_user_id');
  }
  return userId;
}

function ensureDirectoryMode(dirPath, mode) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch (error) {
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error;
  }
}

async function defaultRunSyncthingCli(command) {
  const [bin, ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `syncthing cli exited with ${code}`));
    });
  });
}
