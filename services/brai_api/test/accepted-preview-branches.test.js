import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedPreviewBranches,
  acceptedPreviewReleaseNotes,
  requiredReleaseNotesFromPull
} from '../../../deploy/scripts/accepted-preview-branches.mjs';

test('accepted preview branch lookup prints merged codex branches for the target base', () => {
  const pulls = [
    { base: { ref: 'main' }, head: { ref: 'codex/one' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'main' }, head: { ref: 'feature/no-preview' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'dev' }, head: { ref: 'codex/dev' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'main' }, head: { ref: 'codex/open' }, merged_at: null },
    { base: { ref: 'main' }, head: { ref: 'codex/one' }, merged_at: '2026-06-25T10:00:00Z' },
    { baseRefName: 'main', headRefName: 'codex/two', state: 'MERGED' }
  ];

  assert.deepEqual(acceptedPreviewBranches(pulls), ['codex/one', 'codex/two']);
});

test('accepted preview branch lookup prints nothing when a main commit has no accepted preview PR', () => {
  assert.deepEqual(acceptedPreviewBranches([
    { base: { ref: 'main' }, head: { ref: 'codex/open' }, merged_at: null }
  ]), []);
});

test('accepted preview branch lookup skips current and legacy no-preview labels', () => {
  assert.deepEqual(acceptedPreviewBranches([
    { base: { ref: 'main' }, head: { ref: 'codex/current-docs' }, merged_at: '2026-06-25T10:00:00Z', labels: [{ name: 'brai-delivery:infra-docs' }] },
    { base: { ref: 'main' }, head: { ref: 'codex/current-tech' }, merged_at: '2026-06-25T10:00:00Z', labels: [{ name: 'brai-delivery:technical-no-preview' }] },
    { base: { ref: 'main' }, head: { ref: 'codex/legacy-docs' }, merged_at: '2026-06-25T10:00:00Z', labels: [{ name: 'bright-delivery:infra-docs' }] },
    { base: { ref: 'main' }, head: { ref: 'codex/legacy-tech' }, merged_at: '2026-06-25T10:00:00Z', labels: [{ name: 'bright-delivery:technical-no-preview' }] },
    { base: { ref: 'main' }, head: { ref: 'codex/preview' }, merged_at: '2026-06-25T10:00:00Z', labels: [] }
  ]), ['codex/preview']);
});

test('accepted preview branch lookup requires release notes for JSON promotion metadata', () => {
  const previousCutoff = process.env.BRAI_RELEASE_NOTES_V2_CUTOFF;
  process.env.BRAI_RELEASE_NOTES_V2_CUTOFF = '2026-07-15T00:00:00.000Z';
  const body = `Accepted preview.

<!-- brai-release-notes-v1
{"short_changes":"Исправлены версии.","detailed_changes":"Workflow передаёт release notes через PR.","reason":"Нужно не терять данные версий."}
-->`;
  const pulls = [
    { number: 1, base: { ref: 'main' }, head: { ref: 'codex/one' }, created_at: '2026-06-25T09:00:00Z', merged_at: '2026-06-25T10:00:00Z', nativeBoundary: false, body }
  ];

  assert.deepEqual(acceptedPreviewReleaseNotes(pulls), [
    {
      branch: 'codex/one',
      releaseNotes: {
        short_changes: 'Исправлены версии.',
        detailed_changes: 'Workflow передаёт release notes через PR.',
        reason: 'Нужно не терять данные версий.'
      }
    }
  ]);
  assert.throws(() => requiredReleaseNotesFromPull({ body: '' }, 'codex/missing'), /no allowed brai-release-notes receipt/);
  if (previousCutoff === undefined) delete process.env.BRAI_RELEASE_NOTES_V2_CUTOFF;
  else process.env.BRAI_RELEASE_NOTES_V2_CUTOFF = previousCutoff;
});
