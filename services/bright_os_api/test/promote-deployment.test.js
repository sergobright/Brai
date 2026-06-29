import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrightOsStore } from '../src/store.js';

function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-version-ledger-'));
  const store = new BrightOsStore(path.join(tmp, 'store.sqlite'));
  return { tmp, store };
}

test('accepted preview promotion records one build counter idempotently', () => {
  const { tmp, store } = tempStore();
  try {
    const accepted = {
      sourceBranch: 'codex/example',
      sourceCommit: 'abc123',
      sourceShortChanges: 'Fix version ledger descriptions.',
      sourceDetails: 'Accepted build rows now store human-readable release notes.',
      targetBranch: 'main',
      targetCommit: 'def456',
      releasedAtUtc: '2026-06-24T22:10:00.000Z'
    };
    store.recordAcceptedBuildVersion(accepted);
    store.recordAcceptedBuildVersion(accepted);

    const versions = store.db
      .prepare("SELECT version_type_id, version, included_in_version_id, short_changes FROM build_versions ORDER BY version_type_id, version")
      .all();
    assert.deepEqual(
      versions.map((row) => [row.version_type_id, row.version, row.included_in_version_id, row.short_changes]),
      [
        ['apk', 1, null, 'Initial public APK baseline.'],
        ['build', 1, null, 'Initial public web/OTA baseline.'],
        ['build', 2, null, 'Fix version ledger descriptions.']
      ]
    );
    const ref = store.db
      .prepare("SELECT version_type_id, version, source_branch, source_commit, target_branch, target_commit FROM build_version_refs WHERE version_type_id = 'build' AND version = 2")
      .get();
    assert.deepEqual(ref, {
      version_type_id: 'build',
      version: 2,
      source_branch: 'codex/example',
      source_commit: 'abc123',
      target_branch: 'main',
      target_commit: 'def456'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manual release links unlinked builds and current apk', () => {
  const { tmp, store } = tempStore();
  try {
    store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/one',
      sourceCommit: 'one',
      sourceShortChanges: 'First build.',
      sourceDetails: 'First build details.',
      targetBranch: 'main',
      targetCommit: 'main-one',
      releasedAtUtc: '2026-06-24T22:10:00.000Z'
    });
    store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/two',
      sourceCommit: 'two',
      sourceShortChanges: 'Second build.',
      sourceDetails: 'Second build details.',
      targetBranch: 'main',
      targetCommit: 'main-two',
      releasedAtUtc: '2026-06-24T22:20:00.000Z'
    });

    const release = store.recordReleaseVersion({
      sourceBranch: 'manual',
      sourceCommit: 'release-one',
      sourceShortChanges: 'Release collected builds.',
      sourceDetails: 'Manual release.',
      targetBranch: 'main',
      targetCommit: 'release-one',
      releasedAtUtc: '2026-06-24T23:00:00.000Z'
    });

    assert.deepEqual(release, { versionTypeId: 'release', version: 1 });
    const rows = store.db
      .prepare("SELECT id, version_type_id, version, included_in_version_id FROM build_versions ORDER BY version_type_id, version")
      .all();
    const releaseRow = rows.find((row) => row.version_type_id === 'release');
    assert.ok(releaseRow);
    assert.deepEqual(
      rows.filter((row) => row.version_type_id !== 'release').map((row) => [row.version_type_id, row.version, row.included_in_version_id]),
      [
        ['apk', 1, releaseRow.id],
        ['build', 1, releaseRow.id],
        ['build', 2, releaseRow.id],
        ['build', 3, releaseRow.id]
      ]
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('manual canon links unlinked releases', () => {
  const { tmp, store } = tempStore();
  try {
    store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/one',
      sourceCommit: 'one',
      sourceShortChanges: 'First build.',
      sourceDetails: 'First build details.',
      targetBranch: 'main',
      targetCommit: 'main-one',
      releasedAtUtc: '2026-06-24T22:10:00.000Z'
    });
    store.recordReleaseVersion({
      sourceBranch: 'manual',
      sourceCommit: 'release-one',
      sourceShortChanges: 'Release one.',
      sourceDetails: 'Manual release one.',
      targetBranch: 'main',
      targetCommit: 'release-one',
      releasedAtUtc: '2026-06-24T23:00:00.000Z'
    });
    const canon = store.recordCanonVersion({
      sourceBranch: 'manual',
      sourceCommit: 'canon-one',
      sourceShortChanges: 'Canon one.',
      sourceDetails: 'Manual canon one.',
      targetBranch: 'main',
      targetCommit: 'canon-one',
      releasedAtUtc: '2026-06-25T00:00:00.000Z'
    });

    assert.deepEqual(canon, { versionTypeId: 'canon', version: 1 });
    const release = store.db
      .prepare("SELECT included_in_version_id FROM build_versions WHERE version_type_id = 'release' AND version = 1")
      .get();
    const canonRow = store.db
      .prepare("SELECT id FROM build_versions WHERE version_type_id = 'canon' AND version = 1")
      .get();
    assert.equal(release.included_in_version_id, canonRow.id);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted build recording does not create release automatically', () => {
  const { tmp, store } = tempStore();
  try {
    store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/direct-prod',
      sourceCommit: 'source-direct',
      sourceShortChanges: 'Ship direct production acceptance.',
      sourceDetails: 'Accepted preview metadata is promoted straight into production ledger.',
      sourceReason: 'Prototype delivery skips dev.',
      targetBranch: 'main',
      targetCommit: 'mainsha-direct',
      releasedAtUtc: '2026-06-27T00:00:00.000Z'
    });
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id = 'release'").get().count,
      0
    );
    const accepted = store.db
      .prepare("SELECT version_type_id, version, short_changes FROM build_versions WHERE version_type_id = 'build' ORDER BY version DESC LIMIT 1")
      .get();
    assert.deepEqual(accepted, {
      version_type_id: 'build',
      version: 2,
      short_changes: 'Ship direct production acceptance.'
    });
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
