import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  decryptUserProviderKey,
  encryptUserProviderKey,
  parseUserAiEncryptionKey
} from '../src/store-user-ai.js';
import { resolveUserAiExecution } from '../src/user-ai-runtime.js';
import { withUserScope } from '../src/user-scope.js';

const encryptionKey = crypto.randomBytes(32).toString('base64url');

test('user provider keys round-trip only for the matching account and provider', () => {
  const encrypted = encryptUserProviderKey('sk-user-secret-1234', {
    encryptionKey,
    userId: 'user-1',
    providerId: 'openai'
  });

  assert.match(encrypted, /^v1\./);
  assert.equal(encrypted.includes('sk-user-secret-1234'), false);
  assert.equal(decryptUserProviderKey(encrypted, {
    encryptionKey,
    userId: 'user-1',
    providerId: 'openai'
  }), 'sk-user-secret-1234');
  assert.throws(() => decryptUserProviderKey(encrypted, {
    encryptionKey,
    userId: 'user-2',
    providerId: 'openai'
  }), /credential_decryption_failed/);
  assert.throws(() => decryptUserProviderKey(encrypted, {
    encryptionKey,
    userId: 'user-1',
    providerId: 'groq'
  }), /credential_decryption_failed/);
});

test('user provider key envelope rejects tampering and malformed master keys', () => {
  const encrypted = encryptUserProviderKey('gsk_user_secret_5678', {
    encryptionKey,
    userId: 'user-1',
    providerId: 'groq'
  });
  const parts = encrypted.split('.');
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`;

  assert.throws(() => decryptUserProviderKey(parts.join('.'), {
    encryptionKey,
    userId: 'user-1',
    providerId: 'groq'
  }), /credential_decryption_failed/);
  const shortTag = encrypted.split('.');
  shortTag[3] = shortTag[3].slice(0, 8);
  assert.throws(() => decryptUserProviderKey(shortTag.join('.'), {
    encryptionKey,
    userId: 'user-1',
    providerId: 'groq'
  }), /credential_decryption_failed/);
  const shortIv = encrypted.split('.');
  shortIv[1] = shortIv[1].slice(0, -2);
  assert.throws(() => decryptUserProviderKey(shortIv.join('.'), {
    encryptionKey,
    userId: 'user-1',
    providerId: 'groq'
  }), /credential_decryption_failed/);
  assert.throws(() => parseUserAiEncryptionKey('short'), /invalid_user_ai_encryption_key/);
  assert.equal(parseUserAiEncryptionKey(encryptionKey).length, 32);
});

test('unclaimed work uses internal Codex without reading account settings', () => {
  let settingsReads = 0;
  const result = resolveUserAiExecution({
    userAiSettings() {
      settingsReads += 1;
      throw new Error('account_required');
    }
  }, 'vision');

  assert.equal(settingsReads, 0);
  assert.deepEqual({ mode: result.mode, provider: result.provider, model: result.model, apiKey: result.apiKey }, {
    mode: 'internal',
    provider: 'codex-cli',
    model: null,
    apiKey: null
  });
});

test('account-scoped settings errors never fall back to internal Codex', () => {
  assert.throws(() => withUserScope('user-1', () => resolveUserAiExecution({
    userAiSettings() {
      throw new Error('settings_unavailable');
    }
  }, 'text')), /settings_unavailable/);
});
