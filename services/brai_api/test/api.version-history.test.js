import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixture, jsonRequest, request } from '../test-support/api.js';

test('public version history is normalized, filtered, cursor-paginated, and safe for brai.one', async () => {
  const errors = [];
  const fixture = await createFixture(['2026-07-14T10:00:00.000Z'], { logger: { error: (error) => errors.push(error) } });
  try {
    seedWork(fixture, 301, 'work_api_301', '2099-07-14T10:01:00.000Z');
    seedWork(fixture, 302, 'work_api_302', '2099-07-14T10:03:00.000Z');
    seedWork(fixture, 303, 'work_api_303', '2099-07-14T10:03:00.000Z');
    const pool = fixture.openDatabasePool();
    try {
      await pool.query(fs.readFileSync(path.resolve(import.meta.dirname, '../../../supabase/migrations/0033_normalize_version_work_history.sql'), 'utf8'));
    } finally {
      await pool.end();
    }
    const hostileBody = [
      'Диагностика /srv/projects/brai/private.',
      'postgres://user:pass@example.test/db',
      'Authorization: Bearer abc.def.ghi',
      'Cookie: sid=private',
      'password=hunter2',
      'api_key: "topsecret123"',
      "client_secret = 'topsecret123'",
      'AWS_SECRET_ACCESS_KEY=abc123secret',
      'BRAI_DEPLOY_SSH_KEY=abc123secret',
      `-----BEGIN ${'PRIVATE'} KEY-----\nprivate\n-----END ${'PRIVATE'} KEY-----`,
      ['gh', 'p_abcdefghijklmnopqrstuvwxyz123456'].join(''),
      ['Ser', 'gey'].join(''),
      ['Сер', 'гей'].join(''),
    ].join('\n');
    fixture.store.db.prepare('UPDATE github_pull_requests SET body = ? WHERE pull_number = ?').run(hostileBody, 303);

    const first = await request(fixture.url, '/v1/version-history?limit=2', {}, false);
    assert.equal(first.status, 200, errors.map((error) => error?.message ?? String(error)).join('\n'));
    assert.deepEqual(first.body.types, [
      { id: 'build', title: 'Product' },
      { id: 'apk', title: 'Android APK' },
      { id: 'macos', title: 'macOS' },
      { id: 'ios', title: 'iOS' },
    ]);
    const storedTypes = fixture.store.db.prepare('SELECT id, description FROM version_types ORDER BY id').all();
    assert.deepEqual(storedTypes.map((row) => row.id), ['apk', 'build', 'ios', 'macos']);
    assert.equal(storedTypes.every((row) => row.description.length > 0), true);
    assert.deepEqual(
      fixture.store.db.prepare("SELECT table_name FROM table_descriptions WHERE table_name IN ('version_types', 'build_versions', 'build_version_counters') ORDER BY table_name").all(),
      [{ table_name: 'build_version_counters' }, { table_name: 'build_versions' }, { table_name: 'version_types' }],
    );
    assert.deepEqual(
      fixture.store.db.prepare('SELECT version_type_id FROM build_version_counters ORDER BY version_type_id').all(),
      [{ version_type_id: 'apk' }, { version_type_id: 'build' }],
    );
    assert.equal(
      Number(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM build_versions WHERE version_type_id IN ('macos', 'ios')").get().count),
      0,
    );
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
    assert.match(publicBody, /api_key=\[credential\]/);
    assert.match(publicBody, /client_secret=\[credential\]/);
    assert.match(publicBody, /AWS_SECRET_ACCESS_KEY=\[credential\]/);
    assert.match(publicBody, /BRAI_DEPLOY_SSH_KEY=\[credential\]/);
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
    assert.deepEqual(buildOnly.body.types, first.body.types);
    for (const type of ['macos', 'ios']) {
      const futureType = await request(fixture.url, `/v1/version-history?type=${type}&limit=100`, {}, false);
      assert.equal(futureType.status, 200);
      assert.deepEqual(futureType.body.items, []);
      assert.deepEqual(futureType.body.types, first.body.types);
      assert.equal(futureType.body.next_cursor, null);
    }

    const forgedCursor = Buffer.from(JSON.stringify(['July 14 2099', 3])).toString('base64url');
    for (const query of ['type=missing', 'type=canon', 'type=release', 'limit=0', 'limit=101', 'limit=nope', 'cursor=not-json', `cursor=${forgedCursor}`]) {
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
    assert.equal(serialized.includes('topsecret123'), false);
    assert.equal(serialized.includes('abc123secret'), false);
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

test('work finalization rejects non-atomic details after owner and support notes are combined', async () => {
  const fixture = await createFixture(['2026-07-14T11:30:00.000Z']);
  try {
    fixture.store.upsertReleaseWork({ workKey: 'work_detail_validation' });
    fixture.store.upsertGithubPullRequest(pullSnapshot(411, 'work_detail_validation', 'owner', 'MERGED'));
    fixture.store.upsertGithubPullRequest(pullSnapshot(412, 'work_detail_validation', 'support', 'MERGED'));
    const input = {
      workKey: 'work_detail_validation',
      versionTypeId: 'build',
      shortChanges: 'Общий итог релиза.',
      detailedChanges: 'Краткое обобщение всех независимых изменений.',
      reason: 'История должна сохранять атомарные release notes.',
      pullNumbers: [411, 412],
      releasedAtUtc: '2026-07-14T11:31:00.000Z',
    };
    const validOwner = { title: 'Изменён API', description: 'Owner PR обновил API-контракт.', pullNumber: 411 };
    const invalidCases = [
      {
        details: [validOwner, { ...validOwner, pullNumber: 412 }],
        error: /duplicates another atomic detail/,
      },
      {
        details: [validOwner, { title: 'Изменён API!', description: 'Support PR обновил worker.', pullNumber: 412 }],
        error: /title duplicates another atomic detail title/,
      },
      {
        details: [validOwner, { title: 'Изменён worker', description: 'Owner PR обновил API-контракт!', pullNumber: 412 }],
        error: /description duplicates another atomic detail description/,
      },
      {
        details: [validOwner, { title: 'Фоновая задача — 1', description: 'Support PR обновил worker.', pullNumber: 412 }],
        error: /automatic numeric suffix/,
      },
      {
        details: [validOwner, { title: 'Одинаковый текст', description: 'Одинаковый текст.', pullNumber: 412 }],
        error: /must not repeat its description/,
      },
      {
        details: [validOwner, { title: ' общий итог релиза! ', description: 'Support PR обновил worker.', pullNumber: 412 }],
        error: /title duplicates the parent summary/,
      },
      {
        details: [validOwner, { title: ' краткое обобщение всех независимых изменений! ', description: 'Support PR обновил worker.', pullNumber: 412 }],
        error: /title duplicates the parent summary/,
      },
      {
        details: [validOwner, { title: 'Изменён worker', description: ' общий итог релиза! ', pullNumber: 412 }],
        error: /description duplicates the parent summary/,
      },
      {
        details: [validOwner, { title: 'Изменён worker', description: ' краткое обобщение всех независимых изменений! ', pullNumber: 412 }],
        error: /description duplicates the parent summary/,
      },
      {
        details: [validOwner, { title: ' история должна сохранять атомарные release notes! ', description: 'Support PR обновил worker.', pullNumber: 412 }],
        error: /title duplicates the parent summary/,
      },
      {
        details: [validOwner, { title: 'Изменён worker', description: ' история должна сохранять атомарные release notes! ', pullNumber: 412 }],
        error: /description duplicates the parent summary/,
      },
    ];

    for (const invalid of invalidCases) {
      assert.throws(() => fixture.store.finalizeVersionWork({ ...input, details: invalid.details }), invalid.error);
      assert.equal(fixture.store.releaseWork(input.workKey).status, 'active');
      assert.equal(
        Number(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM build_versions WHERE release_works_id=(SELECT id FROM release_works WHERE work_key=?)').get(input.workKey).count),
        0,
      );
    }
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
      details: [{ title: `Нативный пакет ${version}`, description: `Подтверждён APK ${version}.`, pullNumber }],
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
    fixture.store.upsertGithubPullRequest({ ...pullSnapshot(471, 'work_transfer', 'owner', 'CLOSED'), title: 'Старый marker не возвращает ownership' });
    assert.equal(
      fixture.store.db.prepare('SELECT work_role FROM github_pull_requests WHERE pull_number = 471').get().work_role,
      'support',
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
