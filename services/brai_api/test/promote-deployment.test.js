import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

function apkPull(pullNumber, workKey, workRole, state, native) {
  const merged = state === 'MERGED';
  const marker = { receiptType: 'brai-work-v1', workKey, workRole, nativeBoundary: native };
  const notes = {
    receiptType: 'brai-release-notes-v2',
    work: { key: workKey, role: workRole },
    build: {
      ...(workRole === 'owner' ? {
        short_changes: 'Завершена Android-работа.',
        detailed_changes: 'Owner завершает общий work.',
        reason: 'Нужно завершить work после owner merge.',
      } : {}),
      details: [{ title: `Изменение PR ${pullNumber}`, description: `Изменение PR ${pullNumber} сохранено отдельно.` }],
    },
    testing: 'Проверена Android-доставка.',
    ...(native ? { platforms: { apk: {
      short_changes: 'Обновлён стабильный APK.',
      detailed_changes: 'В APK вошли только нативные изменения support PR.',
      reason: 'Нативная граница требует публикации нового APK.',
      details: [{ title: 'Нативный APK', description: 'Опубликованный пакет содержит Android-изменения.' }],
    } } } : {}),
  };
  return {
    workKey, workRole, repository: 'sergobright/Brai', pullNumber,
    url: `https://github.com/sergobright/Brai/pull/${pullNumber}`,
    title: `PR ${pullNumber}`,
    body: `<!-- brai-work-v1\n${JSON.stringify(marker)}\n-->\n<!-- brai-release-notes-v2\n${JSON.stringify(notes)}\n-->`,
    authorLogin: 'sergobright', state, isDraft: false,
    headBranch: `codex/apk-${pullNumber}`, baseBranch: 'main',
    mergeCommitSha: merged ? `merge-${pullNumber}` : null,
    githubCreatedAtUtc: '2026-07-14T13:00:00.000Z',
    githubUpdatedAtUtc: '2026-07-14T14:00:00.000Z',
    githubClosedAtUtc: merged ? '2026-07-14T14:00:00.000Z' : null,
    githubMergedAtUtc: merged ? '2026-07-14T14:00:00.000Z' : null,
  };
}

test('unscoped accepted-build recording is unavailable', async () => {
  const { tmp, store, drop } = await tempStore();
  try {
    assert.equal(store.recordAcceptedBuildVersion, undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id = 'build'").get().count, 1);
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

test('accepted preview promotion finalizes one work-scoped build', () => {
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

    const workJson = JSON.stringify({
      work: { key: 'work_11111111-1111-4111-a111-111111111111', role: 'owner' },
      pulls: [{
        repository: 'sergobright/Brai',
        pullNumber: 501,
        url: 'https://github.com/sergobright/Brai/pull/501',
        title: 'Work-scoped promotion',
        body: 'Public PR body.',
        authorLogin: 'sergobright',
        state: 'MERGED',
        isDraft: false,
        headBranch: 'codex/build-ledger',
        baseBranch: 'main',
        mergeCommitSha: 'merge-target-dir',
        githubCreatedAtUtc: '2026-07-02T11:00:00.000Z',
        githubUpdatedAtUtc: '2026-07-02T12:00:00.000Z',
        githubClosedAtUtc: '2026-07-02T12:00:00.000Z',
        githubMergedAtUtc: '2026-07-02T12:00:00.000Z',
        workRole: 'owner',
        releaseNotes: {
          build: {
            short_changes: 'Восстановлена запись версий сборок.',
            detailed_changes: 'Promotion атомарно пишет work-scoped build ledger.',
            reason: 'Нужно завершать работу только после сохранения всех PR.',
            details: [{ title: 'Work-scoped build', description: 'Owner PR связан с одной завершённой работой.' }],
          },
        },
      }],
    });

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
      'Нужно завершать деплой только после записи версии сборки.',
      '--work-json',
      workJson,
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
      assert.equal(build.detailed_changes, 'Promotion атомарно пишет work-scoped build ledger.');
      assert.equal(build.reason, 'Нужно завершать работу только после сохранения всех PR.');
      assert.notEqual(build.release_works_id, null);
      const records = promoted.listDeploymentRecords({ environment: 'prod' });
      assert.equal(records.length, 0);
      assert.equal(promoted.db.prepare('SELECT COUNT(*) AS count FROM build_version_details WHERE build_versions_id = ?').get(build.id).count, 1);
      assert.equal(promoted.db.prepare('SELECT COUNT(*) AS count FROM build_version_pull_requests WHERE build_versions_id = ?').get(build.id).count, 1);
    } finally {
      promoted.close();
    }
  })().finally(async () => {
    await sourceDatabase?.drop();
    await targetDatabase?.drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test('published stable APK is recorded after support work reconciliation and later attaches its build', async () => {
  const { tmp, dbUrl, store, drop } = await tempStore();
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  const workKey = 'work_22222222-2222-4222-a222-222222222222';
  const releasedAtUtc = '2026-07-14T14:00:00.000Z';
  try {
    store.upsertReleaseWork({ workKey });
    store.upsertGithubPullRequest(apkPull(601, workKey, 'owner', 'OPEN', false));
    store.upsertGithubPullRequest(apkPull(602, workKey, 'support', 'MERGED', true));

    const artifact = Buffer.from('stable-apk-fixture');
    const artifactName = 'brai-v12.apk';
    fs.writeFileSync(path.join(tmp, artifactName), artifact);
    fs.writeFileSync(path.join(tmp, 'releases.json'), JSON.stringify({ sections: { production: {
      apkBuildKind: 'stable', apkVersion: 12, versionCode: 142, file: artifactName,
      sha256: crypto.createHash('sha256').update(artifact).digest('hex'),
      sizeBytes: artifact.length, publishedAt: releasedAtUtc,
    } } }));

    const runRecorder = (version = '12', versionCode = '142', releasedAt = releasedAtUtc) => execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/record-shipped-apk-version.mjs'),
      '--work-key', workKey,
      '--version', version,
      '--version-code', versionCode,
      '--target-branch', 'main',
      '--target-commit', 'apk-target',
      '--released-at', releasedAt,
    ], { cwd: repoRoot, env: { ...process.env, BRAI_DATABASE_URL: dbUrl, BRAI_RELEASE_TARGET: tmp } });

    runRecorder();
    const apk = store.db.prepare("SELECT * FROM build_versions WHERE release_works_id=(SELECT id FROM release_works WHERE work_key=?) AND version_type_id='apk'").get(workKey);
    assert.equal(apk.version, 12);
    assert.equal(apk.included_in_version_id, null);
    assert.deepEqual(
      store.db.prepare(`SELECT pulls.pull_number FROM build_version_pull_requests links JOIN github_pull_requests pulls ON pulls.id=links.github_pull_requests_id WHERE links.build_versions_id=?`).all(apk.id),
      [{ pull_number: 602 }],
    );

    store.upsertGithubPullRequest(apkPull(601, workKey, 'owner', 'MERGED', false));
    const build = store.finalizeVersionWork({
      workKey, versionTypeId: 'build',
      shortChanges: 'Завершена Android-работа.',
      detailedChanges: 'Owner и native support доставлены.',
      reason: 'Нужно завершить весь work после owner merge.',
      details: [
        { title: 'Owner', description: 'Owner завершил работу.', pullNumber: 601 },
        { title: 'APK support', description: 'Support выпустил APK.', pullNumber: 602 },
      ],
      pullNumbers: [601, 602], targetBranch: 'main', targetCommit: 'build-target',
      releasedAtUtc: '2026-07-14T14:05:00.000Z',
    });
    const newerArtifact = Buffer.from('newer-stable-apk-fixture');
    const newerArtifactName = 'brai-v13.apk';
    const newerReleasedAtUtc = '2026-07-14T15:00:00.000Z';
    fs.writeFileSync(path.join(tmp, newerArtifactName), newerArtifact);
    fs.writeFileSync(path.join(tmp, 'releases.json'), JSON.stringify({ sections: { production: {
      apkBuildKind: 'stable', apkVersion: 13, versionCode: 143, file: newerArtifactName,
      sha256: crypto.createHash('sha256').update(newerArtifact).digest('hex'),
      sizeBytes: newerArtifact.length, publishedAt: newerReleasedAtUtc,
    } } }));
    const repeated = runRecorder('13', '143', newerReleasedAtUtc).toString();
    assert.match(repeated, /apk 12 \(already recorded\)/);
    assert.equal(store.db.prepare('SELECT included_in_version_id FROM build_versions WHERE id=?').get(apk.id).included_in_version_id, build.id);
  } finally {
    store.close();
    await drop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('accepted promotion rejects missing work metadata before writing a build', async () => {
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
    assert.match(result.stderr, /accepted promotion requires --work-json/);
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
    store.upsertBuildVersion({
      versionTypeId: 'build',
      version: 2,
      includedInVersionId: null,
      shortChanges: 'Повторный запуск принят.',
      detailedChanges: 'Повторный promotion видит уже записанную историческую build-версию.',
      reason: 'Нужно не падать после уже освобождённого preview slot.',
      sourceBranch: 'codex/rerun',
      sourceCommit: 'abc-rerun',
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

test('retired APK reset script cannot delete normalized version history', async () => {
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

    assert.throws(() => execFileSync(process.execPath, [
      path.join(repoRoot, 'deploy/scripts/reset-apk-only-version-ledger.mjs'),
      '--postgres-url',
      dbUrl
    ], { cwd: repoRoot, stdio: 'pipe' }), /retired/);

    const reset = new BraiStore(dbUrl);
    try {
      assert.deepEqual(
        reset.db.prepare('SELECT id FROM version_types ORDER BY id').all().map((row) => row.id),
        ['apk', 'build', 'canon', 'ios', 'macos', 'release']
      );
      assert.deepEqual(
        reset.db.prepare('SELECT version_type_id, version, short_changes FROM build_versions ORDER BY version_type_id, version').all(),
        [
          { version_type_id: 'apk', version: 1, short_changes: 'Первичная публичная APK-сборка.' },
          { version_type_id: 'apk', version: 2, short_changes: 'Актуальная публичная APK-сборка v2.' },
          { version_type_id: 'apk', version: 3, short_changes: 'Legacy APK 3.' },
          { version_type_id: 'build', version: 1, short_changes: 'Первичная публичная web/OTA-сборка.' },
          { version_type_id: 'build', version: 2, short_changes: 'Accepted build.' },
          { version_type_id: 'canon', version: 1, short_changes: 'Legacy canon.' },
          { version_type_id: 'release', version: 1, short_changes: 'Legacy release.' },
        ]
      );
      assert.equal(reset.db.prepare("SELECT COUNT(*) AS count FROM build_version_refs WHERE version_type_id = 'apk'").get().count, 1);
      assert.equal(reset.db.prepare("SELECT last_version FROM build_version_counters WHERE version_type_id = 'apk'").get().last_version, 3);
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
