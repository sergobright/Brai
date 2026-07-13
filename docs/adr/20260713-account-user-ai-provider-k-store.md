# Account K-Store для пользовательских AI-провайдеров

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-07-13
- Tags: architecture, security, ai, android, postgres

## Контекст

Глобальный переключатель моделей использует проектные provider keys и не отделяет
владельцев, биллинг и пользовательский выбор. Web, Android Brai CMD и серверные агенты
должны использовать одни аккаунтные ключи, сохраняя анонимный Android-сценарий.

## Решение

Хранить по одному ключу каждого поддерживаемого провайдера на пользователя в Postgres,
шифровать отдельным environment master key через AES-256-GCM и выбирать text/vision
модели в user-scoped настройках. Серверные агенты разрешают профиль по owner user scope.
Android хранит анонимные и синхронизированные аккаунтные ключи раздельно. Browser
получает после входа только короткоживущий одноразовый link token; Kotlin активирует его
с уже выданной device credential, а user-bound account token получает только native-код.
Native-only endpoints отклоняют browser-origin запросы, logout выполняет self-revoke.
При смене аккаунта прежний user-bound token выводится из normal request path до новой
синхронизации; неуспешный canonical sync очищает cached account keys. Provider keys
передаются upstream только в headers и не попадают в URL.
Project keys не являются fallback.

## Рассмотренные альтернативы

- Хранить ключи только в AndroidKeyStore: серверные агенты и Web не смогут их использовать.
- Переиспользовать project keys: нарушает границы владения и биллинга.
- Отдавать ключи через React: расширяет поверхность утечки в WebView.
- Автоматически переключаться на подписочную модель: скрывает смену стоимости и поведения.

## Последствия

- Плюс: один аккаунтный источник ключей для Web, Android и агентов.
- Плюс: пользователь явно контролирует провайдера и модель по capability.
- Минус: Android account token получает право скачать аккаунтные ключи и требует строгой
  привязки к пользователю и устройству, ротации при activation и отзыва при logout.
- Риск: смена encryption master key требует контролируемого re-encryption до перезапуска.

## Проверка

API tests проверяют изоляцию, шифрование, tamper detection и отсутствие plaintext;
runtime tests — маршрутизацию трёх агентов без fallback; Android tests — account-wins,
одноразовую activation, account-switch isolation, fail-closed cache invalidation,
header-only Gemini auth, logout self-revoke и сохранение анонимных ключей. Browser-origin
native requests отклоняются. `ai_logs` читаются только в user scope владельца, а
credential audit не содержит plaintext или key hint. Preview seed не копирует новые таблицы.
Opt-in live test загружает серверные тестовые OpenAI/Groq keys только как credentials
изолированного тестового аккаунта и выполняет реальные вызовы всех трёх агентов.

## Ссылки

- `openspec/changes/account-user-ai-providers/`
- `docs/adr/20260712-preliminary-brai-cmd-device-identity.md`

## Заменяет

Нет.

## Заменено

Нет.
