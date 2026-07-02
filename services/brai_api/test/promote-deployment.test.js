import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BraiStore } from '../src/store.js';

function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-version-ledger-'));
  const dbPath = path.join(tmp, 'store.sqlite');
  const store = new BraiStore(dbPath);
  return { tmp, dbPath, store };
}

test('accepted preview version recording is APK-only no-op', () => {
  const { tmp, store } = tempStore();
  try {
    const accepted = {
      sourceBranch: 'codex/example',
      sourceCommit: 'abc123',
      sourceShortChanges: 'Исправлены описания журнала версий.',
      sourceDetails: 'Строки сборок теперь хранят человекочитаемые release notes.',
      targetBranch: 'main',
      targetCommit: 'def456',
      releasedAtUtc: '2026-06-24T22:10:00.000Z'
    };

    assert.equal(store.recordAcceptedBuildVersion(accepted), null);
    assert.equal(store.recordAcceptedBuildVersion(accepted), null);

    const versions = store.db
      .prepare("SELECT version_type_id, version, included_in_version_id, short_changes FROM build_versions ORDER BY version_type_id, version")
      .all();
    assert.deepEqual(
      versions.map((row) => [row.version_type_id, row.version, row.included_in_version_id, row.short_changes]),
      [['apk', 1, null, 'Первичная публичная APK-сборка.']]
    );
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM build_version_refs').get().count, 0);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release and canon version creation are disabled', () => {
  const { tmp, store } = tempStore();
  try {
    assert.throws(
      () => store.recordReleaseVersion({}),
      /release version rows are disabled by APK-only versioning/
    );
    assert.throws(
      () => store.recordCanonVersion({}),
      /canon version rows are disabled by APK-only versioning/
    );
    assert.deepEqual(
      store.db.prepare('SELECT version_type_id, version FROM build_versions ORDER BY version_type_id, version').all(),
      [{ version_type_id: 'apk', version: 1 }]
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion records deployment but no build, release, or canon rows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-apk-only-'));
  const sourceDb = path.join(tmp, 'source', 'source.sqlite');
  const targetDb = path.join(tmp, 'target', 'nested', 'target.sqlite');

  try {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    fs.mkdirSync(path.dirname(sourceDb), { recursive: true });
    const source = new BraiStore(sourceDb);
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/apk-only',
      commit: 'abc-target-dir',
      domain: 'a.test.brightos.world',
      webOtaVersion: '0.0.41',
      shortChanges: 'Принята APK-only доставка.',
      detailedChanges: 'Promotion переносит deployment metadata без build/release/canon ledger.',
      reason: 'Нужно не писать build/release/canon строки при accepted deploy.',
      deployedAtUtc: '2026-07-02T12:00:00.000Z'
    });
    source.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-db',
      sourceDb,
      '--target-db',
      targetDb,
      '--source-branch',
      'codex/apk-only',
      '--source-commit',
      'abc-target-dir',
      '--source-short-changes',
      'Принята APK-only доставка.',
      '--source-details',
      'Promotion переносит deployment metadata без build/release/canon ledger.',
      '--target-environment',
      'prod',
      '--target-branch',
      'main',
      '--target-commit',
      'merge-target-dir',
      '--target-domain',
      'app.brightos.world',
      '--reason',
      'Нужно не писать build/release/canon строки при accepted deploy.'
    ], { cwd: repoRoot });

    const promoted = new BraiStore(targetDb);
    try {
      assert.deepEqual(
        promoted.db.prepare('SELECT version_type_id, version FROM build_versions ORDER BY version_type_id, version').all(),
        [{ version_type_id: 'apk', version: 1 }]
      );
      const records = promoted.listDeploymentRecords({ environment: 'prod' });
      assert.equal(records.length, 1);
      assert.equal(records[0].branch, 'main');
      assert.equal(records[0].commit_sha, 'merge-target-dir');
      assert.match(records[0].detailed_changes, /codex\/apk-only@abc-target-dir/);
    } finally {
      promoted.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted promotion rejects legacy production release recording flag', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-release-disabled-'));
  const targetDb = path.join(tmp, 'target.sqlite');
  const repoRoot = path.resolve(import.meta.dirname, '../../..');

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-db',
      path.join(tmp, 'missing.sqlite'),
      '--target-db',
      targetDb,
      '--source-branch',
      'codex/release-disabled',
      '--source-commit',
      'abc-release-disabled',
      '--target-environment',
      'prod',
      '--target-branch',
      'main',
      '--target-commit',
      'merge-release-disabled',
      '--target-domain',
      'app.brightos.world',
      '--record-production-release',
      'true'
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release\/canon version rows are disabled by APK-only versioning/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reset script clears legacy version rows back to apk baseline', () => {
  const { tmp, dbPath, store } = tempStore();
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  try {
    const now = '2026-07-02T12:00:00.000Z';
    const insertType = store.db.prepare(`
      INSERT INTO version_types (id, title, description, created_at_utc)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const id of ['build', 'release', 'canon']) {
      insertType.run(id, id, `legacy ${id}`, now);
      store.upsertBuildVersion({
        versionTypeId: id,
        version: 1,
        includedInVersionId: null,
        shortChanges: `Legacy ${id}.`,
        detailedChanges: `Legacy ${id}.`,
        reason: `Legacy ${id}.`,
        releasedAtUtc: now,
        targetBranch: 'main',
        targetCommit: `legacy-${id}`,
      });
    }
    store.upsertBuildVersion({
      versionTypeId: 'apk',
      version: 2,
      includedInVersionId: null,
      shortChanges: 'Legacy APK 2.',
      detailedChanges: 'Legacy APK 2.',
      reason: 'Legacy APK 2.',
      releasedAtUtc: now,
      targetBranch: 'main',
      targetCommit: 'legacy-apk-2',
    });
    store.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/reset-apk-only-version-ledger.mjs'),
      '--db',
      dbPath
    ], { cwd: repoRoot });

    const reset = new BraiStore(dbPath);
    try {
      assert.deepEqual(
        reset.db.prepare('SELECT id FROM version_types ORDER BY id').all().map((row) => row.id),
        ['apk']
      );
      assert.deepEqual(
        reset.db.prepare('SELECT version_type_id, version, short_changes FROM build_versions ORDER BY version_type_id, version').all(),
        [{ version_type_id: 'apk', version: 1, short_changes: 'Первичная публичная APK-сборка.' }]
      );
      assert.equal(reset.db.prepare('SELECT COUNT(*) AS count FROM build_version_refs').get().count, 0);
    } finally {
      reset.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
