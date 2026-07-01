# TASKS.md

Журнал узких мест агента. Если во время задачи возникла процедурная проблема, ошибочный шаг, sandbox/escalation trap, нехватка инструмента/документации или вынужденный обходной путь, добавляй новую запись в конец файла.

Формат: `YYYY-MM-DD — проблема; обходной путь; что стоит исправить.` Секреты, токены, пароли и приватные ключи сюда не записывать.

## Открытые записи

- 2026-07-01 — escalated `scripts/bright-task-start.sh` создал task worktree файлами owner `nobody`, из-за чего `apply_patch` не мог писать; восстановить owner через `sudo chown -R mark:mark <task-worktree>` или исправить starter/runner ownership.
- 2026-07-01 — `npm run app:build` с Next/Turbopack падает в Codex sandbox на `binding to a port`/`Operation not permitted`; повторять build с `sandbox_permissions=require_escalated` или исправить sandbox allowance для Turbopack worker.
- 2026-07-01 — live SQLite backup в `/srv/projects/bright-os/data/backups` не создавался даже от владельца runtime DB `nobody`; держать verified `.backup` в `/tmp` и выполнять live SQL root-ом, затем отдельно чинить права backup-каталога.
- 2026-07-01 — `deploy/scripts/classify-delivery.mjs` из Codex sandbox может падать на `spawnSync git EPERM`; повторять классификацию с `sandbox_permissions=require_escalated`.
- 2026-07-01 — `npm run app:test` в task worktree падает на Vitest/Vite `EACCES`, когда linked `apps/bright_os_app/node_modules/.vite-temp` owned by `nobody:mark` с `750`; нужен owner/group-write fix для shared dependency dirs перед тестами, иначе фиксировать проверку как заблокированную окружением.
- 2026-07-01 — `npm run app:build` в Codex sandbox может падать Turbopack panic на `creating new process`/`binding to a port` с `Operation not permitted`; повторять build с `sandbox_permissions=require_escalated`.
- 2026-07-01 — `deploy/scripts/accept-preview.sh` читает receipt из текущего checkout; если основной checkout содержит receipt другой ветки, запускать accept из matching `.codex-worktrees/<task-slug>` и проверять `.bright-task/preview-handoff.json`.

## Закрыто

- [x] 2026-07-01 — после `acceptance_started` Bright OS git hooks блокировали даже merge/push для разрешения конфликтного accepted PR. Закрыто: добавлен official `acceptance-reconcile` flow для same-branch conflict resolution.
- [x] 2026-07-01 — закрытый без merge superseded `codex/*` PR оставлял preview slot занятым. Закрыто в PR #102: `pull_request.closed` release job освобождает slot для unmerged `codex/*` PR.
- [x] 2026-06-30 — `scripts/bright-task-start.sh` в Codex Desktop нужно запускать с `sandbox_permissions=require_escalated`; без этого starter не сможет нормально сделать fetch и записать git/worktree metadata; использовать эскалацию сразу для этого starter. Закрыто в PR #98: правило закреплено в runbook.
- [x] 2026-06-30 — `git add` в `.codex-worktrees/<task-slug>` из sandbox падает на создании `.git/worktrees/<task-slug>/index.lock`; повторять stage с `sandbox_permissions=require_escalated`, потому что git metadata лежит вне writable worktree. Закрыто в PR #98: правило закреплено в runbook.
- [x] 2026-06-30 — после escalated операций task worktree может стать owned by `nobody`, обычный `git` падает с `dubious ownership`/`not a git repository`, а patch не может писать файлы; восстановить ownership worktree на `mark:mark` перед продолжением. Закрыто в PR #98: добавлен `scripts/bright-task-repair-permissions.sh`.
- [x] 2026-07-01 — `infra-docs` PR может остаться `OPEN/BEHIND` после включения auto-merge, а старый handoff receipt всё равно выглядит успешным; считать delivery завершённой только после `MERGED` или делать replacement ветку от актуального `origin/main`. Закрыто в PR #98: handoff receipt пишется только после `MERGED`.
- [x] 2026-07-01 — preview deploy может упасть на reset SQLite файлов в `/srv/projects/bright-os-envs/preview-*/data`, если runtime создал их без deploy-группы; закрепить общий group-write через Ansible/systemd и повторять деплой тем же branch, чтобы slot переиспользовался без нового reset. Закрыто в PR #98: закреплены preview data group-write/setgid и recovery-сообщение.
