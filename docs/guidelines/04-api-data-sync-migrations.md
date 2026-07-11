# API, данные, sync и миграции

## Назначение

Этот guideline нужен перед изменением `services/brai_api`, Supabase/Postgres schema, sync endpoints, canonical replay, migrations, runtime logs или client data contracts.

## Источники данных

- Supabase Postgres является runtime source of truth для timer canonical state, sessions, Activities, activity events, auth, deploy/version ledger, agents, schedules и AI logs.
- `BRAI_DATABASE_URL` - server-side Supabase/Postgres DSN для runtime API, scheduler, deploy ledger scripts, production, Dev и preview environments. Runtime запускается только с Postgres URL и обязан fail-fast без него.
- Node API остаётся единственной data API boundary. Web/Android не получают Supabase service credentials и не ходят напрямую в Supabase Data API.
- Timer sync основан на event log и deterministic replay.
- Activities sync использует отдельный event log: `activities` и `activity_events`.
- Main work entities живут identity-уровнем в таблице `items`; временные роли сущностей живут в `item_roles`, справочник ролей - в `item_role_types`.
- Server schema metadata регистрируется в таблице `table_descriptions`.
- Runtime AI-агенты регистрируются в таблице `agents`.

## Runtime logs

- `logs` - общая компактная non-AI runtime/operation таблица для auth, API outcomes, sync, deploy, scheduler, admin и shell operations; `ai_logs` используется только AI-агентами.
- При любом изменении runtime/API/sync/deploy/admin/auth/background/native/server side effect всегда проверь, нужен ли новый или изменённый `logs` writer, reader, admin metadata и test.
- Логируй один bounded summary на operation/batch: operation/status/reason/duration/correlation ids/counts/compact flags. Если есть durable ledger, `logs` хранит summary и ссылки на ledger ids.
- Не пиши secrets, credentials, tokens, cookies, OTP, passwords, raw payloads, full stdout/stderr, base64, file paths, transcripts, большие AI outputs или пользовательский контент без явной необходимости.
- Если меняются поля, статусы или смысл операции, обнови `json_data` так, чтобы максимум пользы помещался в минимальный объём.

## Runtime schema verification

- Перед правилом, миграцией, утверждением или handoff про runtime таблицу проверь реальное целевое окружение: environment, Postgres DSN source, наличие таблицы, columns, indexes, constraints и релевантные строки.
- Не выводи состояние preview/prod из кода, миграций, скриншота или слов Сергея. Если не проверил живую базу, так и скажи.
- Для live Postgres проверок используй server-side credentials только из защищённых env-файлов или CI secrets; не вставляй DSN, пароли, tokens или connection strings в docs, logs и commit.
- SQLite не является runtime fallback. Не добавляй `BRAI_DB`, `BRAI_DATA_STORE`, локальные SQLite paths или backup/import scripts в новые API/deploy paths.
- Codex operation-задачи закрывай через deploy-owned helper для текущего runtime API/DB; не обходи API/runtime ownership прямыми клиентскими credentials.
- В невизуальном handoff укажи проверенные environment, DSN source без секрета, SQL/команду и ключевые строки результата.

## Main entities

- `items` - главная таблица сущностей Brai: стабильный id, владелец, человеческое имя, общее описание, автор создания, timestamps identity-уровня и soft-delete.
- `items` не является registry таблиц и не должна заполняться строками `activities`, `inbox` или другими payload table names.
- Роли сущностей назначаются через `item_roles`; role-specific поля живут в таблице из `item_role_types.payload_table`.
- Системные `item_role_types`: `activity` -> `activities`, `inbox` -> `inbox`, `focus_session` -> `focus_sessions`.
- Новые сущности не создаются вручную; прямой путь создания должен идти через отдельную AI-процедуру. Не добавляй обходные ручные процедуры без явного требования.
- В technical schema/workflow decisions ссылайся на `items.id`.

## FK naming

- Любой новый или переименованный FK на `<parent_table>.id` называй `<parent_table>_id`.
- FK на `items.id` называется `items_id`; FK на `item_role_types.id` называется `item_role_types_id`.
- Не используй сокращённые формы для plural parent tables: `item_id`, `role_type_id`, `event_type_id`.

## Миграции

- Postgres baseline живёт в `supabase/migrations/0001_brai_baseline.sql`.
- Каждое server-side schema изменение получает Supabase migration file и marker в Postgres migration history.
- Любое server-side schema metadata изменение обновляет `table_descriptions` в том же change: новые/изменённые таблицы, столбцы, индексы, связи, зависимости и назначение. Content-only изменения строк этого не требуют.
- `table_descriptions` имеет поля `table_name`, `title`, `short_description`, `long_description`, `updated_at_utc`; перед обновлением проверь эти поля в целевой DB.
- Любой новый или изменённый runtime AI-агент должен обновлять строку в `agents` в том же change. Заполняй максимум полезного контекста: stable id, target, kind, status, краткое и подробное описание, когда срабатывает, условия пропуска, входы, выходы, зависимости/взаимодействия, side effects, LLM provider/model, полный prompt template, timeout, fallback и source module.
- Каждый runtime AI-агент при фактическом срабатывании пишет ровно одну строку в `ai_logs`: `agent_id`, `agent_version`, UTC `dt`, `status`, единый `json_data`, короткий русский `ai_title`, и nullable `flow_id`/`flow_command`.
- Migration должна быть idempotent для повторного запуска.
- Не меняй canonical data shape без проверки API consumers и client cache projection.
- Preview `codex/*` и Dev используют отдельные Supabase/Postgres schemas, применяют все migrations и при каждой пересборке тестового окружения refresh-ят данные из production DB. `supabase/preview_seed.sql` остаётся fallback seed для flow без self-hosted prod source. Dev/Preview включают `BRAI_TEST_AUTO_LOGIN=true`; production никогда не включает тестовый auto-login.

## Sync rules

- Client events должны иметь stable device identity и monotonic client sequence.
- Server timestamps хранятся UTC.
- Goal и History day grouping используют Europe/Moscow (UTC+3).
- Sessions crossing Moscow midnight split only for display/goal aggregation, while canonical sessions remain intact unless spec says otherwise.
- Timer events more than 5 minutes in the future относительно receive time are ignored/persisted as ignored, not retried forever.

## API и auth

- Internal API v1 требует Bearer auth или valid password-auth session cookie; external Inbox API требует Inbox API key.
- Browser web `/api/*` идёт через same-origin Caddy proxy and is authorized by Brai API session cookies or explicit Bearer auth; Caddy must not inject a private Bearer token for public browser routes.
- Direct Capacitor Android uses password-auth session cookies against `https://api.brai.one`.
- Не embed private Bearer token или Inbox API key в web bundle, OTA bundle или docs.
- External Inbox API contract is documented in `docs/api/inbox-api.md`.
- Any Inbox API route, payload, response, auth, MIME, limit, storage, DB mapping, processing, or error-code change must update `docs/api/inbox-api.md` in the same commit.

## Проверка

- API tests: `npm --prefix services/brai_api test`.
- Relevant client tests после contract changes.
- `npm run openspec:validate`, если менялись OpenSpec files.
- Проверка live service/restart нужна только если изменение реально должно примениться на сервере.
