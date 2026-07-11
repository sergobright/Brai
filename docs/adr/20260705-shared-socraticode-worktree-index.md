# Общий индекс SocratiCode для worktrees

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-05
- Tags: агенты, worktrees, codebase-context

## Контекст

Работа по реализации в Brai выполняется в Git worktrees. Индексация по path-hash может заставить каждый новый worktree выглядеть как отдельный неиндексированный проект.

## Решение

Brai коммитит стабильный SocratiCode `projectId` и предоставляет `npm run socraticode:ensure`, чтобы main и task worktrees использовали один семантический index.

## Рассмотренные альтернативы

- Индексировать каждый worktree отдельно: отклонено, потому что это дублирует работу и оставляет новые task branches без прогретого индекса.
- Требовать ручной MCP bootstrap для каждого worktree: отклонено, потому что об этом легко забыть и трудно проверить.

## Последствия

- Плюс: semantic search, code graph и context artifacts сходятся между main и task worktrees.
- Минус: изменения project identity должны быть намеренными и проверенными.
- Риск: stale watcher state все еще может требовать ensure/preflight repair.

## Проверка

Запускайте `npm run socraticode:ensure`, когда общий index отсутствует, неполный или устарел.

## Ссылки

- `.socraticode.json`
- `.socraticodecontextartifacts.json`
- `memory-bank/decisionLog.md`

## Заменяет

Нет.

## Заменено

Нет.
