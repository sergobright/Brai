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
  const body = `Accepted preview.

<!-- brai-release-notes-v1
{"short_changes":"Исправлены версии.","detailed_changes":"Workflow передаёт release notes через PR.","reason":"Нужно не терять данные версий."}
-->`;
  const pulls = [
    { base: { ref: 'main' }, head: { ref: 'codex/one' }, merged_at: '2026-06-25T10:00:00Z', body }
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
  assert.throws(() => requiredReleaseNotesFromPull({ body: '' }, 'codex/missing'), /no brai-release-notes-v1/);
});
