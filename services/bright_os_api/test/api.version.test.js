import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, request } from '../test-support/api.js';

test('version endpoint returns current build ledger counters', async () => {
  const fixture = await createFixture(['2026-06-29T12:00:00.000Z']);

  try {
    fixture.store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/engine',
      sourceCommit: 'engine-source',
      sourceShortChanges: 'Add Engine page.',
      sourceDetails: 'Engine reads current version data.',
      targetBranch: 'main',
      targetCommit: 'engine-main',
      releasedAtUtc: '2026-06-29T12:05:00.000Z'
    });
    fixture.store.recordReleaseVersion({
      sourceBranch: 'manual',
      sourceCommit: 'release-one',
      sourceShortChanges: 'Release one.',
      sourceDetails: 'Release details.',
      targetBranch: 'main',
      targetCommit: 'release-one',
      releasedAtUtc: '2026-06-29T12:10:00.000Z'
    });
    fixture.store.recordAcceptedBuildVersion({
      sourceBranch: 'codex/engine-next',
      sourceCommit: 'engine-next-source',
      sourceShortChanges: 'Ship next build.',
      sourceDetails: 'Next build details.',
      targetBranch: 'main',
      targetCommit: 'engine-next-main',
      releasedAtUtc: '2026-06-29T12:15:00.000Z'
    });

    const response = await request(fixture.url, '/v1/version');

    assert.equal(response.status, 200);
    assert.equal(response.body.version, '0.1.3.1');
    assert.deepEqual(response.body.parts, { canon: 0, release: 1, build: 3, apk: 1 });
    assert.equal(response.body.latest.canon, null);
    assert.equal(response.body.latest.release.short_changes, 'Release one.');
    assert.equal(response.body.latest.build.short_changes, 'Ship next build.');
    assert.equal(response.body.latest.apk.version, 1);
  } finally {
    await fixture.close();
  }
});

test('version endpoint requires auth', async () => {
  const fixture = await createFixture(['2026-06-29T12:00:00.000Z']);

  try {
    const response = await request(fixture.url, '/v1/version', {}, false);

    assert.equal(response.status, 401);
  } finally {
    await fixture.close();
  }
});
