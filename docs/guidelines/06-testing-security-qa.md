# Тесты, безопасность и QA

## Назначение

Этот guideline нужен перед добавлением тестов, изменением security-sensitive code, визуальной QA и проверкой релиза.

## Минимальная проверка по типу задачи

Client UI:

```bash
npm run app:test
npm run app:lint
npm run app:build
```

API:

```bash
scripts/brai-api-test.sh
```

OpenSpec:

```bash
npm run openspec:validate
```

Release:

```bash
npm run publish:client-web-layer
```

## Режим запуска в Codex sandbox

Перед тяжёлыми проверками можно сверить режим:

```bash
scripts/use-node22.sh node scripts/brai-sandbox-check-mode.mjs -- <command>
```

| Команда | Режим | Причина |
| --- | --- | --- |
| `npm run app:lint`, `npm run app:test`, `npm run task:test`, `npm run openspec:validate`, `npm run public:guard`, `npm run temporal:test` | `sandbox` | Обычные repo checks без известных sandbox EPERM. |
| `npm run app:build`, `npm run app:dev`, `npm --prefix apps/brai_app run build`, `npm --prefix apps/brai_app run dev` | `require_escalated` | Next/Turbopack открывает local workers/servers. |
| `scripts/brai-api-test.sh`, `npm --prefix services/brai_api test` | `require_escalated` | Wrapper подхватывает `BRAI_TEST_DATABASE_URL` из `BRAI_TEST_ENV_FILE`/`/etc/brai/brai-test.env`, а API suite слушает `127.0.0.1`. |
| `npm run socraticode:preflight`, `npm run socraticode:ensure` | `require_escalated` | SocratiCode читает localhost Qdrant/Ollama и при bootstrap может запускать Docker-backed local services, что в Codex sandbox неавторитетно. |
| `scripts/brai-preview-handoff.sh`, `node scripts/brai-task.mjs handoff` / `preview` / `acceptance-reconcile`, `deploy/scripts/accept-preview.sh <branch>` | `require_escalated` | Команды handoff/acceptance опираются на авторитетное состояние Git/GitHub и delivery-потока вне sandbox. |
| `deploy/scripts/create-operation-activity.sh ...`, `deploy/scripts/complete-operation-activities.sh <operation:agent-task:id>` | `require_escalated` | Helper-скрипты re-enter host deploy context и пишут в защищённый runtime Postgres. |
| `deploy/scripts/classify-delivery.mjs --file <path>` или `BRAI_CHANGED_FILES=... deploy/scripts/classify-delivery.mjs` | `sandbox` | Changed files переданы явно, Git metadata не нужен. |
| `deploy/scripts/classify-delivery.mjs` без `--file`/`BRAI_CHANGED_FILES` | `require_escalated` | Скрипт читает Git metadata. |
| `npm run app:e2e`, `playwright test` | `require_escalated` | Playwright поднимает browser/dev-server runtime. |
| `agent-browser ...` | `agent_browser` | Использовать штатный dedicated browser runtime. |
| `npm run app:cap:sync`, `npm run android:build:release`, `deploy/scripts/build-android-env-apk.sh`, `gradle`/`gradlew` | `require_escalated` | Android/Gradle/Capacitor пишут shared build caches и используют shared toolchain. |

## UI QA

- Визуальные изменения проверяй на desktop и mobile.
- Для complex interaction используй Playwright flow, а не только component test.
- Для copied visual block проверяй, что source structure/style не был заменён custom implementation.
- Для product surfaces проверяй отсутствие новых ручных `panelClass`/border-surface containers.

## Security

- Не хранить secrets в docs, Memory Bank, source, build artifacts или deployment registry.
- Не embed Bearer tokens или Inbox API keys в web/OTA bundles.
- Auth boundaries, input validation, data-loss prevention и rollback behavior не упрощаются ради Ponytail.
- Если проверка касается secrets, сканируй staged/generated content перед commit.

## Performance

- Не добавляй heavy animation/canvas/shader/3D engine в product screen без explicit approval.
- Для mobile UI учитывай Android WebView, static export и gesture conflicts.
- Новая dependency должна быть оправдана реальным need. Если existing dependency или platform покрывает задачу, новую не добавлять.
