import crypto from 'node:crypto';
import { scopedUserId } from './user-scope.js';

export const USER_AI_PROVIDERS = Object.freeze(['openai', 'groq', 'openrouter', 'gemini']);

export const userAiStoreMethods = {
  configureUserAiEncryptionKey(value) {
    this.userAiEncryptionKey = parseUserAiEncryptionKey(value);
  },

  userAiSettings() {
    const userId = requireScopedUser(this);
    const row = this.db.prepare(`
      SELECT model_provider_mode, text_provider_id, text_model,
        vision_provider_id, vision_model, created_at_utc, updated_at_utc
      FROM user_ai_settings
      WHERE user_id = ?
    `).get(userId);
    if (row) return formatUserAiSettings(row);
    return {
      model_provider_mode: 'internal',
      text: null,
      vision: null,
      created_at_utc: null,
      updated_at_utc: null
    };
  },

  setUserAiSettings(input, nowIso = new Date().toISOString()) {
    const userId = requireScopedUser(this);
    const { model_provider_mode: mode, text, vision } = resolveUserAiSettings(input, this.userAiSettings());
    if (text) requireStoredCredential(this, userId, text.provider_id);
    if (vision) requireStoredCredential(this, userId, vision.provider_id);
    this.db.prepare(`
      INSERT INTO user_ai_settings (
        user_id, model_provider_mode, text_provider_id, text_model,
        vision_provider_id, vision_model, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET
        model_provider_mode = excluded.model_provider_mode,
        text_provider_id = excluded.text_provider_id,
        text_model = excluded.text_model,
        vision_provider_id = excluded.vision_provider_id,
        vision_model = excluded.vision_model,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      userId,
      mode,
      text?.provider_id ?? null,
      text?.model ?? null,
      vision?.provider_id ?? null,
      vision?.model ?? null,
      nowIso,
      nowIso
    );
    safeLog(this, {
      dt: nowIso,
      source: 'settings',
      operation: 'user_ai.settings_update',
      status: 'done',
      message: 'User AI settings updated',
      jsonData: {
        model_provider_mode: mode,
        text_provider_id: text?.provider_id ?? null,
        text_model: text?.model ?? null,
        vision_provider_id: vision?.provider_id ?? null,
        vision_model: vision?.model ?? null
      }
    });
    return this.userAiSettings();
  },

  listUserProviderCredentials() {
    const userId = requireScopedUser(this);
    const settings = this.userAiSettings();
    return this.db.prepare(`
      SELECT provider_id, key_hint, verified_at_utc, created_at_utc, updated_at_utc
      FROM user_provider_credentials
      WHERE user_id = ?
      ORDER BY provider_id
    `).all(userId).map((row) => ({
      ...row,
      in_use_by: [
        ...(settings.model_provider_mode === 'external' && settings.text?.provider_id === row.provider_id ? ['text'] : []),
        ...(settings.model_provider_mode === 'external' && settings.vision?.provider_id === row.provider_id ? ['vision'] : [])
      ]
    }));
  },

  getUserProviderCredential(providerId) {
    const userId = requireScopedUser(this);
    const provider = normalizeProvider(providerId);
    const row = this.db.prepare(`
      SELECT provider_id, encrypted_api_key, key_hint, verified_at_utc,
        created_at_utc, updated_at_utc
      FROM user_provider_credentials
      WHERE user_id = ? AND provider_id = ?
    `).get(userId, provider);
    if (!row) return null;
    return {
      provider_id: row.provider_id,
      api_key: decryptUserProviderKey(row.encrypted_api_key, {
        encryptionKey: requiredConfiguredKey(this), userId, providerId: provider
      }),
      key_hint: row.key_hint,
      verified_at_utc: row.verified_at_utc,
      created_at_utc: row.created_at_utc,
      updated_at_utc: row.updated_at_utc
    };
  },

  putUserProviderCredential({ providerId, apiKey, verifiedAt, nowIso = new Date().toISOString() }) {
    const userId = requireScopedUser(this);
    const provider = normalizeProvider(providerId);
    const secret = normalizeApiKey(apiKey);
    const replacing = Boolean(this.db.prepare(`
      SELECT 1 FROM user_provider_credentials WHERE user_id = ? AND provider_id = ?
    `).get(userId, provider));
    const encrypted = encryptUserProviderKey(secret, {
      encryptionKey: requiredConfiguredKey(this), userId, providerId: provider
    });
    this.db.prepare(`
      INSERT INTO user_provider_credentials (
        user_id, provider_id, encrypted_api_key, key_hint,
        verified_at_utc, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, provider_id) DO UPDATE SET
        encrypted_api_key = excluded.encrypted_api_key,
        key_hint = excluded.key_hint,
        verified_at_utc = excluded.verified_at_utc,
        updated_at_utc = excluded.updated_at_utc
    `).run(userId, provider, encrypted, secret.slice(-4), verifiedAt ?? nowIso, nowIso, nowIso);
    safeLog(this, {
      dt: nowIso,
      source: 'settings',
      operation: replacing ? 'user_ai.provider_replace' : 'user_ai.provider_add',
      status: 'done',
      message: replacing
        ? 'User AI provider credential replaced'
        : 'User AI provider credential added',
      jsonData: { provider_id: provider }
    });
    return this.listUserProviderCredentials().find((item) => item.provider_id === provider);
  },

  addUserProviderCredentialIfMissing({ providerId, apiKey, verifiedAt, nowIso = new Date().toISOString() }) {
    const userId = requireScopedUser(this);
    const provider = normalizeProvider(providerId);
    const secret = normalizeApiKey(apiKey);
    const encrypted = encryptUserProviderKey(secret, {
      encryptionKey: requiredConfiguredKey(this), userId, providerId: provider
    });
    const result = this.db.prepare(`
      INSERT INTO user_provider_credentials (
        user_id, provider_id, encrypted_api_key, key_hint,
        verified_at_utc, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, provider_id) DO NOTHING
    `).run(userId, provider, encrypted, secret.slice(-4), verifiedAt ?? nowIso, nowIso, nowIso);
    if (!result.changes) return false;
    safeLog(this, {
      dt: nowIso,
      source: 'settings',
      operation: 'user_ai.provider_add',
      status: 'done',
      message: 'User AI provider credential added',
      jsonData: { provider_id: provider }
    });
    return true;
  },

  deleteUserProviderCredential(providerId, nowIso = new Date().toISOString()) {
    const userId = requireScopedUser(this);
    const provider = normalizeProvider(providerId);
    const settings = this.userAiSettings();
    if (settings.model_provider_mode === 'external'
      && (settings.text?.provider_id === provider || settings.vision?.provider_id === provider)) {
      throw userAiError('provider_in_use', 409);
    }
    const run = this.db.transaction(() => {
      if (settings.text?.provider_id === provider) {
        this.db.prepare(`
          UPDATE user_ai_settings
          SET text_provider_id = NULL, text_model = NULL, updated_at_utc = ?
          WHERE user_id = ?
        `).run(nowIso, userId);
      }
      if (settings.vision?.provider_id === provider) {
        this.db.prepare(`
          UPDATE user_ai_settings
          SET vision_provider_id = NULL, vision_model = NULL, updated_at_utc = ?
          WHERE user_id = ?
        `).run(nowIso, userId);
      }
      return this.db.prepare(`
        DELETE FROM user_provider_credentials
        WHERE user_id = ? AND provider_id = ?
      `).run(userId, provider);
    });
    const result = run();
    if (!result.changes) throw userAiError('provider_not_found', 404);
    safeLog(this, {
      dt: nowIso,
      source: 'settings',
      operation: 'user_ai.provider_delete',
      status: 'done',
      message: 'User AI provider credential deleted',
      jsonData: { provider_id: provider }
    });
    return true;
  }
};

export function parseUserAiEncryptionKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) throw userAiError('invalid_user_ai_encryption_key', 500);
  const key = Buffer.from(text, 'base64url');
  if (key.length !== 32) throw userAiError('invalid_user_ai_encryption_key', 500);
  return key;
}

export function encryptUserProviderKey(apiKey, { encryptionKey, userId, providerId }) {
  const key = parseUserAiEncryptionKey(encryptionKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(credentialAad(userId, providerId)));
  const encrypted = Buffer.concat([cipher.update(normalizeApiKey(apiKey), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

export function decryptUserProviderKey(envelope, { encryptionKey, userId, providerId }) {
  try {
    const [version, ivText, encryptedText, tagText, extra] = String(envelope ?? '').split('.');
    if (version !== 'v1' || !ivText || !encryptedText || !tagText || extra) throw new Error('invalid_envelope');
    const iv = strictBase64Url(ivText, 12);
    const encrypted = strictBase64Url(encryptedText);
    const tag = strictBase64Url(tagText, 16);
    if (!encrypted.length) throw new Error('invalid_envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', parseUserAiEncryptionKey(encryptionKey), iv);
    decipher.setAAD(Buffer.from(credentialAad(userId, providerId)));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw userAiError('credential_decryption_failed', 500);
  }
}

export function normalizeProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!USER_AI_PROVIDERS.includes(provider)) throw userAiError('unsupported_provider', 400);
  return provider;
}

/** Resolves a partial account AI settings update without coupling saved profiles to the active mode. */
export function resolveUserAiSettings(input, current = {}) {
  const patch = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const mode = Object.hasOwn(patch, 'model_provider_mode')
    ? normalizeMode(patch.model_provider_mode)
    : normalizeMode(current.model_provider_mode ?? 'internal');
  const text = Object.hasOwn(patch, 'text')
    ? normalizeOptionalProfile(patch.text, 'text')
    : normalizeOptionalProfile(current.text, 'text');
  const vision = Object.hasOwn(patch, 'vision')
    ? normalizeOptionalProfile(patch.vision, 'vision')
    : normalizeOptionalProfile(current.vision, 'vision');
  if (mode === 'external' && (!text || !vision)) {
    throw userAiError(!text ? 'text_profile_required' : 'vision_profile_required', 400);
  }
  return { model_provider_mode: mode, text, vision };
}

function normalizeApiKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 2048 || /[\r\n]/.test(key)) throw userAiError('invalid_api_key', 400);
  return key;
}

function normalizeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'internal' || mode === 'external') return mode;
  throw userAiError('invalid_model_provider_mode', 400);
}

function normalizeProfile(value, capability) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw userAiError(`${capability}_profile_required`, 400);
  }
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model) throw userAiError(`${capability}_model_required`, 400);
  if (model.length > 240) throw userAiError(`${capability}_model_invalid`, 400);
  return { provider_id: normalizeProvider(value.provider_id), model };
}

function normalizeOptionalProfile(value, capability) {
  return value == null ? null : normalizeProfile(value, capability);
}

function strictBase64Url(value, expectedBytes = null) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('invalid_envelope');
  const decoded = Buffer.from(text, 'base64url');
  if (decoded.toString('base64url') !== text) throw new Error('invalid_envelope');
  if (expectedBytes !== null && decoded.length !== expectedBytes) throw new Error('invalid_envelope');
  return decoded;
}

function requireStoredCredential(store, userId, providerId) {
  const row = store.db.prepare(`
    SELECT 1 FROM user_provider_credentials WHERE user_id = ? AND provider_id = ?
  `).get(userId, providerId);
  if (!row) throw userAiError('provider_not_configured', 400);
}

function requireScopedUser(store) {
  const userId = scopedUserId();
  if (!userId || !store.getAuthUser?.(userId)) throw userAiError('account_required', 403);
  return userId;
}

function requiredConfiguredKey(store) {
  if (!store.userAiEncryptionKey) throw userAiError('user_ai_encryption_key_not_configured', 500);
  return store.userAiEncryptionKey;
}

function credentialAad(userId, providerId) {
  return `${String(userId ?? '').trim()}:${normalizeProvider(providerId)}`;
}

function formatUserAiSettings(row) {
  return {
    model_provider_mode: row.model_provider_mode,
    text: row.text_provider_id ? { provider_id: row.text_provider_id, model: row.text_model } : null,
    vision: row.vision_provider_id ? { provider_id: row.vision_provider_id, model: row.vision_model } : null,
    created_at_utc: row.created_at_utc,
    updated_at_utc: row.updated_at_utc
  };
}

function safeLog(store, input) {
  try {
    store.recordLog?.(input);
  } catch {
    // Credential changes must not be rolled back by optional operation logging.
  }
}

function userAiError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}
