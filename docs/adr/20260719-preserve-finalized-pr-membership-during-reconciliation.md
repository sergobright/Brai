# Неизменяемость финализированной принадлежности PR при reconciliation

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-19
- Tags: delivery, release-ledger, production, reconciliation

## Контекст

При production promotion reconciliation перечитывает merged `codex/*` PR из
GitHub и восстанавливает незавершённые release work по их публичным marker.
Исторический marker может противоречить уже сохранённой в production ledger
связи: например, PR записан как `support` у финализированной работы, но его
старое тело на GitHub объявляет его `owner` другой работы. Попытка обработать
такой PR повторно приводит к корректному fail-closed отказу хранилища, но
блокирует доставку уже принятой работы.

## Решение

Production ledger остаётся авторитетным источником финализированной истории.
Bounded version-work state передаёт identities всех PR, принадлежащих
финализированным работам, вместе с их ключами. До создания кандидатов
reconciliation исключает такой identity, даже если GitHub marker противоречит
сохранённой роли.

Ни запись ledger, ни её роль не обновляются и не переносятся. Защита
`upsertGithubPullRequest` от конфликта между незавершёнными работами остаётся
неизменной.

## Рассмотренные альтернативы

- Переписать старый marker в GitHub: отклонено, потому что это меняет внешний
  исторический артефакт и не защищает от других старых marker.
- Разрешить `upsertGithubPullRequest` переносить PR между работами: отклонено,
  потому что это уничтожает fail-closed защиту release ledger.
- Игнорировать все marker после первого production release: отклонено, потому
  что reconciliation нужен для реально потерянных незавершённых работ.

## Последствия

- Финализированная история не может быть повторно присвоена новой работе.
- Действительно незавершённые работы продолжают восстанавливаться.
- Ошибки для non-finalized конфликтов по-прежнему останавливают promotion до
  явного исправления данных.

## Проверка

- Focused unit test моделирует PR, который уже финализирован как `support`, но
  имеет конфликтующий `owner` marker, и проверяет, что выбирается только
  настоящий pending PR.
- Delivery test проверяет экспорт finalized PR identities и передачу их в
  candidate selector.
- После принятия изменения production promotion завершается, не меняя
  историческую PR-to-work relation.

## Ссылки

- `openspec/changes/repair-production-ledger-pr-ownership/`
- `openspec/specs/repository-operations/spec.md`
- `deploy/scripts/ci-ssh-version-work-state.sh`
- `deploy/scripts/accepted-preview-branches.mjs`

## Заменяет

Нет.

## Заменено

Нет.
