import {
  ProviderError,
  listProviderModels,
  probeProviderCapability,
  validateProviderKey
} from './user-ai-providers.js';
import { normalizeProvider } from './store-user-ai.js';
import { scopedUserId } from './user-scope.js';

const PROVIDER_PATH = /^\/v1\/ai\/providers\/([^/]+)$/;
const PROVIDER_MODELS_PATH = /^\/v1\/ai\/providers\/([^/]+)\/models$/;
const NATIVE_SYNC_PATH = '/v1/brai-cmd/provider-credentials/sync';
// ponytail: production API is single-process; replace with a DB lock before horizontal replicas.
const mutationTails = new Map();

export function isUserAiRoute(pathname) {
  return pathname === '/v1/ai/settings'
    || pathname === '/v1/ai/providers'
    || PROVIDER_PATH.test(pathname)
    || PROVIDER_MODELS_PATH.test(pathname);
}

export function isNativeProviderSyncRoute(pathname) {
  return pathname === NATIVE_SYNC_PATH;
}

export async function handleUserAiRoute({
  req,
  res,
  url,
  store,
  sendJson,
  readJson,
  fetchImpl,
  now = () => new Date()
}) {
  try {
    if (req.method === 'GET' && url.pathname === '/v1/ai/providers') {
      sendJson(req, res, 200, { providers: store.listUserProviderCredentials() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/ai/settings') {
      sendJson(req, res, 200, store.userAiSettings());
      return;
    }
    if (req.method === 'PATCH' && url.pathname === '/v1/ai/settings') {
      const body = await readJson(req, { limit: 32 * 1024 });
      const settings = await serializeUserAiMutation(scopedUserId(), async () => {
        await probeSettings(store, body, fetchImpl);
        return store.setUserAiSettings(body, now().toISOString());
      });
      sendJson(req, res, 200, settings);
      return;
    }

    const modelsMatch = url.pathname.match(PROVIDER_MODELS_PATH);
    if (req.method === 'GET' && modelsMatch) {
      const provider = normalizeProvider(decodeURIComponent(modelsMatch[1]));
      const capability = url.searchParams.get('capability') || null;
      const credential = configuredCredential(store, provider);
      const models = await listProviderModels({
        provider,
        apiKey: credential.api_key,
        capability,
        fetchImpl
      });
      sendJson(req, res, 200, { models });
      return;
    }

    const providerMatch = url.pathname.match(PROVIDER_PATH);
    if (providerMatch) {
      const provider = normalizeProvider(decodeURIComponent(providerMatch[1]));
      if (req.method === 'PUT') {
        const body = await readJson(req, { limit: 8 * 1024 });
        const apiKey = requestApiKey(body?.api_key);
        const saved = await serializeUserAiMutation(scopedUserId(), async () => {
          await validateProviderKey({ provider, apiKey, fetchImpl });
          await probeReplacementBindings(store, provider, apiKey, fetchImpl);
          const nowIso = now().toISOString();
          return store.putUserProviderCredential({
            providerId: provider,
            apiKey,
            verifiedAt: nowIso,
            nowIso
          });
        });
        sendJson(req, res, 200, { provider: saved });
        return;
      }
      if (req.method === 'DELETE') {
        await serializeUserAiMutation(scopedUserId(), () => (
          store.deleteUserProviderCredential(provider, now().toISOString())
        ));
        sendJson(req, res, 200, { ok: true });
        return;
      }
    }

    sendJson(req, res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    throw safeProviderHttpError(error);
  }
}

export async function handleNativeProviderSync({
  req,
  res,
  access,
  store,
  sendJson,
  readJson,
  fetchImpl,
  now = () => new Date()
}) {
  if (req.method !== 'POST') {
    sendJson(req, res, 405, { error: 'method_not_allowed' });
    return;
  }
  if (!access?.userId) throw httpError('account_required', 403);
  const body = await readJson(req, { limit: 16 * 1024 });
  const candidates = nativeCandidates(body?.providers);
  const result = await serializeUserAiMutation(access.userId, async () => {
    const existing = new Set(store.listUserProviderCredentials().map((item) => item.provider_id));
    const imported = [];
    const ignored = [];
    const failed = [];
    for (const candidate of candidates) {
      if (existing.has(candidate.provider_id)) {
        ignored.push(candidate.provider_id);
        continue;
      }
      try {
        await validateProviderKey({
          provider: candidate.provider_id,
          apiKey: candidate.api_key,
          fetchImpl
        });
        const nowIso = now().toISOString();
        const inserted = store.addUserProviderCredentialIfMissing({
          providerId: candidate.provider_id,
          apiKey: candidate.api_key,
          verifiedAt: nowIso,
          nowIso
        });
        if (!inserted) {
          existing.add(candidate.provider_id);
          ignored.push(candidate.provider_id);
          continue;
        }
        existing.add(candidate.provider_id);
        imported.push(candidate.provider_id);
      } catch (error) {
        failed.push({ provider_id: candidate.provider_id, code: safeProviderCode(error) });
      }
    }
    const providers = store.listUserProviderCredentials().map((metadata) => {
      const credential = configuredCredential(store, metadata.provider_id);
      return { provider_id: metadata.provider_id, api_key: credential.api_key };
    });
    return { providers, imported, ignored, failed };
  });
  const { providers, imported, ignored, failed } = result;
  safeLog(store, {
    source: 'brai-cmd',
    operation: 'brai_cmd.provider_credentials_sync',
    status: failed.length ? 'partial' : 'done',
    reason: failed.length ? 'provider_validation_failed' : null,
    message: 'Brai Cmd account provider credentials synchronized',
    jsonData: {
      access_token_id: access.id,
      imported_count: imported.length,
      ignored_count: ignored.length,
      failed_count: failed.length,
      returned_count: providers.length
    }
  });
  sendJson(req, res, 200, {
    account_user_id: access.userId,
    providers,
    imported_provider_ids: imported,
    ignored_provider_ids: ignored,
    failed
  });
}

export async function serializeUserAiMutation(userId, task) {
  if (!userId) throw httpError('account_required', 403);
  const previous = mutationTails.get(userId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  mutationTails.set(userId, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (mutationTails.get(userId) === current) mutationTails.delete(userId);
  }
}

async function probeSettings(store, body, fetchImpl) {
  if (String(body?.model_provider_mode ?? '').trim().toLowerCase() !== 'external') return;
  await Promise.all(['text', 'vision'].map(async (capability) => {
    const profile = body?.[capability];
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      throw httpError(`${capability}_profile_required`, 400);
    }
    const provider = normalizeProvider(profile.provider_id);
    const credential = configuredCredential(store, provider);
    await probeProviderCapability({
      provider,
      apiKey: credential.api_key,
      model: profile.model,
      capability,
      fetchImpl
    });
  }));
}

async function probeReplacementBindings(store, provider, apiKey, fetchImpl) {
  const settings = store.userAiSettings();
  await Promise.all(['text', 'vision'].map(async (capability) => {
    const profile = settings[capability];
    if (profile?.provider_id !== provider) return;
    await probeProviderCapability({
      provider,
      apiKey,
      model: profile.model,
      capability,
      fetchImpl
    });
  }));
}

function configuredCredential(store, provider) {
  const credential = store.getUserProviderCredential(provider);
  if (!credential) throw httpError('provider_not_configured', 404);
  return credential;
}

function nativeCandidates(value) {
  if (!Array.isArray(value) || value.length > 4) throw httpError('invalid_providers_payload', 400);
  const seen = new Set();
  return value.map((entry) => {
    const provider = normalizeProvider(entry?.provider_id);
    if (seen.has(provider)) throw httpError('duplicate_provider', 400);
    seen.add(provider);
    return { provider_id: provider, api_key: requestApiKey(entry?.api_key) };
  });
}

function requestApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (apiKey.length < 8 || apiKey.length > 2048 || /[\r\n]/.test(apiKey)) {
    throw httpError('invalid_api_key', 400);
  }
  return apiKey;
}

function safeProviderHttpError(error) {
  if (!(error instanceof ProviderError)) return error;
  return httpError(error.code, providerStatus(error.code));
}

function safeProviderCode(error) {
  return error instanceof ProviderError ? error.code : 'provider_unavailable';
}

function providerStatus(code) {
  if (code === 'invalid_key') return 400;
  if (code === 'provider_timeout') return 504;
  if (code === 'provider_unavailable') return 502;
  return 422;
}

function httpError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function safeLog(store, input) {
  try {
    store.recordLog?.(input);
  } catch {
    // Native credential sync must not fail because optional operation logging failed.
  }
}
