import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, RELEASE_PASSWORD, request, SESSION_SECRET, textRequest, WEB_PASSWORD } from '../test-support/api.js';

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
      download_url: '/releases/download/production',
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
      download_url: '/releases/download/production',
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
            file: 'brai-v2.apk',
            apkVersion: 2,
            versionCode: 2,
            releaseKey: 'production',
            apkBuildKind: 'stable',
            publishedAt: '2026-07-01T20:23:42Z'
          },
          a: {
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
    },
    mobileFiles: {
      'manifest.json': JSON.stringify({
        schemaVersion: 2,
        otaVersion: '0.0.41',
        targetApkReleaseKey: 'a'
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
      download_url: '/releases/download/a',
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

test('public releases show Production while developer releases require their own session', async () => {
  const fixture = await createFixture([
    '2026-06-29T12:10:00.000Z',
    '2026-06-29T12:10:01.000Z',
    '2026-06-29T12:10:02.000Z',
    '2026-06-29T12:10:03.000Z'
  ], {
    webPassword: WEB_PASSWORD,
    releasePassword: 'air',
    sessionSecret: SESSION_SECRET,
    releaseFiles: {
      'brai.apk': 'fake-apk',
      'brai-dev.apk': 'fake-dev-apk',
      'index.html': 'stale release page',
      'releases.json': JSON.stringify({
        sections: {
          production: {
            title: 'Brai',
            file: 'brai.apk',
            apkVersion: 7,
            apkBuildKind: 'stable',
            publishedAt: '2026-06-29T12:00:00.000Z',
            sizeBytes: 10 * 1024 * 1024
          },
          dev: {
            title: 'Brai Dev',
            file: 'brai-dev.apk',
            apkVersion: 7,
            releaseKey: 'dev',
            apkBuildKind: 'stable',
            publishedAt: '2026-06-29T12:00:00.000Z'
          }
        }
      })
    }
  });

  try {
    const appLogin = await textRequest(fixture.url, '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: WEB_PASSWORD }),
      redirect: 'manual'
    });
    const appCookie = appLogin.headers.get('set-cookie');
    assert.match(appCookie, /brai_session=/);

    const publicPage = await fetch(`${fixture.url}/releases/`);
    assert.equal(publicPage.status, 200);
    const publicHtml = await publicPage.text();
    assert.match(publicHtml, /<h2>Brai<\/h2>/);
    assert.doesNotMatch(publicHtml, /Brai Dev/);
    assert.match(publicHtml, /href="\/releases\/download\/production"/);

    const appSessionRelease = await fetch(`${fixture.url}/dev-releases/brai.apk`, {
      headers: { cookie: appCookie },
      redirect: 'manual'
    });
    assert.equal(appSessionRelease.status, 303);

    const legacyLogin = await textRequest(fixture.url, '/releases/login', { redirect: 'manual' });
    assert.equal(legacyLogin.status, 303);
    assert.equal(legacyLogin.headers.get('location'), '/dev-releases/');

    const wrongReleaseLogin = await textRequest(fixture.url, '/dev-releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(WEB_PASSWORD)}`,
      redirect: 'manual'
    });
    assert.equal(wrongReleaseLogin.status, 401);

    const releaseLogin = await textRequest(fixture.url, '/dev-releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=air',
      redirect: 'manual'
    });
    assert.equal(releaseLogin.status, 303);
    assert.equal(releaseLogin.headers.get('location'), '/dev-releases/');
    const releaseCookie = releaseLogin.headers.get('set-cookie');
    assert.match(releaseCookie, /brai_release_session=/);

    const apk = await fetch(`${fixture.url}/dev-releases/brai.apk`, { headers: { cookie: releaseCookie } });
    assert.equal(apk.status, 200);
    assert.equal(apk.headers.get('content-length'), String(Buffer.byteLength('fake-apk')));
    assert.equal(await apk.text(), 'fake-apk');

    const releasePage = await fetch(`${fixture.url}/dev-releases/`, { headers: { cookie: releaseCookie } });
    assert.equal(releasePage.status, 200);
    const developerHtml = await releasePage.text();
    assert.match(developerHtml, /<p class="version">v7<\/p><span class="size">10 МБ<\/span>/);
    assert.match(developerHtml, /Brai Dev/);
  } finally {
    await fixture.close();
  }
});

test('release downloads are keyed, filtered, attachment responses with one hourly IP limit', async () => {
  const fixture = await createFixture([
    '2026-06-29T12:10:00.000Z',
    '2026-06-29T12:10:01.000Z',
    '2026-06-29T12:10:02.000Z'
  ], {
    releasePassword: RELEASE_PASSWORD,
    sessionSecret: SESSION_SECRET,
    releaseFiles: {
      'brai.apk': 'fake-apk',
      'brai-b.apk': 'fake-preview-b',
      'releases.json': JSON.stringify({
        sections: {
          production: { title: 'Brai', file: 'brai.apk', releaseKey: 'production', apkVersion: 7 },
          b: { title: 'Brai B', file: 'brai-b.apk', releaseKey: 'b', apkVersion: 7 }
        }
      })
    }
  });

  try {
    const unauthorized = await fetch(`${fixture.url}/dev-releases/brai.apk`, { redirect: 'manual' });
    assert.equal(unauthorized.status, 303);

    const login = await textRequest(fixture.url, '/dev-releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(RELEASE_PASSWORD)}`,
      redirect: 'manual'
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /brai_release_session=/);

    const apk = await fetch(`${fixture.url}/releases/download/b`, {
      headers: { 'x-forwarded-for': '198.51.100.20' }
    });
    assert.equal(apk.status, 200);
    assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(apk.headers.get('content-length'), String(Buffer.byteLength('fake-preview-b')));
    assert.equal(apk.headers.get('content-disposition'), 'attachment; filename="brai-b.apk"');
    assert.equal(await apk.text(), 'fake-preview-b');

    const legacyProduction = await fetch(`${fixture.url}/releases/brai.apk`);
    assert.equal(legacyProduction.status, 200);
    assert.equal(await legacyProduction.text(), 'fake-apk');
    const hiddenLegacy = await fetch(`${fixture.url}/releases/brai-b.apk`);
    assert.equal(hiddenLegacy.status, 404);
    const missing = await fetch(`${fixture.url}/releases/download/unknown`);
    assert.equal(missing.status, 404);

    for (let download = 2; download <= 10; download += 1) {
      const response = await fetch(`${fixture.url}/releases/download/b`, {
        headers: { 'x-forwarded-for': '198.51.100.20' }
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const limited = await fetch(`${fixture.url}/releases/download/b`, {
      headers: { 'x-forwarded-for': '198.51.100.20' }
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);

    const logs = fixture.store.db
      .prepare("SELECT source, operation, status, reason, json_data FROM logs WHERE source IN ('auth', 'release') ORDER BY id ASC")
      .all()
      .map((row) => ({ ...row, json_data: JSON.parse(row.json_data) }));
    assert.equal(logs.some((log) => log.operation === 'auth.denied' && log.reason === 'release_session_required'), true);
    assert.equal(logs.some((log) => log.operation === 'release.login' && log.status === 'done'), true);
    assert.equal(logs.some((log) => log.operation === 'release.file_served' && log.status === 'done' && log.json_data.release_key === 'b'), true);
    assert.equal(logs.some((log) => log.operation === 'release.file_served' && log.status === 'failed' && log.reason === 'not_found'), true);
    assert.equal(logs.some((log) => log.operation === 'release.file_served' && log.status === 'failed' && log.reason === 'rate_limited' && log.json_data.outcome === 'rate_limited'), true);
    assert.equal(JSON.stringify(logs).includes(RELEASE_PASSWORD), false);
  } finally {
    await fixture.close();
  }
});
