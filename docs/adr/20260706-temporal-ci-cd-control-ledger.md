# Temporal как контрольный журнал CI/CD

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-06
- Tags: ci-cd, temporal, deployment

## Контекст

Деплой Brai использует GitHub Actions и скрипты деплоя, но критическим переходам preview и promotion нужен устойчивый контрольный журнал, который фиксирует блокеры и состояние ручного восстановления.

## Решение

Brai использует self-hosted Temporal как обязательный контрольный журнал CI/CD для preview-веток и promotions. GitHub Actions по-прежнему запускает проверки и скрипты деплоя; Temporal ограничивает и записывает критические transitions.

## Рассмотренные альтернативы

- Хранить state только в GitHub Actions logs: отклонено, потому что logs не являются явной workflow state machine.
- Немедленно заменить скрипты деплоя на Temporal activities: отклонено, потому что существующие scripts остаются underlying deployment authority.

## Последствия

- Плюс: failed checks, deploys, releases и no-preview handoffs имеют durable workflow state.
- Минус: изменения CI/CD process должны вместе обновлять Temporal state, signals, tests и docs.
- Риск: outages Temporal блокируют strict delivery до восстановления.

## Проверка

Запускайте Temporal state tests и запрашивайте workflow state при изменениях delivery или сбоях.

## Ссылки

- `docs/operations/temporal-ci-cd.md`
- `services/brai_temporal/`
- `docs/operations/branch-preview-environments.md`

## Заменяет

Нет.

## Заменено

Нет.
