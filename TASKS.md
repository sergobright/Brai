# TASKS.md

Журнал узких мест агента. Если во время задачи возникла процедурная проблема, ошибочный шаг, sandbox/escalation trap, нехватка инструмента/документации или вынужденный обходной путь, добавляй новую запись в конец файла.

Формат: `YYYY-MM-DD — проблема; обходной путь; что стоит исправить.` Секреты, токены, пароли и приватные ключи сюда не записывать.

## Записи

- 2026-06-30 — `scripts/bright-task-start.sh` в Codex Desktop нужно запускать с `sandbox_permissions=require_escalated`; без этого starter не сможет нормально сделать fetch и записать git/worktree metadata; использовать эскалацию сразу для этого starter.
- 2026-06-30 — `git add` в `.codex-worktrees/<task-slug>` из sandbox падает на создании `.git/worktrees/<task-slug>/index.lock`; повторять stage с `sandbox_permissions=require_escalated`, потому что git metadata лежит вне writable worktree.
- 2026-06-30 — после escalated операций task worktree может стать owned by `nobody`, обычный `git` падает с `dubious ownership`/`not a git repository`, а patch не может писать файлы; восстановить ownership worktree на `mark:mark` перед продолжением.
- 2026-07-01 — `infra-docs` PR может остаться `OPEN/BEHIND` после включения auto-merge, а старый handoff receipt всё равно выглядит успешным; считать delivery завершённой только после `MERGED` или делать replacement ветку от актуального `origin/main`.
- 2026-07-01 — preview deploy может упасть на reset SQLite файлов в `/srv/projects/bright-os-envs/preview-*/data`, если runtime создал их без deploy-группы; закрепить общий group-write через Ansible/systemd и повторять деплой тем же branch, чтобы slot переиспользовался без нового reset.
