import {
  CHALLENGE_DAYS,
  CHALLENGE_START_DATE,
  DAILY_GOAL_SECONDS
} from './time.js';

export const migrationMethods = {
  migrate() {
    const now = new Date().toISOString();
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
    this.allowTimerEditSessionEvents();
    this.ensureFocusSessionSchema();
    if (!this.hasMigration(2)) {
      this.seedLegacyEvents();
      this.recomputeCanonicalSessions(now);
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
      this.recordMigration(19, 'realign build version ledger sequence');
    }

    if (!this.hasMigration(20)) {
      this.seedAcceptedDevBuildLedgerBackfill();
      this.recordMigration(20, 'record accepted dev build versions 9 and 10');
    }

    if (!this.hasMigration(21)) {
      this.seedAcceptedDevBuild11LedgerBackfill();
      this.recordMigration(21, 'record accepted dev build version 11');
    }

    if (!this.hasMigration(22)) {
      this.removePrVersionCouplingFromBuildLedger();
      this.recordMigration(22, 'remove pull request coupling from version ledger');
    }

    if (!this.hasMigration(23)) {
      this.recordMigration(23, 'add incremental activity projection indexes');
    }

    if (!this.hasMigration(24)) {
      this.ensureFocusSessionSchema();
      this.recomputeCanonicalSessions(now);
      this.dropLegacyTimerSessionTables();
      this.recordMigration(24, 'rename timer sessions to versioned focus sessions');
    }

    this.ensureBuildVersionRefs();
    this.ensureTableDescriptions();

    if (!this.hasMigration(25)) {
      this.repairTechnicalBuildVersionDescriptions();
      this.recordMigration(25, 'repair technical build version descriptions');
    }

    if (!this.hasMigration(26)) {
      this.repairLateTechnicalBuildVersionDescriptions();
      this.recordMigration(26, 'repair late technical build version descriptions');
    }

    if (!this.hasMigration(27)) {
      this.repairBuildVersionReasonText();
      this.backfillBuildVersionRefs();
      this.recordMigration(27, 'separate build version audit refs from reasons');
    }

    if (!this.hasMigration(28)) {
      this.repairAcceptedAuditMetadataBuildVersionDescription();
      this.recordMigration(28, 'repair accepted audit metadata build description');
    }

    if (!this.hasMigration(29)) {
      this.repairGenericAcceptedBuildNotesDescription();
      this.recordMigration(29, 'repair generic accepted build notes description');
    }

    if (!this.hasMigration(30)) {
      this.repairAcceptedGitNotesBuildVersionDescription();
      this.recordMigration(30, 'repair accepted git notes build description');
    }

    if (!this.hasMigration(31)) {
      this.repairAcceptedSshNotesBuildVersionDescription();
      this.recordMigration(31, 'repair accepted ssh notes build description');
    }
  }
,

  ensureBaseSchema() {
    this.db.exec(`
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
        type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'invalid')),
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
    `);
  }
,

  ensureFocusSessionSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS focus_sessions (
        id TEXT PRIMARY KEY,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS focus_session_versions (
        id TEXT PRIMARY KEY,
        focus_session_id TEXT NOT NULL,
        started_at_utc TEXT NOT NULL,
        ended_at_utc TEXT,
        duration_seconds INTEGER,
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        created_at_utc TEXT NOT NULL,
        created_event_id TEXT,
        created_by_device_id TEXT,
        FOREIGN KEY (focus_session_id) REFERENCES focus_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (created_event_id) REFERENCES timer_events(event_id),
        FOREIGN KEY (created_by_device_id) REFERENCES timer_devices(device_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_session_versions_one_current
      ON focus_session_versions (focus_session_id)
      WHERE is_current = 1;

      CREATE INDEX IF NOT EXISTS idx_focus_session_versions_started
      ON focus_session_versions (started_at_utc);

      CREATE INDEX IF NOT EXISTS idx_focus_session_versions_ended
      ON focus_session_versions (ended_at_utc);

      CREATE INDEX IF NOT EXISTS idx_focus_session_versions_current_ended
      ON focus_session_versions (is_current, ended_at_utc);

      CREATE TABLE IF NOT EXISTS focus_session_sources (
        session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (session_id, event_id, role),
        FOREIGN KEY (session_id) REFERENCES focus_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (event_id) REFERENCES timer_events(event_id)
      );
    `);
  }
,

  allowTimerEditSessionEvents() {
    if (!this.tableExists('timer_events')) return;
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'timer_events'")
      .get();
    if (row?.sql?.includes("'edit_session'")) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        CREATE TABLE timer_events_next (
          event_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          client_sequence INTEGER NOT NULL,
          server_sequence INTEGER NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'invalid')),
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

        INSERT INTO timer_events_next (
          event_id, device_id, client_sequence, server_sequence, type,
          occurred_at_utc, received_at_utc, local_timer_id, base_server_revision,
          status, ignore_reason, payload_version, metadata_json
        )
        SELECT
          event_id, device_id, client_sequence, server_sequence, type,
          occurred_at_utc, received_at_utc, local_timer_id, base_server_revision,
          status, ignore_reason, payload_version, metadata_json
        FROM timer_events;

        DROP TABLE timer_events;
        ALTER TABLE timer_events_next RENAME TO timer_events;
      `);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
    this.ensureEventSchema();
  }
,

  dropLegacyTimerSessionTables() {
    this.db.exec(`
      DROP TABLE IF EXISTS timer_session_sources;
      DROP INDEX IF EXISTS idx_timer_sessions_one_active;
      DROP INDEX IF EXISTS idx_timer_sessions_started;
      DROP INDEX IF EXISTS idx_timer_sessions_ended;
      DROP TABLE IF EXISTS timer_sessions;
    `);
  }
,

  ensureTableDescriptions() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS table_descriptions (
        table_name TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        short_description TEXT NOT NULL,
        long_description TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );
    `);

    const now = new Date().toISOString();
    const descriptions = [
      ['activities', 'Действия', 'Текущий список действий.', 'Хранит рабочее состояние действий Bright OS: название, статус, описание, сортировку, удаление и восстановление.'],
      ['activity_events', 'События действий', 'Журнал изменений действий.', 'Хранит каждое клиентское событие по действиям для синхронизации, аудита и восстановления текущей таблицы activities.'],
      ['app_settings', 'Настройки', 'Глобальные настройки приложения.', 'Хранит runtime-настройки в формате ключ-значение: дату старта цели, длительность цели, дневную норму фокуса и похожие параметры.'],
      ['build_version_refs', 'Связи версий', 'Технические связи версий.', 'Хранит source/target branch и commit для build_versions, чтобы audit-метаданные не подменяли короткое изменение, детальные изменения и причину выпуска.'],
      ['build_versions', 'Версии', 'Журнал публичных версий.', 'Хранит принятые web/OTA сборки и APK-релизы с описанием изменений, причиной выпуска и временем релиза.'],
      ['deployment_records', 'Деплои', 'Журнал выкладок.', 'Хранит факты деплоя: окружение, ветку, commit, домен, web/OTA версию, APK версию и описание доставки.'],
      ['focus_sessions', 'Сессии фокуса', 'Стабильные Focus-сессии.', 'Хранит стабильные идентификаторы Focus-сессий. Редактируемые время старта, финиша и длительность лежат в focus_session_versions.'],
      ['focus_session_sources', 'Источники Focus-сессий', 'Связи Focus-сессий и событий.', 'Связывает итоговые Focus-сессии с timer_events, из которых они получились при deterministic replay.'],
      ['focus_session_versions', 'Версии Focus-сессий', 'История значений Focus-сессий.', 'Хранит версии старта, финиша и длительности Focus-сессий. Только одна версия на сессию может быть текущей.'],
      ['items', 'Сущности', 'Реестр рабочих сущностей.', 'Хранит главные рабочие сущности Bright OS как стабильные id для схемы, API и технических решений.'],
      ['schema_migrations', 'Миграции', 'Журнал изменений схемы.', 'Хранит версии уже примененных миграций SQLite, время применения и краткое описание.'],
      ['sqlite_sequence', 'Счётчики', 'Служебные счетчики SQLite.', 'Внутренняя таблица SQLite для AUTOINCREMENT-счетчиков. Это не бизнес-данные Bright OS.'],
      ['table_descriptions', 'Описания таблиц', 'Справочник описаний таблиц.', 'Хранит читаемый русский заголовок и описание для каждой SQLite-таблицы, которые показывает admin-панель.'],
      ['timer_devices', 'Устройства', 'Устройства синхронизации.', 'Хранит устройства, которые отправляют события фокуса и действий: stable device_id, платформу, имя и параметры синхронизации.'],
      ['timer_events', 'События фокуса', 'Журнал событий фокуса.', 'Хранит start, stop и edit_session события фокуса с устройством, клиентской и серверной последовательностью.'],
      ['version_types', 'Типы версий', 'Справочник типов версий.', 'Хранит типы записей для build_versions: обычную сборочную версию build и APK-версию apk.']
    ];
    const actualTables = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => row.name)
    );
    const upsert = this.db.prepare(`
      INSERT INTO table_descriptions (
        table_name, title, short_description, long_description, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(table_name) DO UPDATE SET
        title = excluded.title,
        short_description = excluded.short_description,
        long_description = excluded.long_description,
        updated_at_utc = excluded.updated_at_utc
    `);
    for (const [tableName, title, shortDescription, longDescription] of descriptions) {
      if (actualTables.has(tableName)) {
        upsert.run(tableName, title, shortDescription, longDescription, now);
      }
    }
    this.db
      .prepare("DELETE FROM table_descriptions WHERE table_name IN ('timer_sessions', 'timer_session_sources')")
      .run();
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

      CREATE INDEX IF NOT EXISTS idx_activity_events_activity_occurred
      ON activity_events (activity_id, occurred_at_utc, server_sequence);

      CREATE INDEX IF NOT EXISTS idx_activity_events_type_occurred
      ON activity_events (type, occurred_at_utc, server_sequence);

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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activities_new_sort_order
      ON activities (status, sort_order)
      WHERE deleted_at_utc IS NULL AND sort_order IS NOT NULL;
    `);
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
      'Web/OTA ledger: accepted dev builds increment Z; production releases increment Y.',
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

  ensureBuildVersionRefs() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS build_version_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_type_id TEXT NOT NULL,
        version TEXT NOT NULL,
        source_branch TEXT,
        source_commit TEXT,
        target_branch TEXT NOT NULL,
        target_commit TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY (version_type_id, version) REFERENCES build_versions(version_type_id, version) ON DELETE CASCADE,
        UNIQUE (version_type_id, target_branch, target_commit)
      );

      CREATE INDEX IF NOT EXISTS idx_build_version_refs_version
      ON build_version_refs (version_type_id, version);
    `);
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
      'Aligned dev build ledger sequence.',
      'Recorded accepted dev build 0.0.8.1: dev build Z follows the accepted dev build sequence, and the current dev source keeps the accepted menu and GitHub CLI sandbox-auth fixes.',
      'Accepted dev build ledger alignment into dev.',
      '2026-06-24T21:40:47Z',
      now
    );

    this.db
      .prepare("DELETE FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.9.1'")
      .run();
  }
,

  seedAcceptedDevBuildLedgerBackfill() {
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
      'Accepted dev build 0.0.9.1.',
      'Recorded accepted dev build 0.0.9.1: mobile edge menu swipe, bottom-dock-only page swipes, and 80 percent left menu width.',
      'Accepted dev build 0.0.9.1 into dev.',
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
      'Accepted dev build 0.0.10.1.',
      'Recorded accepted dev build 0.0.10.1: preview slot release now uses a deploy-readable checkout, full preview pools queue FIFO, and acceptance release frees the slot automatically.',
      'Accepted dev build 0.0.10.1 into dev.',
      '2026-06-24T23:10:19.023Z',
      now
    );
  }
,

  seedAcceptedDevBuild11LedgerBackfill() {
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
      'Accepted dev build 0.0.11.1.',
      'Recorded accepted dev build 0.0.11.1: build ledger acceptance flow records dev build versions idempotently before future dev deployments.',
      'Accepted dev build 0.0.11.1 into dev.',
      '2026-06-25T00:08:24Z',
      now
    );
  }
,

  removePrVersionCouplingFromBuildLedger() {
    this.db
      .prepare("UPDATE version_types SET description = ? WHERE id = 'build'")
      .run('Web/OTA ledger: accepted dev builds increment Z; production releases increment Y.');
    const updates = [
      [
        '0.0.8.1',
        'Aligned dev build ledger sequence.',
        'Recorded accepted dev build 0.0.8.1: dev build Z follows the accepted dev build sequence, and the current dev source keeps the accepted menu and GitHub CLI sandbox-auth fixes.',
        'Accepted dev build ledger alignment into dev.',
      ],
      [
        '0.0.9.1',
        'Accepted dev build 0.0.9.1.',
        'Recorded accepted dev build 0.0.9.1: mobile edge menu swipe, bottom-dock-only page swipes, and 80 percent left menu width.',
        'Accepted dev build 0.0.9.1 into dev.',
      ],
      [
        '0.0.10.1',
        'Accepted dev build 0.0.10.1.',
        'Recorded accepted dev build 0.0.10.1: preview slot release now uses a deploy-readable checkout, full preview pools queue FIFO, and acceptance release frees the slot automatically.',
        'Accepted dev build 0.0.10.1 into dev.',
      ],
      [
        '0.0.11.1',
        'Accepted dev build 0.0.11.1.',
        'Recorded accepted dev build 0.0.11.1: build ledger acceptance flow records dev build versions idempotently before future dev deployments.',
        'Accepted dev build 0.0.11.1 into dev.',
      ],
    ];
    const update = this.db.prepare(`
      UPDATE build_versions
      SET short_changes = ?, detailed_changes = ?, reason = ?
      WHERE version_type_id = 'build' AND version = ?
    `);
    for (const [version, shortChanges, detailedChanges, reason] of updates) {
      update.run(shortChanges, detailedChanges, reason, version);
    }
  }
,

  repairTechnicalBuildVersionDescriptions() {
    const updates = [
      [
        '0.0.8.1',
        'Aligned dev build ledger sequence.',
        'Dev build Z follows the accepted dev build sequence, and the current dev source keeps the accepted menu and GitHub CLI sandbox-auth fixes.',
        'Accepted dev build ledger alignment into dev.',
      ],
      [
        '0.0.9.1',
        'Added mobile edge menu swipe.',
        'Mobile navigation now opens the left menu from an edge swipe, keeps horizontal page swipes on the bottom dock only, and uses an 80 percent mobile left menu width.',
        'Accepted dev build 0.0.9.1 into dev.',
      ],
      [
        '0.0.10.1',
        'Fixed preview slot release and queueing.',
        'Preview slot release now uses a deploy-readable checkout, full preview pools queue FIFO, and acceptance release frees the slot automatically.',
        'Accepted dev build 0.0.10.1 into dev.',
      ],
      [
        '0.0.11.1',
        'Recorded accepted build ledger idempotently.',
        'The acceptance flow records dev build versions idempotently before future dev deployments.',
        'Accepted dev build 0.0.11.1 into dev.',
      ],
      [
        '0.0.12.1',
        'Renamed Bright OS API infrastructure.',
        'Renamed Bright OS API infrastructure, fixed local-first timer controls during sync, avoided stale OTA checking state, and rewrote the public README.',
        'Accepted dev build 0.0.12.1: codex/rename-bright-os-api@4eafe83852f9ff3723dd23d3401019a7b6dde233 -> dev@0c57b8f74f4dd8ad2c500bac08714392c932cc1d.',
      ],
      [
        '0.0.13.1',
        'Backfilled accepted build 0.0.11.1.',
        'Backfilled the accepted 0.0.11.1 build ledger row and migration tests so existing dev history is represented in build_versions.',
        'Accepted dev build 0.0.13.1: codex/backfill-pr11-build-ledger@0ae30248632de2c92668d7ad649f71c86cf09008 -> dev@4ba274fed068106057521c319b7b385ce0b0ed45.',
      ],
      [
        '0.0.14.1',
        'Promoted dev build ledger to production.',
        'Production promotion now copies accepted dev build ledger rows and creates production release rows that reference the included dev builds.',
        'Accepted dev build 0.0.14.1: codex/promote-dev-ledger-to-prod@72035952b3cfd243322ea6c4b1d1a28be7e293b3 -> dev@5cbde5ca771201924e72a13d418fa832d266abb3.',
      ],
      [
        '0.0.15.1',
        'Fixed version ledger semantics.',
        'Versioning no longer couples dev build numbers to GitHub PR numbers; accepted branches create Z versions and production promotion creates Y releases with included build references.',
        'Accepted dev build 0.0.15.1: codex/fix-version-ledger-semantics@b743abaaa3e344bd511c959f9963ab9ece096a10 -> dev@a2a8d0cfb8d5f72cbb398de31d60a3a8678eb17c.',
      ],
      [
        '0.0.16.1',
        'Required preview slot release after dev deploy.',
        'Accepted preview cleanup now waits for deploy-dev metadata promotion and releases preview slots only after the dev deployment succeeds.',
        'Accepted dev build 0.0.16.1: codex/require-preview-slot-release@c811cf9c584fa06b58e416118957b68f2066f59b -> dev@1c50f30328f3aaf2b6f8254909dcd37bbda80738.',
      ],
      [
        '0.0.17.1',
        'Fixed preview promotion metadata fallback.',
        'Accepted preview promotion now falls back to branch and commit metadata when the preview database is unavailable and cleans up previously accepted preview slots.',
        'Accepted dev build 0.0.17.1: codex/fix-preview-promotion-fallback@9a00d6312ef0f963ac81847fae106b2c170a7979 -> dev@6ae3a7b2c23c561194375d42b49bccdebb49ac77.',
      ],
      [
        '0.0.18.1',
        'Connected Temporal CI/CD delivery gates.',
        'Delivery now records checks, preview deploys, accepted-preview promotion, slot release, dev deploy, and production deploy in Temporal with strict blocking signals and documented recovery rules.',
        'Accepted dev build 0.0.18.1: codex/fix-preview-promotion-fallback@3329474d5da1b09d5b6930287dbe231a516b1845 -> dev@4c1b5cbd5a26d9bb576ca8a2a3e1a83266dd1758.',
      ],
      [
        '0.0.19.1',
        'Document table_descriptions schema metadata rule.',
        'Project rules now require table_descriptions updates for server SQLite schema metadata changes, while content-only row changes are exempt.',
        'Accepted dev build 0.0.19.1: codex/table-descriptions-metadata-rules@683f8f7f0f77e5e85e3527b2ee2cb955ea309e69 -> dev@1546e6062f1b6a743e18a7c45d78b4298177d9cb.',
      ],
      [
        '0.0.20.1',
        'Optimize activity projection sync.',
        'Activity sync now applies incremental projection updates for activity events and client command method names instead of relying on full recompute paths.',
        'Accepted dev build 0.0.20.1: codex/incremental-activity-projection@7cd4ee2bccfb34842dab52c1ca8d3012bbaab95a -> dev@e8a58dd2e1df97131189878651808e967a50eaa8.',
      ],
      [
        '0.0.21.1',
        'Implemented focus session versioning.',
        'Focus history now uses versioned completed focus sessions, completed session start/end edits sync through timer events, and legacy timer sessions migrate into the new versioned model.',
        'Accepted dev build 0.0.21.1: codex/focus-session-versioning@f80e1bc64f9e3b84ec01088d91e5684901b7f0a8 -> dev@ee0c387eea1b0786c70926058bc257ab25828135.',
      ],
      [
        '0.0.22.1',
        'Enforced branch preview guard rails.',
        'Task-start, handoff, git hook, and Codex hook guards now keep implementation work on codex/* branches, require clean committed pushes, and prevent preview handoff without a verified slot.',
        'Accepted dev build 0.0.22.1: codex/enforce-branch-preview-guards@5b9c621be5dd33c3c4bd3588f702fa69f53fca78 -> dev@f0c71767234ab38b80e5999a0f9fa6cea4877d58.',
      ],
    ];
    const update = this.db.prepare(`
      UPDATE build_versions
      SET short_changes = ?, detailed_changes = ?, reason = ?
      WHERE version_type_id = 'build'
        AND version = ?
    `);
    for (const [version, shortChanges, detailedChanges, reason] of updates) {
      update.run(shortChanges, detailedChanges, reason, version);
    }
  }
,

  repairLateTechnicalBuildVersionDescriptions() {
    const updates = [
      [
        '0.0.23.1',
        'Required runtime DB fact verification.',
        'Project rules now require direct runtime verification before claiming database, service, or deployment facts; document SQLite WAL read-only checks; and add handoff/checklist requirements for non-visual runtime facts.',
        'Accepted dev build 0.0.23.1: codex/require-runtime-db-verification@9846d4db644824b20c8f050aff99ea9fef8a3d38 -> dev@82be3ab928dca8444594f808b3f6fe2a3cb21a55.',
      ],
      [
        '0.0.24.1',
        'Fixed build version release notes.',
        'Accepted build version rows now keep human-readable release notes in short_changes and detailed_changes, move deployment audit metadata into reason, preserve source changelog text during promotion, and repair historical technical descriptions.',
        'Accepted dev build 0.0.24.1: codex/fix-build-version-descriptions@5c16c8450e77273d95d327f4792f502b0dfceee8 -> dev@d778efdcadfa06af938c91fe1247ab1309ebebf8.',
      ],
    ];
    const update = this.db.prepare(`
      UPDATE build_versions
      SET short_changes = ?, detailed_changes = ?, reason = ?
      WHERE version_type_id = 'build'
        AND version = ?
    `);
    for (const [version, shortChanges, detailedChanges, reason] of updates) {
      update.run(shortChanges, detailedChanges, reason, version);
    }
  }
,

  repairBuildVersionReasonText() {
    const updates = [
      [
        '0.0.1.1',
        'Initial public web/OTA baseline.',
        'Published browser web and Android OTA bundle 0.0.1.1 with X=0, Y=0, Z=1, S=1 and min APK versionCode 1. Browser web and Android OTA use the same public version.',
        'Needed to establish the first clean public web/OTA version after the repository baseline was reset.',
      ],
      [
        '0.0.2.1',
        'Accepted public version baseline rules.',
        'Recorded the first accepted public task: task merges into dev increment Z, dev promotions to main increment Y, and APK releases increment S. Browser web and Android OTA use version 0.0.2.1 with Android versionCode 1.',
        'Needed explicit X.Y.Z.S rules so public builds, production promotions, and APK releases were not tracked ad hoc.',
      ],
      [
        '0.0.3.1',
        'Accepted clean task finish rules.',
        'Recorded the second accepted public task: implementation work must finish with committed and pushed tracked changes unless explicitly local-only, and codex task branches deploy to isolated preview slots before dev acceptance.',
        'Needed to prevent unfinished local work or unreviewed task branches from being treated as accepted dev work.',
      ],
      [
        '0.0.4.1',
        'Accepted idempotent preview cleanup.',
        'Recorded the third accepted public task: preview metadata promotion skips cleanly when the preview slot has already been released by a delete event.',
        'Needed because preview cleanup could fail when an accepted slot had already been released.',
      ],
      [
        '0.0.5.1',
        'Accepted environment-specific favicons.',
        'Recorded the fourth accepted public task: dev and preview web/PWA builds use environment-specific favicon and manifest icon assets while production keeps the canonical Bright OS icons.',
        'Needed so dev and preview builds were visually distinguishable while production kept the canonical brand assets.',
      ],
      [
        '0.0.6.1',
        'Accepted preview version semantics.',
        'Recorded the fifth accepted public task: preview deployments keep the current accepted dev app version and record preview deployment metadata, while the next public build version becomes visible only after deploy-dev succeeds.',
        'Needed because preview deployments were exposing unaccepted version numbers before dev acceptance.',
      ],
      [
        '0.0.7.1',
        'Accepted production Android OTA API endpoint fix.',
        'Recorded the sixth accepted public task: production Android web/OTA bundles use the public API endpoint while browser web keeps same-origin /api, and OTA manifests are prepared for cache-safe publication.',
        'Needed because production Android OTA bundles had to call the public API endpoint instead of browser-only same-origin /api.',
      ],
      [
        '0.0.8.1',
        'Aligned dev build ledger sequence.',
        'Dev build Z follows the accepted dev build sequence, and the current dev source keeps the accepted menu and GitHub CLI sandbox-auth fixes.',
        'Needed to make accepted dev build numbering and ledger rows consistent after earlier backfills and workflow fixes.',
      ],
      [
        '0.0.9.1',
        'Added mobile edge menu swipe.',
        'Mobile navigation now opens the left menu from an edge swipe, keeps horizontal page swipes on the bottom dock only, and uses an 80 percent mobile left menu width.',
        'Needed because mobile navigation lacked a reliable edge gesture and page swipes conflicted with menu access.',
      ],
      [
        '0.0.10.1',
        'Fixed preview slot release and queueing.',
        'Preview slot release now uses a deploy-readable checkout, full preview pools queue FIFO, and acceptance release frees the slot automatically.',
        'Needed because preview slots could remain occupied or unavailable, blocking queued task branches.',
      ],
      [
        '0.0.11.1',
        'Recorded accepted build ledger idempotently.',
        'The acceptance flow records dev build versions idempotently before future dev deployments.',
        'Needed because repeated acceptance or deploy steps could duplicate or miss accepted build ledger rows.',
      ],
      [
        '0.0.12.1',
        'Renamed Bright OS API infrastructure.',
        'Renamed Bright OS API infrastructure, fixed local-first timer controls during sync, avoided stale OTA checking state, and rewrote the public README.',
        'Needed to remove stale API naming, keep timer controls responsive during sync, and stop OTA checks from showing stale state.',
      ],
      [
        '0.0.13.1',
        'Backfilled accepted build 0.0.11.1.',
        'Backfilled the accepted 0.0.11.1 build ledger row and migration tests so existing dev history is represented in build_versions.',
        'Needed because existing dev history was missing the accepted 0.0.11.1 build ledger row.',
      ],
      [
        '0.0.14.1',
        'Promoted dev build ledger to production.',
        'Production promotion now copies accepted dev build ledger rows and creates production release rows that reference the included dev builds.',
        'Needed because production releases did not preserve the accepted dev build history they included.',
      ],
      [
        '0.0.15.1',
        'Fixed version ledger semantics.',
        'Versioning no longer couples dev build numbers to GitHub PR numbers; accepted branches create Z versions and production promotion creates Y releases with included build references.',
        'Needed because build versions were coupled to GitHub PR numbers instead of accepted dev and production release sequence.',
      ],
      [
        '0.0.16.1',
        'Required preview slot release after dev deploy.',
        'Accepted preview cleanup now waits for deploy-dev metadata promotion and releases preview slots only after the dev deployment succeeds.',
        'Needed because preview slots could be released before dev deployment metadata was safely promoted.',
      ],
      [
        '0.0.17.1',
        'Fixed preview promotion metadata fallback.',
        'Accepted preview promotion now falls back to branch and commit metadata when the preview database is unavailable and cleans up previously accepted preview slots.',
        'Needed because acceptance could fail or leave slots occupied when preview deployment metadata was unavailable.',
      ],
      [
        '0.0.18.1',
        'Connected Temporal CI/CD delivery gates.',
        'Delivery now records checks, preview deploys, accepted-preview promotion, slot release, dev deploy, and production deploy in Temporal with strict blocking signals and documented recovery rules.',
        'Needed because delivery checks, deploys, promotions, failures, and recovery did not have one strict control ledger.',
      ],
      [
        '0.0.19.1',
        'Document table_descriptions schema metadata rule.',
        'Project rules now require table_descriptions updates for server SQLite schema metadata changes, while content-only row changes are exempt.',
        'Needed because SQLite schema metadata could change without the admin panel descriptions staying current.',
      ],
      [
        '0.0.20.1',
        'Optimize activity projection sync.',
        'Activity sync now applies incremental projection updates for activity events and client command method names instead of relying on full recompute paths.',
        'Needed because activity sync relied on heavier full recompute paths and stale client command method names.',
      ],
      [
        '0.0.21.1',
        'Implemented focus session versioning.',
        'Focus history now uses versioned completed focus sessions, completed session start/end edits sync through timer events, and legacy timer sessions migrate into the new versioned model.',
        'Needed because completed focus-session edits required versioned history and syncable edit events instead of mutating legacy timer rows.',
      ],
      [
        '0.0.22.1',
        'Enforced branch preview guard rails.',
        'Task-start, handoff, git hook, and Codex hook guards now keep implementation work on codex/* branches, require clean committed pushes, and prevent preview handoff without a verified slot.',
        'Needed because implementation work could happen on unsafe branches or be handed off without a clean pushed preview slot.',
      ],
      [
        '0.0.23.1',
        'Required runtime DB fact verification.',
        'Project rules now require direct runtime verification before claiming database, service, or deployment facts; document SQLite WAL read-only checks; and add handoff/checklist requirements for non-visual runtime facts.',
        'Needed because agents were making database and deployment claims from code, screenshots, or assumptions instead of checking the real runtime target.',
      ],
      [
        '0.0.24.1',
        'Fixed build version release notes.',
        'Accepted build version rows now keep human-readable release notes in short_changes and detailed_changes, preserve source changelog text during promotion, repair historical technical descriptions, and keep audit metadata out of the visible change text.',
        'Needed because version rows showed branch, commit, and deploy metadata instead of readable release notes and real change reasons.',
      ],
      [
        '0.0.25.1',
        'Repaired late build version descriptions.',
        'Late accepted build rows now restore readable release notes for runtime verification and release-note fixes, ignore technical preview metadata during promotion, and keep branch/commit audit data out of visible change fields.',
        'Needed because a newly accepted build row still showed branch metadata instead of readable release notes.',
      ],
    ];
    const update = this.db.prepare(`
      UPDATE build_versions
      SET short_changes = ?, detailed_changes = ?, reason = ?
      WHERE version_type_id = 'build'
        AND version = ?
    `);
    for (const [version, shortChanges, detailedChanges, reason] of updates) {
      update.run(shortChanges, detailedChanges, reason, version);
    }
    this.db
      .prepare("UPDATE build_versions SET reason = ? WHERE version_type_id = 'apk' AND version = '0.0.1.1'")
      .run('Needed to establish the first installable public Android APK baseline with signing kept outside the repository.');
  }
,

  backfillBuildVersionRefs() {
    const refs = [
      ['0.0.8.1', 'codex/align-pr-version-ledger', '20c96fa', 'dev', '17976ea'],
      ['0.0.9.1', 'codex/mobile-menu-edge-swipe', 'a2b9cce', 'dev', '3fbef43'],
      ['0.0.10.1', 'codex/fix-preview-slot-release', '1a3eb10', 'dev', '266f7b0'],
      ['0.0.11.1', 'codex/fix-accepted-build-ledger', '2169878', 'dev', 'df4b717'],
      ['0.0.12.1', 'codex/rename-bright-os-api', '4eafe83852f9ff3723dd23d3401019a7b6dde233', 'dev', '0c57b8f74f4dd8ad2c500bac08714392c932cc1d'],
      ['0.0.13.1', 'codex/backfill-pr11-build-ledger', '0ae30248632de2c92668d7ad649f71c86cf09008', 'dev', '4ba274fed068106057521c319b7b385ce0b0ed45'],
      ['0.0.14.1', 'codex/promote-dev-ledger-to-prod', '72035952b3cfd243322ea6c4b1d1a28be7e293b3', 'dev', '5cbde5ca771201924e72a13d418fa832d266abb3'],
      ['0.0.15.1', 'codex/fix-version-ledger-semantics', 'b743abaaa3e344bd511c959f9963ab9ece096a10', 'dev', 'a2a8d0cfb8d5f72cbb398de31d60a3a8678eb17c'],
      ['0.0.16.1', 'codex/require-preview-slot-release', 'c811cf9c584fa06b58e416118957b68f2066f59b', 'dev', '1c50f30328f3aaf2b6f8254909dcd37bbda80738'],
      ['0.0.17.1', 'codex/fix-preview-promotion-fallback', '9a00d6312ef0f963ac81847fae106b2c170a7979', 'dev', '6ae3a7b2c23c561194375d42b49bccdebb49ac77'],
      ['0.0.18.1', 'codex/fix-preview-promotion-fallback', '3329474d5da1b09d5b6930287dbe231a516b1845', 'dev', '4c1b5cbd5a26d9bb576ca8a2a3e1a83266dd1758'],
      ['0.0.19.1', 'codex/table-descriptions-metadata-rules', '683f8f7f0f77e5e85e3527b2ee2cb955ea309e69', 'dev', '1546e6062f1b6a743e18a7c45d78b4298177d9cb'],
      ['0.0.20.1', 'codex/incremental-activity-projection', '7cd4ee2bccfb34842dab52c1ca8d3012bbaab95a', 'dev', 'e8a58dd2e1df97131189878651808e967a50eaa8'],
      ['0.0.21.1', 'codex/focus-session-versioning', 'f80e1bc64f9e3b84ec01088d91e5684901b7f0a8', 'dev', 'ee0c387eea1b0786c70926058bc257ab25828135'],
      ['0.0.22.1', 'codex/enforce-branch-preview-guards', '5b9c621be5dd33c3c4bd3588f702fa69f53fca78', 'dev', 'f0c71767234ab38b80e5999a0f9fa6cea4877d58'],
      ['0.0.23.1', 'codex/require-runtime-db-verification', '9846d4db644824b20c8f050aff99ea9fef8a3d38', 'dev', '82be3ab928dca8444594f808b3f6fe2a3cb21a55'],
      ['0.0.24.1', 'codex/fix-build-version-descriptions', '5c16c8450e77273d95d327f4792f502b0dfceee8', 'dev', 'd778efdcadfa06af938c91fe1247ab1309ebebf8'],
      ['0.0.25.1', 'codex/repair-late-build-version-descriptions', '50caeb4c844d0487d04a28de64ced4161c1eaa00', 'dev', 'a1887a755689967b2a892ebc6a8b50ca31072958'],
    ];
    const exists = this.db.prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = ?");
    for (const [version, sourceBranch, sourceCommit, targetBranch, targetCommit] of refs) {
      if (!exists.get(version)) continue;
      this.upsertBuildVersionRef({
        versionTypeId: 'build',
        version,
        sourceBranch,
        sourceCommit,
        targetBranch,
        targetCommit,
      });
    }
  }
,

  repairAcceptedAuditMetadataBuildVersionDescription() {
    this.db
      .prepare(`
        UPDATE build_versions
        SET short_changes = ?,
            detailed_changes = ?,
            reason = ?
        WHERE version_type_id = 'build'
          AND version = '0.0.26.1'
      `)
      .run(
        'Separated build ledger audit metadata.',
        'Build version rows now store branch and commit audit references in build_version_refs, repair late accepted release-note rows, and prevent technical Accepted codex fallbacks from entering visible change fields.',
        'Needed because accepted build metadata still fell back to generic release-note text when the dev checkout could not see the preview source commit.',
      );
    const exists = this.db
      .prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.26.1'")
      .get();
    if (exists) {
      this.upsertBuildVersionRef({
        versionTypeId: 'build',
        version: '0.0.26.1',
        sourceBranch: 'codex/repair-late-build-version-descriptions',
        sourceCommit: 'ca6b2e282d6bbc5f8fd2b2f11817e89c6791fac1',
        targetBranch: 'dev',
        targetCommit: 'f3592f7c9adfc492e5920623aefda087532d6015',
      });
    }
  }
,

  repairGenericAcceptedBuildNotesDescription() {
    this.db
      .prepare(`
        UPDATE build_versions
        SET short_changes = ?,
            detailed_changes = ?,
            reason = ?
        WHERE version_type_id = 'build'
          AND version = '0.0.27.1'
      `)
      .run(
        'Used preview source for accepted build notes.',
        'Accepted preview promotion now attempts to read release notes from the preview checkout instead of the dev deploy source and repairs the generic 0.0.26.1 build description through migration 28.',
        'Needed because accepted build metadata could not be read from the dev deploy source and fell back to generic no-release-notes text.',
      );
    const exists = this.db
      .prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.27.1'")
      .get();
    if (exists) {
      this.upsertBuildVersionRef({
        versionTypeId: 'build',
        version: '0.0.27.1',
        sourceBranch: 'codex/repair-late-build-version-descriptions',
        sourceCommit: '2804346377fbb3f2cb81ff703d79ae20cd0ef735',
        targetBranch: 'dev',
        targetCommit: '449bb5a9a908243dd0a2685b2e56519b86a92393',
      });
    }
  }
,

  repairAcceptedGitNotesBuildVersionDescription() {
    this.db
      .prepare(`
        UPDATE build_versions
        SET short_changes = ?,
            detailed_changes = ?,
            reason = ?
        WHERE version_type_id = 'build'
          AND version = '0.0.28.1'
      `)
      .run(
        'Read accepted build notes from git history.',
        'Accepted preview promotion now reads authored commit notes from the deploy repo git history when tar-copied preview/dev sources have no .git directory, ignores generic no-release-notes placeholders when better fallback notes exist, and repairs the 0.0.27.1 build ledger row with migration 29.',
        'Needed because accepted preview promotion still wrote generic no-release-notes text instead of the authored source commit notes.',
      );
    const exists = this.db
      .prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.28.1'")
      .get();
    if (exists) {
      this.upsertBuildVersionRef({
        versionTypeId: 'build',
        version: '0.0.28.1',
        sourceBranch: 'codex/repair-late-build-version-descriptions',
        sourceCommit: '53866e6800be4c5789a60ef049911d26a5693b0a',
        targetBranch: 'dev',
        targetCommit: '1dc4f8af7eb719aa8632b40a3f8b569f2a47884d',
      });
    }
  }
,

  repairAcceptedSshNotesBuildVersionDescription() {
    this.db
      .prepare(`
        UPDATE build_versions
        SET short_changes = ?,
            detailed_changes = ?,
            reason = ?
        WHERE version_type_id = 'build'
          AND version = '0.0.29.1'
      `)
      .run(
        'Passed accepted build notes before SSH.',
        'Acceptance now resolves authored source-branch commit notes in the GitHub runner and passes them to server-side promotion before SSH, so accepted build_versions rows no longer depend on tar-copied deploy sources or server git checkout state. Migration 30 repaired the 0.0.28.1 row that still received the generic no-release-notes fallback.',
        'Needed because accepted build notes were still unavailable on the server during preview promotion.',
      );
    const exists = this.db
      .prepare("SELECT 1 FROM build_versions WHERE version_type_id = 'build' AND version = '0.0.29.1'")
      .get();
    if (exists) {
      this.upsertBuildVersionRef({
        versionTypeId: 'build',
        version: '0.0.29.1',
        sourceBranch: 'codex/repair-late-build-version-descriptions',
        sourceCommit: 'bdb660b18b0e20363967c15a8018548be32550df',
        targetBranch: 'dev',
        targetCommit: 'e68cf2685dfce4903f7d28dc8e38ef7c7ab25d8f',
      });
    }
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
