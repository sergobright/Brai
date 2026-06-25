import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrightOsStore } from '../src/store.js';

test('accepted preview promotion records a PR-matched build version once', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-ledger-'));
  const targetDb = path.join(tmp, 'target.sqlite');
  const store = new BrightOsStore(targetDb);

  try {
    const accepted = {
      prNumber: '11',
      sourceBranch: 'codex/example',
      sourceCommit: 'abc123',
      sourceDetails: 'Automated preview deploy.',
      targetBranch: 'dev',
      targetCommit: 'def456',
      deployedAtUtc: '2026-06-24T22:00:00.000Z'
    };
    store.recordAcceptedBuildVersion({ ...accepted, releasedAtUtc: '2026-06-24T22:10:00.000Z' });
    store.recordAcceptedBuildVersion({ ...accepted, releasedAtUtc: '2026-06-24T22:10:00.000Z' });

    const version = store.db
      .prepare("SELECT * FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.11.1'")
      .get();
    assert.ok(version);
    assert.equal(version.build_version, 11);
    assert.equal(version.reason, 'Accepted PR #11 into dev.');
    assert.equal(version.released_at_utc, '2026-06-24T22:10:00.000Z');
    assert.match(version.detailed_changes, /codex\/example@abc123 promoted to dev@def456/);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id = 'build'").get().count,
      11
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
