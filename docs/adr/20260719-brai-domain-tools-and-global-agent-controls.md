# Bounded domain tools для Брая и глобальное управление агентами

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-19
- Tags: agents, codex, factory, authorization, actions, inbox

## Контекст

Изначальный debug-контракт `brai-codex` запрещал любые изменения данных. Для
полезного диалога Браю нужно по явной просьбе пользователя добавлять запись в
Actions либо Inbox, не превращая модель в произвольный DB-клиент. Одновременно
Factory должен показывать реальные runtime-агенты и позволять владельцу
глобально отключать неприемлемые фоновые рекомендации.

## Решение

- Codex thread регистрирует только два typed dynamic tools:
  `brai_create_action` и `brai_create_inbox`.
- Broker проверяет имя, bounded JSON-аргументы, ownership корреляции и возвращает
  App Server только bounded text result. Он не получает доступ к DB.
- Brai API выполняет tool в scope авторизованного пользователя через штатные
  доменные сервисы. Identity записи детерминирована user/thread/run/call, поэтому
  повторная доставка возвращает исходный результат без дубля.
- Tool вызывается только по явной просьбе с достаточным содержимым. При
  неоднозначном разделе или тексте Брай задаёт уточняющий вопрос без записи.
- Старый внутренний Codex thread без tool contract один раз заменяется новым.
  Ограниченный очищенный снимок видимой Postgres-истории передаётся как контекст;
  публичные сообщения и replay не переписываются.
- Factory показывает public-safe поля `agents` и owner-scoped `ai_logs`.
  Состояние агента является глобальным. Изменять его может только primary account
  и только для агентов с `metadata_json.user_toggleable=true`.
- Выключенный optional agent не получает новые producer-срабатывания и не
  dispatch-ит уже ожидающую очередь. Уже запущенная работа завершается штатно.
  Защищённые агенты, включая `brai-codex`, нельзя выключить из продукта.

## Последствия

- Модель не получает произвольный доступ к SQL, shell, Vault или внутренним API.
- Права на изменение данных совпадают с текущей пользовательской сессией.
- Глобальное выключение одинаково действует для всех аккаунтов и устройств.
- Primary account становится явной административной границей продукта.
- Однократный upgrade старого provider thread сохраняет видимую историю, но
  переносит только bounded недавний контекст во внутреннее состояние модели.

## Проверка

- API tests доказывают primary/secondary boundary, protected-agent lock и
  глобальную видимость статуса.
- Store/runtime tests доказывают остановку queued dispatch, owner scope,
  idempotent Action/Inbox creation и отсутствие скрытого bootstrap в replay.
- Broker tests доказывают allowlist dynamic tools, owner-scoped correlation и
  bounded text-only response.
- Preview QA проверяет Factory, переключатель primary account и реальные команды
  Браю на опубликованном HTTPS окружении.

## Ссылки

- `openspec/changes/stabilize-brai-chat/`
- `docs/adr/20260715-self-hosted-brai-codex-chat.md`

## Заменяет

Часть ограничения на любые data mutations из
`docs/adr/20260715-self-hosted-brai-codex-chat.md`: вместо полного запрета
разрешены ровно две bounded owner-scoped операции.

## Заменено

Нет.
