# Изоляция отказов auth и Supavisor

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-15
- Tags: authentication, supavisor, reliability, deployment

## Контекст

После ручного пересоздания self-hosted Supabase/Supavisor незавершённые SCRAM-handshake Preview открыли общий circuit breaker tenant `brightos`. Production Better Auth перестал получать соединения. Brai API проглотил ошибку и вернул `authenticated:false`, поэтому клиент принял инфраструктурный отказ за завершение сессии, очистил account scope и показал Galaxy/login shell.

Существующая `/health` проверяла только основной product store. Отдельный async `pg` pool Better Auth мог быть недоступен при зелёном health. Production, Dev и Preview использовали один Supavisor tenant и одну breaker boundary.

## Решение

- У session resolution три результата: действующая сессия, достоверно отсутствующая сессия и недоступный auth backend. Последний всегда становится `503 auth_backend_unavailable` для `/auth/session`, session-protected `/v1/*` и WebSocket upgrade.
- `/health` независимо проверяет product pool и Better Auth pool и возвращает `503`, если любой из них не готов.
- Клиент сохраняет user id, IndexedDB snapshots, outbox и текущий экран при network/`5xx`; account scope очищается только после достоверного anonymous или настоящего `401`.
- Supavisor получает только tenant `brai-prod` для production и `brai-nonprod` для Dev/Preview. Maintenance удаляет persistent metadata legacy tenants `brightos`, `brightos-prod` и `brightos-nonprod` перед пересозданием pooler и после запуска fail-closed проверяет точное множество Brai targets.
- Любая reconfiguration/recreation pooler проходит через repo-managed maintenance wrapper: единый порядок deploy-lock, остановка клиентов, точечный Supavisor recreate, production-first health/auth canary и последовательный возврат non-production.

## Рассмотренные альтернативы

- Повторять Better Auth запрос и затем считать пользователя anonymous: отклонено, потому что timeout остаётся инфраструктурным отказом и не доказывает отсутствие сессии.
- Сохранить общий tenant и только увеличить timeout/breaker threshold: отклонено, потому что Preview всё ещё способен блокировать production.
- Пересоздавать весь Supabase Compose stack: отклонено из-за ненужного риска для stateful Postgres, Auth, Storage и зависимых сервисов.
- Добавить новую клиентскую систему session state: отклонено; существующая local-first обработка non-401 уже сохраняет данные, достаточно исправить API contract и покрыть его регрессией.

## Последствия

- Плюс: временный отказ auth больше не разлогинивает пользователя и не стирает локальный scope.
- Плюс: Preview/Dev breaker не блокирует production auth.
- Плюс: deploy readiness видит сломанный auth pool.
- Минус: live tenant migration требует короткой координированной maintenance-операции после принятия preview.
- Риск: неверный порядок «DSN раньше tenant» отключит окружение; wrapper обязан сначала создать tenants и fail-closed проверить mapping.

## Проверка

- Integration tests различают session/user/null/error и ожидают `503`, а не `401`/anonymous.
- `/health` падает отдельно для product и auth pool.
- DSN tests доказывают сохранение пароля и `search_path`, deploy tests — правильный tenant.
- Maintenance tests доказывают canonical lock order, остановку клиентов, production-first restart и fail-closed rollback.
- После production rollout diagnostics пятнадцать минут не показывают `SCRAM timeout`, `ECIRCUITBREAKER`, ложные anonymous-ответы или волну auth-denied.

## Ссылки

- `openspec/specs/local-services/spec.md`
- `openspec/specs/next-capacitor-client/spec.md`
- `openspec/specs/repository-operations/spec.md`
- `deploy/scripts/supabase-maintenance.sh`
- `docs/operations/branch-preview-environments.md`

## Заменяет

Нет.

## Заменено

Нет.
