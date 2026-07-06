# API, данные, sync и миграции

## Назначение

Этот guideline нужен перед изменением `services/brai_api`, Supabase/Postgres schema, sync endpoints, canonical replay, migrations или client data contracts.

## Источники данных

- Supabase Postgres является runtime source of truth для timer canonical state, sessions, Activities, activity events, auth, deploy/version ledger, agents, schedules и AI logs.
- `BRAI_DATABASE_URL` - server-side Postgres DSN для runtime API, scheduler и deploy ledger scripts. `BRAI_DATA_STORE=postgres` - transitional guard. `BRAI_DB` остаётся только для frozen SQLite backup/import source и legacy tests.
- Node API остаётся единственной data API boundary. Web/Android не получают Supabase service credentials и не ходят напрямую в Supabase Data API.
- Timer sync основан на event log и deterministic replay.
- Activities sync использует отдельный event log: `activities` и `activity_events`.
- Main work entities живут identity-уровнем в таблице `items`; временные роли сущностей живут в `item_roles`, справочник ролей - в `item_role_types`.
- Server schema metadata регистрируется в таблице `table_descriptions`.
- Runtime AI-агенты регистрируются в таблице `agents`.

## Runtime schema verification

- Перед правилом, миграцией, утверждением или handoff про runtime таблицу проверь реальное целевое окружение: environment, Postgres DSN source, наличие таблицы, columns, indexes, constraints и релевантные строки.
- Не выводи состояние preview/prod из кода, миграций, скриншота или слов Сергея. Если не проверил живую базу, так и скажи.
- Для live Postgres проверок используй server-side credentials только из защищённых env-файлов или CI secrets; не вставляй DSN, пароли, tokens или connection strings в docs, logs и commit.
- Legacy SQLite проверяй только как frozen backup/import source. Для frozen SQLite в WAL mode используй обычный read-only connection (`mode=ro`), а не `immutable=1`, иначе свежие данные из `-wal` можно не увидеть.
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

- Postgres baseline живёт в `supabase/migrations/0001_brai_baseline.sql`; не портируй старые SQLite migrations буквально без необходимости.
- Каждое server-side schema изменение получает Supabase migration file и marker в Postgres migration history.
- Любое server-side schema metadata изменение обновляет `table_descriptions` в том же change: новые/изменённые таблицы, столбцы, индексы, связи, зависимости и назначение. Content-only изменения строк этого не требуют.
- `table_descriptions` имеет поля `table_name`, `title`, `short_description`, `long_description`, `updated_at_utc`; перед обновлением проверь эти поля в целевой DB.
- Любой новый или изменённый runtime AI-агент должен обновлять строку в `agents` в том же change. Заполняй максимум полезного контекста: stable id, target, kind, status, краткое и подробное описание, когда срабатывает, условия пропуска, входы, выходы, зависимости/взаимодействия, side effects, LLM provider/model, полный prompt template, timeout, fallback и source module.
- Каждый runtime AI-агент при фактическом срабатывании пишет ровно одну строку в `ai_logs`: `agent_id`, `agent_version`, UTC `dt`, `status`, единый `json_data`, короткий русский `ai_title`, и nullable `flow_id`/`flow_command`.
- Перед production cutover, import или destructive-risk изменением делай свежий frozen SQLite backup и сохраняй его read-only.
- Migration должна быть idempotent для повторного запуска.
- Не меняй canonical data shape без проверки API consumers и client cache projection.
- Preview `codex/*` использует отдельную Supabase preview branch с production data clone. Dev использует долгоживущую `brai-dev` branch без automatic prod refresh.

## Sync rules

- Client events должны иметь stable device identity и monotonic client sequence.
- Server timestamps хранятся UTC.
- Goal и History day grouping используют Europe/Moscow (UTC+3).
- Sessions crossing Moscow midnight split only for display/goal aggregation, while canonical sessions remain intact unless spec says otherwise.
- Timer events more than 5 minutes in the future относительно receive time are ignored/persisted as ignored, not retried forever.

## API и auth

- Internal API v1 требует Bearer auth или valid password-auth session cookie; external inbound API требует inbound API key.
- Browser web `/api/*` идёт через same-origin Caddy proxy and is authorized by Brai API session cookies or explicit Bearer auth; Caddy must not inject a private Bearer token for public browser routes.
- Direct Capacitor Android uses password-auth session cookies against `https://api.brightos.world`.
- Не embed private Bearer token или inbound API key в web bundle, OTA bundle или docs.
- External inbound API contract is documented in `docs/api/inbound-api.md`.
- Any inbound API route, payload, response, auth, MIME, limit, storage, DB mapping, title-generation, or error-code change must update `docs/api/inbound-api.md` in the same commit.

## Проверка

- API tests: `npm --prefix services/brai_api test`.
- Relevant client tests после contract changes.
- `npm run openspec:validate`, если менялись OpenSpec files.
- Проверка live service/restart нужна только если изменение реально должно примениться на сервере.
