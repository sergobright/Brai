# Better Auth как отдельный stateless-сервис с digest promotion

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-15
- Tags: authentication, services, postgres, caddy, deployment

## Контекст

Better Auth сейчас встроен в `brai-api`, разделяет с ним process lifecycle и
Supavisor path. Это мешает независимо наблюдать и восстанавливать auth, а отказ
auth backend уже требовал отдельного fail-closed контракта. При этом Brai-specific
onboarding, application user projection и остальные доменные данные не являются
ответственностью authentication runtime.

Privileged Caddy, Compose, sudoers и root helper устанавливаются только из
канонического `main`, тогда как Preview runtime деплоится из точного task SHA.
Production имеет одного владельца, поэтому перенос активных sessions дороже и
рискованнее одного повторного OTP-входа.

## Решение

- Выделить минимальный Node.js 22 `brai-auth` вокруг неизменённого Better Auth,
  сохранив Brai onboarding и `public.user` в `brai-api`.
- Держать auth sessions в отдельной environment-scoped Postgres schema с
  least-privilege role; контейнер остаётся stateless и ходит напрямую в private
  `supabase-db:5432` с pool `max=2`.
- Разделить доставку: сначала inert `docs/infra` bootstrap без container/schema/
  secret/route activation, затем новая `runtime/product` ветка из обновлённого
  `origin/main` с реальным Preview.
- Строить image один раз из Preview SHA, деплоить только
  `ghcr.io/sergobright/brai-auth@sha256:...` и продвигать тот же digest через Dev
  в Production без rebuild.
- Не переносить Production session/verification rows. Сохранить durable user id,
  установить новый secret и потребовать один свежий email-OTP вход.
- Менять Caddy route только fixed root helper-ом под environment/lease/Caddy locks;
  Preview route, container, schema и env принадлежат одной exact lease.

## Рассмотренные альтернативы

- Оставить постоянный auth facade внутри `brai-api`: отклонено, потому что не даёт
  отдельного deploy/failure boundary.
- Копировать sessions и сохранять secret: отклонено как лишняя миграция с худшим
  rollback и security profile.
- JWT/JWKS, mTLS, NATS, Kubernetes или отдельный gateway: отложено до измеренной
  потребности; bounded same-host session lookup закрывает первый extraction.
- Оставить auth на Supavisor tenants API: отклонено, потому что сохраняет общий
  failure path, ради устранения которого создаётся сервис.

## Последствия

- Плюс: auth получает собственные readiness, storage privilege и rollback boundary.
- Плюс: Preview проверяет точный image и route, которые затем продвигаются дальше.
- Минус: первая Production активация намеренно завершает старую сессию.
- Риск: split delivery требует строгой проверки main bootstrap и exact lease;
  любой mismatch блокирует мутацию до route/container/schema change.

## Проверка

- Bootstrap check/apply/check доказывает отсутствие auth schema/container/secret и
  активных routes, а также неизменность прежних HTTPS маршрутов.
- Helper tests отклоняют mutable image, неизвестный environment, произвольные
  paths и stale Preview lease; Caddy reload failure восстанавливает fragment.
- Runtime Preview связывает branch, SHA, lease generation, auth digest, schema,
  Caddy route и Temporal facts до ready.
- Dev и Production используют только digest, проверенный этим Preview; удаление
  старых auth tables разрешено лишь после свежего OTP-входа владельца.

## Ссылки

- `openspec/changes/extract-brai-auth-service/`
- `docs/adr/20260715-auth-pooler-failure-isolation.md`
- `docs/operations/branch-preview-environments.md`
- `docs/operations/temporal-ci-cd.md`

## Заменяет

Нет.

## Заменено

Нет.
