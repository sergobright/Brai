# Relations как Item-граф, Goal как Activity subtype и специализированные agent services

- Status: accepted
- Deciders: Владелец проекта
- Date: 2026-07-13
- Tags: архитектура, relations, goals, agents, temporal, local-first

## Контекст

Brai уже хранит устойчивую идентичность сущностей в `items`, широкие ролевые
домены в `item_role_types`/`item_roles` и role-specific payload в отдельных
таблицах. Эта модель отвечает на вопросы «что за сущность существует» и «в каком
домене она сейчас участвует», но пока не умеет выразить, как одна сущность
относится к другой.

Из-за этого Actions и нормализованные Operations существуют изолированно. Нельзя
канонически сказать, что сегодняшнее действие является частью более крупной цели,
нельзя пройти по цепочке смысла вверх, а агенты не имеют общего проверяемого графа
для построения будущего контекста.

Долгосрочное продуктовое направление — показать человеку непрерывную восходящую
цепочку влияния:

```text
Action / Operation -> Goal -> Quest -> Mission -> Level -> Arc
```

За личной иерархией в будущем появится отдельный кооперативный/цивилизационный
контекст: совместные цели, вплоть до строительства лунной базы или сферы Дайсона.
Он потребует другой модели владения, прав, вкладов и управления и поэтому не
должен неявно проникать в личный v1.

Первый релиз обязан доказать ценность целиком, а не просто добавить пустую
универсальную таблицу. Выбранный вертикальный сценарий — Goals как именованные
списки в Actions workspace, членами которых являются Actions и нормализованные
Operations. Пользователь должен видеть, к каким Goals относится текущая работа,
фильтровать списки, редактировать membership и получать помощь нескольких узких
агентов.

Дополнительные ограничения:

- Goal не равен существующему Focus challenge;
- Action и Goal имеют одинаковый Activity payload/lifecycle и не должны
  одновременно быть текущими типами одного Activity;
- Relations должны быть достаточно универсальны для symmetric/directed
  семантики и будущей иерархии, но без преждевременной graph database;
- Canonical факт и AI proposal нельзя смешивать;
- пользователь хочет бесшовную автоматизацию: технические последствия не требуют
  подтверждения, а агентов после измеренной калибровки система включает сама;
- новые придуманные агентом Goals и планы всё равно назначают человеческий смысл,
  поэтому требуют явного редактируемого принятия;
- продукт local-first на Web/Android, а domain mutation выполняется только
  детерминированным серверным кодом;
- отдельные agent responsibilities должны иметь собственные версии, качество и
  failure domains;
- Relations в перспективе станут отдельным microservice, но v1 не должен сразу
  платить цену distributed consistency.

## Решение

### 1. Relations связывают canonical Items

Canonical Relation — бинарный temporal факт между двумя `items.id` одного
пользователя. Endpoint payload не копируется, raw role rows до нормализации не
связываются, отдельный слой entity identity не создаётся.

Relation type задаёт:

- system/user ownership и stable key;
- `symmetric` или `directed` directionality;
- source/target labels для directed типов;
- ordered/unordered behavior;
- lifecycle `candidate|active|retired`;
- queryable endpoint rules через stable role-domain/local-type keys.

Symmetric endpoint pair канонизируется по ID. Directed Relation сохраняет
семантические source/target. Accepted факты живут в `relations`; proposals — в
decision ledger. End не удаляет Relation, а закрывает interval. Повторное
добавление создаёт новый ID/interval.

### 2. Иерархия использует один directed `part_of`

Система seed-ит один immutable ordered Relation type `part_of`. Направление
всегда снизу вверх: lower-level source -> next-higher target. В v1 допустимы
только:

```text
activity/action -> activity/goal
inbox/operation -> activity/goal
```

В будущем те же semantics расширяются только соседними уровнями:

```text
Goal -> Quest -> Mission -> Level -> Arc
```

Skip-level edges, Goal nesting и отдельные relation types вроде
`action_to_goal` не создаются. Один lower Item может иметь несколько родителей
следующего уровня; один parent — несколько children. Восходящий смысл вычисляется
транзитивным обходом `part_of`, а не дублирующими shortcut edges.

### 3. Goal — closed system subtype Activity

Добавляется system `activity_type_id = goal`. Goal использует существующий
Activity payload, active `activity` role, Markdown description и `New/Done`.
Отдельные Goal table, Goal role type и temporal type-assignment table не
создаются.

`action` и `goal` — взаимоисключающие текущие типы. Переход сохраняет Item и
Activity role, добавляет immutable `activity.type_changed` event и обновляет
current projection. Техническая reconciliation Relations происходит
детерминированно в той же операции: сохранить valid, а invalid edge закрыть без
замены. Общий reconciliation contract сохраняет reverse-ветку для будущего
Relation type/adjacent-level контракта, который явно её потребует, но две v1
endpoint rules `part_of` её никогда не используют: Action/Goal type change не
создаёт обратный `goal -> action|operation` edge.

### 4. Goal membership и completion

Membership — incoming ordered `part_of` Relations от Actions/Operations. Оно
many-to-many и независимо упорядочено внутри каждой Goal. Все members v1
обязательные.

Goal можно создать с 0 или 1 member, но завершить только при:

- минимум двух active valid non-deleted members;
- status Done у каждого Action member;
- service status Done у каждого Operation member.

Done Goal остаётся редактируемой: reorder/remove допустимы, добавить можно только
уже Done member. После любой влияющей мутации invariant проверяется повторно. Если
он нарушен, исходная пользовательская операция не блокируется, а Goal бесшовно
переоткрывается в New с causal reason/event/operation provenance.

В монолите v1 все Relation mutations и все Activity/Operation mutations,
способные изменить валидность Goal membership, сначала берут один
transaction-scoped mutation lock на пользователя, а уже затем list/endpoint/row
locks. Это намеренно грубая граница корректности: невидимый ещё Relation create
не может вклиниться между snapshot lookup member и Goal repair. При выделении
Relations service тот же порядок заменяется сериализацией owner command stream,
не меняя внешний контракт.

Тот же порядок начинается на внешней границе decision orchestration. Auto-apply,
accept, audit rejection и undo, способные применить или компенсировать graph
mutation, берут owner mutation lock до insert/`FOR UPDATE` decision/audit/domain
rows. Иначе deferred provenance FK позволяет Relation sync держать owner lock и
ждать decision row, пока resolver держит row и ждёт owner lock.

Delete Goal закрывает memberships, но не удаляет members. Restore возвращает Goal
как New и не resurrect-ит старые edges. То же правило действует для restore
member.

### 5. Inbox conversion сохраняет Item

После accepted classification нормализованный не-Operation Inbox Item может
получить Activity Action или Goal payload/role на том же Item, а active Inbox
role завершается. Inbox/raw/normalization history сохраняется. Entity merge и
семантическая дедупликация не выполняются.

Forced Operations всегда остаются Inbox Operations. После normalization/item
linkage они видимы в Actions workspace и могут быть Goal members, но их New/Done
status read-only для product UI и принадлежит Operation API. Legacy Activity
Operations остаются read-compatible; новые там не создаются.

### 6. Relations сначала принадлежат модулю, а не отдельному deploy

V1 реализует Relations owner module внутри текущих Brai API/Postgres. Только этот
модуль и deterministic apply Activities пишут Relation/policy/audit tables и
events. Другие модули вызывают commands/read contracts, клиенты используют API и
sync, agents не имеют DB credentials.

Boundary проектируется extraction-ready: stable IDs/DTO, exclusive table
ownership, explicit operation/compensation data и отсутствие SQL coupling у
consumers. Когда модель стабилизируется и независимое масштабирование оправдает
цену, in-process commands можно заменить service messages/saga/outbox без смены
product semantics.

### 7. Пять специализированных agents

Создаются отдельные logical agents и deploy/failure domains:

1. `activity.classifier` — Action vs Goal и same-Item Inbox conversion;
2. `goal.item-matcher` — найти существующие Goals для одного Action/Operation;
3. `goal.member-finder` — найти существующие Actions/Operations для одной Goal;
4. `goal.discovery` — объединить минимум два существующих work Items в editable
   proposal новой Goal;
5. `goal.planner` — по явной кнопке предложить 2..20 editable Action drafts.

Они используют один минимальный shared Node.js 22 runner для Temporal/LLM/schema
transport, но имеют отдельные manifests/entrypoints, queues, prompts, schemas,
versions, policies, systemd units и AI logs. Один worker не потребляет чужую
queue, не имеет public listener и DB credentials.

Эти пять имён обозначают service families. Production использует исходные
несуффиксированные unit names, а Dev и каждый Preview slot — отдельные
environment-qualified instances и Temporal queues. Это обязательная изоляция:
все environments используют один Temporal namespace, поэтому общая queue могла
бы отдать Preview workflow Production worker. Agent/prompt/policy identity при
этом не зависит от deployment suffix.

Agent process запускается под отдельным non-login Unix user/group
`brai-goal-agent`; его supplementary groups ограничены `brai-codex-exec` и
`brai-codex-auth`, без `brai`/`brai-deploy`. Он читает только
`/etc/brai/brai-goal-agents.env` (`root:brai-goal-agent`, `0640`) с
Temporal/LLM configuration и не может читать `/etc/brai/brai-api.env`, DB/API,
Caddy, deploy или signing secrets. Отдельный
`/srv/opt/codex-runtime/brai-goal-agent` имеет mode `0700` и только read-only
group-scoped links к shared Codex auth; deployed source для worker read/execute,
но не write. Systemd явно unset-ит DB/Supabase/Brai API credential variables.
API environment остаётся control plane для Postgres Activities, durable dispatch
и apply. API наблюдает agent pollers через Temporal task-queue description и
сохраняет heartbeat read model; worker не получает DB/API credential только ради
health.

Замена worker build использует минимальный fail-closed drain contract, а не
параллельный runtime старых версий. Под exact environment deploy lock generic
deploy сначала graceful-stop-ит соответствующий API unit и ждёт его полного
завершения. API — единственный producer/dispatcher Goal-agent executions, поэтому
после barrier новый execution уже не может вклиниться между проверкой и source
swap. Затем old target DB и Temporal проверяются по всем owners только выбранного
environment: любой `queued`/`running` execution с missing/different frozen build,
unmatched Temporal run, недоступная или unbounded проверка блокирует deploy до
swap. Same incoming agent build остаётся restart-safe только при равном
content-bound build встроенного API context worker. Каждый execution freeze-ит
`context_worker_build_id` в private input, API Context Activity проверяет его до
чтения данных, а drain сопоставляет frozen value с incoming build и trusted
recalculation из deployed source. Missing/malformed/mismatch или нечитаемый old
context source блокирует deploy без speculative parallel runtime.

Dev/Preview обычно refresh-ит schema из Production. Если первая quiesced-проверка
находит валидный same-build nonterminal state, deploy сохраняет existing target
data вместо TRUNCATE/reseed, применяет additive migrations и повторяет bounded
DB+Temporal check перед swap. При нулевом target state обычный refresh разрешён;
скопированные Production rows исключаются exact `deployment_environment` как в
post-setup check, так и в runtime reconciler.

Preserve разрешён только если `.brai-deploy-branch` deployed source совпадает с
incoming branch; reused slot другой ветки с nonterminal state блокируется даже
при равных hashes. Первый rollout на pre-0025 schema допускается без вечной
блокировки только после schema-aware доказательства отсутствия legacy Goal rows
и open exact-environment Temporal workflows, затем migrations и полный recheck.

При pre-swap failure ранее активный API запускается из неизменённого source.
Source swap считается provisional до bounded healthy start нового API; failure в
этом окне возвращает previous source и прежнее active/inactive состояние API.
После successful new API health поздний web/Admin failure не гасит API.
Отсутствие branch DB разрешено только для действительно нового slot/source при
inactive API; существующий или stale source требует полной проверки. Generic
deploy после swap перезапускает только API/Admin. Пять agent units остаются за
отдельным blocking `goal_agents_deploy` gate, поэтому v1 не получает speculative
parallel-worker/multi-build framework.

Cross-queue context Activity — security boundary, а не просто transport. При
создании execution API генерирует 32 random bytes: raw base64url capability
попадает только в frozen `input_json.execution_contract.context_capability` и
Temporal execution reference, а в отдельной колонке хранится только SHA-256
digest. Capability не попадает в descriptor/model context/result/log/Admin.
Каждый context Activity использует Temporal `activityInfo()` и требует точного
совпадения environment queue, `workflowExecution.workflowId` с reference и DB,
frozen manifest workflow type и capability hash. Первый valid Activity атомарно
bind-ит DB `run_id` к фактическому `workflowExecution.runId`; последующие вызовы
обязаны совпасть. Wrong workflow/type/queue/capability/run, direct call и replay
reference из другого run fail closed до чтения context. Только API context
worker имеет DB authority.

`workflow_executions` расширяется typed subject/trigger полями. Существующие
Inbox/Activity normalization ссылки `role_contract_id`/`raw_record_id` остаются
совместимыми, но discovery/planner/Item executions не маскируют user/watermark
или Item под raw Inbox record.

Matchers обрабатывают весь набор deterministic pages по 50 без silent
truncation. Discovery запускается после 5 relevant changes или 24 часов при
наличии хотя бы одного change; одновременно не больше одного run/user. Большие
наборы проходят page-map и bounded cluster merge. Успех двигает watermark,
failure сохраняет range для retry.

### 8. Agents предлагают, deterministic Activities применяют

Agent получает bounded versioned snapshot/catalog envelope и возвращает
structured JSON с decision kind, subject, confidence `[0,1]`, bounded rationale,
evidence и typed proposal. Каждая completed или provider-reported failed LLM
invocation, результат которой пересёк durable Temporal boundary, имеет ровно
один `ai_logs` row. Если process погиб после принятия запроса провайдером, но до
наблюдаемого результата, workflow attempt остаётся `unknown`; система не пишет
fake AI log. Следующий фактический retry получает отдельную строку. Без
provider idempotency абсолютный provider-side exactly-once не заявляется.

Каждый observable real call фиксируется отдельной durable transaction с exact
`llm_call_id` до envelope validation, decision persistence и domain apply.
Ошибка AI-log persistence блокирует apply; последующая validation/apply failure
не откатывает уже committed AI log. Reuse того же immutable call возвращает ту
же строку, а несовпадающая provenance под тем же ID fail-ит. Crash до
observable result остаётся `unknown` без выдуманной success/failure строки.

Agent не пишет Items/Roles/Relations/events/decisions/policies. Deterministic
apply перепроверяет user scope, current revision, role/type, endpoint rules,
duplicates, Goal invariants, policy и idempotency. Stale context не применяется и
может поставить fresh analysis. Schema errors могут вернуть structured context до
трёх consecutive validation failures; business/DB errors не вызывают новый LLM
call.

Reviewable decision повторно сверяется с frozen workflow snapshot внутри самой
resolution transaction непосредственно перед mutation. Relation
`origin_decision_id` является reserved deterministic provenance: public sync не
может его назначить, а DB связывает его с decision того же owner. Compensation
не откатывает поле, если original causal event уже перекрыт более поздним
пользовательским event; `compensated` остаётся terminal replay state исходной
operation.

Accepted draft packages применяются под one operation identity. В текущем
Postgres — одной transaction; будущая service extraction сможет заменить её
saga, используя сохранённые compensation data.

### 9. Автоматизация включается системой после измеренной калибровки

Policy key изолирован по:

```text
user + agent_id + agent_version + prompt_version + model + schema_version + decision_kind
```

Каждый новый key начинает в shadow. Accept/reject agent decisions дают labels;
manual user mutations labels не дают. Система автоматически выбирает самый
покрывающий/низкий cutoff, для которого есть минимум 25 labels at-or-above и
observed precision не ниже 95%. Если такого нет, остаётся shadow. При activation
пользователь получает одно informational notification, без подтверждения.

Active policy auto-accepts только valid simple decisions at-or-above threshold.
Below threshold остаётся review. Любая смена prompt/model/schema/agent version
создаёт новый shadow key. `goal.discovery` и `goal.planner` всегда review-only,
даже при высокой точности.

После 100 auto-accepts или 30 дней audit window становится due. Batch создаётся
только при наличии ровно пяти выбранных eligible решений: три ближайших выше
threshold и два случайных из remainder; partial batch запрещён. Если к 30 дням
есть 1..4 eligible решения, граница window не сдвигается, а пятое решение
атомарно создаёт один idempotent five-item batch. Due date batch — 14 дней.
Audit non-modal; при overdue policy возвращается в shadow до следующих решений,
но обычная работа не блокируется. Rejection/undo — negative label плюс
compensating operation; precision пересчитывается, degradation ниже 95%
возвращает policy в shadow.

### 10. Пользовательский UX бесшовный и local-first

Actions navigation содержит `Все`, `Действия`, `Операции`, `Без цели`, затем
Goals и collapsed completed Goals. Desktop использует существующую правую панель,
mobile — существующий левый drawer. `Все` не показывает Goal rows.

Выбор Goal фильтрует work list. Вне Goal row показывает до двух Goal badges и
`+N`. Пользователь получает полный Goal CRUD, membership picker/remove/reorder.
Обычный add input внутри Goal создаёт Action и membership как one durable local
intent. Operation status остаётся read-only.

Dexie хранит Goal/Relation state/outboxes, decisions/audits и causal dependencies.
Activity create и зависимый Relation create пишутся в одной local transaction;
Relation sync ждёт не только Activity event ack, но и canonical `item_roles_id`
после асинхронной normalization из PR #269. Если race всё же достиг сервера,
same-user raw endpoint возвращается как retryable `endpoint_not_ready` без
ack/ignored event; truly missing/cross-user endpoint остаётся invalid. Pending
intent переживает reload/app kill/offline restart. Migration failure сохраняет
старую DB, а не очищает её.

Review/audit inline и non-modal. Технические cascade consequences, automatic
reopen, thresholds и workflow IDs не показываются как подтверждение: они доступны
в history/Admin.

### 11. Admin остаётся read-only observability

Admin показывает Relation contracts/facts/history, decisions, policies,
precision/threshold/audits, пять services/queues/workflows/runs/attempts/AI logs и
integrity diagnostics. Он не становится direct edit path. Все schema objects
получают `table_descriptions`, agents/workflows — canonical registry definitions,
а installation пяти systemd services синхронно отражается во внешнем
deployment registry, обязательном по workspace rules, без secrets.

## Рассмотренные альтернативы

- **Добавить только универсальную таблицу Relations.** Отклонено: таблица без
  полного пользовательского сценария не проверяет ценность и оставляет API,
  lifecycle, sync и semantics неопределёнными.
- **Отдельная Goal role/table.** Отклонено: Goal и Action используют один payload,
  lifecycle и являются mutually exclusive Activity subtypes. Новая роль нужна
  только если позже они должны сосуществовать на одном Item или получат
  независимые payload/lifecycle/ownership.
- **Оставить Goal равным Focus challenge.** Отклонено: Focus challenge управляет
  фокус-сценарием, semantic Goal соединяет работу в долгосрочную иерархию.
- **Создать отдельные relation types для каждой пары уровней.** Отклонено:
  размножает одинаковую семантику и усложняет traversal. Один adjacent `part_of`
  достаточно выразителен.
- **Сделать все Relations directed.** Отклонено: у будущих отношений может не быть
  естественного направления. Directionality принадлежит type contract.
- **Разрешить skip-level edges.** Отклонено: появляются противоречивые redundant
  facts. Влияние вверх вычисляется traversal.
- **Использовать N-ary Relation core.** Отклонено для v1: binary покрывает текущий
  сценарий. Реальная многоместная связь позже моделируется отдельным Item и
  бинарными participant relations.
- **Сразу вынести Relations в microservice.** Отклонено: до стабилизации domain
  contract distributed transaction/saga усложнит простой вертикальный slice.
- **Сразу использовать graph database.** Отклонено: indexed Postgres edges
  покрывают direct membership и будущие recursive queries; вернуться после
  измеренной нагрузки/latency.
- **Один универсальный AI agent.** Отклонено: classification, matching, discovery
  и planning имеют разные triggers, labels, risk, prompt и failure modes.
- **Пять полностью дублированных сервисных кодовых баз.** Отклонено: deployment
  isolation не требует дублирования transport/runtime plumbing.
- **Agents напрямую пишут БД.** Отклонено: model output находится за trust
  boundary; нужны deterministic validation, idempotency, audit и compensation.
- **Автоакцепт по заранее заданному confidence.** Отклонено: confidence не
  калиброван между agents/versions/users. Threshold должен выводиться из реальных
  labels.
- **Всегда спрашивать пользователя.** Отклонено как основной steady state:
  создаёт friction и противоречит seamless intent. Shadow нужен для измерения, а
  затем qualifying simple decisions включаются автоматически.
- **Автоматически создавать discovered Goals/plans.** Отклонено: это назначение
  смысла и создание новой пользовательской структуры, поэтому требуется
  editable explicit acceptance.
- **Показывать cascade preview перед type/relation changes.** Отклонено: технические
  последствия должны deterministic repair-иться бесшовно; explainability остаётся
  в history/Admin.
- **Использовать entity merge в matching.** Отклонено: identity resolution —
  отдельная сложная capability. Conversion использует тот же уже известный Item,
  а похожие разные Items не сливаются.
- **Сделать subtasks отдельными Items.** Отклонено для этой модели: будущие
  Action/Operation subtasks определены как атомарный payload-local checklist.

## Последствия

- **Плюс:** один canonical graph становится общей основой для UI, agents и
  будущего contextual traversal.
- **Плюс:** первый релиз сразу даёт понятную пользовательскую ценность через Goal
  lists и связь текущей работы со смыслом.
- **Плюс:** Goal переиспользует Activity identity/payload/sync и не создаёт
  дублирующую модель.
- **Плюс:** temporal facts, type events, decisions и compensations дают полную
  explainability без засорения обычного UX.
- **Плюс:** отдельные agents можно независимо версионировать, калибровать,
  отключать, масштабировать и диагностировать.
- **Плюс:** shadow-to-active policy уменьшает долгосрочный user friction, не
  включая automation вслепую.
- **Плюс:** local causal outbox сохраняет единый пользовательский intent даже при
  раздельных Activity/Relation sync domains.
- **Плюс:** module ownership позволяет доказать модель до microservice extraction.
- **Минус:** v1 требует согласованных изменений schema, API, Activities, Inbox,
  Temporal, пяти services, Dexie, Web/Android UI, Admin и deployment.
- **Минус:** temporal history и compensation сложнее hard-delete/update-in-place,
  но необходимы для agent audit и доверия.
- **Минус:** пять deploy units увеличивают operational surface, хотя используют
  общий runner.
- **Минус:** без graph/vector database большие future traversals или semantic
  candidate search могут позже потребовать отдельного решения.
- **Минус:** threshold с 25 labels означает период shadow review для каждого
  нового exact policy key.
- **Риск:** confidence может быть плохо калиброван или labels слишком редкими;
  policy останется shadow, что безопасно, но снизит seamless benefit.
- **Риск:** cross-domain type/status/delete events могут породить сложные race
  conditions; нужны locks/revision checks/idempotent repair и exhaustive matrix
  tests.
- **Риск:** ignored OpenSpec change хранится в task worktree по принятой repo
  convention; ADR остаётся tracked указателем, а реализация обязана использовать
  linked change до его archive.
- **Риск:** если Goal позже потребует coexistence с Action, собственный lifecycle
  или cooperative ownership, решение о subtype нужно пересмотреть новым ADR.

## Проверка

Будущая реализация следует ADR, если одновременно выполняется всё ниже:

- Relation endpoints — только same-user `items.id`; accepted facts отделены от
  decisions/proposals.
- `part_of` один, directed lower->higher, ordered и только adjacent; v1 endpoint
  rules ровно Action/Operation->Goal.
- Goal хранится как system Activity type, а не новая broad role/table; Action и
  Goal не являются current одновременно.
- Type transition сохраняет Item/Activity role и добавляет immutable event.
- Relation end/re-add/undo сохраняют history; hard-delete canonical facts не
  используется.
- Done Goal требует минимум двух Done members и автоматически reopening при
  нарушении invariant.
- Inbox conversion использует тот же Item, forced Operations не конвертируются.
- Пять agent IDs, queues, policies и deploy services существуют отдельно, shared
  runner не смешивает их prompts/responsibilities.
- Product producer для этих proposal agents выключен по умолчанию отдельным
  opt-in gate; control-plane workers остаются изолированными и проверяемыми, но
  без явного включения не получают новые пользовательские recommendation runs.
- Effective worker build ID включает declared manifest base и детерминированный
  digest runtime content; изменение worker/API-context кода не переиспользует
  frozen definition/build молча.
- Existing-environment deploy до source/migration/API/worker swap graceful-stop-ит
  exact API producer и fail-closed проверяет target DB + Temporal nonterminal
  executions против incoming agent/context builds; old/different/unknown build блокирует, same
  build restart-safe и сохраняет Dev/Preview ledger от reseed, post-setup recheck
  обязателен, а pre-swap failure возвращает old API из unchanged source.
- Preview/Dev/Production имеют отдельный blocking Temporal gate
  `goal_agents_deploy_started/passed/failed` для restart, exact poller/build health
  и worker-deployment promotion.
- В branch Preview generic exact-SHA gate сначала делает совместимые API/client
  доступными, затем отдельный `goal_agents_deploy` gate может сразу запустить пять
  workers без human pause или второго release. Это не обходит rollout boundary:
  каждый новый exact policy key начинается в shadow, discovery/planner всегда
  review-only, agents не имеют direct domain writes, а acceptance остаётся
  заблокированным до manual/offline/existing-client QA.
- Preview deploy исполняет orchestration-код exact branch SHA во временном
  SHA-qualified Temporal worker/workflow, поэтому ещё не принятый workflow-код
  не подменяет глобальный Production worker и не интерпретируется его старой
  версией.
- Generic application deploy оставляет slot lease в `deploying`; отдельный
  Goal-agent gate проверяет пять exact pollers/builds, API context poller,
  promotion и один реальный agent-to-API cross-queue workflow. Только после него
  CAS-переход того же branch/SHA переводит слот в `ready`.
- Все Preview gates и handoff сверяются с authoritative head SHA; поздний результат
  старого SHA остаётся историей и не может изменить readiness или slot lease
  нового SHA.
- Agents не имеют DB credentials/public ports и возвращают только structured JSON.
- Каждый observable completed/provider-failed LLM call имеет один AI log;
  crash-window остаётся unknown, а deterministic retry не изображает новый
  model call.
- Exact policy starts shadow; activation требует 25 labels и >=95% precision;
  audit 5 after 100 or 30 days, due 14 days.
- Discovery/planner всегда editable review-only.
- Dexie pending Activity/Relation intent переживает offline/restart и sync-ится в
  causal order.
- Product UI не показывает Goals как rows в All и не позволяет менять Operation
  status; desktop/mobile используют оговорённые панели.
- Admin read-only; table/agent/workflow/deployment registries актуальны.
- Existing Actions, Focus challenge, Inbox и `/v1/actions` compatibility tests не
  регрессируют.
- Preview проходит exact desktop/mobile/offline/agent failure/calibration/audit
  scenarios до принятия.

Если любой из этих пунктов невозможно выполнить из-за фактической архитектуры,
нужно сначала обновить OpenSpec и этот ADR, а не молча выбрать альтернативу.

## Ссылки

- [OpenSpec proposal](../../openspec/changes/relations-goal-lists/proposal.md)
- [OpenSpec design](../../openspec/changes/relations-goal-lists/design.md)
- [OpenSpec implementation tasks](../../openspec/changes/relations-goal-lists/tasks.md)
- [Entity-role architecture spec](../../openspec/specs/entity-role-architecture/spec.md)
- [Activities spec](../../openspec/specs/activities/spec.md)
- [Agent mutation workflow spec](../../openspec/specs/agent-mutation-workflows/spec.md)
- [Development guidelines](../DEVELOPMENT_GUIDELINES.md)

## Заменяет

Нет.

## Заменено

Нет.
