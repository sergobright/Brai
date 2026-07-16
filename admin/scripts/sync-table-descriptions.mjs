import pg from "pg";

const { Pool } = pg;
const WRITE_DATABASE_URL_ENV = "BRAI_ADMIN_WRITE_DATABASE_URL";
const RUNTIME_DATABASE_URL_ENV = "BRAI_DATABASE_URL";

const DESCRIPTIONS = [
  {
    table_name: "activities",
    title: "Действия",
    short_description: "Текущий список действий.",
    long_description:
      "Хранит рабочее состояние действий Brai: название, статус, описание, сортировку, удаление и восстановление.\nЭто быстрая проекция activity-domain записей canonical events ledger.",
  },
  {
    table_name: "events",
    title: "События",
    short_description: "Единый canonical журнал domain-событий.",
    long_description:
      "Хранит timer, activity, inbox и system события с domain-local revision, статусом accepted/ignored и universal role links.\nИспользуется для синхронизации, deterministic replay, projections и аудита; прежние отдельные event tables удалены.",
  },
  {
    table_name: "app_settings",
    title: "Настройки",
    short_description: "Глобальные настройки приложения.",
    long_description:
      "Хранит runtime-настройки в формате ключ-значение: дату старта цели, длительность цели, дневную норму фокуса и похожие параметры.\nНужна, чтобы менять поведение приложения через данные, а не через правку кода.",
  },
  {
    table_name: "build_versions",
    title: "Версии",
    short_description: "Журнал завершённых работ и опубликованных platform-артефактов.",
    long_description:
      "Хранит build-записи завершённых project works и отдельные APK или будущие platform releases с неизменным номером и временем публикации.\nBuild является ledger выполненной работы; browser web, Android OTA и APK остаются фактами соответствующих артефактов и не обязаны увеличиваться вместе.",
  },
  {
    table_name: "release_works",
    title: "Release works",
    short_description: "Стабильные идентификаторы законченных объёмов работы.",
    long_description:
      "Один work объединяет owner PR и необязательные support PR. Support merge сам по себе не создаёт build; owner или явно разрешённая support-only finalization завершает work атомарно вместе с version history.",
  },
  {
    table_name: "github_pull_requests",
    title: "GitHub pull requests",
    short_description: "Публичные GitHub snapshots PR, зарегистрированных в release work.",
    long_description:
      "Хранит полный release-time snapshot PR и неизменяемую принадлежность к work с ролью owner или support. Один PR может быть связан не более чем с одной версией каждого platform type.",
  },
  {
    table_name: "build_version_details",
    title: "Version details",
    short_description: "Атомарные упорядоченные изменения версии.",
    long_description:
      "Каждая version содержит хотя бы одну независимую detail. Необязательная ссылка на GitHub PR сохраняет provenance, а display_order задаёт стабильный публичный порядок.",
  },
  {
    table_name: "build_version_pull_requests",
    title: "Version pull requests",
    short_description: "Типизированные связи версий с GitHub PR.",
    long_description:
      "Связывает build или platform version с доказанными PR. Composite foreign key фиксирует тип родительской версии; один PR может входить максимум в одну version каждого type.",
  },
  {
    table_name: "build_version_refs",
    title: "Ссылки версий",
    short_description: "Git refs, доказанно относящиеся к версии.",
    long_description:
      "Хранит source и target branch/commit для конкретной build или platform version. Исторический backfill использует только точные refs и не выводит отношения из соседних дат, PR numbers или commit ranges.",
  },
  {
    table_name: "deployment_records",
    title: "Деплои",
    short_description: "Журнал выкладок.",
    long_description:
      "Хранит факты деплоя: окружение, ветку, commit, домен, web/OTA версию, APK версию и описание доставки.\nНужна для аудита production и preview: что именно было выложено, куда и когда.",
  },
  {
    table_name: "items",
    title: "Сущности",
    short_description: "Реестр рабочих сущностей.",
    long_description:
      "Хранит главные рабочие сущности Brai. Сейчас здесь зарегистрирована сущность activities.\nНужна как стабильный справочник для схемы, API и технических решений, чтобы они ссылались на общий id сущности.",
  },
  {
    table_name: "logs",
    title: "Логи",
    short_description: "Компактный журнал runtime-операций.",
    long_description:
      "Хранит компактные non-AI runtime и operation факты: auth/API outcomes, sync summaries, deploy/version/scheduler/admin события и shell operations.\nAI-agent executions пишутся в ai_logs, а logs хранит только bounded summaries, correlation ids, counts и flags без secrets, raw payloads и больших outputs.",
  },
  {
    table_name: "schema_migrations",
    title: "Миграции",
    short_description: "Журнал изменений схемы.",
    long_description:
      "Хранит версии уже примененных Supabase/Postgres миграций, время применения и краткое описание.\nНужна, чтобы миграции запускались повторно безопасно и не применяли одно и то же изменение дважды.",
  },
  {
    table_name: "table_descriptions",
    title: "Описания таблиц",
    short_description: "Справочник описаний таблиц.",
    long_description:
      "Хранит читаемый русский заголовок, короткое описание и длинное описание для каждой таблицы Postgres.\nАдминка читает эту таблицу, чтобы показывать понятные заголовки и раскрываемые пояснения без hardcode в UI.",
  },
  {
    table_name: "timer_devices",
    title: "Устройства",
    short_description: "Устройства синхронизации.",
    long_description:
      "Хранит устройства, которые отправляют события таймера и действий: stable device_id, платформу, имя, последнее появление, последнюю синхронизацию и смещение часов.\nНужна, чтобы сервер понимал источник событий и мог проверять последовательность клиентских изменений.",
  },
  {
    table_name: "focus_session_sources",
    title: "Источники Focus-сессий",
    short_description: "Связи Focus-сессий и событий.",
    long_description:
      "Связывает итоговые Focus-сессии с timer-domain записями canonical events ledger.\nНужна для аудита replay: можно открыть сессию и увидеть конкретные start/stop события, устройство и роль каждого события.",
  },
  {
    table_name: "focus_session_intervals",
    title: "Интервалы Focus-сессий",
    short_description: "Текущие интервалы работы внутри Focus-сессий.",
    long_description:
      "Хранит время старта, завершения и длительность интервалов Focus.\ncreated_event_id и ended_event_id ссылаются по domain event id на timer-записи canonical events ledger.",
  },
  {
    table_name: "focus_sessions",
    title: "Сессии фокуса",
    short_description: "Стабильные Focus-сессии.",
    long_description:
      "Хранит стабильные идентификаторы Focus-сессий, происхождение и soft-delete.\nВремя старта, финиша и длительность находится в focus_session_intervals, а domain history — в events.",
  },
  {
    table_name: "version_types",
    title: "Типы версий",
    short_description: "Справочник типов версий.",
    long_description:
      "Хранит типы записей для build_versions: обычную сборочную версию build и APK-версию apk.\nНужна, чтобы правила версионирования были явными в данных, а не только в коде и документации.",
  },
];

const db = new Pool({ connectionString: resolveWriteDatabaseUrl(), max: 1 });
const now = new Date().toISOString();

try {
  await db.query(`
    CREATE TABLE IF NOT EXISTS table_descriptions (
      table_name text PRIMARY KEY,
      title text NOT NULL,
      short_description text NOT NULL,
      long_description text NOT NULL,
      updated_at_utc text NOT NULL
    );
  `);

  const actualTables = (
    await db.query(`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type IN ('BASE TABLE', 'VIEW')
      ORDER BY table_name ASC
    `)
  ).rows.map((row) => row.name);

  const rows = new Map(DESCRIPTIONS.map((row) => [row.table_name, row]));
  const missing = actualTables.filter((tableName) => !rows.has(tableName));
  if (missing.length) {
    console.warn(`missing table descriptions: ${missing.join(", ")}`);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const row of [...rows.values()].filter((description) => actualTables.includes(description.table_name))) {
      await client.query(
        `
          INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT(table_name) DO UPDATE SET
            title = excluded.title,
            short_description = excluded.short_description,
            long_description = excluded.long_description,
            updated_at_utc = excluded.updated_at_utc
        `,
        [row.table_name, row.title, row.short_description, row.long_description, now],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  console.log(`synced known table descriptions for ${actualTables.length} Postgres objects`);
} finally {
  await db.end();
}

function resolveWriteDatabaseUrl() {
  const databaseUrl = process.env[WRITE_DATABASE_URL_ENV];
  if (!databaseUrl) throw new Error(`${WRITE_DATABASE_URL_ENV} is required for admin metadata writes`);
  if (databaseUrl === process.env[RUNTIME_DATABASE_URL_ENV]) {
    throw new Error(`${WRITE_DATABASE_URL_ENV} must be separate from runtime ${RUNTIME_DATABASE_URL_ENV}`);
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(`${WRITE_DATABASE_URL_ENV} must be a valid Postgres connection URL`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${WRITE_DATABASE_URL_ENV} must use postgres:// or postgresql://`);
  }
  return databaseUrl;
}
