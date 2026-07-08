# Чеклист изменения клиента

Перед изменением `apps/brai_app`:

- [ ] Прочитан `docs/guidelines/03-next-capacitor-client.md`.
- [ ] Изменение совместимо с Next static export.
- [ ] Изменение работает в browser web и Android WebView, если не явно web-only/native-only.
- [ ] Mobile и desktop layouts проверены.
- [ ] Horizontal gesture surface использует `data-nav-swipe-exclusion`, если нужно.
- [ ] Visible scrolling использует source-owned `ScrollArea`.
- [ ] Desktop split-screen области прокручиваются независимо через локальный `ScrollArea`; ни одна область не зависит от общего page scroll, когда рядом есть другая область.
- [ ] Desktop split-screen scrollbar стоит близко к краю области/workspace с минимальным inset; content/card имеет небольшой отступ от scrollbar, а не уезжает вплотную под него.
- [ ] Текстовые action/toggle кнопки держат подпись в одну строку или становятся icon-only; внутри compact buttons нет переносов.
- [ ] Product surface использует source-owned shadcn primitive/block или accepted source block.
- [ ] Не добавлены hardcoded product colors, static arbitrary radii/shadows, arbitrary font classes, arbitrary font-size classes, new font families или custom card recipes.
- [ ] Theme UI не добавляет arbitrary accent/color picker по умолчанию; используются standard shadcn theme modes/tokens.
- [ ] Tests/selectors не завязаны на visual-only class names вроде `.panel`, `.chart-panel`, `.metric`, `.settings-card`, `.auth-panel`, `.empty-state`.
- [ ] Если клиент меняет server call, sync или native boundary, проверено, нужно ли обновить server-side `logs` writer/fields/test.
- [ ] Существенные новые/измененные экспортируемые hooks, model/API/storage/platform/time helpers имеют короткий JSDoc-комментарий.
- [ ] `npm run app:test` выполнен или есть объяснение, почему не запускался.
- [ ] `npm run app:lint` выполнен или есть объяснение.
- [ ] `npm run app:build` выполнен или есть объяснение.
