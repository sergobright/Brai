# Единый Actions rail, inline reviews и web refresh

- Status: accepted
- Deciders: Владелец проекта
- Date: 2026-07-15
- Tags: actions, navigation, agents, local-first, engine

## Контекст

Actions navigation и весь review ledger были объединены в один sidebar-компонент.
Он одновременно монтировался в desktop right panel, mobile left drawer и mobile
info-sheet. Desktop contextual rail при этом не получал Actions content. В
результате списки пропадали слева, предложения дублировались, а Goal plan мог
оказаться отдельно от Goal. Повторный plan request также мог создать несколько
pending proposals одной Goal.

Engine использует общий Web/Android UI, но browser deployment не скачивает APK
или OTA archive: новая web-версия уже находится на сервере и применяется reload.

## Решение

- Один `ActionsWorkspaceNavigation` является content source desktop contextual
  rail и mobile page drawer. Он содержит `Все`, `Действия`, `Операции`, `Без
  цели`, active Goals и collapsed `Завершённые`, после чего заканчивается.
- Архив Goals остаётся на общей Archive page. Mobile drawer не показывает
  отдельный header/X; backdrop, Escape, Back и close-after-selection сохраняются.
- Actions не имеет постоянной правой info panel и отдельного mobile info-sheet.
  Desktop right panel существует только для выбранного Action/Operation detail.
- Review ledger детерминированно partition-ится в единственного inline owner:
  `goal_plan` принадлежит открытой Goal; `relation_add` и
  `activity_type_change` — своему work Item; `goal_discovery`, notifications и
  предложения без доступного subject — верхней части `Все`. Audit и undo
  используют ту же маршрутизацию.
- На одну Goal допускается не более одного queued/running execution или pending
  `goal_plan`. Повторный request возвращает существующий execution; после
  accept/reject можно создать новый. Postgres partial unique index защищает
  pending decision, а migration переводит старые дубли в `stale_context`.
- Membership picker добавляет одну новую Goal membership за операцию и не
  заменяет существующие связи. Создание Goal из picker пишет Activity create и
  зависимый Relation create одной Dexie transaction.
- Engine получает вычисленный platform capability. Android сохраняет явные
  download/install flows. Browser при найденной версии показывает `Обновить
  страницу` и вызывает `window.location.reload()`.

## Последствия

- Navigation content существует в одном месте и одинаков на desktop/mobile.
- AI review остаётся рядом с объектом, которому принадлежит, без параллельной
  proposal system или новых UI dependencies.
- Retry plan request становится безопасным при timeout, повторном клике и гонке.
- Browser update не имитирует скачивание; Android integrity/install boundary не
  меняется и новый APK для этого решения не требуется.

## Дополнение 2026-07-18: рекомендации отключены по умолчанию

После проверки реального Actions UX автоматические Goal-agent рекомендации
переведены в explicit opt-in. Product не показывает сохранённые proposal-панели
и кнопку генерации плана, а API без
`BRAI_GOAL_AGENT_RECOMMENDATIONS_ENABLED=true` не создаёт новые classifier,
matcher, member-finder, discovery или planner executions. Это не отключает
нормализацию новой Action/Inbox записи и не удаляет существующий review ledger.
Постоянный Action badge `AI` удалён; компактный processing marker существует
только пока обычная AI-нормализация действительно queued/running и исчезает при
completed.

## Проверка

- Component/E2E проверяют exact rail, отсутствие drawer X/info-sheet/right
  fallback и единственное inline-размещение каждого review kind.
- API tests проверяют retry, concurrent POST, duplicate migration и новый plan
  после accept/reject.
- Storage tests проверяют атомарный Goal create + membership intent.
- Engine tests проверяют browser reload и неизменный Android download action.
- Published HTTPS Preview проверяется после login на desktop/mobile через Chrome
  DevTools: DOM/a11y, console, network и реальные flows.

## Заменяет

- `20260713-relations-goal-agent-service-architecture.md` только в части решения
  использовать desktop right panel для Actions navigation/reviews.
- `20260713-contextual-rail-archive-and-feedback.md` не заменяется: это решение
  уточняет Actions content для уже принятого contextual rail.
