# Чеклист API или миграции

Перед API, sync или database/schema изменением:

- [ ] Прочитан `docs/guidelines/04-api-data-sync-migrations.md`.
- [ ] Для runtime DB/schema утверждений проверены реальные environment и DSN source без секрета; результат не выведен только из кода, миграций, скриншота или слов Сергея.
- [ ] Live Postgres проверен read-only SQL: таблицы, columns, indexes, constraints и релевантные строки.
- [ ] Runtime не добавляет SQLite fallback, `BRAI_DB`, `BRAI_DATA_STORE`, локальные DB paths или import scripts.
- [ ] Есть Supabase migration file и marker в Postgres migration history, если меняется schema.
- [ ] `table_descriptions` schema проверена в целевой DB; обновлены `table_name`, `title`, `short_description`, `long_description`, `updated_at_utc` для schema metadata changes. Пропуск допустим только для content-only изменений строк.
- [ ] Migration idempotent.
- [ ] Backup нужен и сделан перед live-risk change.
- [ ] Auth boundary не ослаблен.
- [ ] No secrets added to docs/source/build output.
- [ ] Если менялся Inbox API contract, обновлена `docs/api/inbox-api.md` в том же commit.
- [ ] Client cache/projection compatibility проверена.
- [ ] Timer/Activities replay semantics сохранены или обновлены в OpenSpec.
- [ ] `npm --prefix services/brai_api test` выполнен или есть объяснение.
- [ ] Relevant client tests выполнены, если менялся contract.
- [ ] Для невизуальных изменений в handoff указаны проверенные environment, DSN source без секрета и ключевые SQL/results.
