import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BraiStore } from '../src/store.js';

function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-version-ledger-'));
  const dbPath = path.join(tmp, 'store.sqlite');
  const store = new BraiStore(dbPath);
  return { tmp, dbPath, store };
}

test('accepted preview version recording creates idempotent build row with authored notes', () => {
  const { tmp, store } = tempStore();
  try {
    const accepted = {
      sourceBranch: 'codex/example',
      sourceCommit: 'abc123',
      sourceShortChanges: 'Исправлены описания журнала версий.',
      sourceDetails: 'Строки сборок теперь хранят человекочитаемые release notes.',
      sourceReason: 'Нужно сохранить понятные описания принятой сборки.',
      targetBranch: 'main',
      targetCommit: 'def456',
      releasedAtUtc: '2026-06-24T22:10:00.000Z'
    };

    assert.deepEqual(store.recordAcceptedBuildVersion(accepted), { versionTypeId: 'build', version: 2 });
    assert.deepEqual(store.recordAcceptedBuildVersion(accepted), { versionTypeId: 'build', version: 2 });

    const versions = store.db
      .prepare("SELECT version_type_id, version, included_in_version_id, short_changes, detailed_changes, reason FROM build_versions ORDER BY version_type_id, version")
      .all();
    assert.deepEqual(
      versions.map((row) => [row.version_type_id, row.version, row.included_in_version_id, row.short_changes]),
      [
        ['apk', 1, null, 'Первичная публичная APK-сборка.'],
        ['build', 1, null, 'Первичная публичная web/OTA-сборка.'],
        ['build', 2, null, accepted.sourceShortChanges],
      ]
    );
    assert.equal(versions.find((row) => row.version_type_id === 'build' && row.version === 2).detailed_changes, accepted.sourceDetails);
    assert.equal(versions.find((row) => row.version_type_id === 'build' && row.version === 2).reason, accepted.sourceReason);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM build_version_refs').get().count, 1);
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release and canon version creation remain disabled', () => {
  const { tmp, store } = tempStore();
  try {
    assert.throws(
      () => store.recordReleaseVersion({}),
      /release version rows are disabled/
    );
    assert.throws(
      () => store.recordCanonVersion({}),
      /canon version rows are disabled/
    );
    assert.deepEqual(
      store.db.prepare('SELECT version_type_id, version FROM build_versions ORDER BY version_type_id, version').all(),
      [
        { version_type_id: 'apk', version: 1 },
        { version_type_id: 'build', version: 1 },
      ]
    );
  } finally {
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion records deployment and required build ledger row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-promote-apk-only-'));
  const sourceDb = path.join(tmp, 'source', 'source.sqlite');
  const targetDb = path.join(tmp, 'target', 'nested', 'target.sqlite');

  try {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    fs.mkdirSync(path.dirname(sourceDb), { recursive: true });
    const source = new BraiStore(sourceDb);
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/build-ledger',
      commit: 'abc-target-dir',
      domain: 'a.test.brightos.world',
      webOtaVersion: '0.0.41',
      shortChanges: 'Восстановлена запись версий сборок.',
      detailedChanges: 'Promotion переносит deployment metadata и обязательно пишет build ledger.',
      reason: 'Нужно завершать деплой только после записи версии сборки.',
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
      'codex/build-ledger',
      '--source-commit',
      'abc-target-dir',
      '--source-short-changes',
      'Восстановлена запись версий сборок.',
      '--source-details',
      'Promotion переносит deployment metadata и обязательно пишет build ledger.',
      '--source-reason',
      'Нужно завершать деплой только после записи версии сборки.',
      '--target-environment',
      'prod',
      '--target-branch',
      'main',
      '--target-commit',
      'merge-target-dir',
      '--target-domain',
      'app.brightos.world',
      '--reason',
      'Нужно завершать деплой только после записи версии сборки.'
    ], { cwd: repoRoot });

    const promoted = new BraiStore(targetDb);
    try {
      assert.deepEqual(
        promoted.db.prepare('SELECT version_type_id, version FROM build_versions ORDER BY version_type_id, version').all(),
        [
          { version_type_id: 'apk', version: 1 },
          { version_type_id: 'build', version: 1 },
          { version_type_id: 'build', version: 2 },
        ]
      );
      const build = promoted.db.prepare("SELECT * FROM build_versions WHERE version_type_id = 'build' AND version = 2").get();
      assert.equal(build.short_changes, 'Восстановлена запись версий сборок.');
      assert.equal(build.detailed_changes, 'Promotion переносит deployment metadata и обязательно пишет build ledger.');
      assert.equal(build.reason, 'Нужно завершать деплой только после записи версии сборки.');
      const records = promoted.listDeploymentRecords({ environment: 'prod' });
      assert.equal(records.length, 1);
      assert.equal(records[0].branch, 'main');
      assert.equal(records[0].commit_sha, 'merge-target-dir');
      assert.equal(records[0].web_ota_version, '0.0.2');
      assert.match(records[0].detailed_changes, /codex\/build-ledger@abc-target-dir/);
    } finally {
      promoted.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion uses release-note reason when source reason is generic', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-promote-reason-fallback-'));
  const sourceDb = path.join(tmp, 'source.sqlite');
  const targetDb = path.join(tmp, 'target.sqlite');

  try {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const source = new BraiStore(sourceDb);
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/reason-fallback',
      commit: 'abc-reason',
      domain: 'a.test.brightos.world',
      webOtaVersion: '0.0.42',
      shortChanges: 'Исправлена причина версии.',
      detailedChanges: 'Promotion не должен брать generic reason из deployment metadata.',
      reason: 'Автоматическая доставка ветки',
      deployedAtUtc: '2026-07-03T07:10:00.000Z'
    });
    source.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-db',
      sourceDb,
      '--target-db',
      targetDb,
      '--source-branch',
      'codex/reason-fallback',
      '--source-commit',
      'abc-reason',
      '--source-short-changes',
      'Исправлена причина версии.',
      '--source-details',
      'Promotion не должен брать generic reason из deployment metadata.',
      '--source-reason',
      'Нужно сохранить authored reason из release notes.',
      '--target-environment',
      'prod',
      '--target-branch',
      'main',
      '--target-commit',
      'merge-reason',
      '--target-domain',
      'app.brightos.world',
    ], { cwd: repoRoot });

    const promoted = new BraiStore(targetDb);
    try {
      const build = promoted.db.prepare("SELECT reason FROM build_versions WHERE version_type_id = 'build' AND version = 2").get();
      assert.equal(build.reason, 'Нужно сохранить authored reason из release notes.');
    } finally {
      promoted.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted promotion rejects missing authored source notes before deployment record', () => {
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
      'codex/missing-notes',
      '--source-commit',
      'abc-missing-notes',
      '--target-environment',
      'prod',
      '--target-branch',
      'main',
      '--target-commit',
      'merge-missing-notes',
      '--target-domain',
      'app.brightos.world',
      '--source-short-changes',
      'Branch deployment',
      '--source-details',
      'Automated deployment from codex/missing-notes@abc-missing-notes to prod.',
      '--source-reason',
      'Accepted codex/missing-notes.'
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing Russian source short_changes/);
    const store = new BraiStore(targetDb);
    try {
      assert.equal(store.listDeploymentRecords({ environment: 'prod' }).length, 0);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted promotion rerun skips missing slot after build ledger was recorded', () => {
  const { tmp, dbPath, store } = tempStore();
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const registry = path.join(tmp, 'preview-slots.json');
  try {
    fs.writeFileSync(registry, JSON.stringify({
      A: { status: 'free', branch: null },
      B: { status: 'free', branch: null },
      C: { status: 'free', branch: null },
      D: { status: 'free', branch: null },
      E: { status: 'free', branch: null },
      queue: [],
    }));
    store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/rerun',
      sourceCommit: 'abc-rerun',
      sourceShortChanges: 'Повторный запуск принят.',
      sourceDetails: 'Повторный promotion видит уже записанную build-версию.',
      sourceReason: 'Нужно не падать после уже освобождённого preview slot.',
      targetBranch: 'main',
      targetCommit: 'merge-rerun',
      releasedAtUtc: '2026-07-03T10:40:00.000Z'
    });
    store.close();

    const output = execFileSync('bash', [path.join(repoRoot, 'deploy/scripts/promote-accepted-deployment.sh')], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_BIN: process.execPath,
        BRAI_ROOT: repoRoot,
        BRAI_DB: dbPath,
        BRAI_ENVS_ROOT: tmp,
        BRAI_PREVIEW_REGISTRY: registry,
        BRAI_SOURCE_BRANCH: 'codex/rerun',
        BRAI_TARGET_ENVIRONMENT: 'prod',
        BRAI_TARGET_BRANCH: 'main',
        BRAI_TARGET_COMMIT: 'merge-rerun',
        BRAI_SOURCE_SHORT_CHANGES: 'Повторный запуск принят.',
        BRAI_SOURCE_DETAILED_CHANGES: 'Повторный promotion видит уже записанную build-версию.',
        BRAI_SOURCE_REASON: 'Нужно не падать после уже освобождённого preview slot.',
      },
    });

    assert.match(output, /already promoted for main@merge-rerun/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reset script resets APK row without deleting build history', () => {
  const { tmp, dbPath, store } = tempStore();
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  try {
    const now = '2026-07-02T12:00:00.000Z';
    const insertType = store.db.prepare(`
      INSERT INTO version_types (id, title, description, created_at_utc)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    for (const id of ['release', 'canon']) {
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
      versionTypeId: 'build',
      version: 2,
      includedInVersionId: null,
      shortChanges: 'Accepted build.',
      detailedChanges: 'Accepted build.',
      reason: 'Accepted build.',
      releasedAtUtc: now,
      targetBranch: 'main',
      targetCommit: 'accepted-build',
    });
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
        ['apk', 'build']
      );
      assert.deepEqual(
        reset.db.prepare('SELECT version_type_id, version, short_changes FROM build_versions ORDER BY version_type_id, version').all(),
        [
          { version_type_id: 'apk', version: 1, short_changes: 'Первичная публичная APK-сборка.' },
          { version_type_id: 'build', version: 1, short_changes: 'Первичная публичная web/OTA-сборка.' },
          { version_type_id: 'build', version: 2, short_changes: 'Accepted build.' },
        ]
      );
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id = 'apk'").get().count, 0);
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id = 'build'").get().count, 1);
    } finally {
      reset.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
