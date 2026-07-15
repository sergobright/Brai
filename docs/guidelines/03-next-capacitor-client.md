# Next/Capacitor клиент

## Назначение

Этот guideline нужен перед изменением `apps/brai_app`.

## Клиентская платформа

- Primary client находится в `apps/brai_app`.
- Web и Android используют один Next.js/React/TypeScript/Tailwind продуктовый UI.
- Android получает тот же static export через Capacitor.
- Обычные web-layer изменения должны работать и в browser web, и в Android WebView.

## Layout и navigation

- Док-меню — центральная основная навигация; Дроп-меню — меню аватара на desktop и три точки слева на mobile; Контекст-меню — крайняя узкая desktop-панель и мобильная сетка 3×4.
- Элементы страницы называются: левый рейл, верхний блок, главная область и панель. Не называть левый рейл контекст-меню или панелью страницы.
- Основная навигация строится из единого массива разделов для desktop и mobile.
- `Настройки` открываются как full app section из profile dropdown.
- `/focus` является canonical route для таймера и History.
- `/timer*` и `/history*` retired live URLs и не должны возвращаться без отдельного принятого решения.
- Mobile использует bottom navigation и horizontal tab swipe.
- Desktop shell uses the full workspace beside navigation rails; the shared page workspace, not each section, centers panel-less content at the accepted maximum width.
- Authenticated product sections use the shared page workspace defined by `openspec/specs/next-capacitor-client/spec.md`; do not copy header, main/panel split, or mobile sheet shells into individual sections.
- Visible page-main and page-panel scrolling is owned by exactly one shared local `ScrollArea`: normally by `PageWorkspace`, or by an explicit content-owned `ScrollArea` when a specialized list/canvas already owns the viewport. Raw `overflow-auto`/`overflow-y-auto` scroll owners and nested scrolling viewports in the page-shell are forbidden because they bypass or duplicate the standard scrollbar geometry and behavior.
- Without a panel, page content is centered at a 768px maximum; with a panel, desktop uses the shared 50/50 region and mobile uses the shared sheet below the fixed opaque header.
- Page-specific behavior is supplied through the central desktop/mobile rail and panel registry. Exceptions wrap the shared shell instead of modifying or copying its internals.
- Fullscreen product modes use the shared page workspace's explicit full-bleed override; local width or inset bypasses are forbidden.
- Dismissible mobile sheets and drawers use the shared gesture primitive as the only transform owner for enter, drag, settle, and exit. Do not combine it with component keyframes.
- Backdrop taps and directional backdrop swipes dismiss the active mobile layer. Upper Dock layers remain clipped behind the visible lower layer during motion.
- Mobile Dock edge controls remain fixed and visible while overflow layers are open. The two Dock rows reserve equal edge lanes and share the same centered four-button geometry; account content must stay above the main Dock and use the local `ScrollArea` only when the viewport is too short.
- The second-level Dock owns its `SunMedium` control inside the same transformed sheet; the control must enter and leave with that row rather than waiting for a separately positioned overlay to unmount.
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
