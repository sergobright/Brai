# Self-hosted чат Брай через Codex App Server и AG-UI

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-15
- Tags: codex, ag-ui, copilotkit, chat, isolation, security

## Контекст

Brai нужен полноценный persistent chat внутри статически экспортируемого Next.js/Capacitor клиента. На сервере уже есть авторизованный Codex, но browser-to-Codex доступ раскрыл бы внутренние identifiers, credentials и runtime. CopilotKit даёт готовый chat surface и AG-UI boundary, но не Brai ownership, Postgres history, Vault attachments или tenant isolation.

API уже содержит защищённые non-chat Codex executors для существующих workflow, включая Inbox. Этот change изолирует новый chat request path, но не заявляет удаление прежнего OS-level credential access; такая миграция имеет отдельный scope и rollout.

MVP не получает доступ к данным, проектам, DB, общему Vault или Docker Brai. Он временно использует одну подтверждённую владельцем подписочную авторизацию Codex для всех авторизованных пользователей. Это исключение нельзя расширять до общего provider-auth contract.

## Решение

- Статический client использует pinned `@copilotkit/react-core` `1.62.3` и обращается только к Better-Auth-protected Brai API; Copilot Cloud, managed thread storage и необязательная телеметрия не используются.
- Brai API использует pinned `@copilotkit/runtime` `1.62.3`, `@ag-ui/client` `0.0.57` и один custom AG-UI agent. Adapter преобразует pinned Codex App Server `0.144.4` JSON-RPC в стандартные AG-UI events и versioned safe `brai.*` custom events.
- Один allowlist/redaction boundary отбрасывает raw reasoning, credentials и host paths до stream, Postgres, logs и search; технический output ограничивается 64 KiB.
- Postgres является product source of truth для owner-scoped threads, messages, normalized events, attachments, replay и search. Persistent per-user `CODEX_HOME` остаётся provider state для native resume/reconciliation, но не заменяет Brai history.
- Отдельный localhost-only broker владеет Docker lifecycle и permissioned Unix socket. Brai API не получает Docker socket. Broker принимает только allowlisted operations и opaque identities.
- В новом chat request path API handlers не читают и не монтируют Codex credential: read-only credential получает только broker-managed user runtime. Существующий Inbox Codex executor остаётся отдельным legacy consumer и не используется чатом.
- Каждый пользователь получает on-demand non-root container без inbound ports, Brai source/API/DB secrets или чужого state. Root filesystem и пустой workspace read-only; per-user `CODEX_HOME` writable; shared auth и выбранные attachments read-only. Codex работает с `approval=never`, read-only sandbox и отключённой tool network.
- Active turn отделён от subscriber connection. Persist-before-fan-out и monotonic sequence обеспечивают replay; turn и idle deadlines равны 15 минутам, причём idle cleanup не останавливает active turn.
- Холодный CopilotKit consumer всегда получает полный Postgres-backed AG-UI replay. Sequence cursor принимается только при явном `resume` уже гидратированной локальной сессии и не может заменить полную историю. Messages, events, threads и artifacts обновляются независимо, поэтому частичный сбой проекции не очищает уже видимый ответ.
- Client держит BRAI session и CopilotKit provider смонтированными на уровне приложения при переходах между разделами. Последний активный тред хранится локально для пары user/environment, а управляемый черновик — отдельно для каждого треда.
- Runtime agent `brai-codex` зарегистрирован версионируемой identity-инструкцией. Она описывает BrightOS/Brai через статический architecture snapshot и явно сообщает debug-ограничения: нет живого репозитория, DB, Vault, внутренних данных, выполнения команд или изменения файлов. Каждый фактический turn пишет одну idempotent bounded запись `ai_logs`.
- Управляемый поиск разрешён только в режиме `cached`; live search, произвольная сеть и network-enabled commands запрещены. Новые треды получают реальный catalog ID модели с display name `GPT-5.6-Luna` и reasoning effort `medium`; существующие настройки не переписываются, а readiness завершается ошибкой при отсутствии закреплённой модели.
- Каждый `turn/start` явно запрашивает `summary: "auto"` по generated schema закреплённого Codex App Server `0.144.4`. AG-UI собирает только публичное reasoning summary по `summaryIndex` и границам частей; raw reasoning остаётся отключённым и не передаётся клиенту.
- `attachment_id` является единой identity сгенерированного изображения. Runtime проверяет файл, MIME, размер и SHA-256 до события `ready`, публикует один безопасный `brai.artifact.v1` без host path/base64/internal args и синтезирует «Изображение готово.», если модель не дала текст. Просмотр и `?download=1` используют owner-scoped авторизованный endpoint.
- Главное меню остаётся в существующем нижнем `MainDock`. `Брай` становится первым пунктом и route `/`; `Действия` переходят на `/activities`; `Inbox`, `Фокус`, `Factory`, `Draws` и служебный `DesktopRail` сохраняются.

## Рассмотренные альтернативы

- Прямой WebSocket client → App Server: отклонён из-за обхода Better Auth, ownership, persistence и sanitization.
- Copilot Cloud/managed threads: отклонены из-за self-hosted boundary.
- Один общий App Server process: отклонён из-за cross-user filesystem/state isolation.
- Docker socket в Brai API: отклонён, потому что API compromise становился бы host-equivalent.
- App Server-only history: отклонена, потому что не даёт Brai-owned replay, search и safe normalized contract.
- Отдельная artifact table: отклонена; стабильная проекция messages/events не дублирует payloads.
- Перенос primary navigation в desktop left rail: отклонён как несвязанная переработка действующего dock UX.
- Индивидуальная либо организационная provider authentication: вынесена в отдельный future change.

## Последствия

- Плюс: web и Android получают единый self-hosted chat contract без provider credentials в bundle.
- Плюс: owner scope, replay, search и attachments остаются под контролем Brai.
- Плюс: Docker privilege отделён от public API process.
- Минус: появляются pinned broker image и отдельный stateful runtime service.
- Минус: изоляция credential в этом решении ограничена chat request path; legacy Inbox executor сохраняет ранее выданный server-side доступ до отдельной миграции.
- Минус: shared subscription не даёт продуктовых квот и может упираться во внешние limits.
- Риск: App Server protocol меняется; generated schema, capability preflight и fail-closed readiness обязательны при upgrade.
- Риск: shared personal-account use нельзя считать готовой multi-user коммерческой моделью.

## Проверка

- Migration/API tests доказывают ownership, RLS, idempotency, archive/restore, replay, search и attachment cleanup.
- Adapter tests доказывают AG-UI ordering, cold full replay/resume distinction, `summaryIndex` reasoning boundaries, redaction, 64 KiB bound, detached replay, stop/steer/retry, single image artifact и safe errors.
- Broker tests доказывают RPC allowlist, path containment, per-user state, selected-file-only mounts, idle handling и отсутствие public ports/Docker socket внутри user container.
- Client tests доказывают persistent session mount, last-thread restore, independent projections, per-thread draft preservation, dock geometry и авторизованный image viewer/download.
- Preview QA проходит через опубликованный HTTPS route после Caddy и app login на desktop/mobile с console/network inspection.
- Upgrade Codex начинается с `codex app-server generate-ts` и сравнения required methods/events для новой pinned версии.

## Ссылки

- `openspec/changes/add-brai-codex-chat/`
- `openspec/changes/stabilize-brai-chat/`
- `openspec/specs/next-capacitor-client/spec.md`
- `openspec/specs/local-services/spec.md`
- [Codex App Server](https://learn.chatgpt.com/docs/app-server.md)
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
- [CopilotKit](https://github.com/copilotkit/copilotkit)

## Заменяет

Нет.

## Заменено

Нет.
