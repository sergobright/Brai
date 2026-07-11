import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BraiStore } from '../src/store.js';
import { createTestDatabase } from '../test-support/api.js';

async function tempStore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-version-ledger-'));
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  return { tmp, dbUrl: database.url, store, drop: () => database.drop() };
}

test('accepted preview version recording creates idempotent build row with authored notes', async () => {
  const { tmp, store, drop } = await tempStore();
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
        ['apk', 2, null, 'Актуальная публичная APK-сборка v2.'],
        ['build', 1, null, 'Первичная публичная web/OTA-сборка.'],
        ['build', 2, null, accepted.sourceShortChanges],
      ]
    );
    assert.equal(versions.find((row) => row.version_type_id === 'build' && row.version === 2).detailed_changes, accepted.sourceDetails);
    assert.equal(versions.find((row) => row.version_type_id === 'build' && row.version === 2).reason, accepted.sourceReason);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM build_version_refs').get().count, 1);
    const log = store.db.prepare("SELECT status, json_data FROM logs WHERE operation = 'version.build_recorded'").get();
    assert.equal(log.status, 'done');
    assert.deepEqual(JSON.parse(log.json_data), {
      version: 2,
      target_branch: 'main',
      target_commit: 'def456',
      source_branch: 'codex/example',
      source_commit: 'abc123'
    });
  } finally {
    store.close();
    await drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('release and canon version creation remain disabled', async () => {
  const { tmp, store, drop } = await tempStore();
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
        { version_type_id: 'apk', version: 2 },
        { version_type_id: 'build', version: 1 },
      ]
    );
  } finally {
    store.close();
    await drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted preview promotion records deployment and required build ledger row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-promote-apk-only-'));
  let sourceDatabase;
  let targetDatabase;

  return (async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    sourceDatabase = await createTestDatabase();
    targetDatabase = await createTestDatabase();
    const source = new BraiStore(sourceDatabase.url);
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/build-ledger',
      commit: 'abc-target-dir',
      domain: 'a.test.brai.one',
      webOtaVersion: '0.0.41',
      shortChanges: 'Восстановлена запись версий сборок.',
      detailedChanges: 'Promotion переносит deployment metadata и обязательно пишет build ledger.',
      reason: 'Нужно завершать деплой только после записи версии сборки.',
      deployedAtUtc: '2026-07-02T12:00:00.000Z'
    });
    source.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-postgres-url',
      sourceDatabase.url,
      '--target-postgres-url',
      targetDatabase.url,
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
      'app.brai.one',
      '--reason',
      'Нужно завершать деплой только после записи версии сборки.'
    ], { cwd: repoRoot });

    const promoted = new BraiStore(targetDatabase.url);
    try {
      assert.deepEqual(
        promoted.db.prepare('SELECT version_type_id, version FROM build_versions ORDER BY version_type_id, version').all(),
        [
          { version_type_id: 'apk', version: 1 },
          { version_type_id: 'apk', version: 2 },
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
      const logs = promoted.db
        .prepare("SELECT operation, status, json_data FROM logs WHERE operation IN ('deployment.recorded', 'version.build_recorded') ORDER BY operation")
        .all()
        .map((row) => ({ ...row, json_data: JSON.parse(row.json_data) }));
      assert.equal(logs.some((log) => log.operation === 'deployment.recorded' && log.json_data.deployment_record_id === records[0].id), true);
      assert.equal(logs.some((log) => log.operation === 'version.build_recorded' && log.json_data.version === 2), true);
    } finally {
      promoted.close();
    }
  })().finally(async () => {
    await sourceDatabase?.drop();
    await targetDatabase?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('accepted preview promotion uses release-note reason when source reason is generic', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-promote-reason-fallback-'));
  let sourceDatabase;
  let targetDatabase;

  return (async () => {
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    sourceDatabase = await createTestDatabase();
    targetDatabase = await createTestDatabase();
    const source = new BraiStore(sourceDatabase.url);
    source.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/reason-fallback',
      commit: 'abc-reason',
      domain: 'a.test.brai.one',
      webOtaVersion: '0.0.42',
      shortChanges: 'Исправлена причина версии.',
      detailedChanges: 'Promotion не должен брать generic reason из deployment metadata.',
      reason: 'Автоматическая доставка ветки',
      deployedAtUtc: '2026-07-03T07:10:00.000Z'
    });
    source.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-postgres-url',
      sourceDatabase.url,
      '--target-postgres-url',
      targetDatabase.url,
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
      'app.brai.one',
    ], { cwd: repoRoot });

    const promoted = new BraiStore(targetDatabase.url);
    try {
      const build = promoted.db.prepare("SELECT reason FROM build_versions WHERE version_type_id = 'build' AND version = 2").get();
      assert.equal(build.reason, 'Нужно сохранить authored reason из release notes.');
    } finally {
      promoted.close();
    }
  })().finally(async () => {
    await sourceDatabase?.drop();
    await targetDatabase?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('accepted promotion rejects missing authored source notes before deployment record', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-promote-release-disabled-'));
  const sourceDatabase = await createTestDatabase();
  const targetDatabase = await createTestDatabase();
  const repoRoot = path.resolve(import.meta.dirname, '../../..');

  try {
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/promote-deployment.mjs'),
      '--source-postgres-url',
      sourceDatabase.url,
      '--target-postgres-url',
      targetDatabase.url,
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
      'app.brai.one',
      '--source-short-changes',
      'Branch deployment',
      '--source-details',
      'Automated deployment from codex/missing-notes@abc-missing-notes to prod.',
      '--source-reason',
      'Accepted codex/missing-notes.'
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing Russian source short_changes/);
    const store = new BraiStore(targetDatabase.url);
    try {
      assert.equal(store.listDeploymentRecords({ environment: 'prod' }).length, 0);
    } finally {
      store.close();
    }
  } finally {
    await sourceDatabase.drop();
    await targetDatabase.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted promotion rerun skips missing slot after build ledger was recorded', async () => {
  const { tmp, dbUrl, store, drop } = await tempStore();
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
        BRAI_DATABASE_URL: dbUrl,
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
    await drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reset script resets APK row without deleting build history', async () => {
  const { tmp, dbUrl, store, drop } = await tempStore();
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
      version: 3,
      includedInVersionId: null,
      shortChanges: 'Legacy APK 3.',
      detailedChanges: 'Legacy APK 3.',
      reason: 'Legacy APK 3.',
      releasedAtUtc: now,
      targetBranch: 'main',
      targetCommit: 'legacy-apk-3',
    });
    store.close();

    execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/reset-apk-only-version-ledger.mjs'),
      '--postgres-url',
      dbUrl
    ], { cwd: repoRoot });

    const reset = new BraiStore(dbUrl);
    try {
      assert.deepEqual(
        reset.db.prepare('SELECT id FROM version_types ORDER BY id').all().map((row) => row.id),
        ['apk', 'build', 'canon', 'release']
      );
      assert.deepEqual(
        reset.db.prepare('SELECT version_type_id, version, short_changes FROM build_versions ORDER BY version_type_id, version').all(),
        [
          { version_type_id: 'apk', version: 1, short_changes: 'Первичная публичная APK-сборка.' },
          { version_type_id: 'apk', version: 2, short_changes: 'Актуальная публичная APK-сборка v2.' },
          { version_type_id: 'build', version: 1, short_changes: 'Первичная публичная web/OTA-сборка.' },
          { version_type_id: 'build', version: 2, short_changes: 'Accepted build.' },
          { version_type_id: 'canon', version: 1, short_changes: 'Legacy canon.' },
          { version_type_id: 'release', version: 1, short_changes: 'Legacy release.' },
        ]
      );
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id = 'apk'").get().count, 0);
      assert.equal(reset.db.prepare("SELECT last_version FROM build_version_counters WHERE version_type_id = 'apk'").get().last_version, 2);
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id = 'build'").get().count, 1);
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id IN ('canon', 'release')").get().count, 2);
    } finally {
      reset.close();
    }
  } finally {
    await drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
