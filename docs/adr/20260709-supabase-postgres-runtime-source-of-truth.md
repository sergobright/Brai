# Supabase Postgres как источник истины для runtime

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-09
- Tags: postgres, supabase, runtime, данные

## Контекст

Runtime-состояние Brai включает каноническое состояние таймера, sessions, Activities, activity events, auth, deployment/version ledger, agents, schedules, runtime logs и AI logs. Проекту нужен один источник истины runtime-БД для production, Dev и preview environments.

## Решение

Brai использует Supabase Postgres как runtime source of truth. `BRAI_DATABASE_URL` - защищенный server-side DSN для API, scheduler, deploy ledger scripts, production, Dev и preview environments. Node API остается границей данных; web и Android clients не получают Supabase service credentials и не вызывают Supabase Data API напрямую.

## Рассмотренные альтернативы

- Оставить SQLite как runtime fallback: отклонено, потому что текущие runtime, deploy ledger, Dev, production и preview paths должны fail fast без Postgres.
- Разрешить clients использовать Supabase напрямую: отклонено, потому что service credentials и data contracts должны оставаться за Node API boundary.

## Последствия

- Плюс: production, Dev и previews используют одну database model с изолированными schemas и migration history.
- Минус: live runtime claims требуют environment-specific Postgres verification.
- Риск: обработка protected DSN должна оставаться вне Git и вне logs.

## Проверка

Перед rules, migrations, handoff или claims о runtime tables проверяйте реальную environment, DSN source без секретов, наличие tables, columns, indexes, constraints и relevant rows.

## Ссылки

- `docs/guidelines/04-api-data-sync-migrations.md`
- `openspec/specs/project-governance/spec.md`
- `openspec/specs/repository-operations/spec.md`

## Заменяет

Нет.

## Заменено

Нет.
