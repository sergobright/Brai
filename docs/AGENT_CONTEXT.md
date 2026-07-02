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
- `assets/brand/` - исходные бренд-ассеты: `brai-logo-source.png` - мастер логотипа от Сергея; `brai-logo-black.png` - версия с чёрным фоном.
- `apps/brai_app/android/app/src/main/` - Android native boundary, ресурсы, icons, generated assets.
- `apps/brai_app/android/app/src/main/java/world/brightos/brai/` - native Android код приложения; `ota/` и `timer/` - частые точки входа.
- `services/brai_api/` - Node API, WebSocket/HTTP server и SQLite store.
- `services/brai_temporal/` - Temporal worker/client для required CI/CD control ledger preview и promotion flows.
- `admin/` - техническая admin-панель для protected admin subdomain.
- `deploy/scripts/` - publish scripts; `deploy/systemd/` - service units; `deploy/web/` и `deploy/mobile-update/bundles/` - опубликованные артефакты.
- `deploy/ansible/` и `deploy/environments.json` - one-VPS production/preview environment setup and routing source.
- `docs/operations/branch-preview-environments.md` - branch preview workflow, CI secrets, deploy-user boundary and branch protection steps.
- `openspec/` - accepted/planned requirements.
- `memory-bank/` - фактический контекст и решения.
- `.socraticodecontextartifacts.json` - SocratiCode context artifact registry for agent rules, docs, OpenSpec, and Memory Bank.

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
- `npm run socraticode:preflight` - проверка, что SocratiCode подключён, context artifacts объявлены, и watcher активен для текущего project path.
- `npm run publish:web` - публикация web layer.
- `npm run publish:client-web-layer` - публикация клиентского web layer.
- `npm run publish:mobile-bundle` - публикация mobile bundle.
- `npm run publish:apk` - публикация APK.
- `npm run android:icons:preview` - генерация Preview A-E Android launcher icons from canonical logo.
- `npm run android:build:env-apk -- <flavor>` - сборка и публикация Android APK flavor (`production`, `previewA`-`previewE`) with matching web fallback.
- `deploy/scripts/preview-slots.sh` - lock-protected preview slot registry commands.
- `deploy/scripts/accept-preview.sh <codex-branch>` - deterministic acceptance entrypoint when the project owner accepts a preview; creates/reuses PR into `main` and enables merge/auto-merge.
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
