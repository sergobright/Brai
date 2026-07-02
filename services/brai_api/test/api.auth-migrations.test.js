import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createBraiServer } from '../src/server.js';
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-api-migrate-'));
  const dbPath = path.join(tmp, 'brai.sqlite');
  seedLegacyDatabase(dbPath);
  let index = 0;
  const times = ['2026-06-14T12:00:00.000Z', '2026-06-14T12:00:01.000Z'];
  let runtime = createBraiServer({
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
    assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM focus_sessions').get().count, 2);
    assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM focus_session_intervals').get().count, 2);
    assert.equal(
      runtime.store.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'focus_session_versions'")
        .get().count,
      0
    );
    assert.equal(
      runtime.store.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'timer_sessions'")
        .get().count,
      0
    );

    await runtime.close();
    runtime = createBraiServer({
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
    assert.equal(runtime.store.db.prepare('SELECT COUNT(*) AS count FROM focus_session_intervals').get().count, 2);
  } finally {
    await runtime.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration renames actions tables to activities and seeds items', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-api-actions-migrate-'));
  const dbPath = path.join(tmp, 'brai.sqlite');
  seedActionsDatabase(dbPath);
  const runtime = createBraiServer({
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
    assert.ok(activityColumns.includes('activity_type_id'));
    assert.ok(activityColumns.includes('author'));
    assert.ok(activityColumns.includes('reason'));
    assert.ok(activityColumns.includes('deleted_at_utc'));
    assert.ok(activityColumns.includes('restored_at_utc'));
    assert.equal(
      runtime.store.db.prepare('SELECT activity_id FROM activity_events WHERE event_id = ?').get('create').activity_id,
      'action-1'
    );
    assert.equal(
      runtime.store.db.prepare('SELECT change_type FROM activity_events WHERE event_id = ?').get('create').change_type,
      'create'
    );
  } finally {
    await runtime.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('migration adds inbox entity schema and metadata', async () => {
  const fixture = await createFixture(['2026-06-26T12:00:00.000Z']);

  try {
    const columns = new Set(
      fixture.store.db.prepare('PRAGMA table_info(inbox)').all().map((row) => row.name)
    );
    assert.deepEqual(
      [
        'id',
        'title',
        'description_text',
        'source',
        'source_key',
        'response_required',
        'related_inbox_id',
        'record_type_id',
        'item_date',
        'author',
        'preliminary_section',
        'urgency',
        'attachment_links_json',
        'explanation_text',
        'normalization_text',
        'is_normalized',
        'created_at_utc',
        'updated_at_utc',
        'deleted_at_utc',
        'last_event_id'
      ].filter((column) => !columns.has(column)),
      []
    );

    const indexes = fixture.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbox'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('idx_inbox_item_date'));
    assert.ok(indexes.includes('idx_inbox_normalized_updated'));
    assert.ok(indexes.includes('idx_inbox_source_key_created'));
    assert.ok(indexes.includes('idx_inbox_record_type_created'));
    assert.ok(indexes.includes('idx_inbox_related'));

    const items = fixture.store.db
      .prepare("SELECT id FROM items WHERE id IN ('activities', 'inbox') ORDER BY id")
      .all()
      .map((row) => row.id);
    assert.deepEqual(items, ['activities', 'inbox']);
    assert.deepEqual(
      fixture.store.db.prepare('SELECT id FROM activity_types ORDER BY id').all().map((row) => row.id),
      ['action', 'operation']
    );

    const description = fixture.store.db
      .prepare("SELECT title, short_description FROM table_descriptions WHERE table_name = 'inbox'")
      .get();
    assert.equal(description.title, 'Входящие');
    assert.equal(description.short_description, 'Список входящих материалов.');

    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 32').get().description,
      'add inbox work entity schema'
    );
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 33').get().description,
      'add inbox offline event log'
    );
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 34').get().description,
      'add inbox inbound metadata and record types'
    );
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 35').get().description,
      'add handler registry'
    );
    assert.equal(
      fixture.store.db.prepare('SELECT description FROM schema_migrations WHERE version = 41').get().description,
      'add scheduled runtime handlers'
    );
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inbox_events'").get());
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inbox_record_types'").get());
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'handlers'").get());
    assert.ok(fixture.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'handler_schedules'").get());
    assert.deepEqual(
      fixture.store.db.prepare('SELECT id FROM inbox_record_types ORDER BY id').all().map((row) => row.id),
      [1, 2, 3, 4]
    );
    assert.equal(
      fixture.store.db.prepare("SELECT title FROM table_descriptions WHERE table_name = 'inbox_events'").get().title,
      'События входящих'
    );
    assert.equal(
      fixture.store.db.prepare("SELECT title FROM table_descriptions WHERE table_name = 'handlers'").get().title,
      'Обработчики'
    );
    assert.equal(
      fixture.store.db.prepare("SELECT title FROM table_descriptions WHERE table_name = 'handler_schedules'").get().title,
      'Расписания обработчиков'
    );
    const handler = fixture.store.db
      .prepare(`
        SELECT target, kind, trigger_description, conditions_description, llm_provider,
          llm_prompt_template, llm_timeout_ms, source_module
        FROM handlers
        WHERE id = 'inbound.inbox.title_generator'
      `)
      .get();
    assert.equal(handler.target, 'inbox');
    assert.equal(handler.kind, 'inbound_llm_title_generator');
    assert.match(handler.trigger_description, /POST \/v1\//);
    assert.match(handler.conditions_description, /duplicate idempotency_key/);
    assert.equal(handler.llm_provider, 'codex-cli');
    assert.match(handler.llm_prompt_template, /{{text}}/);
    assert.equal(handler.llm_timeout_ms, 3000);
    assert.equal(handler.source_module, 'services/brai_api/src/inbound.js');
    const scheduledHandler = fixture.store.db
      .prepare(`
        SELECT target, kind, status, trigger_description, side_effects_description, llm_provider,
          llm_prompt_template, llm_timeout_ms, source_module
        FROM handlers
        WHERE id = 'maintenance.tasks_md_deduper'
      `)
      .get();
    assert.equal(scheduledHandler.target, 'repository');
    assert.equal(scheduledHandler.kind, 'scheduled_llm_git_pr');
    assert.equal(scheduledHandler.status, 'disabled');
    assert.match(scheduledHandler.trigger_description, /handler_schedules/);
    assert.match(scheduledHandler.side_effects_description, /Legacy side effects/);
    assert.equal(scheduledHandler.llm_provider, 'codex-cli');
    assert.match(scheduledHandler.llm_prompt_template, /{{tasks_md}}/);
    assert.equal(scheduledHandler.llm_timeout_ms, 120000);
    assert.equal(scheduledHandler.source_module, 'services/brai_api/src/scheduler-runner.js');
    const schedule = fixture.store.db
      .prepare(`
        SELECT handler_id, status, next_run_at_utc, interval_seconds
        FROM handler_schedules
        WHERE id = 'maintenance.tasks_md_deduper'
      `)
      .get();
    assert.equal(schedule.handler_id, 'maintenance.tasks_md_deduper');
    assert.equal(schedule.status, 'disabled');
    assert.equal(schedule.next_run_at_utc, null);
    assert.equal(schedule.interval_seconds, null);

    const operations = fixture.store.db
      .prepare("SELECT status, COUNT(*) AS count FROM activities WHERE activity_type_id = 'operation' GROUP BY status ORDER BY status")
      .all();
    assert.deepEqual(operations, [
      { status: 'Done', count: 7 },
      { status: 'New', count: 7 }
    ]);
    const operation = fixture.store.db
      .prepare("SELECT author, reason FROM activities WHERE id = 'operation:agent-task:worktree-owner-nobody'")
      .get();
    assert.equal(operation.author, 'Codex');
    assert.match(operation.reason, /owner nobody/);

    fixture.store.migrate();
    assert.equal(fixture.store.db.prepare("SELECT COUNT(*) AS count FROM items WHERE id = 'inbox'").get().count, 1);
    assert.equal(
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM handlers WHERE id = 'inbound.inbox.title_generator'")
        .get().count,
      1
    );
    assert.equal(
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM handler_schedules WHERE id = 'maintenance.tasks_md_deduper'")
        .get().count,
      1
    );
  } finally {
    await fixture.close();
  }
});

test('migration upgrades legacy inbox table before metadata indexes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brai-api-inbox-migrate-'));
  const dbPath = path.join(tmp, 'brai.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE inbox (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description_text TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      item_date TEXT,
      author TEXT NOT NULL DEFAULT '',
      preliminary_section TEXT NOT NULL DEFAULT '',
      urgency TEXT NOT NULL DEFAULT '',
      attachment_links_json TEXT NOT NULL DEFAULT '[]',
      explanation_text TEXT NOT NULL DEFAULT '',
      normalization_text TEXT NOT NULL DEFAULT '',
      is_normalized INTEGER NOT NULL DEFAULT 0 CHECK (is_normalized IN (0, 1)),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      deleted_at_utc TEXT,
      last_event_id TEXT
    );

    INSERT INTO inbox (
      id,
      title,
      description_text,
      source,
      item_date,
      attachment_links_json,
      explanation_text,
      is_normalized,
      created_at_utc,
      updated_at_utc,
      last_event_id
    )
    VALUES (
      'inbound:inbox:legacy',
      'Legacy inbound',
      '',
      'legacy-source',
      '2026-06-26',
      '[]',
      'legacy explanation',
      0,
      '2026-06-26T12:00:00.000Z',
      '2026-06-26T12:00:00.000Z',
      'inbound:inbox:legacy'
    );
  `);
  db.close();

  const runtime = createBraiServer({
    dbPath,
    token: TOKEN,
    now: () => new Date('2026-06-27T10:30:00.000Z'),
    logger: { error: () => {} }
  });

  try {
    await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
    const columns = new Set(
      runtime.store.db.prepare('PRAGMA table_info(inbox)').all().map((row) => row.name)
    );
    assert.ok(columns.has('source_key'));
    assert.ok(columns.has('response_required'));
    assert.ok(columns.has('related_inbox_id'));
    assert.ok(columns.has('record_type_id'));
    assert.equal(
      runtime.store.db.prepare("SELECT record_type_id FROM inbox WHERE id = 'inbound:inbox:legacy'").get()
        .record_type_id,
      1
    );

    const indexes = runtime.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbox'")
      .all()
      .map((row) => row.name);
    assert.ok(indexes.includes('idx_inbox_source_key_created'));
    assert.ok(indexes.includes('idx_inbox_record_type_created'));
    assert.ok(indexes.includes('idx_inbox_related'));
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
    assert.deepEqual(versionTypes, ['apk', 'build', 'canon', 'release']);

    const versions = fixture.store.db
      .prepare('SELECT * FROM build_versions ORDER BY version_type_id, version')
      .all();
    assert.equal(versions.length, 2);

    const baselineApk = versions.find((version) => version.version_type_id === 'apk' && version.version === 1);
    assert.ok(baselineApk);
    assert.equal(baselineApk.included_in_version_id, null);
    assert.equal(baselineApk.released_at_utc, '2026-06-23T09:13:50Z');
    assert.match(baselineApk.short_changes, /APK/);
    assert.match(baselineApk.detailed_changes, /versionCode 1/);
    assert.match(baselineApk.detailed_changes, /Release signing material/);

    const baselineBuild = versions.find((version) => version.version_type_id === 'build' && version.version === 1);
    assert.ok(baselineBuild);
    assert.equal(baselineBuild.included_in_version_id, null);
    assert.equal(baselineBuild.released_at_utc, '2026-06-23T09:12:45Z');
    assert.match(baselineBuild.short_changes, /web\/OTA/);
    assert.match(baselineBuild.detailed_changes, /versionCode 1/);

    fixture.store.migrate();
    assert.equal(fixture.store.db.prepare('SELECT COUNT(*) AS count FROM build_versions').get().count, 2);
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
    assert.match(cookie, /brai_session=/);

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
    assert.match(cookie, /brai_session=/);

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
