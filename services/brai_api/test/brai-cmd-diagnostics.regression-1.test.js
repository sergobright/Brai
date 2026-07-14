import assert from 'node:assert/strict';
import test from 'node:test';
import { createBraiCmdRuntime } from '../src/brai-cmd.js';

// Regression: ISSUE-005 — диагностика проверяла список моделей, а не рабочий audio endpoint.
// Found by /qa on 2026-07-12
// Report: .gstack/qa-reports/qa-report-c-test-brai-one-2026-07-12.md
test('cloud transcription diagnostics sends a real minimal WAV request', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ text: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const runtime = createBraiCmdRuntime({
    config: {
      groqApiKey: 'fixture-groq-key',
      transcriptionModel: 'whisper-large-v3-turbo',
      transcriptionTimeoutMs: 5_000,
    },
  });

  const result = await runtime.deps.probeTranscription();

  assert.deepEqual(result, { provider: 'groq', model: 'whisper-large-v3-turbo' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-groq-key');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('model'), 'whisper-large-v3-turbo');
  const audio = calls[0].init.body.get('file');
  assert.ok(audio instanceof Blob);
  assert.equal(audio.type, 'audio/wav');
  assert.equal(audio.size, 3_244);
});

test('cloud transcription diagnostics exercises the same Groq to OpenAI fallback', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'Groq unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ text: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const runtime = createBraiCmdRuntime({
    config: {
      groqApiKey: 'fixture-groq-key',
      openaiApiKey: 'fixture-openai-key',
      transcriptionModel: 'whisper-large-v3',
      openaiTranscriptionModel: 'gpt-4o-mini-transcribe',
      transcriptionTimeoutMs: 5_000,
    },
  });

  const result = await runtime.deps.probeTranscription();

  assert.deepEqual(result, { provider: 'openai', model: 'gpt-4o-mini-transcribe' });
  assert.deepEqual(calls, [
    'https://api.groq.com/openai/v1/audio/transcriptions',
    'https://api.openai.com/v1/audio/transcriptions',
  ]);
});
