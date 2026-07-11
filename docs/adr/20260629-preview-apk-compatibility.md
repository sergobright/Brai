# Совместимость preview APK

- Status: accepted
- Deciders: Владелец проекта, Codex
- Date: 2026-06-29
- Tags: android, preview, apk, ota

## Контекст

Preview-ветки могут менять нативную границу Android. Устаревший preview APK не должен незаметно запускать несовместимый OTA-bundle.

## Решение

Preview-ветки, меняющие нативную границу, публикуют APK для конкретного слота и соответствующие OTA-метаданные. Preview Android `versionCode` использует `N * 10000 + M`, где `N` - стабильная версия APK, а `M` - локальная для ветки preview-итерация.

## Рассмотренные альтернативы

- Переиспользовать production APK для native preview-веток: отклонено, потому что совместимость native/web может разойтись.
- Публиковать preview OTA без метаданных совместимости APK: отклонено, потому что несовместимые клиенты падали бы поздно.

## Последствия

- Плюс: устаревшие preview APK блокируются вместо тихого запуска несовместимых bundles.
- Минус: native preview deploy тяжелее, чем web-only preview deploy.
- Риск: ошибки в APK ledger или метаданных слота могут заблокировать preview handoff.

## Проверка

Проверяйте метаданные native-boundary preview APK, совместимость OTA manifest и записи release index во время preview deploy.

## Ссылки

- `openspec/specs/app-delivery/spec.md`
- `docs/operations/branch-preview-environments.md`
- `docs/guidelines/05-android-web-ota-releases.md`

## Заменяет

Нет.

## Заменено

Нет.
