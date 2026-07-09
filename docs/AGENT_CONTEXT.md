# Короткий контекст агента

Этот файл - карта проекта, а не набор правил. Он нужен, чтобы быстрее найти нужные места и не перечитывать шумные директории. Если карта спорит с `docs/guidelines/`, OpenSpec, Memory Bank или кодом, верь более сильному источнику из `docs/guidelines/01-sources-of-truth.md`.

Правило обновления этой карты живет в `docs/guidelines/01-sources-of-truth.md`.

## Где что лежит

- `apps/brai_app/` - основной Next.js 16 / React 19 / Capacitor Android клиент.
- `apps/brai_app/AGENTS.md` - локальное правило Next.js: перед правками Next-кода читать релевантные docs из `node_modules/next/dist/docs/`.
- `apps/brai_app/src/app/` - routes, layout, manifest, global CSS.
- `apps/brai_app/src/features/` - пользовательские модули: `app`, `goal`, `history`, `settings`, `timer`.
- `apps/brai_app/src/shared/` - общие API, config, hooks, platform, storage, theme, time, types, UI.
- `apps/brai_app/public/icons/` - web/public иконки.
- `assets/brand/` - исходные бренд-ассеты и актуальная пачка логотипов Brai.
- `apps/brai_app/android/app/src/main/` - Android native boundary, ресурсы, icons, generated assets.
- `apps/brai_app/android/app/src/main/java/world/brightos/brai/` - native Android код приложения; `ota/`, `timer/`, and `capabilities/` - частые точки входа.
- `services/brai_api/` - Node API, WebSocket/HTTP server и Supabase Postgres-backed store.
- `services/brai_temporal/` - Temporal worker/client для required CI/CD control ledger preview и promotion flows.
- `admin/` - техническая admin-панель, доступная как `/admin` внутри prod/dev/preview окружений.
- `deploy/scripts/` - publish scripts; `deploy/systemd/` - service units; `deploy/web/` и `deploy/mobile-update/bundles/` - опубликованные артефакты.
- `deploy/ansible/` и `deploy/environments.json` - one-VPS production/preview environment setup and routing source.
- `docs/operations/branch-preview-environments.md` - branch preview workflow, CI secrets, deploy-user boundary and branch protection steps.
- `openspec/` - accepted/planned requirements.
- `memory-bank/` - фактический контекст и решения.
- `.socraticode.json` - committed SocratiCode `projectId` so the main checkout and task worktrees share one semantic index.
- `.socraticodecontextartifacts.json` - SocratiCode context artifact registry for agent rules, docs, OpenSpec, and Memory Bank.

## Бренд-логотипы

Актуальные wordmark-логотипы лежат в `assets/brand/` парами PNG/SVG. PNG имеют размер `2596x1226`; SVG-файлы обрезаны по tight `viewBox="197 854 779 368"` из обновлённого `Brai.svg`. Красный знак сохранён из встроенного PNG исходника, текст `Brai` остаётся SVG path.

| Файл | Когда использовать |
| --- | --- |
| `brai-logo-transparent.png` / `brai-logo-transparent.svg` | Основной вариант для UI, сайта и макетов, где фон задаёт контейнер. Подходит для тёмных, цветных и фото-фонов; не ставить на светлый фон без проверки контраста, потому что `Br` белые. |
| `brai-logo-white-bg.png` / `brai-logo-white-bg.svg` | Для белых и светлых поверхностей, документов, писем, презентаций и экспортов: `Br` чёрные, красный остаётся без изменения. |
| `brai-logo-black-bg.png` / `brai-logo-black-bg.svg` | Для тёмных блоков, заставок и экспортов, где нужна встроенная чёрная подложка и предсказуемый контраст: `Br` белые, красный остаётся без изменения. |

`brai-logo-source.png`, `brai-logo-black.png`, app icons, favicons и launcher assets являются отдельными иконками/прежними исходниками; wordmark-размещения по умолчанию берут один из трёх вариантов выше.

## Команды

- `npm run app:dev` - local dev server клиента; не branch/deploy workflow.
- `npm run app:build` - production build клиента.
- `npm run app:lint` - ESLint клиента.
- `npm run app:test` - Vitest клиента.
- `npm run app:e2e` - Playwright клиента.
- `npm run app:cap:sync` - Capacitor sync Android.
- `npm run android:build:release` - release APK build.
- `npm run openspec:guard` - проверка, что завершённые OpenSpec changes не оставлены активными.
- `npm run openspec:validate` - completed-change guard плюс strict OpenSpec validation.
- `scripts/brai-guard-sync-check.sh --check` - проверка, что installed Brai guard copy в `/srv/opt` совпадает с repo `scripts/brai-task.mjs`.
- `npm run socraticode:ensure` - создать/догнать shared SocratiCode index для текущего worktree path и поднять watcher.
- `npm run socraticode:preflight` - проверка, что SocratiCode подключён, shared index complete, context artifacts объявлены, и watcher активен для текущего project path.
- `npm run publish:web` - публикация web layer.
- `npm run publish:client-web-layer` - публикация клиентского web layer.
- `npm run publish:mobile-bundle` - публикация mobile bundle.
- `npm run publish:apk` - публикация APK.
- `npm run android:icons:preview` - генерация Preview A-E Android launcher icons from canonical logo.
- `npm run android:build:env-apk -- <flavor>` - сборка и публикация Android APK flavor (`production`, `previewA`-`previewE`) with matching web fallback.
- `deploy/scripts/preview-slots.sh` - lock-protected preview slot registry commands.
- `deploy/scripts/accept-preview.sh <codex-branch>` - deterministic acceptance entrypoint when the project owner accepts a preview; creates/reuses PR into `main` and enables merge/auto-merge.
- `deploy/scripts/complete-operation-activities.sh <operation-activity-id>...` - host/deploy-context helper that runs from deploy-owned prod source and marks Codex operation activities as `Done` in the runtime database.
- `npm --prefix services/brai_api test` - тесты Brai API.
- `npm --prefix services/brai_api start` - запуск Brai API.
- `npm --prefix services/brai_temporal test` - state tests для Temporal CI/CD workflow package.
- `npm --prefix services/brai_temporal start` - запуск Temporal worker against `127.0.0.1:7233`.

## Первые чтения по типу задачи

| Задача | Сначала смотри |
| --- | --- |
| UI/client | `apps/brai_app/src/app/`, `apps/brai_app/src/features/`, guidelines `02`, `03`, `12` |
| Android/Capacitor | `apps/brai_app/AGENTS.md`, `apps/brai_app/capacitor.config.ts`, Android paths выше, guideline `05` |
| API/data/sync | `services/brai_api/src/`, `apps/brai_app/src/shared/api/`, `apps/brai_app/src/shared/storage/`, guideline `04` |
| Tests/QA | `apps/brai_app/tests/`, `services/brai_api/test/`, guideline `06` |
| Publish/release | `deploy/scripts/`, `deploy/systemd/`, guidelines `05`, `07` |
| Rules/docs | `docs/DEVELOPMENT_GUIDELINES.md`, `docs/guidelines/01-sources-of-truth.md` |

## Обычно не читать без причины

- `node_modules/`, кроме актуальных docs зависимостей, когда это прямо требует задача.
- `.next/`, `out/`, `output/`, `test-results/`, Playwright screenshots/reports.
- `.gradle/`, Android build directories.
- `.codex-worktrees/`, кроме текущего task worktree, если работа уже стартовала там.
- `deploy/web/`, `deploy/mobile-update/bundles/`, build artifacts и release outputs, если задача не про опубликованный артефакт.
