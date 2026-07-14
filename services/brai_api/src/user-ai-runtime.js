import { scopedUserId } from './user-scope.js';

export function resolveUserAiExecution(store, capability, fetchImpl = fetch) {
  if (!scopedUserId()) {
    return { mode: 'internal', provider: 'codex-cli', model: null, apiKey: null, fetchImpl };
  }
  const settings = store.userAiSettings?.() ?? { model_provider_mode: 'internal' };
  if (settings.model_provider_mode !== 'external') {
    return { mode: 'internal', provider: 'codex-cli', model: null, apiKey: null, fetchImpl };
  }
  const profile = settings[capability];
  const execution = {
    mode: 'external',
    provider: profile?.provider_id ?? null,
    model: profile?.model ?? null,
    apiKey: null,
    fetchImpl
  };
  if (!profile?.provider_id || !profile?.model) {
    throw executionError(`${capability}_profile_not_configured`, execution);
  }
  let credential;
  try {
    credential = store.getUserProviderCredential?.(profile.provider_id);
  } catch (error) {
    throw executionError(error, execution);
  }
  if (!credential?.api_key) throw executionError('provider_not_configured', execution);
  return {
    ...execution,
    apiKey: credential.api_key,
  };
}

function executionError(value, execution) {
  const error = value instanceof Error ? value : new Error(String(value));
  error.userAiExecution = execution;
  return error;
}
