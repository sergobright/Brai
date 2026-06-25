import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrightOsServer } from '../src/server.js';
import {
  RELEASE_PASSWORD,
  SESSION_SECRET,
  TOKEN,
  WEB_PASSWORD,
  createFixture,
  jsonRequest,
  request,
  seedActionsDatabase,
  seedLegacyDatabase,
  textRequest
} from '../test-support/api.js';

test('migration seeds legacy sessions and survives close and reopen', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-os-api-migrate-'));
  const dbPath = path.join(tmp, 'bright_os.sqlite');
  seedLegacyDatabase(dbPath);
  let index = 0;
  const times = ['2026-06-14T12:00:00.000Z', '2026-06-14T12:00:01.000Z'];
  let runtime = createBrightOsServer({
    dbPath,
    token: TOKEN,
    now: () => new Date(times[Math.min(index++, times.length - 1)]),
    logger: { error: () => {} }
  });

  try {
    await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    let address = runtime.server.address();
    let baseUrl = `http://127.0.0.1:${address.port}`;

    let history = await request(baseUrl, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    assert.equal(history.body.sessions[0].duration_seconds, 3600);
    let state = await request(baseUrl, '/v1/timer/state');
    assert.ok(state.body.active_session);
    assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM timer_events').get().count, 3);

    await runtime.close();
    runtime = createBrightOsServer({
      dbPath,
      token: TOKEN,
      now: () => new Date('2026-06-14T12:00:02.000Z'),
      logger: { error: () => {} }
    });
    await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    address = runtime.server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    history = await request(baseUrl, '/v1/sessions');
    assert.equal(history.body.sessions.length, 1);
    state = await request(baseUrl, '/v1/timer/state');
    assert.ok(state.body.active_session);
    assert.equal(state.body.server_revision, 3);
  } finally {
    await runtime.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration renames actions tables to activities and seeds items', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bright-os-api-actions-migrate-'));
  const dbPath = path.join(tmp, 'bright_os.sqlite');
  seedActionsDatabase(dbPath);
  const runtime = createBrightOsServer({
    dbPath,
    token: TOKEN,
    now: () => new Date('2026-06-17T12:00:00.000Z'),
    logger: { error: () => {} }
  });

  try {
    await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const address = runtime.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const state = await request(baseUrl, '/v1/activities');
    assert.equal(state.body.activities.length, 1);
    assert.equal(state.body.activities[0].title, 'Фокус');
    assert.equal(state.body.activities[0].description_md, '');

    const tables = runtime.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
    assert.ok(tables.includes('activities'));
    assert.ok(tables.includes('activity_events'));
    assert.ok(!tables.includes('actions'));
    assert.ok(!tables.includes('action_events'));
    assert.equal(runtime.store.db.prepare('SELECT id FROM items').get().id, 'activities');
    const activityColumns = runtime.store.db.prepare("PRAGMA table_info(activities)").all().map((row) => row.name);
    assert.ok(activityColumns.includes('description_md'));
    assert.ok(activityColumns.includes('deleted_at_utc'));
    assert.ok(activityColumns.includes('restored_at_utc'));
    assert.equal(
      runtime.store.db.prepare('SELECT activity_id FROM activity_events WHERE event_id = ?').get('create').activity_id,
      'action-1'
    );
  } finally {
    await runtime.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration seeds unified build version ledger', async () => {
  const fixture = await createFixture(['2026-06-22T00:00:00.000Z']);

  try {
    const versionTypes = fixture.store.db
      .prepare('SELECT id FROM version_types ORDER BY id')
      .all()
      .map((row) => row.id);
    assert.deepEqual(versionTypes, ['apk', 'build']);

    const versions = fixture.store.db
      .prepare('SELECT * FROM build_versions ORDER BY version_type_id, version')
      .all();
    assert.equal(versions.length, 12);

    const buildVersions = versions
      .filter((version) => version.version_type_id === 'build')
      .sort((left, right) => left.build_version - right.build_version);
    assert.equal(buildVersions.length, 11);
    assert.deepEqual(
      buildVersions.map((version) => version.build_version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    );
    assert.equal(buildVersions.at(-1).build_version, buildVersions.length);
    assert.equal(buildVersions.at(-1).version, '0.0.11.1');

    const baselineApk = versions.find((version) => version.version_type_id === 'apk' && version.version === '0.0.1.1');
    assert.ok(baselineApk);
    assert.equal(baselineApk.major_version, 0);
    assert.equal(baselineApk.release_version, 0);
    assert.equal(baselineApk.build_version, 1);
    assert.equal(baselineApk.apk_version, 1);
    assert.equal(baselineApk.released_at_utc, '2026-06-23T09:13:50Z');
    assert.match(baselineApk.short_changes, /APK/);
    assert.match(baselineApk.detailed_changes, /versionCode 1/);
    assert.match(baselineApk.detailed_changes, /Release signing material/);
    assert.equal(baselineApk.reason, 'Initial public baseline.');

    const baselineBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.1.1');
    assert.ok(baselineBuild);
    assert.equal(baselineBuild.major_version, 0);
    assert.equal(baselineBuild.release_version, 0);
    assert.equal(baselineBuild.build_version, 1);
    assert.equal(baselineBuild.apk_version, 1);
    assert.equal(baselineBuild.released_at_utc, '2026-06-23T09:12:45Z');
    assert.match(baselineBuild.short_changes, /web\/OTA/);
    assert.match(baselineBuild.detailed_changes, /min APK versionCode 1/);
    assert.equal(baselineBuild.reason, 'Initial public baseline.');

    const firstTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.2.1');
    assert.ok(firstTaskBuild);
    assert.equal(firstTaskBuild.major_version, 0);
    assert.equal(firstTaskBuild.release_version, 0);
    assert.equal(firstTaskBuild.build_version, 2);
    assert.equal(firstTaskBuild.apk_version, 1);
    assert.equal(firstTaskBuild.released_at_utc, '2026-06-24T13:45:00Z');
    assert.match(firstTaskBuild.detailed_changes, /dev promotions to main increment Y/);
    assert.equal(firstTaskBuild.reason, 'Accepted first public task into dev.');

    const secondTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.3.1');
    assert.ok(secondTaskBuild);
    assert.equal(secondTaskBuild.major_version, 0);
    assert.equal(secondTaskBuild.release_version, 0);
    assert.equal(secondTaskBuild.build_version, 3);
    assert.equal(secondTaskBuild.apk_version, 1);
    assert.equal(secondTaskBuild.released_at_utc, '2026-06-24T14:05:00Z');
    assert.match(secondTaskBuild.detailed_changes, /codex task branches deploy to isolated preview slots/);
    assert.equal(secondTaskBuild.reason, 'Accepted clean task finish workflow into dev.');

    const thirdTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.4.1');
    assert.ok(thirdTaskBuild);
    assert.equal(thirdTaskBuild.major_version, 0);
    assert.equal(thirdTaskBuild.release_version, 0);
    assert.equal(thirdTaskBuild.build_version, 4);
    assert.equal(thirdTaskBuild.apk_version, 1);
    assert.equal(thirdTaskBuild.released_at_utc, '2026-06-24T14:25:00Z');
    assert.match(thirdTaskBuild.detailed_changes, /preview slot has already been released/);
    assert.equal(thirdTaskBuild.reason, 'Accepted preview cleanup workflow into dev.');

    const fourthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.5.1');
    assert.ok(fourthTaskBuild);
    assert.equal(fourthTaskBuild.major_version, 0);
    assert.equal(fourthTaskBuild.release_version, 0);
    assert.equal(fourthTaskBuild.build_version, 5);
    assert.equal(fourthTaskBuild.apk_version, 1);
    assert.equal(fourthTaskBuild.released_at_utc, '2026-06-24T14:40:00Z');
    assert.match(fourthTaskBuild.detailed_changes, /environment-specific favicon/);
    assert.equal(fourthTaskBuild.reason, 'Accepted dev and preview favicon separation into dev.');

    const fifthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.6.1');
    assert.ok(fifthTaskBuild);
    assert.equal(fifthTaskBuild.major_version, 0);
    assert.equal(fifthTaskBuild.release_version, 0);
    assert.equal(fifthTaskBuild.build_version, 6);
    assert.equal(fifthTaskBuild.apk_version, 1);
    assert.equal(fifthTaskBuild.released_at_utc, '2026-06-24T15:10:00Z');
    assert.match(fifthTaskBuild.detailed_changes, /preview deployments keep the current accepted dev app version/);
    assert.equal(fifthTaskBuild.reason, 'Accepted preview/dev version separation into dev.');

    const sixthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.7.1');
    assert.ok(sixthTaskBuild);
    assert.equal(sixthTaskBuild.major_version, 0);
    assert.equal(sixthTaskBuild.release_version, 0);
    assert.equal(sixthTaskBuild.build_version, 7);
    assert.equal(sixthTaskBuild.apk_version, 1);
    assert.equal(sixthTaskBuild.released_at_utc, '2026-06-24T18:20:00Z');
    assert.match(sixthTaskBuild.detailed_changes, /production Android web\/OTA bundles use the public API endpoint/);
    assert.equal(sixthTaskBuild.reason, 'Accepted production Android OTA API endpoint fix into dev.');

    const eighthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.8.1');
    assert.ok(eighthTaskBuild);
    assert.equal(eighthTaskBuild.major_version, 0);
    assert.equal(eighthTaskBuild.release_version, 0);
    assert.equal(eighthTaskBuild.build_version, 8);
    assert.equal(eighthTaskBuild.apk_version, 1);
    assert.equal(eighthTaskBuild.released_at_utc, '2026-06-24T21:40:47Z');
    assert.match(eighthTaskBuild.detailed_changes, /Z now matches the accepted GitHub PR number/);
    assert.equal(eighthTaskBuild.reason, 'Accepted PR/version ledger alignment into dev.');

    const ninthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.9.1');
    assert.ok(ninthTaskBuild);
    assert.equal(ninthTaskBuild.build_version, 9);
    assert.equal(ninthTaskBuild.reason, 'Accepted PR #9 into dev.');

    const tenthTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.10.1');
    assert.ok(tenthTaskBuild);
    assert.equal(tenthTaskBuild.build_version, 10);
    assert.equal(tenthTaskBuild.reason, 'Accepted PR #10 into dev.');

    const eleventhTaskBuild = versions.find((version) => version.version_type_id === 'build' && version.version === '0.0.11.1');
    assert.ok(eleventhTaskBuild);
    assert.equal(eleventhTaskBuild.build_version, 11);
    assert.equal(eleventhTaskBuild.reason, 'Accepted PR #11 into dev.');

    fixture.store.migrate();
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM build_versions').get().count, 12);

    fixture.store.db
      .prepare("DELETE FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.11.1'")
      .run();
    fixture.store.db.prepare('DELETE FROM schema_migrations WHERE version = 21').run();
    fixture.store.migrate();
    assert.ok(
      fixture.store.db
        .prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.11.1'")
        .get()
    );
  } finally {
    await fixture.close();
  }
});

test('migration adds environment deployment ledger', async () => {
  const fixture = await createFixture(['2026-06-23T12:00:00.000Z']);

  try {
    fixture.store.recordDeployment({
      environment: 'preview-a',
      slot: 'A',
      branch: 'codex/example',
      commit: 'abc123456789',
      domain: 'a.test.brightos.world',
      webOtaVersion: '0.0.1.2.42',
      shortChanges: 'Preview deploy',
      detailedChanges: 'Automated preview deploy.',
      reason: 'Preview accepted',
      deployedAtUtc: '2026-06-23T12:00:00.000Z'
    });

    const records = fixture.store.listDeploymentRecords({ environment: 'preview-a' });
    assert.equal(records.length, 1);
    assert.equal(records[0].slot, 'A');
    assert.equal(records[0].branch, 'codex/example');
    assert.equal(records[0].web_ota_version, '0.0.1.2.42');
  } finally {
    await fixture.close();
  }
});

test('password login creates cookie session for API requests', async () => {
  const fixture = await createFixture(['2026-06-12T06:00:00.000Z'], {
    webPassword: WEB_PASSWORD,
    sessionSecret: SESSION_SECRET
  });

  try {
    const badLogin = await jsonRequest(fixture.url, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong' })
    });
    assert.equal(badLogin.status, 401);

    const login = await jsonRequest(fixture.url, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: WEB_PASSWORD })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /bright_os_session=/);

    const session = await jsonRequest(fixture.url, '/auth/session', {
      headers: { cookie }
    });
    assert.equal(session.body.authenticated, true);

    const state = await jsonRequest(fixture.url, '/v1/timer/state', {
      headers: { cookie }
    });
    assert.equal(state.status, 200);
    assert.equal(state.body.timezone, 'Europe/Moscow');
  } finally {
    await fixture.close();
  }
});

test('webview password login uses credential-compatible CORS and secure cookies', async () => {
  const fixture = await createFixture(['2026-06-12T06:00:00.000Z'], {
    webPassword: WEB_PASSWORD,
    sessionSecret: SESSION_SECRET
  });

  try {
    const preflight = await fetch(`${fixture.url}/auth/session`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://localhost',
        'access-control-request-method': 'GET'
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(preflight.headers.get('vary'), 'Origin');

    const login = await jsonRequest(fixture.url, '/auth/login', {
      method: 'POST',
      headers: {
        origin: 'https://localhost',
        'x-forwarded-proto': 'https'
      },
      body: JSON.stringify({ password: WEB_PASSWORD })
    });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('access-control-allow-origin'), 'https://localhost');
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Secure/);

    const session = await jsonRequest(fixture.url, '/auth/session', {
      headers: {
        origin: 'https://localhost',
        cookie
      }
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(session.body.authenticated, true);
  } finally {
    await fixture.close();
  }
});

test('preview origins are credential-compatible CORS origins', async () => {
  const fixture = await createFixture(['2026-06-23T12:00:00.000Z'], {
    webPassword: WEB_PASSWORD,
    sessionSecret: SESSION_SECRET
  });

  try {
    const response = await fetch(`${fixture.url}/auth/session`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://a.test.brightos.world',
        'access-control-request-method': 'GET'
      }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://a.test.brightos.world');
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  } finally {
    await fixture.close();
  }
});

test('release files require cookie session', async () => {
  const fixture = await createFixture(['2026-06-12T06:00:00.000Z'], {
    webPassword: WEB_PASSWORD,
    releasePassword: RELEASE_PASSWORD,
    sessionSecret: SESSION_SECRET,
    releaseFiles: {
      'index.html': '<h1>Release</h1>',
      'app.apk': 'fake-apk'
    }
  });

  try {
    const unauth = await textRequest(fixture.url, '/releases/');
    assert.equal(unauth.status, 200);
    assert.equal(unauth.headers.get('cache-control'), 'no-store');
    assert.match(unauth.body, /name="password"/);
    assert.match(unauth.body, /Введите пароль релиза/);
    assert.match(unauth.body, /href="data:,"/);
    assert.doesNotMatch(unauth.body, /href="\/favicon\.png"/);
    assert.doesNotMatch(unauth.body, /src="\/icons\/Icon-192\.png"/);

    const unauthDownload = await textRequest(fixture.url, '/releases/app.apk', {
      redirect: 'manual'
    });
    assert.equal(unauthDownload.status, 303);
    assert.equal(unauthDownload.headers.get('location'), '/releases/');

    const badLogin = await textRequest(fixture.url, '/releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(WEB_PASSWORD)}`,
      redirect: 'manual'
    });
    assert.equal(badLogin.status, 401);
    assert.match(badLogin.body, /Неверный пароль/);

    const login = await textRequest(fixture.url, '/releases/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(RELEASE_PASSWORD)}`,
      redirect: 'manual'
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /bright_os_session=/);

    const page = await textRequest(fixture.url, '/releases/', { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.match(page.body, /Release/);

    const apk = await textRequest(fixture.url, '/releases/app.apk', { headers: { cookie } });
    assert.equal(apk.status, 200);
    assert.equal(apk.body, 'fake-apk');
  } finally {
    await fixture.close();
  }
});
