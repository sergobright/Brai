# Preliminary Brai CMD device identity

- Status: accepted
- Deciders: Владелец проекта
- Date: 2026-07-12
- Tags: architecture, security, android, auth

## Контекст

Brai CMD даёт Android-пользователю cloud-расшифровку голоса ещё до email-регистрации. Если хранить только локальный install id, пользователь может удалить приложение, поставить заново и получить новый лимит. Нужна server-side запись предварительного пользователя и более стабильная device identity, но без новой тяжёлой зависимости в первом релизе.

## Решение

В v1 используем Android `Settings.Secure.ANDROID_ID` как native device fingerprint source, отправляем его только в Brai API и сохраняем только `sha256` hash. Предварительный пользователь живёт в `preliminary_users`; после email-auth он связывается с `"user"` и переводится в `converted`.

## Рассмотренные альтернативы

- Только текущий install id: не подходит, потому что сбрасывается при удалении приложения.
- Play Integrity Device Recall сразу: сильнее против abuse, но требует Google Play setup, серверной проверки verdict/token и отдельной операционной настройки.
- Browser fingerprint: не подходит для Android WebView и хуже по приватности.

## Последствия

- Плюс: обычная переустановка Android-приложения больше не создаёт новый preliminary voice-доступ.
- Плюс: preliminary profile можно связать с будущим email-user без смешивания с full auth user.
- Минус: `ANDROID_ID` не является абсолютным hardware id и может измениться при factory reset, смене app signing key/user scope и отдельных legacy-сценариях.
- Риск: если abuse через reset станет важным, нужно добавить Play Integrity Device Recall как дополнительный сигнал.

## Проверка

API tests должны подтверждать, что raw fingerprint/token не сохраняются, duplicate fingerprint блокирует new onboarding, а auth может связать unbound duplicate fingerprint.

## Ссылки

- OpenSpec: `openspec/changes/preliminary-brai-cmd-users/`
- Android identifiers: https://developer.android.com/identity/user-data-ids
- `ANDROID_ID`: https://developer.android.com/reference/android/provider/Settings.Secure#ANDROID_ID
- Play Integrity: https://developer.android.com/google/play/integrity/overview

## Заменяет

Нет.

## Заменено

Нет.
