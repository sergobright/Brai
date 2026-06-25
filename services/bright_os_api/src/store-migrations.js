import {
  CHALLENGE_DAYS,
  CHALLENGE_START_DATE,
  DAILY_GOAL_SECONDS
} from './time.js';

export const migrationMethods = {
  migrate() {
    this.ensureBaseSchema();
    this.ensureSettings();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL,
        description TEXT NOT NULL
      );
    `);

    if (!this.hasMigration(1)) {
      this.recordMigration(1, 'base timer sessions and settings schema');
    }

    this.ensureEventSchema();
    if (!this.hasMigration(2)) {
      this.seedLegacyEvents();
      this.recomputeCanonicalSessions(new Date().toISOString());
      this.recordMigration(2, 'offline-first timer event log and canonical sessions');
    }

    if (this.hasMigration(3) && !this.hasMigration(4)) {
      this.renameActionsToActivities();
    }

    this.ensureActivitySchema();
    if (!this.hasMigration(3)) {
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(3, 'offline-first activities event log and canonical activities');
    }

    if (!this.hasMigration(4)) {
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(4, 'rename actions to activities and seed item registry');
    }

    if (!this.hasMigration(5)) {
      this.allowActivityDeleteEvents();
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(5, 'allow activity delete events');
    }

    if (!this.hasMigration(6)) {
      this.addActivityDescriptions();
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(6, 'add activity markdown descriptions');
    }

    if (!this.hasMigration(7)) {
      this.addActivityManualSort();
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(7, 'add manual activity ordering');
    }

    if (!this.hasMigration(8)) {
      this.addActivityArchiveFields();
      this.recomputeActivities(new Date().toISOString());
      this.recordMigration(8, 'archive deleted activities');
    }

    this.ensureVersionSchema();
    if (!this.hasMigration(9)) {
      this.seedInitialBuildVersion();
      this.recordMigration(9, 'add unified build version ledger');
    }

    this.ensureDeploymentSchema();
    if (!this.hasMigration(10)) {
      this.recordMigration(10, 'add environment deployment ledger');
    }

    if (!this.hasMigration(11)) {
      this.seedPublicVersionRulesBuildVersion();
      this.recordMigration(11, 'record public version rules task');
    }

    if (!this.hasMigration(12)) {
      this.seedCleanTaskFinishBuildVersion();
      this.recordMigration(12, 'record clean task finish rules task');
    }

    if (!this.hasMigration(13)) {
      this.seedPreviewCleanupBuildVersion();
      this.recordMigration(13, 'record preview cleanup workflow task');
    }

    if (!this.hasMigration(14)) {
      this.seedEnvironmentFaviconBuildVersion();
      this.recordMigration(14, 'record environment favicon task');
    }

    if (!this.hasMigration(15)) {
      this.seedPreviewVersionSemanticsBuildVersion();
      this.recordMigration(15, 'record preview version semantics task');
    }

    if (!this.hasMigration(16)) {
      this.seedProductionAndroidOtaApiBuildVersion();
      this.recordMigration(16, 'record production Android OTA API endpoint fix');
    }

    if (!this.hasMigration(17)) {
      this.seedSplitLeftMenuBuildVersion();
      this.recordMigration(17, 'record split left menu task');
    }

    if (!this.hasMigration(18)) {
      this.seedGithubCliSandboxAuthBuildVersion();
      this.recordMigration(18, 'record GitHub CLI sandbox auth guidance');
    }

    if (!this.hasMigration(19)) {
      this.realignBuildVersionLedger();
      this.recordMigration(19, 'realign build version ledger with pull request number');
    }

    if (!this.hasMigration(20)) {
      this.seedAcceptedPrLedgerBackfill();
      this.recordMigration(20, 'record accepted PR 9 and 10 build versions');
    }

    if (!this.hasMigration(21)) {
      this.seedAcceptedPr11LedgerBackfill();
      this.recordMigration(21, 'record accepted PR 11 build version');
    }
  }
,

  ensureBaseSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timer_sessions (
        id TEXT PRIMARY KEY,
        started_at_utc TEXT NOT NULL,
        ended_at_utc TEXT,
        duration_seconds INTEGER,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_timer_sessions_one_active
      ON timer_sessions ((ended_at_utc IS NULL))
      WHERE ended_at_utc IS NULL;

      CREATE INDEX IF NOT EXISTS idx_timer_sessions_started
      ON timer_sessions (started_at_utc);

      CREATE INDEX IF NOT EXISTS idx_timer_sessions_ended
      ON timer_sessions (ended_at_utc);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);
  }
,

  ensureSettings() {
    const insertSetting = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at_utc)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `);
    const now = new Date().toISOString();
    insertSetting.run('goal_start_date', CHALLENGE_START_DATE, now);
    insertSetting.run('goal_days', String(CHALLENGE_DAYS), now);
    insertSetting.run('daily_goal_seconds', String(DAILY_GOAL_SECONDS), now);
    insertSetting.run('goal_timezone', 'Europe/Moscow', now);
  }
,

  ensureEventSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS timer_devices (
        device_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        display_name TEXT,
        created_at_utc TEXT NOT NULL,
        last_seen_at_utc TEXT NOT NULL,
        last_sync_at_utc TEXT,
        last_server_clock_offset_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS timer_events (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        local_timer_id TEXT,
        base_server_revision INTEGER,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        metadata_json TEXT,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_timer_events_device_sequence
      ON timer_events (device_id, client_sequence);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_timer_events_server_sequence
      ON timer_events (server_sequence);

      CREATE INDEX IF NOT EXISTS idx_timer_events_occurred
      ON timer_events (occurred_at_utc);

      CREATE INDEX IF NOT EXISTS idx_timer_events_device_occurred
      ON timer_events (device_id, occurred_at_utc);

      CREATE INDEX IF NOT EXISTS idx_timer_events_received
      ON timer_events (received_at_utc);

      CREATE TABLE IF NOT EXISTS timer_session_sources (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id, role),
        FOREIGN KEY (session_id) REFERENCES timer_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (event_id) REFERENCES timer_events(event_id)
      );
    `);
  }
,

  ensureActivitySchema() {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('New', 'Done')),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        completed_at_utc TEXT,
        sort_order INTEGER,
        deleted_at_utc TEXT,
        restored_at_utc TEXT,
        last_event_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_activities_status_created
      ON activities (status, created_at_utc);

      CREATE INDEX IF NOT EXISTS idx_activities_updated
      ON activities (updated_at_utc);

      CREATE TABLE IF NOT EXISTS activity_events (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        activity_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'restore', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_device_sequence
      ON activity_events (device_id, client_sequence);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_server_sequence
      ON activity_events (server_sequence);

      CREATE INDEX IF NOT EXISTS idx_activity_events_occurred
      ON activity_events (occurred_at_utc);

      CREATE INDEX IF NOT EXISTS idx_activity_events_device_occurred
      ON activity_events (device_id, occurred_at_utc);
    `);
    this.db
      .prepare('INSERT INTO items (id, created_at_utc) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run('activities', now);

    if (this.tableExists('activities') && !this.columnExists('activities', 'description_md')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN description_md TEXT NOT NULL DEFAULT '';");
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'sort_order')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN sort_order INTEGER;');
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'deleted_at_utc')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN deleted_at_utc TEXT;');
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'restored_at_utc')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN restored_at_utc TEXT;');
    }
  }
,

  renameActionsToActivities() {
    if (this.tableExists('actions') && !this.tableExists('activities')) {
      this.db.exec('ALTER TABLE actions RENAME TO activities;');
    }

    if (this.tableExists('action_events') && !this.tableExists('activity_events')) {
      this.db.exec('ALTER TABLE action_events RENAME TO activity_events;');
    }

    if (
      this.tableExists('activity_events') &&
      this.columnExists('activity_events', 'action_id') &&
      !this.columnExists('activity_events', 'activity_id')
    ) {
      this.db.exec('ALTER TABLE activity_events RENAME COLUMN action_id TO activity_id;');
    }

    this.db.exec(`
      DROP INDEX IF EXISTS idx_actions_status_created;
      DROP INDEX IF EXISTS idx_actions_updated;
      DROP INDEX IF EXISTS idx_action_events_device_sequence;
      DROP INDEX IF EXISTS idx_action_events_server_sequence;
      DROP INDEX IF EXISTS idx_action_events_occurred;
      DROP INDEX IF EXISTS idx_action_events_device_occurred;
    `);
  }
,

  allowActivityDeleteEvents() {
    if (!this.tableExists('activity_events')) return;
    this.db.exec(`
      CREATE TABLE activity_events_next (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        activity_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      INSERT INTO activity_events_next (
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      FROM activity_events;

      DROP TABLE activity_events;
      ALTER TABLE activity_events_next RENAME TO activity_events;
    `);
    this.ensureActivitySchema();
  }
,

  addActivityDescriptions() {
    if (this.tableExists('activities') && !this.columnExists('activities', 'description_md')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN description_md TEXT NOT NULL DEFAULT '';");
    }

    if (!this.tableExists('activity_events')) return;
    this.db.exec(`
      CREATE TABLE activity_events_next (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        activity_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      INSERT INTO activity_events_next (
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      FROM activity_events;

      DROP TABLE activity_events;
      ALTER TABLE activity_events_next RENAME TO activity_events;
    `);
    this.ensureActivitySchema();
  }
,

  addActivityManualSort() {
    if (this.tableExists('activities') && !this.columnExists('activities', 'sort_order')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN sort_order INTEGER;');
    }

    if (!this.tableExists('activity_events')) return;
    this.db.exec(`
      CREATE TABLE activity_events_next (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        activity_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      INSERT INTO activity_events_next (
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      FROM activity_events;

      DROP TABLE activity_events;
      ALTER TABLE activity_events_next RENAME TO activity_events;
    `);
    this.ensureActivitySchema();
  }
,

  addActivityArchiveFields() {
    if (this.tableExists('activities') && !this.columnExists('activities', 'deleted_at_utc')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN deleted_at_utc TEXT;');
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'restored_at_utc')) {
      this.db.exec('ALTER TABLE activities ADD COLUMN restored_at_utc TEXT;');
    }

    if (!this.tableExists('activity_events')) return;
    this.db.exec(`
      CREATE TABLE activity_events_next (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        activity_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'restore', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      INSERT INTO activity_events_next (
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      FROM activity_events;

      DROP TABLE activity_events;
      ALTER TABLE activity_events_next RENAME TO activity_events;
    `);
    this.ensureActivitySchema();
  }
,

  ensureVersionSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS version_types (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS build_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_type_id TEXT NOT NULL,
        major_version INTEGER NOT NULL CHECK (major_version >= 0),
        release_version INTEGER NOT NULL CHECK (release_version >= 0),
        build_version INTEGER NOT NULL CHECK (build_version >= 0),
        apk_version INTEGER NOT NULL CHECK (apk_version >= 0),
        version TEXT NOT NULL,
        short_changes TEXT NOT NULL,
        detailed_changes TEXT NOT NULL,
        reason TEXT NOT NULL,
        released_at_utc TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY (version_type_id) REFERENCES version_types(id),
        UNIQUE (version_type_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_build_versions_type_released
      ON build_versions (version_type_id, released_at_utc);
    `);

    const now = new Date().toISOString();
    const insertType = this.db.prepare(`
      INSERT INTO version_types (id, title, description, created_at_utc)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    insertType.run(
      'build',
      'Сборочная версия',
      'Обычный релиз Bright OS: увеличивает только Z в версии X.Y.Z.S.',
      now
    );
    insertType.run(
      'apk',
      'APK версия',
      'APK релиз Bright OS: увеличивает только S в версии X.Y.Z.S.',
      now
    );
  }
,

  seedInitialBuildVersion() {
    const now = new Date().toISOString();
    const buildReleasedAt = '2026-06-23T09:12:45Z';
    const apkReleasedAt = '2026-06-23T09:13:50Z';
    const insertVersion = this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `);
    insertVersion.run(
      'build',
      0,
      0,
      1,
      1,
      '0.0.1.1',
      'Initial public web/OTA baseline.',
      'Published browser web and Android OTA bundle 0.0.1.1 with X=0, Y=0, Z=1, S=1 and min APK versionCode 1. Browser web and Android OTA use the same public version.',
      'Initial public baseline.',
      buildReleasedAt,
      now
    );
    insertVersion.run(
      'apk',
      0,
      0,
      1,
      1,
      '0.0.1.1',
      'Initial public APK baseline.',
      'APK uses public version 0.0.1.1 with S=1 and Android versionCode 1. Release signing material is supplied outside the repository.',
      'Initial public baseline.',
      apkReleasedAt,
      now
    );
  }
,

  seedPublicVersionRulesBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      2,
      1,
      '0.0.2.1',
      'Accepted public version baseline rules.',
      'Recorded the first accepted public task: task merges into dev increment Z, dev promotions to main increment Y, and APK releases increment S. Browser web and Android OTA use version 0.0.2.1 with Android versionCode 1.',
      'Accepted first public task into dev.',
      '2026-06-24T13:45:00Z',
      now
    );
  }
,

  seedCleanTaskFinishBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      3,
      1,
      '0.0.3.1',
      'Accepted clean task finish rules.',
      'Recorded the second accepted public task: implementation work must finish with committed and pushed tracked changes unless explicitly local-only, and codex task branches deploy to isolated preview slots before dev acceptance.',
      'Accepted clean task finish workflow into dev.',
      '2026-06-24T14:05:00Z',
      now
    );
  }
,

  seedPreviewCleanupBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      4,
      1,
      '0.0.4.1',
      'Accepted idempotent preview cleanup.',
      'Recorded the third accepted public task: preview metadata promotion skips cleanly when the preview slot has already been released by a delete event.',
      'Accepted preview cleanup workflow into dev.',
      '2026-06-24T14:25:00Z',
      now
    );
  }
,

  seedEnvironmentFaviconBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      5,
      1,
      '0.0.5.1',
      'Accepted environment-specific favicons.',
      'Recorded the fourth accepted public task: dev and preview web/PWA builds use environment-specific favicon and manifest icon assets while production keeps the canonical Bright OS icons.',
      'Accepted dev and preview favicon separation into dev.',
      '2026-06-24T14:40:00Z',
      now
    );
  }
,

  seedPreviewVersionSemanticsBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      6,
      1,
      '0.0.6.1',
      'Accepted preview version semantics.',
      'Recorded the fifth accepted public task: preview deployments keep the current accepted dev app version and record preview deployment metadata, while the next public build version becomes visible only after deploy-dev succeeds.',
      'Accepted preview/dev version separation into dev.',
      '2026-06-24T15:10:00Z',
      now
    );
  }
,

  seedProductionAndroidOtaApiBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      7,
      1,
      '0.0.7.1',
      'Accepted production Android OTA API endpoint fix.',
      'Recorded the sixth accepted public task: production Android web/OTA bundles use the public API endpoint while browser web keeps same-origin /api, and OTA manifests are prepared for cache-safe publication.',
      'Accepted production Android OTA API endpoint fix into dev.',
      '2026-06-24T18:20:00Z',
      now
    );
  }
,

  seedSplitLeftMenuBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      8,
      1,
      '0.0.8.1',
      'Accepted split left menu by page.',
      'Recorded the seventh accepted public task: desktop rail navigation no longer duplicates the dock and instead shows page-specific menu actions with regression coverage.',
      'Accepted split left menu by page into dev.',
      '2026-06-24T21:10:59Z',
      now
    );
  }
,

  seedGithubCliSandboxAuthBuildVersion() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `).run(
      'build',
      0,
      0,
      9,
      1,
      '0.0.9.1',
      'Accepted GitHub CLI sandbox auth guidance.',
      'Recorded the eighth accepted public task: Codex agents must recheck GitHub CLI authentication outside the sandbox before treating gh token errors as real authentication failures.',
      'Accepted GitHub CLI sandbox auth guidance into dev.',
      '2026-06-24T21:17:09Z',
      now
    );
  }
,

  realignBuildVersionLedger() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO UPDATE SET
          short_changes = excluded.short_changes,
          detailed_changes = excluded.detailed_changes,
          reason = excluded.reason,
          released_at_utc = excluded.released_at_utc
      `).run(
      'build',
      0,
      0,
      8,
      1,
      '0.0.8.1',
      'Aligned dev build ledger with PR numbering.',
      'Recorded the eighth accepted public task: dev build Z now matches the accepted GitHub PR number, the build ledger has exactly Z build rows, and the current dev source keeps the accepted menu and GitHub CLI sandbox-auth fixes.',
      'Accepted PR/version ledger alignment into dev.',
      '2026-06-24T21:40:47Z',
      now
    );

    this.db
      .prepare("DELETE FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.9.1'")
      .run();
  }
,

  seedAcceptedPrLedgerBackfill() {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO UPDATE SET
          short_changes = excluded.short_changes,
          detailed_changes = excluded.detailed_changes,
          reason = excluded.reason,
          released_at_utc = excluded.released_at_utc
      `);
    insert.run(
      'build',
      0,
      0,
      9,
      1,
      '0.0.9.1',
      'Accepted PR #9 into dev.',
      'Recorded accepted PR #9: mobile edge menu swipe, bottom-dock-only page swipes, and 80 percent left menu width.',
      'Accepted PR #9 into dev.',
      '2026-06-24T22:52:31.873Z',
      now
    );
    insert.run(
      'build',
      0,
      0,
      10,
      1,
      '0.0.10.1',
      'Accepted PR #10 into dev.',
      'Recorded accepted PR #10: preview slot release now uses a deploy-readable checkout, full preview pools queue FIFO, and acceptance release frees the slot automatically.',
      'Accepted PR #10 into dev.',
      '2026-06-24T23:10:19.023Z',
      now
    );
  }
,

  seedAcceptedPr11LedgerBackfill() {
    const now = new Date().toISOString();
    this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          major_version,
          release_version,
          build_version,
          apk_version,
          version,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO UPDATE SET
          short_changes = excluded.short_changes,
          detailed_changes = excluded.detailed_changes,
          reason = excluded.reason,
          released_at_utc = excluded.released_at_utc
      `).run(
      'build',
      0,
      0,
      11,
      1,
      '0.0.11.1',
      'Accepted PR #11 into dev.',
      'Recorded accepted PR #11: build ledger acceptance flow records PR-matched dev build versions idempotently before future dev deployments.',
      'Accepted PR #11 into dev.',
      '2026-06-25T00:08:24Z',
      now
    );
  }
,

  ensureDeploymentSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        environment TEXT NOT NULL,
        slot TEXT,
        branch TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        domain TEXT NOT NULL,
        web_ota_version TEXT,
        apk_version TEXT,
        short_changes TEXT NOT NULL,
        detailed_changes TEXT NOT NULL,
        reason TEXT NOT NULL,
        deployed_at_utc TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deployment_records_env_deployed
      ON deployment_records (environment, deployed_at_utc);

      CREATE INDEX IF NOT EXISTS idx_deployment_records_branch_deployed
      ON deployment_records (branch, deployed_at_utc);
    `);
  }
,

  tableExists(name) {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
    );
  }
,

  columnExists(table, column) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  }
,

  hasMigration(version) {
    const row = this.db
      .prepare('SELECT 1 AS found FROM schema_migrations WHERE version = ?')
      .get(version);
    return Boolean(row);
  }
,

  recordMigration(version, description) {
    this.db
      .prepare(`
        INSERT INTO schema_migrations (version, applied_at_utc, description)
        VALUES (?, ?, ?)
        ON CONFLICT(version) DO NOTHING
      `)
      .run(version, new Date().toISOString(), description);
  }

};
