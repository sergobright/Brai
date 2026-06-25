# Чеклист API или миграции

Перед API, sync или SQLite изменением:

- [ ] Прочитан `docs/guidelines/04-api-data-sync-migrations.md`.
- [ ] Есть migration marker в `schema_migrations`, если меняется schema.
- [ ] Migration idempotent.
- [ ] Backup нужен и сделан перед live-risk change.
- [ ] Auth boundary не ослаблен.
- [ ] No secrets added to docs/source/build output.
- [ ] Client cache/projection compatibility проверена.
- [ ] Timer/Activities replay semantics сохранены или обновлены в OpenSpec.
- [ ] `npm --prefix services/bright_os_api test` выполнен или есть объяснение.
- [ ] Relevant client tests выполнены, если менялся contract.
