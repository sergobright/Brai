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
    this.allowTimerDeleteSessionEvents();
    this.allowFocusActionTimerEvents();
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
      this.recordMigration(11, 'record public version rules task');
    }

    if (!this.hasMigration(12)) {
      this.recordMigration(12, 'record clean task finish rules task');
    }

    if (!this.hasMigration(13)) {
      this.recordMigration(13, 'record preview cleanup workflow task');
    }

    if (!this.hasMigration(14)) {
      this.recordMigration(14, 'record environment favicon task');
    }

    if (!this.hasMigration(15)) {
      this.recordMigration(15, 'record preview version semantics task');
    }

    if (!this.hasMigration(16)) {
      this.recordMigration(16, 'record production Android OTA API endpoint fix');
    }

    if (!this.hasMigration(17)) {
      this.recordMigration(17, 'record split left menu task');
    }

    if (!this.hasMigration(18)) {
      this.recordMigration(18, 'record GitHub CLI sandbox auth guidance');
    }

    if (!this.hasMigration(19)) {
      this.recordMigration(19, 'realign build version ledger sequence');
    }

    if (!this.hasMigration(20)) {
      this.recordMigration(20, 'record accepted dev build versions 9 and 10');
    }

    if (!this.hasMigration(21)) {
      this.recordMigration(21, 'record accepted dev build version 11');
    }

    if (!this.hasMigration(22)) {
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
    this.ensureInboxSchema();
    this.ensureHandlerSchema();
    this.ensureHandlerScheduleSchema();
    this.ensureTableDescriptions();

    if (!this.hasMigration(25)) {
      this.recordMigration(25, 'repair technical build version descriptions');
    }

    if (!this.hasMigration(26)) {
      this.recordMigration(26, 'repair late technical build version descriptions');
    }

    if (!this.hasMigration(27)) {
      this.recordMigration(27, 'separate build version audit refs from reasons');
    }

    if (!this.hasMigration(28)) {
      this.recordMigration(28, 'repair accepted audit metadata build description');
    }

    if (!this.hasMigration(29)) {
      this.recordMigration(29, 'repair generic accepted build notes description');
    }

    if (!this.hasMigration(30)) {
      this.recordMigration(30, 'repair accepted git notes build description');
    }

    if (!this.hasMigration(31)) {
      this.recordMigration(31, 'repair accepted ssh notes build description');
    }

    if (!this.hasMigration(32)) {
      this.recordMigration(32, 'add inbox work entity schema');
    }

    if (!this.hasMigration(33)) {
      this.recordMigration(33, 'add inbox offline event log');
    }

    if (!this.hasMigration(34)) {
      this.recordMigration(34, 'add inbox inbound metadata and record types');
    }

    if (!this.hasMigration(35)) {
      this.recordMigration(35, 'add handler registry');
    }

    if (!this.hasMigration(36)) {
      this.allowTimerDeleteSessionEvents();
      this.ensureFocusSessionSchema();
      this.recomputeCanonicalSessions(now);
      this.recordMigration(36, 'add focus session soft delete events');
    }

    if (!this.hasMigration(37)) {
      this.rebuildVersionLedgerTypes();
      this.recordMigration(37, 'rebuild version ledger as typed counters');
    }

    if (!this.hasMigration(38)) {
      this.recordMigration(38, 'standardize inbound API key and default target');
    }

    if (!this.hasMigration(39)) {
      this.recordMigration(39, 'shorten inbound API route');
    }

    if (!this.hasMigration(40)) {
      this.allowFocusActionTimerEvents();
      this.ensureFocusSessionSchema();
      this.backfillFocusSessionIntervals();
      this.recomputeCanonicalSessions(now);
      this.dropLegacyFocusSessionVersions();
      this.ensureTableDescriptions();
      this.recordMigration(40, 'replace focus session versions with intervals');
    }

    if (!this.hasMigration(41)) {
      this.recordMigration(41, 'add scheduled runtime handlers');
    }

    if (!this.hasMigration(42)) {
      this.seedAgentTaskActivities();
      this.recordMigration(42, 'move agent task ledger into operation activities');
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
        type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'delete_session', 'start_activity_focus', 'switch_activity_focus', 'stop_activity_focus', 'edit_focus_interval', 'invalid')),
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
        updated_at_utc TEXT NOT NULL,
        deleted_at_utc TEXT,
        deleted_event_id TEXT,
        start_origin TEXT NOT NULL DEFAULT 'focus' CHECK (start_origin IN ('focus', 'activity')),
        started_by_activity_id TEXT
      );

      CREATE TABLE IF NOT EXISTS focus_session_intervals (
        id TEXT PRIMARY KEY,
        focus_session_id TEXT NOT NULL,
        activity_id TEXT,
        started_at_utc TEXT NOT NULL,
        ended_at_utc TEXT,
        duration_seconds INTEGER,
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        created_event_id TEXT,
        ended_event_id TEXT,
        created_by_device_id TEXT,
        FOREIGN KEY (focus_session_id) REFERENCES focus_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (created_event_id) REFERENCES timer_events(event_id),
        FOREIGN KEY (ended_event_id) REFERENCES timer_events(event_id),
        FOREIGN KEY (created_by_device_id) REFERENCES timer_devices(device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_session_started
      ON focus_session_intervals (focus_session_id, started_at_utc);

      CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_activity_started
      ON focus_session_intervals (activity_id, started_at_utc);

      CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_started
      ON focus_session_intervals (started_at_utc);

      CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_ended
      ON focus_session_intervals (ended_at_utc);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_session_intervals_one_active
      ON focus_session_intervals (focus_session_id)
      WHERE ended_at_utc IS NULL;

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
    if (this.tableExists('focus_sessions') && !this.columnExists('focus_sessions', 'deleted_at_utc')) {
      this.db.exec('ALTER TABLE focus_sessions ADD COLUMN deleted_at_utc TEXT;');
    }
    if (this.tableExists('focus_sessions') && !this.columnExists('focus_sessions', 'deleted_event_id')) {
      this.db.exec('ALTER TABLE focus_sessions ADD COLUMN deleted_event_id TEXT;');
    }
    if (this.tableExists('focus_sessions') && !this.columnExists('focus_sessions', 'start_origin')) {
      this.db.exec("ALTER TABLE focus_sessions ADD COLUMN start_origin TEXT NOT NULL DEFAULT 'focus';");
    }
    if (this.tableExists('focus_sessions') && !this.columnExists('focus_sessions', 'started_by_activity_id')) {
      this.db.exec('ALTER TABLE focus_sessions ADD COLUMN started_by_activity_id TEXT;');
    }
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

  allowTimerDeleteSessionEvents() {
    if (!this.tableExists('timer_events')) return;
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'timer_events'")
      .get();
    if (row?.sql?.includes("'delete_session'")) return;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        CREATE TABLE timer_events_next (
          event_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          client_sequence INTEGER NOT NULL,
          server_sequence INTEGER NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'delete_session', 'invalid')),
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

  allowFocusActionTimerEvents() {
    if (!this.tableExists('timer_events')) return;
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'timer_events'")
      .get();
    if (
      row?.sql?.includes("'start_activity_focus'") &&
      row?.sql?.includes("'switch_activity_focus'") &&
      row?.sql?.includes("'stop_activity_focus'") &&
      row?.sql?.includes("'edit_focus_interval'")
    ) {
      return;
    }

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        CREATE TABLE timer_events_next (
          event_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          client_sequence INTEGER NOT NULL,
          server_sequence INTEGER NOT NULL UNIQUE,
          type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'delete_session', 'start_activity_focus', 'switch_activity_focus', 'stop_activity_focus', 'edit_focus_interval', 'invalid')),
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

  backfillFocusSessionIntervals() {
    if (!this.tableExists('focus_session_versions')) return;
    if (!this.tableExists('focus_session_intervals')) this.ensureFocusSessionSchema();
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM focus_session_intervals').get();
    if (existing.count > 0) return;

    this.db.exec(`
      INSERT INTO focus_session_intervals (
        id, focus_session_id, activity_id, started_at_utc, ended_at_utc,
        duration_seconds, created_at_utc, updated_at_utc, created_event_id,
        ended_event_id, created_by_device_id
      )
      SELECT
        focus_session_id || ':interval:legacy',
        focus_session_id,
        NULL,
        started_at_utc,
        ended_at_utc,
        duration_seconds,
        created_at_utc,
        created_at_utc,
        created_event_id,
        NULL,
        created_by_device_id
      FROM focus_session_versions
      WHERE is_current = 1;
    `);
  }
,

  dropLegacyFocusSessionVersions() {
    this.db.exec(`
      DROP INDEX IF EXISTS idx_focus_session_versions_one_current;
      DROP INDEX IF EXISTS idx_focus_session_versions_started;
      DROP INDEX IF EXISTS idx_focus_session_versions_ended;
      DROP INDEX IF EXISTS idx_focus_session_versions_current_ended;
      DROP TABLE IF EXISTS focus_session_versions;
    `);
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
      ['activities', 'Действия', 'Текущий список действий и операций.', 'Хранит рабочее состояние действий Brai и внутренних операций агента: activity_type_id, название, описание, автора, причину, статус, сортировку, удаление и восстановление. Пользовательские записи имеют activity_type_id action, агентские задачи имеют activity_type_id operation.'],
      ['activity_events', 'События действий', 'Журнал изменений действий.', 'Хранит каждое клиентское изменение по действиям для синхронизации, аудита и восстановления текущей таблицы activities. Поле change_type хранит тип изменения.'],
      ['activity_types', 'Типы действий', 'Справочник типов activities.', 'Хранит разрешённые типы activities для поля activities.activity_type_id: action для пользовательских действий и operation для внутренних задач агента.'],
      ['app_settings', 'Настройки', 'Глобальные настройки приложения.', 'Хранит runtime-настройки в формате ключ-значение: дату старта цели, длительность цели, дневную норму фокуса и похожие параметры.'],
      ['build_version_refs', 'Связи версий', 'Технические связи версий.', 'Хранит source/target branch и commit для build_versions, чтобы audit-метаданные не подменяли короткое изменение, детальные изменения и причину выпуска.'],
      ['build_versions', 'Версии', 'Типизированный журнал версий.', 'Хранит версии типов apk, build, release и canon. Поле version является счётчиком внутри типа; included_in_version_id связывает build/APK с release и release с canon. Публичная строка версии собирается из последних счётчиков.'],
      ['deployment_records', 'Деплои', 'Журнал выкладок.', 'Хранит факты деплоя: окружение, ветку, commit, домен, web/OTA версию, APK версию и описание доставки.'],
      ['focus_sessions', 'Сессии фокуса', 'Стабильные Focus-сессии.', 'Хранит стабильные идентификаторы Focus-сессий, soft-delete метку, origin старта и activity, из которой сессия была начата. Время хранится в focus_session_intervals.'],
      ['focus_session_sources', 'Источники Focus-сессий', 'Связи Focus-сессий и событий.', 'Связывает итоговые Focus-сессии с timer_events, из которых они получились при deterministic replay.'],
      ['focus_session_intervals', 'Интервалы Focus-сессий', 'Интервалы времени фокуса.', 'Хранит все временные интервалы Focus-сессий: обычный фокус с NULL activity_id, activity-linked интервалы, начало, конец, длительность и события, которыми интервал открыт или закрыт.'],
      ['inbox', 'Входящие', 'Список входящих материалов.', 'Хранит входящие материалы Brai до нормализации: заголовок, описание, источник, ключ источника, требование ответа, связь с предыдущим входящим, тип записи, дату, автора, предварительный раздел, срочность, ссылки на вложения, пояснение, текст нормализации и признак нормализации.'],
      ['inbox_events', 'События входящих', 'Журнал изменений входящих.', 'Хранит клиентские события по входящим для offline-first синхронизации, аудита и восстановления текущей таблицы inbox.'],
      ['inbox_record_types', 'Типы входящих', 'Справочник типов входящих.', 'Хранит разрешённые типы записей Inbox: входящее от человека по API, входящее от агента по API, внутреннее входящее от агента и добавленное человеком из интерфейса.'],
      ['handlers', 'Обработчики', 'Реестр runtime-обработчиков.', 'Хранит полный реестр обработчиков Brai: stable id, target, тип, статус, подробное описание, условия срабатывания, входы, выходы, взаимодействия, side effects, используемый LLM provider/model, prompt template, timeout, fallback и source module. Каждое добавление или изменение обработчика должно обновлять соответствующую строку.'],
      ['handler_schedules', 'Расписания обработчиков', 'Очередь scheduled runtime-обработчиков.', 'Хранит расписания runtime-обработчиков Brai: ссылку на handlers, статус, следующий запуск, повторяемый интервал, lock от параллельного запуска, последние timestamps и последнюю ошибку. Внешний systemd timer только будит scheduler-runner; due-логика хранится здесь.'],
      ['items', 'Сущности', 'Реестр рабочих сущностей.', 'Хранит главные рабочие сущности Brai как стабильные id для схемы, API и технических решений.'],
      ['schema_migrations', 'Миграции', 'Журнал изменений схемы.', 'Хранит версии уже примененных миграций SQLite, время применения и краткое описание.'],
      ['sqlite_sequence', 'Счётчики', 'Служебные счетчики SQLite.', 'Внутренняя таблица SQLite для AUTOINCREMENT-счетчиков. Это не бизнес-данные Brai.'],
      ['table_descriptions', 'Описания таблиц', 'Справочник описаний таблиц.', 'Хранит читаемый русский заголовок и описание для каждой SQLite-таблицы, которые показывает admin-панель.'],
      ['timer_devices', 'Устройства', 'Устройства синхронизации.', 'Хранит устройства, которые отправляют события фокуса и действий: stable device_id, платформу, имя и параметры синхронизации.'],
      ['timer_events', 'События фокуса', 'Журнал событий фокуса.', 'Хранит start, stop, start_activity_focus, switch_activity_focus, stop_activity_focus, edit_session, edit_focus_interval и delete_session события фокуса с устройством, клиентской и серверной последовательностью.'],
      ['version_types', 'Типы версий', 'Справочник типов версий.', 'Хранит типы записей для build_versions: apk, build, release и canon.']
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
      .prepare("DELETE FROM table_descriptions WHERE table_name IN ('timer_sessions', 'timer_session_sources', 'focus_session_versions')")
      .run();
  }
,

  ensureInboxSchema() {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_record_types (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description_text TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        source_key TEXT NOT NULL DEFAULT '',
        response_required INTEGER NOT NULL DEFAULT 0 CHECK (response_required IN (0, 1)),
        related_inbox_id TEXT,
        record_type_id INTEGER NOT NULL DEFAULT 4,
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

      CREATE INDEX IF NOT EXISTS idx_inbox_item_date
      ON inbox (item_date);

      CREATE INDEX IF NOT EXISTS idx_inbox_normalized_updated
      ON inbox (is_normalized, updated_at_utc);

      CREATE TABLE IF NOT EXISTS inbox_events (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL,
        server_sequence INTEGER NOT NULL UNIQUE,
        inbox_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'delete', 'invalid')),
        occurred_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('accepted', 'ignored')),
        ignore_reason TEXT,
        payload_version INTEGER NOT NULL,
        FOREIGN KEY (device_id) REFERENCES timer_devices(device_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_device_sequence
      ON inbox_events (device_id, client_sequence);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_server_sequence
      ON inbox_events (server_sequence);

      CREATE INDEX IF NOT EXISTS idx_inbox_events_occurred
      ON inbox_events (occurred_at_utc);

      CREATE INDEX IF NOT EXISTS idx_inbox_events_inbox_occurred
      ON inbox_events (inbox_id, occurred_at_utc, server_sequence);
    `);
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'deleted_at_utc')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN deleted_at_utc TEXT;');
    }
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'last_event_id')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN last_event_id TEXT;');
    }
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'source_key')) {
      this.db.exec("ALTER TABLE inbox ADD COLUMN source_key TEXT NOT NULL DEFAULT '';");
    }
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'response_required')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN response_required INTEGER NOT NULL DEFAULT 0;');
    }
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'related_inbox_id')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN related_inbox_id TEXT;');
    }
    if (this.tableExists('inbox') && !this.columnExists('inbox', 'record_type_id')) {
      this.db.exec('ALTER TABLE inbox ADD COLUMN record_type_id INTEGER NOT NULL DEFAULT 4;');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_inbox_source_key_created
      ON inbox (source_key, created_at_utc);

      CREATE INDEX IF NOT EXISTS idx_inbox_record_type_created
      ON inbox (record_type_id, created_at_utc);

      CREATE INDEX IF NOT EXISTS idx_inbox_related
      ON inbox (related_inbox_id);
    `);
    const upsertType = this.db.prepare(`
      INSERT INTO inbox_record_types (id, key, title, description, created_at_utc)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        key = excluded.key,
        title = excluded.title,
        description = excluded.description
    `);
    for (const type of [
      [1, 'api_human_inbound', 'Входящее от человека по API', 'Внешний API запрос, инициированный человеком.'],
      [2, 'api_agent_inbound', 'Входящее от агента по API', 'Внешний API запрос, инициированный агентом.'],
      [3, 'internal_agent_inbound', 'Внутреннее входящее от агента', 'Внутренний агент Brai создал входящую запись.'],
      [4, 'interface_human_created', 'Человек добавил из интерфейса', 'Пользователь создал входящую запись в интерфейсе Brai.']
    ]) {
      upsertType.run(...type, now);
    }
    this.db.exec(`
      UPDATE inbox
      SET record_type_id = 1
      WHERE record_type_id = 4
        AND (
          id LIKE 'inbound:inbox:%'
          OR last_event_id LIKE 'inbound:inbox:%'
          OR source <> ''
        );
    `);
    this.db
      .prepare('INSERT INTO items (id, created_at_utc) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run('inbox', now);
  }
,

  ensureHandlerSchema() {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handlers (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        trigger_description TEXT NOT NULL,
        conditions_description TEXT NOT NULL,
        input_description TEXT NOT NULL,
        output_description TEXT NOT NULL,
        interactions_description TEXT NOT NULL,
        side_effects_description TEXT NOT NULL,
        llm_provider TEXT NOT NULL DEFAULT '',
        llm_model TEXT NOT NULL DEFAULT '',
        llm_prompt_template TEXT NOT NULL DEFAULT '',
        llm_timeout_ms INTEGER,
        fallback_description TEXT NOT NULL DEFAULT '',
        source_module TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_handlers_target_status
      ON handlers (target, status);
    `);

    const upsertHandler = this.db.prepare(`
      INSERT INTO handlers (
        id, target, kind, status, title, summary, trigger_description,
        conditions_description, input_description, output_description,
        interactions_description, side_effects_description, llm_provider,
        llm_model, llm_prompt_template, llm_timeout_ms, fallback_description,
        source_module, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target = excluded.target,
        kind = excluded.kind,
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        trigger_description = excluded.trigger_description,
        conditions_description = excluded.conditions_description,
        input_description = excluded.input_description,
        output_description = excluded.output_description,
        interactions_description = excluded.interactions_description,
        side_effects_description = excluded.side_effects_description,
        llm_provider = excluded.llm_provider,
        llm_model = excluded.llm_model,
        llm_prompt_template = excluded.llm_prompt_template,
        llm_timeout_ms = excluded.llm_timeout_ms,
        fallback_description = excluded.fallback_description,
        source_module = excluded.source_module,
        updated_at_utc = excluded.updated_at_utc
    `);

    upsertHandler.run(
      'inbound.inbox.title_generator',
      'inbox',
      'inbound_llm_title_generator',
      'active',
      'Генератор заголовка входящего сообщения',
      'Создает короткий русский заголовок для новой Inbox-записи из обязательного inbound text.',
      'Срабатывает внутри POST /v1/ после проверки inbound API key, JSON payload, destination/target, обязательного text, record_type_id, вложений, idempotency key и связи с предыдущим сообщением, но до записи create-события inbox.',
      'Запускается только для поддержанного target inbox и только при создании новой записи. Не запускается для duplicate idempotency_key, неавторизованных запросов, invalid payload, неподдержанных вложений или ошибок validation.',
      'Получает trimmed body.text. Остальные поля inbound payload участвуют в создании Inbox-записи, но не передаются в LLM prompt.',
      'Возвращает строку inbox.title: первая непустая строка ответа модели очищается от внешних кавычек, обрезается до 80 символов и сохраняется через inbox_events create payload.',
      'Читает собственную строку из handlers, использует Codex CLI из BRAI_CODEX_BIN, модель из runtime-настройки BRAI_CODEX_MODEL при наличии, иначе llm_model из handlers, timeout из runtime BRAI_CODEX_TIMEOUT_MS при наличии, иначе llm_timeout_ms из handlers. Результат сохраняется через store.createInboundInboxItem в inbox_events/inbox.',
      'Создает временную директорию для output-last-message и удаляет ее после завершения. При успехе меняет только title будущей Inbox-записи; запись Inbox и файлы вложений выполняются внешним inbound handler flow.',
      'codex-cli',
      '',
      [
        'Сгенерируй короткий русский заголовок для входящего сообщения.',
        'Верни только заголовок, без Markdown, кавычек и пояснений.',
        '',
        '{{text}}'
      ].join('\n'),
      3000,
      'Если Codex CLI падает, возвращает пустой ответ или превышает timeout, используется локальный fallback: первые семь слов text, очищенные и обрезанные до 80 символов; если они пустые, заголовок Входящее.',
      'services/brai_api/src/inbound.js',
      now
    );
    upsertHandler.run(
      'maintenance.tasks_md_deduper',
      'repository',
      'scheduled_llm_git_pr',
      'disabled',
      'Дедупликация TASKS.md',
      'Legacy handler выключен: агентские задачи перенесены из TASKS.md в activities как operation.',
      'Срабатывает из services/brai_api/src/scheduler-runner.js, когда handler_schedules.next_run_at_utc наступил и строка не заблокирована другим запуском.',
      'Не запускается после переноса агентских задач в activities.',
      'Legacy input: корневой TASKS.md. Новый источник правды для агентских задач: activities rows с activity_type_id operation.',
      'Ничего не создает, пока handler disabled.',
      'Читает handlers и handler_schedules из server SQLite, запускает Codex CLI read-only для получения полного обновленного TASKS.md, затем использует git CLI для clone, branch, commit и push.',
      'Legacy side effects отключены: раньше мог создать временную директорию, codex/tasks-md-dedupe-* ветку, commit, push и GitHub PR.',
      'codex-cli',
      '',
      [
        'Ты обслуживаешь корневой TASKS.md проекта Brai.',
        'Нужно убрать только очевидные дубли или почти одинаковые записи в разделе "## Записи".',
        'Не добавляй новые факты, не переписывай стиль, не меняй смысл уникальных записей.',
        'Если дубликатов нет, верни ровно: NO_CHANGES',
        'Если изменения нужны, верни полный новый файл TASKS.md без Markdown fence и без пояснений.',
        '',
        '{{tasks_md}}'
      ].join('\n'),
      120000,
      'Не применяется, пока handler disabled.',
      'services/brai_api/src/scheduler-runner.js',
      now
    );
  }
,

  ensureHandlerScheduleSchema() {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handler_schedules (
        id TEXT PRIMARY KEY,
        handler_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
        next_run_at_utc TEXT,
        interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds > 0),
        locked_until_utc TEXT,
        last_started_at_utc TEXT,
        last_finished_at_utc TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        updated_at_utc TEXT NOT NULL,
        FOREIGN KEY (handler_id) REFERENCES handlers(id)
      );

      CREATE INDEX IF NOT EXISTS idx_handler_schedules_due
      ON handler_schedules (status, next_run_at_utc, locked_until_utc);

      CREATE INDEX IF NOT EXISTS idx_handler_schedules_handler
      ON handler_schedules (handler_id);
    `);

    this.db.prepare(`
      INSERT INTO handler_schedules (
        id, handler_id, status, next_run_at_utc, interval_seconds,
        locked_until_utc, last_started_at_utc, last_finished_at_utc,
        last_error, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, '', ?)
      ON CONFLICT(id) DO UPDATE SET
        handler_id = excluded.handler_id,
        status = excluded.status,
        next_run_at_utc = excluded.next_run_at_utc,
        interval_seconds = excluded.interval_seconds,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      'maintenance.tasks_md_deduper',
      'maintenance.tasks_md_deduper',
      'disabled',
      null,
      null,
      now
    );
  }
,

  ensureActivitySchema() {
    const now = new Date().toISOString();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activity_types (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at_utc TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        activity_type_id TEXT NOT NULL DEFAULT 'action',
        title TEXT NOT NULL,
        description_md TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('New', 'Done')),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        completed_at_utc TEXT,
        sort_order INTEGER,
        deleted_at_utc TEXT,
        restored_at_utc TEXT,
        last_event_id TEXT,
        FOREIGN KEY (activity_type_id) REFERENCES activity_types(id)
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
        change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'restore', 'invalid')),
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

    `);
    const upsertActivityType = this.db.prepare(`
      INSERT INTO activity_types (id, title, description, created_at_utc)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description
    `);
    for (const type of [
      ['action', 'Действие', 'Пользовательская activity, созданная человеком в интерфейсе или синхронизированная с клиента.'],
      ['operation', 'Операция агента', 'Внутренняя задача агента с автором и причиной выполнения.']
    ]) {
      upsertActivityType.run(...type, now);
    }
    this.db
      .prepare('INSERT INTO items (id, created_at_utc) VALUES (?, ?) ON CONFLICT(id) DO NOTHING')
      .run('activities', now);

    if (this.tableExists('activity_events') && this.columnExists('activity_events', 'type') && !this.columnExists('activity_events', 'change_type')) {
      this.db.exec('ALTER TABLE activity_events RENAME COLUMN type TO change_type;');
    }

    if (this.tableExists('activities') && !this.columnExists('activities', 'description_md')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN description_md TEXT NOT NULL DEFAULT '';");
    }
    if (this.tableExists('activities') && this.columnExists('activities', 'type') && !this.columnExists('activities', 'activity_type_id')) {
      this.db.exec('ALTER TABLE activities RENAME COLUMN type TO activity_type_id;');
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'activity_type_id')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN activity_type_id TEXT NOT NULL DEFAULT 'action';");
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'author')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN author TEXT NOT NULL DEFAULT '';");
    }
    if (this.tableExists('activities') && !this.columnExists('activities', 'reason')) {
      this.db.exec("ALTER TABLE activities ADD COLUMN reason TEXT NOT NULL DEFAULT '';");
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

      CREATE INDEX IF NOT EXISTS idx_activities_type_status_updated
      ON activities (activity_type_id, status, updated_at_utc);

      DROP INDEX IF EXISTS idx_activity_events_type_occurred;

      CREATE INDEX IF NOT EXISTS idx_activity_events_change_type_occurred
      ON activity_events (change_type, occurred_at_utc, server_sequence);
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
        change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
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
        change_type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        change_type, occurred_at_utc, received_at_utc, payload_json,
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
        change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
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
        change_type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        change_type, occurred_at_utc, received_at_utc, payload_json,
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
        change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'invalid')),
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
        change_type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        change_type, occurred_at_utc, received_at_utc, payload_json,
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
        change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'restore', 'invalid')),
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
        change_type, occurred_at_utc, received_at_utc, payload_json,
        status, ignore_reason, payload_version
      )
      SELECT
        event_id, device_id, client_sequence, server_sequence, activity_id,
        change_type, occurred_at_utc, received_at_utc, payload_json,
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
        version INTEGER NOT NULL CHECK (version > 0),
        included_in_version_id INTEGER,
        short_changes TEXT NOT NULL,
        detailed_changes TEXT NOT NULL,
        reason TEXT NOT NULL,
        released_at_utc TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        FOREIGN KEY (version_type_id) REFERENCES version_types(id),
        FOREIGN KEY (included_in_version_id) REFERENCES build_versions(id) ON DELETE SET NULL,
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
      'Сборка',
      'Принятая web/OTA сборка Brai. Увеличивает Z в версии X.Y.Z.S.',
      now
    );
    insertType.run(
      'apk',
      'APK',
      'Публичная Android APK-линия. Увеличивается только при осознанном выпуске нового APK.',
      now
    );
    insertType.run(
      'release',
      'Релиз',
      'Ручной релиз, который группирует принятые сборки и текущую APK-запись.',
      now
    );
    insertType.run(
      'canon',
      'Канон',
      'Ручной канон, который группирует релизы для публичной линии.',
      now
    );
  }
,

  ensureBuildVersionRefs() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS build_version_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_type_id TEXT NOT NULL,
        version INTEGER NOT NULL,
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

  rebuildVersionLedgerTypes() {
    if (!this.tableExists('build_versions') || !this.columnExists('build_versions', 'major_version')) return;

    const oldVersions = this.db
      .prepare('SELECT * FROM build_versions ORDER BY id')
      .all();
    const oldRefs = this.tableExists('build_version_refs')
      ? this.db.prepare('SELECT * FROM build_version_refs ORDER BY id').all()
      : [];
    const counters = { apk: 0, build: 0, release: 0, canon: 0 };
    const versionMap = new Map();
    const releaseRanges = [];
    let previousReleaseBuild = 0;

    this.db.pragma('foreign_keys = OFF');
    try {
      this.db.exec(`
        CREATE TABLE build_versions_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version_type_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          included_in_version_id INTEGER,
          short_changes TEXT NOT NULL,
          detailed_changes TEXT NOT NULL,
          reason TEXT NOT NULL,
          released_at_utc TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          FOREIGN KEY (version_type_id) REFERENCES version_types(id),
          FOREIGN KEY (included_in_version_id) REFERENCES build_versions_next(id) ON DELETE SET NULL,
          UNIQUE (version_type_id, version)
        );
      `);
      const insertVersion = this.db.prepare(`
        INSERT INTO build_versions_next (
          id,
          version_type_id,
          version,
          included_in_version_id,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of oldVersions) {
        const oldVersion = String(row.version);
        const nextType = row.version_type_id === 'build' && row.release_version > 0 ? 'release' : row.version_type_id;
        if (!Object.hasOwn(counters, nextType)) continue;
        const nextVersion = ++counters[nextType];
        insertVersion.run(
          row.id,
          nextType,
          nextVersion,
          null,
          row.short_changes,
          row.detailed_changes,
          row.reason,
          row.released_at_utc,
          row.created_at_utc,
        );
        versionMap.set(`${row.version_type_id}|${oldVersion}`, {
          versionTypeId: nextType,
          version: nextVersion,
          id: row.id,
        });
        if (nextType === 'release') {
          releaseRanges.push({
            id: row.id,
            from: previousReleaseBuild,
            to: row.build_version,
          });
          previousReleaseBuild = row.build_version;
        }
      }
      const link = this.db.prepare('UPDATE build_versions_next SET included_in_version_id = ? WHERE id = ?');
      for (const release of releaseRanges) {
        for (const row of oldVersions) {
          if (row.version_type_id !== 'build' || row.release_version !== 0) continue;
          if (row.build_version > release.from && row.build_version <= release.to) {
            link.run(release.id, row.id);
          }
        }
      }
      const latestRelease = releaseRanges.at(-1);
      const latestApk = oldVersions.filter((row) => row.version_type_id === 'apk').at(-1);
      if (latestRelease && latestApk) link.run(latestRelease.id, latestApk.id);

      this.db.exec(`
        CREATE TABLE build_version_refs_next (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version_type_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          source_branch TEXT,
          source_commit TEXT,
          target_branch TEXT NOT NULL,
          target_commit TEXT NOT NULL,
          created_at_utc TEXT NOT NULL,
          FOREIGN KEY (version_type_id, version) REFERENCES build_versions_next(version_type_id, version) ON DELETE CASCADE,
          UNIQUE (version_type_id, target_branch, target_commit)
        );
      `);
      const insertRef = this.db.prepare(`
        INSERT INTO build_version_refs_next (
          id,
          version_type_id,
          version,
          source_branch,
          source_commit,
          target_branch,
          target_commit,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, target_branch, target_commit) DO UPDATE SET
          version = excluded.version,
          source_branch = excluded.source_branch,
          source_commit = excluded.source_commit
      `);
      for (const ref of oldRefs) {
        const mapped = versionMap.get(`${ref.version_type_id}|${ref.version}`);
        if (!mapped) continue;
        insertRef.run(
          ref.id,
          mapped.versionTypeId,
          mapped.version,
          ref.source_branch,
          ref.source_commit,
          ref.target_branch,
          ref.target_commit,
          ref.created_at_utc,
        );
      }

      this.db.exec(`
        DROP TABLE IF EXISTS build_version_refs;
        DROP TABLE build_versions;
        ALTER TABLE build_versions_next RENAME TO build_versions;
        ALTER TABLE build_version_refs_next RENAME TO build_version_refs;

        CREATE INDEX IF NOT EXISTS idx_build_versions_type_released
        ON build_versions (version_type_id, released_at_utc);

        CREATE INDEX IF NOT EXISTS idx_build_version_refs_version
        ON build_version_refs (version_type_id, version);
      `);
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }
,

  seedInitialBuildVersion() {
    const now = new Date().toISOString();
    const buildReleasedAt = '2026-06-23T09:12:45Z';
    const apkReleasedAt = '2026-06-23T09:13:50Z';
    const insertVersion = this.db.prepare(`
        INSERT INTO build_versions (
          version_type_id,
          version,
          included_in_version_id,
          short_changes,
          detailed_changes,
          reason,
          released_at_utc,
          created_at_utc
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(version_type_id, version) DO NOTHING
      `);
    insertVersion.run(
      'build',
      1,
      null,
      'Первичная публичная web/OTA-сборка.',
      'Опубликована baseline web/OTA-сборка 1 с минимальным Android versionCode 1.',
      'Нужно зафиксировать первую чистую публичную web/OTA-версию.',
      buildReleasedAt,
      now
    );
    insertVersion.run(
      'apk',
      1,
      null,
      'Первичная публичная APK-сборка.',
      'APK baseline 1 использует Android versionCode 1. Release signing material хранится вне репозитория.',
      'Нужно зафиксировать первую публичную Android APK-сборку.',
      apkReleasedAt,
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

  seedAgentTaskActivities() {
    const insert = this.db.prepare(`
      INSERT INTO activities (
        id, activity_type_id, title, description_md, author, reason, status,
        created_at_utc, updated_at_utc, completed_at_utc, sort_order,
        deleted_at_utc, restored_at_utc, last_event_id
      ) VALUES (?, 'operation', ?, '', 'Codex', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET
        activity_type_id = 'operation',
        title = excluded.title,
        author = 'Codex',
        reason = excluded.reason,
        status = excluded.status,
        updated_at_utc = excluded.updated_at_utc,
        completed_at_utc = excluded.completed_at_utc,
        last_event_id = excluded.last_event_id
    `);
    for (const task of AGENT_TASK_ACTIVITIES) {
      const createdAt = `${task.date}T00:00:00.000Z`;
      insert.run(
        task.id,
        task.title,
        task.reason,
        task.done ? 'Done' : 'New',
        createdAt,
        createdAt,
        task.done ? createdAt : null,
        `migration:42:${task.id}`
      );
    }
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

const AGENT_TASK_ACTIVITIES = [
  {
    id: 'operation:agent-task:worktree-owner-nobody',
    date: '2026-07-01',
    title: 'Task worktree ownership blocks apply_patch',
    reason: 'escalated scripts/brai-task-start.sh создал task worktree файлами owner nobody, из-за чего apply_patch не мог писать; восстановить owner через sudo chown -R mark:mark <task-worktree> или исправить starter/runner ownership.',
    done: false
  },
  {
    id: 'operation:agent-task:turbopack-sandbox-port-binding',
    date: '2026-07-01',
    title: 'Next/Turbopack build needs sandbox allowance',
    reason: 'npm run app:build с Next/Turbopack падает в Codex sandbox на binding to a port/Operation not permitted; повторять build с sandbox_permissions=require_escalated или исправить sandbox allowance для Turbopack worker.',
    done: false
  },
  {
    id: 'operation:agent-task:live-sqlite-backup-permissions',
    date: '2026-07-01',
    title: 'Live SQLite backup directory permissions block backup',
    reason: 'live SQLite backup в /srv/projects/brai/data/backups не создавался даже от владельца runtime DB nobody; держать verified .backup в /tmp и выполнять live SQL root-ом, затем отдельно чинить права backup-каталога.',
    done: false
  },
  {
    id: 'operation:agent-task:classify-delivery-git-eperm',
    date: '2026-07-01',
    title: 'Delivery classification may need escalation',
    reason: 'deploy/scripts/classify-delivery.mjs из Codex sandbox может падать на spawnSync git EPERM; повторять классификацию с sandbox_permissions=require_escalated.',
    done: false
  },
  {
    id: 'operation:agent-task:app-test-vite-temp-permissions',
    date: '2026-07-01',
    title: 'Shared Vite temp permissions can block app tests',
    reason: 'npm run app:test в task worktree падает на Vitest/Vite EACCES, когда linked apps/brai_app/node_modules/.vite-temp owned by nobody:mark с 750; нужен owner/group-write fix для shared dependency dirs перед тестами, иначе фиксировать проверку как заблокированную окружением.',
    done: false
  },
  {
    id: 'operation:agent-task:turbopack-process-sandbox',
    date: '2026-07-01',
    title: 'Turbopack process creation can fail in sandbox',
    reason: 'npm run app:build в Codex sandbox может падать Turbopack panic на creating new process/binding to a port с Operation not permitted; повторять build с sandbox_permissions=require_escalated.',
    done: false
  },
  {
    id: 'operation:agent-task:accept-preview-matching-worktree',
    date: '2026-07-01',
    title: 'Accept preview must run from matching worktree',
    reason: 'deploy/scripts/accept-preview.sh читает receipt из текущего checkout; если основной checkout содержит receipt другой ветки, запускать accept из matching .codex-worktrees/<task-slug> и проверять .brai-task/preview-handoff.json.',
    done: false
  },
  {
    id: 'operation:agent-task:acceptance-conflict-resolution-flow',
    date: '2026-07-01',
    title: 'Acceptance conflict resolution was blocked by hooks',
    reason: 'после acceptance_started Brai git hooks блокировали даже merge/push для разрешения конфликтного accepted PR. Закрыто: добавлен official acceptance-reconcile flow для same-branch conflict resolution.',
    done: true
  },
  {
    id: 'operation:agent-task:superseded-pr-preview-slot-release',
    date: '2026-07-01',
    title: 'Superseded PR left preview slot occupied',
    reason: 'закрытый без merge superseded codex/* PR оставлял preview slot занятым. Закрыто в PR #102: pull_request.closed release job освобождает slot для unmerged codex/* PR.',
    done: true
  },
  {
    id: 'operation:agent-task:starter-escalation-rule',
    date: '2026-06-30',
    title: 'Task starter requires escalation in Codex Desktop',
    reason: 'scripts/brai-task-start.sh в Codex Desktop нужно запускать с sandbox_permissions=require_escalated; без этого starter не сможет нормально сделать fetch и записать git/worktree metadata; использовать эскалацию сразу для этого starter. Закрыто в PR #98: правило закреплено в runbook.',
    done: true
  },
  {
    id: 'operation:agent-task:git-add-index-lock-escalation',
    date: '2026-06-30',
    title: 'git add in task worktree needs metadata escalation',
    reason: 'git add в .codex-worktrees/<task-slug> из sandbox падает на создании .git/worktrees/<task-slug>/index.lock; повторять stage с sandbox_permissions=require_escalated, потому что git metadata лежит вне writable worktree. Закрыто в PR #98: правило закреплено в runbook.',
    done: true
  },
  {
    id: 'operation:agent-task:worktree-permission-repair-script',
    date: '2026-06-30',
    title: 'Task worktree ownership repair needed after escalated operations',
    reason: 'после escalated операций task worktree может стать owned by nobody, обычный git падает с dubious ownership/not a git repository, а patch не может писать файлы; восстановить ownership worktree на mark:mark перед продолжением. Закрыто в PR #98: добавлен scripts/brai-task-repair-permissions.sh.',
    done: true
  },
  {
    id: 'operation:agent-task:infra-docs-handoff-merged-state',
    date: '2026-07-01',
    title: 'Infra-docs handoff needed merged-state verification',
    reason: 'infra-docs PR может остаться OPEN/BEHIND после включения auto-merge, а старый handoff receipt всё равно выглядит успешным; считать delivery завершённой только после MERGED или делать replacement ветку от актуального origin/main. Закрыто в PR #98: handoff receipt пишется только после MERGED.',
    done: true
  },
  {
    id: 'operation:agent-task:preview-data-permissions',
    date: '2026-07-01',
    title: 'Preview data permissions blocked deploy reset',
    reason: 'preview deploy может упасть на reset SQLite файлов в /srv/projects/brai-envs/preview-*/data, если runtime создал их без deploy-группы; закрепить общий group-write через Ansible/systemd и повторять деплой тем же branch, чтобы slot переиспользовался без нового reset. Закрыто в PR #98: закреплены preview data group-write/setgid и recovery-сообщение.',
    done: true
  }
];
