# Защитные правила доставки для агентов

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-06-29
- Tags: агенты, delivery, guardrails

## Контекст

Работа агента может случайно изменить отслеживаемые файлы на неправильной ветке, обойти preview workflow или оставить завершенные изменения OpenSpec активными.

## Решение

Brai обеспечивает доставку агентских изменений через `scripts/brai-task.mjs`, Codex hooks, Git hooks, классификацию delivery, OpenSpec validation, public guard и требования preview/no-preview handoff.

## Рассмотренные альтернативы

- Доверить агентам помнить процедуру: отклонено, потому что контекст может сжиматься, а несколько инструментов могут менять файлы.
- Использовать Git branches вручную как fallback: отклонено, потому что официальное task state должно оставаться авторитетным.

## Последствия

- Плюс: работа по реализации имеет детерминированную ветку и handoff flow.
- Минус: легитимные операции могут требовать escalation, когда инструменты в sandbox не могут писать refs или runtime ledgers.
- Риск: расхождение hooks может ослабить enforcement, если hooks не синхронизировать и не проверять.

## Проверка

Запускайте `scripts/brai-guard-sync-check.sh --check` и task tests при изменении поведения delivery guard.

## Ссылки

- `AGENTS.md`
- `scripts/brai-task.mjs`
- `docs/operations/branch-preview-environments.md`

## Заменяет

Нет.

## Заменено

Нет.
