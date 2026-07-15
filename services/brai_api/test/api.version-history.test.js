import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, jsonRequest, request } from '../test-support/api.js';

test('public version history is normalized, filtered, cursor-paginated, and safe for brai.one', async () => {
  const errors = [];
  const fixture = await createFixture(['2026-07-14T10:00:00.000Z'], { logger: { error: (error) => errors.push(error) } });
  try {
    seedWork(fixture, 301, 'work_api_301', '2099-07-14T10:01:00.000Z');
    seedWork(fixture, 302, 'work_api_302', '2099-07-14T10:03:00.000Z');
    seedWork(fixture, 303, 'work_api_303', '2099-07-14T10:03:00.000Z');
    const hostileBody = [
      'Диагностика /srv/projects/brai/private.',
      'postgres://user:pass@example.test/db',
      'Authorization: Bearer abc.def.ghi',
      'Cookie: sid=private',
      'password=hunter2',
      `-----BEGIN ${'PRIVATE'} KEY-----\nprivate\n-----END ${'PRIVATE'} KEY-----`,
      ['gh', 'p_abcdefghijklmnopqrstuvwxyz123456'].join(''),
      ['Ser', 'gey'].join(''),
      ['Сер', 'гей'].join(''),
    ].join('\n');
    fixture.store.db.prepare('UPDATE github_pull_requests SET body = ? WHERE pull_number = ?').run(hostileBody, 303);

    const first = await request(fixture.url, '/v1/version-history?limit=2', {}, false);
    assert.equal(first.status, 200, errors.map((error) => error?.message ?? String(error)).join('\n'));
    assert.deepEqual(first.body.items.map((item) => item.work.key), ['work_api_303', 'work_api_302']);
    assert.ok(first.body.next_cursor);
    assert.equal(first.body.items[0].details[0].title, 'Изменение 303');
    assert.equal(first.body.items[0].pull_requests[0].number, 303);
    const publicBody = first.body.items[0].pull_requests[0].body;
    assert.match(publicBody, /\[local path\]/);
    assert.match(publicBody, /\[database URL\]/);
    assert.match(publicBody, /Authorization: \[credential\]/);
    assert.match(publicBody, /Cookie: \[credential\]/);
    assert.match(publicBody, /password=\[credential\]/);
    assert.match(publicBody, /\[private key\]/);
    assert.equal(publicBody.match(/\[private name\]/g)?.length, 2);
    assert.equal(first.body.items[0].refs[0].target_commit, 'target-303');
    assert.deepEqual(Object.keys(first.body.items[0]).sort(), [
      'created_at_utc', 'details', 'detailed_changes', 'id', 'pull_requests', 'reason',
      'refs', 'released_at_utc', 'short_changes', 'type', 'version', 'work'
    ].sort());

    const second = await request(fixture.url, `/v1/version-history?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`, {}, false);
    assert.equal(second.status, 200);
    assert.equal(second.body.items[0].work.key, 'work_api_301');
    const allItems = [...first.body.items, ...second.body.items];
    let cursor = second.body.next_cursor;
    while (cursor) {
      const page = await request(fixture.url, `/v1/version-history?limit=2&cursor=${encodeURIComponent(cursor)}`, {}, false);
      assert.equal(page.status, 200);
      allItems.push(...page.body.items);
      cursor = page.body.next_cursor;
    }
    assert.equal(new Set(allItems.map((item) => item.id)).size, allItems.length);
    assert.deepEqual(allItems.filter((item) => item.work).map((item) => item.work.key).sort(), ['work_api_301', 'work_api_302', 'work_api_303']);

    const buildOnly = await request(fixture.url, '/v1/version-history?type=build&limit=100', {}, false);
    assert.equal(buildOnly.status, 200);
    assert.equal(buildOnly.body.items.every((item) => item.type === 'build'), true);
    assert.equal(buildOnly.body.types.some((type) => type.id === 'apk'), true);

    const forgedCursor = Buffer.from(JSON.stringify(['July 14 2099', 3])).toString('base64url');
    for (const query of ['type=missing', 'limit=0', 'limit=101', 'limit=nope', 'cursor=not-json', `cursor=${forgedCursor}`]) {
      const invalid = await request(fixture.url, `/v1/version-history?${query}`, {}, false);
      assert.equal(invalid.status, 400, query);
    }

    const cors = await jsonRequest(fixture.url, '/v1/version-history?limit=1', {
      headers: { origin: 'https://brai.one' }
    });
    assert.equal(cors.status, 200);
    assert.equal(cors.headers.get('access-control-allow-origin'), 'https://brai.one');
    const preflight = await fetch(`${fixture.url}/v1/version-history`, {
      method: 'OPTIONS',
      headers: { origin: 'https://brai.one', 'access-control-request-method': 'GET' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://brai.one');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET,OPTIONS');
    const evil = await jsonRequest(fixture.url, '/v1/version-history?limit=1', {
      headers: { origin: 'https://evil.example' }
    });
    assert.equal(evil.status, 200);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const readOnly = await request(fixture.url, '/v1/version-history', { method: 'POST', body: '{}' }, false);
    assert.equal(readOnly.status, 405);
    const serialized = JSON.stringify(cors.body);
    assert.equal(serialized.includes('postgres://'), false);
    assert.equal(serialized.includes('cookie'), false);
    assert.equal(serialized.includes('token'), false);
    assert.equal(serialized.includes('/srv/'), false);
    assert.equal(serialized.includes('ghp_'), false);
    assert.equal(serialized.includes('user:pass'), false);
    assert.equal(serialized.includes('hunter2'), false);
    assert.equal(serialized.includes('PRIVATE KEY'), false);
  } finally {
    await fixture.close();
  }
});

test('work finalization is atomic, idempotent, and blocked by unresolved support PRs', async () => {
  const fixture = await createFixture(['2026-07-14T11:00:00.000Z']);
  try {
    fixture.store.upsertReleaseWork({ workKey: 'work_atomic' });
    fixture.store.upsertGithubPullRequest(pullSnapshot(401, 'work_atomic', 'owner', 'MERGED'));
    fixture.store.upsertGithubPullRequest(pullSnapshot(402, 'work_atomic', 'support', 'OPEN'));
    const input = {
      workKey: 'work_atomic',
      versionTypeId: 'build',
      shortChanges: 'Завершена атомарная работа.',
      detailedChanges: 'Объединены owner и support изменения.',
      reason: 'Нужно сохранить полный состав работы.',
      details: [{ title: 'Owner-изменение', description: 'Проверяем атомарную финализацию.', pullNumber: 401 }],
      targetBranch: 'main',
      targetCommit: 'atomic-target',
      releasedAtUtc: '2026-07-14T11:01:00.000Z'
    };
    assert.throws(() => fixture.store.finalizeVersionWork(input), /unresolved PRs: #402 \(OPEN\)/);
    assert.equal(fixture.store.releaseWork('work_atomic').status, 'active');
    assert.equal(Number(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE release_works_id IS NOT NULL").get().count), 0);

    fixture.store.upsertGithubPullRequest(pullSnapshot(402, 'work_atomic', 'support', 'MERGED'));
    input.details.push({ title: 'Support-изменение', description: 'Support PR сохранён отдельно.', pullNumber: 402 });
    assert.throws(
      () => fixture.store.finalizeVersionWork({ ...input, pullNumbers: [401] }),
      /must link every merged work PR/,
    );
    assert.equal(Number(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE release_works_id IS NOT NULL").get().count), 0);
    const created = fixture.store.finalizeVersionWork(input);
    const repeated = fixture.store.finalizeVersionWork(input);
    assert.equal(created.created, true);
    assert.equal(repeated.created, false);
    assert.equal(created.version, repeated.version);
    assert.equal(fixture.store.releaseWork('work_atomic').status, 'finalized');
    assert.equal(Number(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM build_version_details WHERE build_versions_id = ?').get(created.id).count), 2);
    assert.equal(Number(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM build_version_pull_requests WHERE build_versions_id = ?').get(created.id).count), 2);
    assert.throws(
      () => fixture.store.finalizeVersionWork({ ...input, version: created.version + 1 }),
      /different explicit version/,
    );

    const changed = pullSnapshot(401, 'work_atomic', 'owner', 'MERGED');
    changed.body = 'Отредактированное после финализации описание';
    fixture.store.upsertGithubPullRequest(changed);
    assert.equal(
      fixture.store.db.prepare('SELECT body FROM github_pull_requests WHERE pull_number = 401').get().body,
      'Полное публичное описание PR 401',
    );

    assert.throws(
      () => fixture.store.upsertGithubPullRequest(pullSnapshot(401, 'work_conflict', 'owner', 'MERGED')),
      /already belongs to work_atomic/,
    );
    assert.equal(fixture.store.releaseWork('work_conflict'), undefined);
    assert.throws(
      () => fixture.store.db.prepare('UPDATE release_works SET work_key = ? WHERE work_key = ?').run('work_changed', 'work_atomic'),
      /release_works\.work_key is immutable/,
    );
  } finally {
    await fixture.close();
  }
});

test('explicit platform versions and typed PR links fail closed on conflicting work identity', async () => {
  const fixture = await createFixture(['2026-07-14T12:00:00.000Z']);
  try {
    for (const [workKey, pullNumber] of [['work_apk_a', 451], ['work_apk_b', 452]]) {
      fixture.store.upsertReleaseWork({ workKey });
      fixture.store.upsertGithubPullRequest(pullSnapshot(pullNumber, workKey, 'owner', 'MERGED'));
    }
    const input = (workKey, pullNumber, version) => ({
      workKey,
      versionTypeId: 'apk',
      version,
      shortChanges: `APK ${version}.`,
      detailedChanges: `Нативные изменения APK ${version}.`,
      reason: `Опубликован артефакт APK ${version}.`,
      details: [{ title: `APK ${version}`, description: `Подтверждён APK ${version}.`, pullNumber }],
      pullNumbers: [pullNumber],
      releasedAtUtc: '2026-07-14T12:01:00.000Z',
    });
    fixture.store.finalizeVersionWork(input('work_apk_a', 451, 900));
    assert.throws(
      () => fixture.store.finalizeVersionWork(input('work_apk_b', 452, 900)),
      /already belongs to another release work/,
    );
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id='apk' AND version=900").get().count, 1);

    fixture.store.upsertBuildVersion({
      versionTypeId: 'apk', version: 901, includedInVersionId: null,
      shortChanges: 'Legacy.', detailedChanges: 'Legacy.', reason: 'Legacy.',
      releasedAtUtc: '2026-07-14T12:02:00.000Z',
    });
    const legacy = fixture.store.db.prepare("SELECT id FROM build_versions WHERE version_type_id='apk' AND version=901").get();
    const pull = fixture.store.db.prepare('SELECT id FROM github_pull_requests WHERE pull_number=452').get();
    fixture.store.db.prepare(`
      INSERT INTO build_version_pull_requests (build_versions_id, version_type_id, github_pull_requests_id, created_at_utc)
      VALUES (?, 'apk', ?, ?)
    `).run(legacy.id, pull.id, '2026-07-14T12:02:00.000Z');
    assert.throws(
      () => fixture.store.finalizeVersionWork(input('work_apk_b', 452, 902)),
      /unique|duplicate/i,
    );
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id='apk' AND version=902").get().count, 0);
  } finally {
    await fixture.close();
  }
});

test('ownership transfer, support-only finalization, and cancellation keep work lifecycle explicit', async () => {
  const fixture = await createFixture(['2026-07-14T13:00:00.000Z']);
  try {
    fixture.store.upsertReleaseWork({ workKey: 'work_transfer' });
    fixture.store.upsertGithubPullRequest(pullSnapshot(471, 'work_transfer', 'owner', 'OPEN'));
    fixture.store.upsertGithubPullRequest(pullSnapshot(472, 'work_transfer', 'support', 'OPEN'));
    fixture.store.transferReleaseWorkOwnership({
      workKey: 'work_transfer', repository: 'sergobright/Brai', fromPullNumber: 471, toPullNumber: 472,
    });
    assert.deepEqual(
      fixture.store.db.prepare('SELECT pull_number, work_role FROM github_pull_requests WHERE release_works_id=(SELECT id FROM release_works WHERE work_key=?) ORDER BY pull_number').all('work_transfer'),
      [{ pull_number: 471, work_role: 'support' }, { pull_number: 472, work_role: 'owner' }],
    );

    fixture.store.upsertReleaseWork({ workKey: 'work_support_only' });
    fixture.store.upsertGithubPullRequest(pullSnapshot(473, 'work_support_only', 'owner', 'CLOSED'));
    fixture.store.upsertGithubPullRequest(pullSnapshot(474, 'work_support_only', 'support', 'MERGED'));
    const built = fixture.store.finalizeVersionWork({
      workKey: 'work_support_only', versionTypeId: 'build', allowSupportOnly: true,
      shortChanges: 'Завершена support-only работа.',
      detailedChanges: 'Merged support сохранён без брошенного owner.',
      reason: 'Owner закрыт без merge, а support уже доставлен.',
      details: [{ title: 'Support', description: 'Support PR завершил полезное изменение.', pullNumber: 474 }],
      pullNumbers: [474], releasedAtUtc: '2026-07-14T13:01:00.000Z',
    });
    assert.equal(built.created, true);
    assert.equal(fixture.store.releaseWork('work_support_only').status, 'finalized');

    fixture.store.upsertReleaseWork({ workKey: 'work_cancel' });
    fixture.store.upsertGithubPullRequest(pullSnapshot(475, 'work_cancel', 'owner', 'CLOSED'));
    fixture.store.cancelReleaseWork({ workKey: 'work_cancel' });
    assert.equal(fixture.store.releaseWork('work_cancel').status, 'cancelled');
  } finally {
    await fixture.close();
  }
});

function seedWork(fixture, pullNumber, workKey, releasedAtUtc) {
  fixture.store.upsertReleaseWork({ workKey });
  fixture.store.upsertGithubPullRequest(pullSnapshot(pullNumber, workKey, 'owner', 'MERGED'));
  fixture.store.finalizeVersionWork({
    workKey,
    versionTypeId: 'build',
    shortChanges: `Завершена работа ${pullNumber}.`,
    detailedChanges: `Подробности работы ${pullNumber}.`,
    reason: `История работы ${pullNumber} должна быть доступна.`,
    details: [{ title: `Изменение ${pullNumber}`, description: `Результат независимого изменения ${pullNumber}.`, pullNumber }],
    sourceBranch: `codex/work-${pullNumber}`,
    sourceCommit: `source-${pullNumber}`,
    targetBranch: 'main',
    targetCommit: `target-${pullNumber}`,
    releasedAtUtc,
  });
}

function pullSnapshot(pullNumber, workKey, workRole, state) {
  const merged = state === 'MERGED';
  return {
    workKey,
    workRole,
    repository: 'sergobright/Brai',
    pullNumber,
    url: `https://github.com/sergobright/Brai/pull/${pullNumber}`,
    title: `PR ${pullNumber}`,
    body: `Полное публичное описание PR ${pullNumber}`,
    authorLogin: 'sergobright',
    state,
    isDraft: false,
    headBranch: `codex/work-${pullNumber}`,
    baseBranch: 'main',
    mergeCommitSha: merged ? `merge-${pullNumber}` : null,
    githubCreatedAtUtc: '2026-07-14T09:00:00.000Z',
    githubUpdatedAtUtc: '2026-07-14T10:00:00.000Z',
    githubClosedAtUtc: merged ? '2026-07-14T10:00:00.000Z' : null,
    githubMergedAtUtc: merged ? '2026-07-14T10:00:00.000Z' : null,
  };
}
