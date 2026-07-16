# История версий по завершённым работам

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-14
- Tags: versions, delivery, github, postgres

## Контекст

Одна завершённая работа Brai может потребовать owner PR и несколько отдельно доставляемых support PR. Прежняя модель создавала build из одного принятого PR и связывала версии с Git по времени или target commit, поэтому параллельные работы было невозможно группировать доказуемо. Та же таблица смешивала историю выполненной работы с фактами публикации web/OTA и APK-артефактов.

## Решение

Каждая задача получает неизменяемый публичный `work_key` и роль `owner` или `support`. Support-задача создаётся только официальным starter и наследует ключ owner-задачи, но сохраняет собственную ветку и frozen base.

Postgres хранит work lifecycle, полные публичные GitHub PR snapshots, атомарные детали версий и типизированные связи version-to-PR. Build означает одну полностью завершённую работу и финализируется owner только после terminal state всех зарегистрированных PR. APK и будущие platform types остаются независимыми версиями опубликованных артефактов. Browser web и Android OTA продолжают использовать собственные `X.Y.Z` artifact versions и не обязаны увеличиваться вместе с build.

Исторические связи восстанавливаются только по точным GitHub, Git, release, artifact, Preview и Temporal evidence. Временная близость, соседний номер PR и диапазон коммитов не являются доказательством.

## Рассмотренные альтернативы

- Один build на каждый PR: отклонено, потому что одна работа может требовать нескольких независимо принятых PR.
- Группировка по времени merge или диапазону Git: отклонено, потому что она захватывает конкурентные работы.
- Ручной список support PR при handoff: отклонено как недетерминированный и легко неполный.
- Использовать build counter как web/OTA version: отклонено, потому что server, docs и infrastructure work не всегда публикуют клиентский артефакт.

## Последствия

- Плюс: история работы, PR provenance и platform releases становятся проверяемыми и независимо запрашиваемыми.
- Плюс: support PR не теряется и не создаёт ложный отдельный build.
- Минус: task starter, GitHub reconciliation, promotion и release metadata должны нести общий work contract.
- Риск: owner finalization блокируется, если GitHub snapshot любого support PR устарел; reconciliation обязан обновить все PR работы перед записью версии.

## Проверка

- Дважды выполнить idempotent historical backfill и сравнить identities и статистику.
- Проверить schema constraints, owner/support lifecycle и fail-closed native release metadata.
- Проверить публичный cursor API, CORS, DTO allowlist и отсутствие runtime secrets.
- Выполнить Preview QA Engine history после принятия shared page shell.

## Ссылки

- `openspec/changes/normalize-version-work-history/`
- `supabase/migrations/0033_normalize_version_work_history.sql`
- `services/brai_api/src/store-version-history.js`
- `scripts/brai-task.mjs`

## Заменяет

Нет.

## Заменено

Нет.
