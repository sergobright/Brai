# API, данные, sync и миграции

## Назначение

Этот guideline нужен перед изменением `services/bright_os_api`, SQLite schema, sync endpoints, canonical replay, migrations или client data contracts.

## Источники данных

- Server SQLite является source of truth для timer canonical state, sessions, Activities и activity events.
- Timer sync основан на event log и deterministic replay.
- Activities sync использует отдельный event log: `activities` и `activity_events`.
- Main work entities регистрируются в таблице `items`; сейчас основной entity - `activities`.

## Main entities

- Bright OS main work entities регистрируются в server SQLite таблице `items`.
- В technical schema/workflow decisions ссылайся на `items.id`.
- Первый зарегистрированный main entity - `activities`.

## Миграции

- Каждое server-side schema изменение получает migration marker в `schema_migrations`.
- Перед live migration или destructive-risk изменением делай SQLite backup.
- Migration должна быть idempotent для повторного запуска.
- Не меняй canonical data shape без проверки API consumers и client cache projection.

## Sync rules

- Client events должны иметь stable device identity и monotonic client sequence.
- Server timestamps хранятся UTC.
- Goal и History day grouping используют Europe/Moscow (UTC+3).
- Sessions crossing Moscow midnight split only for display/goal aggregation, while canonical sessions remain intact unless spec says otherwise.
- Timer events more than 5 minutes in the future относительно receive time are ignored/persisted as ignored, not retried forever.

## API и auth

- API v1 требует Bearer auth или valid password-auth session cookie.
- Browser web `/api/*` идёт через Caddy upstream Bearer injection.
- Direct Capacitor Android uses password-auth session cookies against `https://api.brightos.world`.
- Не embed private Bearer token в web bundle, OTA bundle или docs.

## Проверка

- API tests: `npm --prefix services/bright_os_api test`.
- Relevant client tests после contract changes.
- `npm run openspec:validate`, если менялись OpenSpec files.
- Проверка live service/restart нужна только если изменение реально должно примениться на сервере.
