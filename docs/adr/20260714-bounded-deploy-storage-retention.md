# Ограниченное хранение артефактов деплоя

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-14
- Tags: deployment, storage, reliability

## Контекст

Повторные и отменённые деплои оставляли полные `source.previous-*` и CI upload-каталоги. Production накопил около 58 ГБ предыдущих source tree, а две старые CI-попытки — ещё около 5 ГБ. In-band cleanup зависел от успешного прохождения поздних gate и не ограничивал рост после сбоя.

## Решение

- Каждая CI-попытка получает уникальный staging-каталог и terminal marker; повторная попытка не переиспользует и не удаляет каталог другого запуска.
- Deploy не удаляет `source.previous-*`. Root maintenance удаляет только allowlisted CI uploads, ownership-marked previous source и непривязанные APK после повторной проверки возраста, процесса, mountpoint, symlink, inode и device.
- Source, staging и release операции используют единый порядок блокировок `source -> staging -> release`. Успешный Goal-agent gate пишет exact ready marker под source lock и запускает раннюю очистку; ежедневный timer остаётся fallback.
- Перед upload/deploy требуется минимум 12 GiB свободного места. Docker `json-file` logs ограничиваются `50m x 3` после пересоздания контейнеров.
- Sessions, databases, Docker data/images, backups, `source.orphan`, worktrees и dependency caches никогда не входят в автоматическую очистку.

## Рассмотренные альтернативы

- Глобальный `docker system prune` или широкий `rm -rf`: отклонено из-за риска удалить активные данные и rollback state.
- Удалять previous source самим CI после каждого запуска: отклонено, потому что cancellation и поздний failure могут оборвать cleanup или перепутать владельца каталога.
- Оставить ручную очистку: отклонено, потому что она не ограничивает повторный рост.

## Последствия

- Плюс: рост от deploy artifacts ограничен, а нормальный успешный previous source удаляется сразу после полного gate.
- Плюс: hard-kill и restart оставляют точные маркеры для безопасного timer fallback.
- Минус: первый rollout требует Ansible bootstrap lock-файлов, root unit/timer и узкого sudo boundary до нового Preview deploy.
- Риск: hard crash строго после release registry и до artifact cleanup может оставить bounded файлы свободного Preview-слота до его повторного использования.

## Проверка

Запускайте `npm run task:test`, `npm run temporal:test`, `node --test services/brai_goal_agents/test/deploy.test.mjs`, Ansible syntax check и `storage-maintenance.mjs --dry-run`. Apply допустим только от root после dry-run без неожиданных кандидатов.

## Ссылки

- `deploy/scripts/ci-ssh-deploy.sh`
- `deploy/scripts/storage-maintenance.mjs`
- `deploy/systemd/brai-storage-maintenance.service`
- `docs/operations/temporal-ci-cd.md`

## Заменяет

Нет.

## Заменено

Нет.
