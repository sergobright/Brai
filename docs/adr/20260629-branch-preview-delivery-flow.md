# Процесс доставки preview-веток

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-06-29
- Tags: delivery, preview, deployment

## Контекст

Runtime/product-изменения требуют видимой проверки перед acceptance, а docs/infra-only изменения можно подтверждать checks и no-preview handoff.

## Решение

`main` деплоит production. Ветки `codex/*` используют task starter и delivery classification. Runtime/product branches деплоятся в preview slots A-E; docs/infra и technical-no-preview branches могут использовать no-preview path.

## Рассмотренные альтернативы

- Commit напрямую в `main`: отклонено, потому что работа по реализации требует checks и handoff перед acceptance.
- Требовать preview для каждого изменения: отклонено, потому что docs/infra changes не требуют выделения browser slot.

## Последствия

- Плюс: product work получает preview URLs для ревью, а техническая docs/infra work избегает лишнего использования slots.
- Минус: агенты должны точно соблюдать starter и handoff procedures.
- Риск: misclassification может либо пропустить нужный preview, либо потратить preview capacity впустую.

## Проверка

Используйте `scripts/brai-task-start.sh <task-slug>` перед tracked project-file work и классифицируйте delivery перед handoff.

## Ссылки

- `AGENTS.md`
- `docs/operations/branch-preview-environments.md`
- `docs/guidelines/07-git-versioning-repository-sync.md`

## Заменяет

Нет.

## Заменено

Нет.
