import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { BraiStore } from '../src/store.js';
import { createTestDatabase } from '../test-support/api.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const recoveryScript = path.join(repoRoot, 'deploy/scripts/recover-version-work.mjs');

test('support-only recovery is dry-run by default and idempotently finalizes every merged support PR', async () => {
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  const workKey = 'work_33333333-3333-4333-a333-333333333333';
  try {
    store.upsertReleaseWork({ workKey });
    store.upsertGithubPullRequest(pull(701, workKey, 'owner', 'CLOSED'));
    store.upsertGithubPullRequest(pull(702, workKey, 'support', 'MERGED'));
    const receipt = recoveryReceipt('support-only-finalize', workKey);

    const dryRun = runRecovery(database.url, receipt);
    assert.match(dryRun, /Dry run: support-only-finalize/);
    assert.equal(workBuild(store, workKey), undefined);
    assert.equal(recoveryLogCount(store, workKey), 0);

    const applied = runRecovery(database.url, receipt, workKey);
    assert.match(applied, /Applied: support-only-finalize/);
    const build = workBuild(store, workKey);
    assert.ok(build);
    assert.deepEqual(linkedPulls(store, build.id), [702]);
    assert.deepEqual(versionDetails(store, build.id), ['Изменение PR 702']);
    assert.equal(recoveryLogCount(store, workKey), 1);

    assert.match(runRecovery(database.url, receipt, workKey), /already complete/);
    assert.equal(recoveryLogCount(store, workKey), 1);
    const mismatched = spawnSync(process.execPath, [
      recoveryScript,
      '--receipt-json', JSON.stringify({
        ...receipt,
        build: { ...receipt.build, reason: 'Повторный receipt не должен менять уже записанную причину.' },
      }),
      '--apply', workKey,
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, BRAI_DATABASE_URL: database.url } });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /existing build \d+ has different reason/);
  } finally {
    store.close();
    await database.drop();
  }
});

test('owner recovery transfers and finalizes atomically without a transfer-only state', async () => {
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  const workKey = 'work_44444444-4444-4444-a444-444444444444';
  const blockedWorkKey = 'work_55555555-5555-4555-a555-555555555555';
  try {
    seedTransferWork(store, workKey, 711, 712);
    const receipt = {
      ...recoveryReceipt('transfer-and-finalize', workKey),
      repository: 'sergobright/Brai',
      from_pull_number: 711,
      to_pull_number: 712,
    };
    runRecovery(database.url, receipt, workKey);
    assert.deepEqual(workRoles(store, workKey), [
      { pull_number: 711, work_role: 'support' },
      { pull_number: 712, work_role: 'owner' },
    ]);
    assert.deepEqual(linkedPulls(store, workBuild(store, workKey).id), [712]);
    assert.match(runRecovery(database.url, receipt, workKey), /already complete/);

    seedTransferWork(store, blockedWorkKey, 721, 722);
    store.upsertGithubPullRequest(pull(723, blockedWorkKey, 'support', 'OPEN'));
    const blockedReceipt = {
      ...recoveryReceipt('transfer-and-finalize', blockedWorkKey),
      repository: 'sergobright/Brai',
      from_pull_number: 721,
      to_pull_number: 722,
    };
    const blocked = spawnSync(process.execPath, [
      recoveryScript, '--receipt-json', JSON.stringify(blockedReceipt), '--apply', blockedWorkKey,
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, BRAI_DATABASE_URL: database.url } });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /unresolved PRs: #723 \(OPEN\)/);
    assert.deepEqual(workRoles(store, blockedWorkKey), [
      { pull_number: 721, work_role: 'owner' },
      { pull_number: 722, work_role: 'support' },
      { pull_number: 723, work_role: 'support' },
    ]);
    assert.equal(workBuild(store, blockedWorkKey), undefined);
  } finally {
    store.close();
    await database.drop();
  }
});

test('recovery cancellation requires exact apply confirmation and no merged PRs', async () => {
  const database = await createTestDatabase();
  const store = new BraiStore(database.url);
  const workKey = 'work_66666666-6666-4666-a666-666666666666';
  try {
    store.upsertReleaseWork({ workKey });
    store.upsertGithubPullRequest(pull(731, workKey, 'owner', 'CLOSED'));
    const receipt = {
      receiptType: 'brai-work-recovery-v1',
      action: 'cancel',
      workKey,
      recovery_reason: 'Работа закрыта без объединённых изменений.',
    };
    const mismatch = spawnSync(process.execPath, [
      recoveryScript, '--receipt-json', JSON.stringify(receipt), '--apply', 'work_77777777-7777-4777-a777-777777777777',
    ], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, BRAI_DATABASE_URL: database.url } });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /--apply must equal the exact recovery work key/);
    runRecovery(database.url, receipt, workKey);
    assert.equal(store.releaseWork(workKey).status, 'cancelled');
  } finally {
    store.close();
    await database.drop();
  }
});

function seedTransferWork(store, workKey, ownerNumber, supportNumber) {
  store.upsertReleaseWork({ workKey });
  store.upsertGithubPullRequest(pull(ownerNumber, workKey, 'owner', 'CLOSED'));
  store.upsertGithubPullRequest(pull(supportNumber, workKey, 'support', 'MERGED'));
}

function pull(pullNumber, workKey, workRole, state) {
  const merged = state === 'MERGED';
  const marker = { receiptType: 'brai-work-v1', workKey, workRole, nativeBoundary: false };
  const notes = {
    receiptType: 'brai-release-notes-v2',
    work: { key: workKey, role: workRole },
    build: {
      ...(workRole === 'owner' ? {
        short_changes: 'Исходный владелец работы.',
        detailed_changes: 'Исходная owner-сводка сохранена в PR.',
        reason: 'Работа начиналась с отдельным владельцем.',
      } : {}),
      details: [{ title: `Изменение PR ${pullNumber}`, description: `Результат PR ${pullNumber} сохранён как атомарная деталь.` }],
    },
    testing: 'Проверен сценарий восстановления истории версий.',
  };
  return {
    workKey, workRole, repository: 'sergobright/Brai', pullNumber,
    url: `https://github.com/sergobright/Brai/pull/${pullNumber}`,
    title: `PR ${pullNumber}`,
    body: `<!-- brai-work-v1\n${JSON.stringify(marker)}\n-->\n<!-- brai-release-notes-v2\n${JSON.stringify(notes)}\n-->`,
    authorLogin: 'sergobright', state, isDraft: false,
    headBranch: `codex/recovery-${pullNumber}`, baseBranch: 'main',
    mergeCommitSha: merged ? `merge-${pullNumber}` : null,
    githubCreatedAtUtc: '2026-07-14T13:00:00.000Z',
    githubUpdatedAtUtc: '2026-07-14T14:00:00.000Z',
    githubClosedAtUtc: state === 'OPEN' ? null : '2026-07-14T14:00:00.000Z',
    githubMergedAtUtc: merged ? '2026-07-14T14:00:00.000Z' : null,
  };
}

function recoveryReceipt(action, workKey) {
  return {
    receiptType: 'brai-work-recovery-v1',
    action,
    workKey,
    recovery_reason: 'Owner закрыт, но объединённые support-изменения нужно записать без потерь.',
    build: {
      short_changes: 'Восстановлена завершённая работа.',
      detailed_changes: 'Все объединённые support-изменения связаны с одной build-версией.',
      reason: 'Нельзя оставлять доставленные изменения без версии после закрытия owner PR.',
    },
    target_branch: 'main',
    target_commit: workKey.replace(/^work_/, '').replaceAll('-', '').padEnd(40, '0').slice(0, 40),
    released_at_utc: '2026-07-14T15:00:00.000Z',
  };
}

function runRecovery(databaseUrl, receipt, apply = null) {
  const args = [recoveryScript, '--receipt-json', JSON.stringify(receipt)];
  if (apply) args.push('--apply', apply);
  return execFileSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BRAI_DATABASE_URL: databaseUrl },
  });
}

function workBuild(store, workKey) {
  return store.db.prepare("SELECT * FROM build_versions WHERE release_works_id=(SELECT id FROM release_works WHERE work_key=?) AND version_type_id='build'").get(workKey);
}

function workRoles(store, workKey) {
  return store.db.prepare('SELECT pull_number, work_role FROM github_pull_requests WHERE release_works_id=(SELECT id FROM release_works WHERE work_key=?) ORDER BY pull_number').all(workKey);
}

function linkedPulls(store, buildId) {
  return store.db.prepare('SELECT pulls.pull_number FROM build_version_pull_requests links JOIN github_pull_requests pulls ON pulls.id=links.github_pull_requests_id WHERE links.build_versions_id=? ORDER BY pulls.pull_number').all(buildId).map((row) => row.pull_number);
}

function versionDetails(store, buildId) {
  return store.db.prepare('SELECT title FROM build_version_details WHERE build_versions_id=? ORDER BY display_order').all(buildId).map((row) => row.title);
}

function recoveryLogCount(store, workKey) {
  return Number(store.db.prepare("SELECT COUNT(*) AS count FROM logs WHERE source='version-history-recovery' AND message LIKE ?").get(`%${workKey}%`).count);
}
