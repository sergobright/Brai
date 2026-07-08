# Чеклист агента перед задачей

Перед нетривиальной задачей:

- [ ] Прочитан `AGENTS.md`.
- [ ] Открыт главный индекс `docs/DEVELOPMENT_GUIDELINES.md`.
- [ ] Прочитан `memory-bank/README.md` и нужные core files.
- [ ] Найден релевантный guideline в `docs/guidelines/`.
- [ ] Найден релевантный OpenSpec spec/change.
- [ ] Если задача касается runtime/API/sync/deploy/admin/auth/background/native/server side effect, явно решено, нужен ли writer/reader/test для таблицы `logs`.
- [ ] Проверено реальное состояние кода через `rg` или file reads.
- [ ] Перед тяжёлыми проверками сверена sandbox/escalation policy в `docs/guidelines/06-testing-security-qa.md` или через `scripts/brai-sandbox-check-mode.mjs -- <command>`.
- [ ] Если задача касается runtime DB/service/deploy фактов, проверены реальные target environment, path/schema/data; если доступа нет, это blocker, а не допущение.
- [ ] Проверен `git status --short`.
- [ ] Если работа read-only или меняет только внешнее окружение без project-file changes, новая ветка не нужна.
- [ ] Перед первым изменением файлов проекта создана/выбрана правильная branch: новая `codex/<task-slug>` для новой задачи, текущая `codex/*` только для прямого follow-up или по явному указанию Сергея.
- [ ] Определены user changes, которые нельзя перезаписывать.
- [ ] Если есть blocker, он назван и решается до workaround.
