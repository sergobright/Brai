# Чеклист API или миграции

Перед API, sync или SQLite изменением:

- [ ] Прочитан `docs/guidelines/04-api-data-sync-migrations.md`.
- [ ] Для runtime DB/schema утверждений проверены реальные environment и DB path; результат не выведен только из кода, миграций, скриншота или слов Сергея.
- [ ] Live SQLite проверена read-only подключением с учетом WAL (`mode=ro`, не `immutable=1` для свежих данных).
- [ ] Перед ссылкой на конкретную таблицу проверены `sqlite_master`, `.schema`, `PRAGMA table_info`, индексы и релевантные строки.
- [ ] Есть migration marker в `schema_migrations`, если меняется schema.
- [ ] `table_descriptions` schema проверена в целевой DB; обновлены `table_name`, `title`, `short_description`, `long_description`, `updated_at_utc` для schema metadata changes. Пропуск допустим только для content-only изменений строк.
- [ ] Migration idempotent.
- [ ] Backup нужен и сделан перед live-risk change.
- [ ] Auth boundary не ослаблен.
- [ ] No secrets added to docs/source/build output.
- [ ] Если менялся inbound API contract, обновлена `docs/api/inbound-api.md` в том же commit.
- [ ] Client cache/projection compatibility проверена.
- [ ] Timer/Activities replay semantics сохранены или обновлены в OpenSpec.
- [ ] `npm --prefix services/bright_os_api test` выполнен или есть объяснение.
- [ ] Relevant client tests выполнены, если менялся contract.
- [ ] Для невизуальных изменений в handoff указаны проверенные DB path/environment и ключевые SQL/results.
