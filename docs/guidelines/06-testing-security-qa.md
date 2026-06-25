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
npm --prefix services/bright_os_api test
```

OpenSpec:

```bash
npm run openspec:validate
```

Release:

```bash
npm run publish:client-web-layer
```

## UI QA

- Визуальные изменения проверяй на desktop и mobile.
- Для complex interaction используй Playwright flow, а не только component test.
- Для copied visual block проверяй, что source structure/style не был заменён custom implementation.
- Для product surfaces проверяй отсутствие новых ручных `panelClass`/border-surface containers.

## Security

- Не хранить secrets в docs, Memory Bank, source, build artifacts или deployment registry.
- Не embed Bearer tokens в web/OTA bundles.
- Auth boundaries, input validation, data-loss prevention и rollback behavior не упрощаются ради Ponytail.
- Если проверка касается secrets, сканируй staged/generated content перед commit.

## Performance

- Не добавляй heavy animation/canvas/shader/3D engine в product screen без explicit approval.
- Для mobile UI учитывай Android WebView, static export и gesture conflicts.
- Новая dependency должна быть оправдана реальным need. Если existing dependency или platform покрывает задачу, новую не добавлять.

