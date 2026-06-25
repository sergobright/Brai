import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedPreviewBranches } from '../../../deploy/scripts/accepted-preview-branches.mjs';

test('accepted preview branch lookup prints merged codex branches for the target base', () => {
  const pulls = [
    { base: { ref: 'dev' }, head: { ref: 'codex/one' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'dev' }, head: { ref: 'feature/no-preview' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'main' }, head: { ref: 'codex/prod' }, merged_at: '2026-06-25T10:00:00Z' },
    { base: { ref: 'dev' }, head: { ref: 'codex/open' }, merged_at: null },
    { base: { ref: 'dev' }, head: { ref: 'codex/one' }, merged_at: '2026-06-25T10:00:00Z' },
    { baseRefName: 'dev', headRefName: 'codex/two', state: 'MERGED' }
  ];

  assert.deepEqual(acceptedPreviewBranches(pulls, 'dev'), ['codex/one', 'codex/two']);
});

test('accepted preview branch lookup prints nothing when a dev commit has no accepted preview PR', () => {
  assert.deepEqual(acceptedPreviewBranches([
    { base: { ref: 'dev' }, head: { ref: 'codex/open' }, merged_at: null }
  ]), []);
});
