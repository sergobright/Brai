# Next/Capacitor клиент

## Назначение

Этот guideline нужен перед изменением `apps/brai_app`.

## Клиентская платформа

- Primary client находится в `apps/brai_app`.
- Web и Android используют один Next.js/React/TypeScript/Tailwind продуктовый UI.
- Android получает тот же static export через Capacitor.
- Обычные web-layer изменения должны работать и в browser web, и в Android WebView.

## Layout и navigation

- Основная навигация в существующем нижнем `MainDock`: `Брай`, `Действия`, `Inbox`, `Фокус`, `Factory`, `Draws`; на mobile `Draws` остаётся в overflow.
- `/` является canonical route для `Брай`, `/activities` — для `Действия`; `Inbox`, `Фокус`, `Factory` и `Draws` сохраняют собственные canonical routes.
- Desktop left rail остаётся служебным rail для sync, Engine и account actions и не содержит primary navigation.
- `Настройки` открываются как full app section из profile dropdown.
- `/focus` является canonical route для таймера и History.
- `/timer*` и `/history*` retired live URLs и не должны возвращаться без отдельного принятого решения.
- Mobile использует bottom navigation и horizontal tab swipe.
- Desktop использует left rail/dock и full workspace beside rail, без искусственного centered max-width shell.
- В разделе Goal/`Цели фокусировки` длительности показывай компактно: `Hч Mм`; часы без ведущего нуля, минуты не показываются при `0`.

## Styling

- Client styling Tailwind-first: layout, spacing, typography, borders, colors, states и responsive behavior живут в `className`, но visual decisions должны идти через standard shadcn/Tailwind tokens и source-owned shadcn primitives.
- `globals.css` ограничен Tailwind import, theme tokens, base rules, platform selectors, debug console hiding и necessary keyframes.
- Static component CSS blocks для shell, panels, Activities, Timer/Focus, History, Goal, Settings, Auth и chart UI не возвращать.
- Product surfaces строить через source-owned shadcn primitive/block или approved source block. Не расширять legacy `panelClass`.
- Не добавлять hardcoded product colors, static arbitrary radii/shadows, arbitrary font classes, new font families, custom card recipes или runtime arbitrary accent/color pickers без прямого запроса Сергея.
- Product font sizes использовать только standard Tailwind/shadcn utilities; не добавлять `text-[...]`, CSS `font-size`, viewport-scaled typography или отдельную type scale.

## Mobile/Android compatibility

- New page/component/control/chart/form проверяется на narrow Android viewport и desktop.
- Text, controls и dynamic content не должны overlap или overflow.
- Hover-only controls требуют touch alternative.
- Horizontal scroll/drag/swipe surfaces используют `data-nav-swipe-exclusion`, если они должны владеть жестом.
- Android safe-area spacing идёт через shared shell/platform selectors, не через per-section hacks.

## Client state и offline-first

- Timer и Activities сохраняют local-first state перед sync.
- Dexie outbox является durable client-side очередью для offline-first событий.
- LocalStorage можно использовать только для lightweight preferences или immediate crash/back drafts, не как основной источник sync.
- API calls из browser web идут через same-origin `/api`; Android WebView использует тот же Better Auth flow: production OTP, Preview/Dev email-only test login.

## Component boundaries

- В TSX/JSX оставляй разметку и простую UI-связку.
- Нетривиальные transforms, storage/API side effects, autosave/sync и view-model расчёты выноси в `*.model.ts`, shared helper или hook.
- Обычный локальный UI state, event handlers и conditional rendering не считаются бизнес-логикой сами по себе.

## Комментарии

- Существенные экспортируемые hooks, `*.model.ts`, API, platform, storage, time и type helpers документируй коротким JSDoc-комментарием при написании кода.
- Не комментируй очевидные UI-примитивы, JSX-разметку и маленькие pass-through wrappers только ради комментария.
- `eslint-plugin-jsdoc` проверяет это для клиента через `npm run app:lint`.

## Что проверять

- `npm run app:test` для component/unit покрытия.
- `npm run app:lint`.
- `npm run app:build`.
- Playwright для route/layout/gesture flows, когда меняется реальный UI behavior.
