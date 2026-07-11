export const DEFAULT_APP_TIMEZONE = 'Europe/Moscow';
export const DEFAULT_MODEL_PROVIDER_MODE = 'internal';
export const DEFAULT_INBOX_TEXT_PROVIDER = 'groq';
export const DEFAULT_INBOX_TEXT_MODEL = 'openai/gpt-oss-120b';
export const DEFAULT_INBOX_IMAGE_PROVIDER = 'openai';
export const DEFAULT_INBOX_IMAGE_MODEL = 'gpt-4.1-mini';

const SETTINGS_KEYS = [
  'display_timezone',
  'goal_timezone',
  'model_provider_mode',
  'inbox_text_provider',
  'inbox_text_model',
  'inbox_image_provider',
  'inbox_image_model'
];

export const appSettingsMethods = {
  appSettings() {
    const rows = this.db
      .prepare(`SELECT key, value FROM app_settings WHERE key IN (${SETTINGS_KEYS.map(() => '?').join(', ')})`)
      .all(...SETTINGS_KEYS);
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const displayTimezone = normalizeTimeZone(values.display_timezone || values.goal_timezone || DEFAULT_APP_TIMEZONE);
    const modelProviderMode = normalizeModelProviderMode(values.model_provider_mode || DEFAULT_MODEL_PROVIDER_MODE);
    return {
      display_timezone: displayTimezone,
      model_provider_mode: modelProviderMode,
      inbox_text_provider: normalizeFixed(values.inbox_text_provider, 'groq', DEFAULT_INBOX_TEXT_PROVIDER),
      inbox_text_model: cleanModel(values.inbox_text_model) || DEFAULT_INBOX_TEXT_MODEL,
      inbox_image_provider: normalizeFixed(values.inbox_image_provider, 'openai', DEFAULT_INBOX_IMAGE_PROVIDER),
      inbox_image_model: cleanModel(values.inbox_image_model) || DEFAULT_INBOX_IMAGE_MODEL
    };
  },

  setAppSettings(patch, nowIso = new Date().toISOString()) {
    const current = this.appSettings();
    const next = {
      ...current,
      ...(Object.hasOwn(patch, 'display_timezone') ? { display_timezone: normalizeTimeZone(patch.display_timezone) } : {}),
      ...(Object.hasOwn(patch, 'model_provider_mode') ? { model_provider_mode: normalizeModelProviderMode(patch.model_provider_mode) } : {}),
      ...(Object.hasOwn(patch, 'inbox_text_model') ? { inbox_text_model: cleanModel(patch.inbox_text_model) || DEFAULT_INBOX_TEXT_MODEL } : {}),
      ...(Object.hasOwn(patch, 'inbox_image_model') ? { inbox_image_model: cleanModel(patch.inbox_image_model) || DEFAULT_INBOX_IMAGE_MODEL } : {})
    };

    const upsert = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        value = excluded.value,
        updated_at_utc = excluded.updated_at_utc
    `);
    const transaction = this.db.transaction(() => {
      upsert.run('display_timezone', next.display_timezone, nowIso);
      upsert.run('goal_timezone', next.display_timezone, nowIso);
      upsert.run('model_provider_mode', next.model_provider_mode, nowIso);
      upsert.run('inbox_text_provider', next.inbox_text_provider, nowIso);
      upsert.run('inbox_text_model', next.inbox_text_model, nowIso);
      upsert.run('inbox_image_provider', next.inbox_image_provider, nowIso);
      upsert.run('inbox_image_model', next.inbox_image_model, nowIso);
    });
    transaction();
    this.recordLog?.({
      dt: nowIso,
      source: 'settings',
      operation: 'settings.update',
      status: 'done',
      message: 'App settings updated',
      jsonData: {
        display_timezone: next.display_timezone,
        model_provider_mode: next.model_provider_mode,
        inbox_text_provider: next.inbox_text_provider,
        inbox_text_model: next.inbox_text_model,
        inbox_image_provider: next.inbox_image_provider,
        inbox_image_model: next.inbox_image_model
      }
    });
    return this.appSettings();
  }
};

export function normalizeTimeZone(value) {
  const text = String(value ?? '').trim();
  const zone = text === 'UTC+0' || text === 'UTC+00:00' || text === 'Etc/UTC' ? 'UTC' : text;
  if (!zone) throw settingError('invalid_timezone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    throw settingError('invalid_timezone');
  }
}

export function normalizeModelProviderMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'internal' || text === 'external') return text;
  throw settingError('invalid_model_provider_mode');
}

function normalizeFixed(value, allowed, fallback) {
  return String(value ?? '').trim().toLowerCase() === allowed ? allowed : fallback;
}

function cleanModel(value) {
  return typeof value === 'string' ? value.trim().slice(0, 100) : '';
}

function settingError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
