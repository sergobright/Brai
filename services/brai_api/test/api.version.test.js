import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, RELEASE_PASSWORD, request, SESSION_SECRET, textRequest } from '../test-support/api.js';

test('version endpoint returns build ledger, APK line, and release-index OTA target', async () => {
  const fixture = await createFixture(['2026-06-29T12:00:00.000Z'], {
    releaseFiles: {
      'releases.json': JSON.stringify({
        schemaVersion: 2,
        sections: {
          production: {
            file: 'brai-v2.apk',
            apkVersion: 2,
            versionCode: 2,
            publishedAt: '2026-06-30T20:23:42Z',
            capabilities: ['AccessibilityService', 'Overlay', 'Microphone', 'MediaProjection']
          }
        }
      })
    },
    mobileFiles: {
      'manifest.json': JSON.stringify({
        schemaVersion: 2,
        otaVersion: '0.0.41',
        targetApkVersion: 2
      })
    }
  });
  fixture.store.upsertBuildVersion({
    versionTypeId: 'apk',
    version: 2,
    includedInVersionId: null,
    shortChanges: 'Актуальная публичная APK-сборка v2.',
    detailedChanges: 'APK v2.',
    reason: 'Актуальная APK-линейка Brai.',
    releasedAtUtc: '2026-06-30T20:23:42Z',
  });

  try {
    const response = await request(fixture.url, '/v1/version');

    assert.equal(response.status, 200);
    assert.equal(response.body.version, '0.0.41');
    assert.equal(response.body.ota_version, '0.0.41');
    assert.deepEqual(response.body.parts, { canon: 0, release: 0, build: 1, apk: 2 });
    assert.equal(response.body.latest.canon, null);
    assert.equal(response.body.latest.release, null);
    assert.equal(response.body.latest.build.version, 1);
    assert.equal(response.body.latest.apk.version, 2);
    assert.deepEqual(response.body.target_apk, {
      file: 'brai-v2.apk',
      version: 2,
      version_code: 2,
      release_key: 'production',
      apk_build_kind: 'stable',
      preview_iteration: null,
      release_url: '/releases/',
      published_at: '2026-06-30T20:23:42Z',
      capabilities: ['AccessibilityService', 'Overlay', 'Microphone', 'MediaProjection']
    });
    assert.deepEqual(response.body.apk_release, {
      file: 'brai-v2.apk',
      version: 2,
      version_code: 2,
      release_key: 'production',
      apk_build_kind: 'stable',
      preview_iteration: null,
      release_url: '/releases/',
      published_at: '2026-06-30T20:23:42Z',
      capabilities: ['AccessibilityService', 'Overlay', 'Microphone', 'MediaProjection']
    });
  } finally {
    await fixture.close();
  }
});

test('version endpoint returns preview APK release metadata from release index', async () => {
  const fixture = await createFixture(['2026-06-29T12:00:00.000Z'], {
    releaseFiles: {
      'releases.json': JSON.stringify({
        schemaVersion: 2,
        sections: {
          production: {
            file: 'brai-a-v2-preview7.apk',
            apkVersion: 2,
            versionCode: 20007,
            releaseKey: 'a',
            apkBuildKind: 'preview',
            previewIteration: 7,
            publishedAt: '2026-07-04T20:23:42Z',
            capabilities: ['AccessibilityService']
          }
        }
      })
    }
  });

  try {
    const response = await request(fixture.url, '/v1/version');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.target_apk, {
      file: 'brai-a-v2-preview7.apk',
      version: 2,
      version_code: 20007,
      release_key: 'a',
      apk_build_kind: 'preview',
      preview_iteration: 7,
      release_url: '/releases/',
      published_at: '2026-07-04T20:23:42Z',
      capabilities: ['AccessibilityService']
    });
    assert.deepEqual(response.body.apk_release, response.body.target_apk);
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

test('release login and APK serving write compact runtime logs', async () => {
  const fixture = await createFixture([
    '2026-06-29T12:10:00.000Z',
    '2026-06-29T12:10:01.000Z',
    '2026-06-29T12:10:02.000Z'
  ], {
    releasePassword: RELEASE_PASSWORD,
    sessionSecret: SESSION_SECRET,
    releaseFiles: { 'brai.apk': 'fake-apk' }
  });

  try {
    const unauthorized = await fetch(`${fixture.url}/releases/brai.apk`, { redirect: 'manual' });
    assert.equal(unauthorized.status, 303);

    const login = await textRequest(fixture.url, '/releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(RELEASE_PASSWORD)}`,
      redirect: 'manual'
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /brai_session=/);

    const apk = await fetch(`${fixture.url}/releases/brai.apk`, { headers: { cookie } });
    assert.equal(apk.status, 200);
    assert.equal(await apk.text(), 'fake-apk');
    const missing = await fetch(`${fixture.url}/releases/missing.apk`, { headers: { cookie } });
    assert.equal(missing.status, 404);

    const logs = fixture.store.db
      .prepare("SELECT source, operation, status, reason, json_data FROM logs WHERE source IN ('auth', 'release') ORDER BY id ASC")
      .all()
      .map((row) => ({ ...row, json_data: JSON.parse(row.json_data) }));
    assert.equal(logs.some((log) => log.operation === 'auth.denied' && log.reason === 'release_session_required'), true);
    assert.equal(logs.some((log) => log.operation === 'release.login' && log.status === 'done'), true);
    assert.equal(logs.some((log) => log.operation === 'release.file_served' && log.status === 'done' && log.json_data.extension === 'apk'), true);
    assert.equal(logs.some((log) => log.operation === 'release.file_served' && log.status === 'failed' && log.reason === 'not_found'), true);
    assert.equal(JSON.stringify(logs).includes(RELEASE_PASSWORD), false);
  } finally {
    await fixture.close();
  }
});
