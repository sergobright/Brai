# AGENTS.md

This file routes agents to the project rules.

## Route

- Before development, debugging, refactoring, review, UI work, API/DB changes, releases, commits, infrastructure work, or publication, read [docs/DEVELOPMENT_GUIDELINES.md](docs/DEVELOPMENT_GUIDELINES.md).
- For the first Bright OS question in a working context, read [docs/DEVELOPMENT_GUIDELINES.md](docs/DEVELOPMENT_GUIDELINES.md), [docs/AGENT_CONTEXT.md](docs/AGENT_CONTEXT.md), and `memory-bank/activeContext.md`; for status, version, release, or deployment questions also read `memory-bank/progress.md`.
- Keep detailed development rules in `docs/guidelines/`, not here.

## АХТУНГ: ЭТОТ БЛОК ТЫ ОБЯЗАН ПОМНИТЬ ВСЕГДА И НЕ ЗАБЫВАТЬ И НЕ СЖИМАТЬ

- После сжатия контекста, перед продолжением правок и перед финальным ответом, если были изменения файлов проекта, перечитать `AGENTS.md`.
- Read-only анализ, планирование и вопросы без project-file writes не требуют новой ветки.
- Перед первой правкой файлов проекта в новом Codex thread всегда запускать официальный starter от актуального `origin/main`: `scripts/bright-task-start.sh <task-slug>`; выбранная UI ветка не имеет значения.
- Нельзя вручную создавать/switch-ить fallback ветки через `git switch`, `git checkout`, `git branch`, `git worktree`.
- Если текущий thread уже вывел ветку на preview и пользователь ещё не принял её, прямые follow-up правки в этом же thread идут в ту же `codex/*` ветку через `node scripts/bright-task.mjs follow-up`.
- Пока preview/follow-up ветка не принята, не подтягивать в неё новый `origin/main`: не делать `git fetch origin main`, `git pull origin main`, `git merge origin/main`, `git rebase origin/main` и эквиваленты. База задачи заморожена в `.bright-task/task.json` с момента starter; новые изменения `main` учитываются только после принятия или в новой задаче.
- Если ветка уже принята через PR/merge в `main`, любые новые правки, даже в этом же thread, обязаны начинаться с новой `codex/*` ветки от `origin/main`.
- Если в процессе работы пришёл вопрос и пользователь не сказал остановиться/пауза/только ответь, ответить на вопрос, принять новые данные в контекст и продолжать задачу.
- Если во время задачи обнаружена процедурная проблема, ошибочный шаг, sandbox/escalation trap, нехватка инструмента/документации или вынужденный обходной путь, мешающий качественной работе, добавить короткую запись в конец корневого `TASKS.md`: дата, проблема, обходной путь/что исправить; секреты не записывать.
- Перед завершением классифицировать доставку по guard-классу: `runtime/product`, включая runtime bugfix, идёт через preview; `docs/infra` guard-fix идёт через no-preview PR/auto-merge в `main`.
- Для preview-class финальный implementation response начинается строго с verified header из `scripts/bright-preview-handoff.sh`: `<slot emoji> Preview`, затем URL, branch, commit.
- Если пользователь после preview говорит `Принято`, `принимаю`, `accepted` или эквивалент без отрицания, запускать `deploy/scripts/accept-preview.sh <codex-branch>` и мониторить PR/merge/prod deploy/slot release.
- Короткие ссылки: [docs/DEVELOPMENT_GUIDELINES.md](docs/DEVELOPMENT_GUIDELINES.md), [docs/guidelines/07-git-versioning-repository-sync.md](docs/guidelines/07-git-versioning-repository-sync.md), [docs/operations/branch-preview-environments.md](docs/operations/branch-preview-environments.md), [docs/operations/temporal-ci-cd.md](docs/operations/temporal-ci-cd.md), [docs/checklists/CHECKLIST_REPOSITORY_SYNC.md](docs/checklists/CHECKLIST_REPOSITORY_SYNC.md).
- Исключение: работа внутри `admin/` следует `admin/AGENTS.md`; это standalone admin project, не обычный preview-slot flow.

## Final Preview Handoff

- After `scripts/bright-preview-handoff.sh` succeeds, the final implementation response MUST start with that command's preview header: `<slot emoji> Preview`.
- Put no text before that header. Then include the preview URL, branch, and commit before any summary.
