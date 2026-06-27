# Короткий контекст агента

Этот файл - карта проекта, а не набор правил. Он нужен, чтобы быстрее найти нужные места и не перечитывать шумные директории. Если карта спорит с `docs/guidelines/`, OpenSpec, Memory Bank или кодом, верь более сильному источнику из `docs/guidelines/01-sources-of-truth.md`.

Правило обновления этой карты живет в `docs/guidelines/01-sources-of-truth.md`.

## Где что лежит

- `apps/bright_os_app/` - основной Next.js 16 / React 19 / Capacitor Android клиент.
- `apps/bright_os_site/` - статический исходник публичного сайта для `brightos.world`.
- `apps/bright_os_app/AGENTS.md` - локальное правило Next.js: перед правками Next-кода читать релевантные docs из `node_modules/next/dist/docs/`.
- `apps/bright_os_app/src/app/` - routes, layout, manifest, global CSS.
- `apps/bright_os_app/src/features/` - пользовательские модули: `app`, `goal`, `history`, `settings`, `timer`.
- `apps/bright_os_app/src/shared/` - общие API, config, hooks, platform, storage, theme, time, types, UI.
- `apps/bright_os_app/public/icons/` - web/public иконки.
- `assets/brand/` - исходные бренд-ассеты: `bright-os-logo-source.png` - мастер логотипа от Сергея; `bright-os-logo-black.png` - версия с чёрным фоном.
- `apps/bright_os_app/android/app/src/main/` - Android native boundary, ресурсы, icons, generated assets.
- `apps/bright_os_app/android/app/src/main/java/world/brightos/bright_os_client/` - native Android код приложения; `ota/` и `timer/` - частые точки входа.
- `services/bright_os_api/` - Node API, WebSocket/HTTP server и SQLite store.
- `services/bright_os_temporal/` - Temporal worker/client для required CI/CD control ledger preview и promotion flows.
- `admin/` - техническая admin-панель для protected admin subdomain.
- `deploy/scripts/` - publish scripts; `deploy/systemd/` - service units; `deploy/web/` и `deploy/mobile-update/bundles/` - опубликованные артефакты.
- `deploy/site/` - сгенерированный public site root, не коммитить.
- `deploy/ansible/` и `deploy/environments.json` - one-VPS prod/dev/preview environment setup and routing source.
- `docs/operations/branch-preview-environments.md` - branch preview workflow, CI secrets, deploy-user boundary and branch protection steps.
- `openspec/` - accepted/planned requirements.
- `memory-bank/` - фактический контекст и решения.
- `.socraticodecontextartifacts.json` - SocratiCode context artifact registry for agent rules, docs, OpenSpec, and Memory Bank.

## Команды

- `npm run app:dev` - dev server клиента.
- `npm run app:build` - production build клиента.
- `npm run app:lint` - ESLint клиента.
- `npm run app:test` - Vitest клиента.
- `npm run app:e2e` - Playwright клиента.
- `npm run site:publish` - публикация статического public site source в `deploy/site`.
- `npm run app:cap:sync` - Capacitor sync Android.
- `npm run android:build:release` - release APK build.
- `npm run openspec:guard` - проверка, что завершённые OpenSpec changes не оставлены активными.
- `npm run openspec:validate` - completed-change guard плюс strict OpenSpec validation.
- `npm run socraticode:preflight` - проверка, что SocratiCode подключён, context artifacts объявлены, и watcher активен для текущего project path.
- `npm run publish:web` - публикация web layer.
- `npm run publish:client-web-layer` - публикация клиентского web layer.
- `npm run publish:mobile-bundle` - публикация mobile bundle.
- `npm run publish:apk` - публикация APK.
- `npm run android:icons:preview` - генерация Dev/A-E Android launcher icons from canonical logo.
- `npm run android:build:env-apk -- <flavor>` - сборка и публикация non-production Android APK flavor (`dev`, `previewA`-`previewE`) with matching web fallback.
- `deploy/scripts/preview-slots.sh` - lock-protected preview slot registry commands.
- `deploy/scripts/accept-preview.sh <codex-branch>` - deterministic acceptance entrypoint when the project owner accepts a preview; creates/reuses PR into `main` and enables merge/auto-merge.
- `npm --prefix services/bright_os_api test` - тесты Bright OS API.
- `npm --prefix services/bright_os_api start` - запуск Bright OS API.
- `npm --prefix services/bright_os_temporal test` - state tests для Temporal CI/CD workflow package.
- `npm --prefix services/bright_os_temporal start` - запуск Temporal worker against `127.0.0.1:7233`.

## Первые чтения по типу задачи

| Задача | Сначала смотри |
| --- | --- |
| UI/client | `apps/bright_os_app/src/app/`, `apps/bright_os_app/src/features/`, guidelines `02`, `03`, `12` |
| Android/Capacitor | `apps/bright_os_app/AGENTS.md`, `apps/bright_os_app/capacitor.config.ts`, Android paths выше, guideline `05` |
| API/data/sync | `services/bright_os_api/src/`, `apps/bright_os_app/src/shared/api/`, `apps/bright_os_app/src/shared/storage/`, guideline `04` |
| Tests/QA | `apps/bright_os_app/tests/`, `services/bright_os_api/test/`, guideline `06` |
| Publish/release | `deploy/scripts/`, `deploy/systemd/`, guidelines `05`, `07` |
| Rules/docs | `docs/DEVELOPMENT_GUIDELINES.md`, `docs/guidelines/01-sources-of-truth.md` |

## Обычно не читать без причины

- `node_modules/`, кроме актуальных docs зависимостей, когда это прямо требует задача.
- `.next/`, `out/`, `output/`, `test-results/`, Playwright screenshots/reports.
- `.gradle/`, Android build directories.
- `deploy/web/`, `deploy/mobile-update/bundles/`, если задача не про опубликованный артефакт.
