import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, request } from '../test-support/api.js';

test('version endpoint returns build ledger, APK line, and release-index OTA target', async () => {
  const fixture = await createFixture(['2026-06-29T12:00:00.000Z'], {
    releaseFiles: {
      'releases.json': JSON.stringify({
        schemaVersion: 2,
        sections: {
          production: {
            file: 'brai-v1.apk',
            apkVersion: 1,
            versionCode: 1,
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
        targetApkVersion: 1
      })
    }
  });

  try {
    const response = await request(fixture.url, '/v1/version');

    assert.equal(response.status, 200);
    assert.equal(response.body.version, '0.0.41');
    assert.equal(response.body.ota_version, '0.0.41');
    assert.deepEqual(response.body.parts, { canon: 0, release: 0, build: 1, apk: 1 });
    assert.equal(response.body.latest.canon, null);
    assert.equal(response.body.latest.release, null);
    assert.equal(response.body.latest.build.version, 1);
    assert.equal(response.body.latest.apk.version, 1);
    assert.deepEqual(response.body.target_apk, {
      file: 'brai-v1.apk',
      version: 1,
      version_code: 1,
      release_key: 'production',
      apk_build_kind: 'stable',
      preview_iteration: null,
      release_url: '/releases/',
      published_at: '2026-06-30T20:23:42Z',
      capabilities: ['AccessibilityService', 'Overlay', 'Microphone', 'MediaProjection']
    });
    assert.deepEqual(response.body.apk_release, {
      file: 'brai-v1.apk',
      version: 1,
      version_code: 1,
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
            file: 'brai-v2-preview7.apk',
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
      file: 'brai-v2-preview7.apk',
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
