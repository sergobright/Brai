import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createMobileAction, dragTouch, horizontalCenterOffset } from "./shell-helpers";

test("renders mobile and desktop navigation without starter content", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия" })).toBeVisible();
  await expect(page.getByRole("button", { name: "История фокуса" })).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("button", { name: "Добавить действие" })).toBeVisible();
    await expect(page.locator(".mobile-nav .nav-label").first()).toBeHidden();
    await expect(page.locator(".mobile-nav .nav-button")).toHaveCount(3);
    await expect(page.locator(".mobile-nav .nav-button").nth(2)).not.toHaveClass(/active:scale/);
  } else {
    await expect(page.getByRole("textbox", { name: "Добавить" })).toBeVisible();
    await expect(page.locator(".desktop-rail")).toBeVisible();
    await expect(page.locator(".desktop-rail .status-pill")).toBeVisible();
    await expect(page.locator(".section-page-current .topbar .status-pill")).toBeHidden();
    await expect(page.getByRole("button", { name: "Свернуть меню" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Развернуть меню" })).toHaveCount(0);
    await expect(page.locator(".desktop-rail [data-rail-page-title]")).toHaveCount(0);
  }
  await expect(page.getByText("Deploy Now")).toHaveCount(0);
});

test("renders the mobile floating dock without inactive circular backgrounds", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only dock");

  await page.goto("/");
  await expect(page.locator(".mobile-nav")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const items = page.locator(".mobile-nav .nav-button");
  await expect(items).toHaveCount(3);
  await expect(items.nth(2)).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.getByRole("button", { name: "Фокус" }).last().click();
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();
  await expect(items.nth(2)).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("keeps the desktop rail static and compact across reloads", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only rail");

  await page.context().addCookies([{ name: "sidebar_state", value: "true", url: "http://127.0.0.1:3201" }]);
  await page.goto("/");
  await expect(page.locator(".desktop-rail")).not.toHaveClass(/expanded/);
  await expect
    .poll(async () => (await page.locator(".desktop-rail").boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(50);
  await expect(page.getByRole("button", { name: "Свернуть меню" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Развернуть меню" })).toHaveCount(0);

  for (const title of ["Входящие", "Фокус"]) {
    await page.getByRole("button", { name: title }).last().click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator(".desktop-rail").getByRole("button", { name: "Настройки" })).toBeVisible();
    await expect(page.locator(".desktop-rail").getByRole("button", { name: "Архив" })).toBeVisible();
  }

  await page.reload();
  await expect(page.locator(".desktop-rail")).not.toHaveClass(/expanded/);
  await expect
    .poll(async () => (await page.locator(".desktop-rail").boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(50);
});

test("keeps the compact desktop rail slim and centered", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only rail");

  await page.goto("/");
  await expect(page.locator(".desktop-rail")).not.toHaveClass(/expanded/);
  await expect
    .poll(async () => (await page.locator(".desktop-rail").boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(76);

  const rail = await page.locator(".desktop-rail").boundingBox();
  const profile = await page.locator(".desktop-rail .rail-profile").boundingBox();
  const avatar = await page.locator(".desktop-rail [data-slot='avatar']").boundingBox();
  await page.getByRole("button", { name: /Engine/ }).click();
  await expect(page.getByRole("heading", { name: "Engine" })).toBeVisible();
  const activeItem = await page.locator(".desktop-rail [data-sidebar='menu-button'][data-active='true']").boundingBox();
  const activeIconSize = await page
    .locator(".desktop-rail [data-sidebar='menu-button'][data-active='true'] svg")
    .first()
    .evaluate((element) => getComputedStyle(element).width);

  expect(rail?.width ?? 0).toBeGreaterThanOrEqual(47);
  expect(rail?.width ?? 999).toBeLessThanOrEqual(50);
  expect(profile?.width ?? 999).toBeLessThanOrEqual(42);
  expect(activeItem?.width ?? 999).toBeLessThanOrEqual(42);
  expect(activeItem?.height ?? 999).toBeLessThanOrEqual(46);
  expect(Number.parseFloat(activeIconSize)).toBeLessThanOrEqual(16);
  expect(horizontalCenterOffset(avatar, rail)).toBeLessThanOrEqual(1.5);
  expect(horizontalCenterOffset(activeItem, rail)).toBeLessThanOrEqual(1.5);
});

test("keeps the desktop floating dock fixed near the bottom center", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only dock");

  await page.goto("/");
  const dock = page.locator(".main-dock");
  await expect(dock).toBeVisible();

  const viewport = page.viewportSize();
  const before = await dock.boundingBox();
  expect(before).not.toBeNull();
  expect(Math.abs((before?.x ?? 0) + (before?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2)).toBeLessThanOrEqual(2);
  expect((viewport?.height ?? 0) - ((before?.y ?? 0) + (before?.height ?? 0))).toBeLessThanOrEqual(24);

  await page.mouse.wheel(0, 900);
  const after = await dock.boundingBox();
  expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("keeps Evil Eye out of the desktop action rail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only action rail");

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Настройки" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Evil Eye" })).toHaveCount(0);
});

test("uses full-width left-aligned desktop content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only layout");

  await page.goto("/");
  const viewport = page.viewportSize();
  const rail = await page.locator(".desktop-rail").boundingBox();
  const main = await page.locator(".main-view").boundingBox();
  const stage = await page.locator(".section-swipe-stage").boundingBox();
  const form = await page.locator(".actions-add-form").boundingBox();
  const heading = await page.locator(".section-page-current .topbar h1").boundingBox();

  await page.getByRole("textbox", { name: "Добавить" }).fill("Фокус");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Фокус" })).toBeVisible();

  const row = page.locator(".action-row").first();
  const titleSize = await page.locator(".action-title").first().evaluate((element) => getComputedStyle(element).fontSize);

  expect(main?.x ?? 9999).toBeLessThanOrEqual((rail?.width ?? 0) + 2);
  expect(stage?.width ?? 0).toBeGreaterThan((viewport?.width ?? 0) - (rail?.width ?? 0) - 72);
  expect(heading?.x ?? 9999).toBeLessThanOrEqual((rail?.width ?? 0) + 96);
  expect(form?.width ?? 0).toBeGreaterThan((stage?.width ?? 0) * 0.45);
  expect(form?.height ?? 9999).toBeLessThanOrEqual(50);
  await expect(page.locator(".actions-add-form")).toHaveAttribute("data-slot", "input-group");
  const addFormRadius = await page.locator(".actions-add-form").evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
  expect(Number.parseFloat(addFormRadius)).toBeGreaterThanOrEqual(8);
  expect(heading?.height ?? 9999).toBeLessThanOrEqual(32);
  await expect.poll(async () => (await row.boundingBox())?.height ?? 9999).toBeLessThanOrEqual(60);
  expect(Number.parseFloat(titleSize)).toBe(16);
});

test("shows desktop Focus context panels from header actions", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only focus layout");
  test.setTimeout(210_000);

  await mockFocusApi(page);
  await page.goto("/focus");
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();
  await expect(page.locator(".section-page-current .timer-scroll-hint")).toBeVisible();

  const stage = await page.locator(".section-swipe-stage").boundingBox();
  const face = await page.locator(".section-page-current .timer-face").boundingBox();
  const hint = await page.locator(".section-page-current .timer-scroll-hint").boundingBox();
  const startButton = await page.getByRole("button", { name: "Запустить" }).boundingBox();
  const viewport = page.viewportSize();
  const timerPane = page.locator(".section-page-current .focus-timer-pane[data-slot='scroll-area']");
  const timerViewport = timerPane.locator("> [data-slot='scroll-area-viewport']");
  const mainViewport = page.locator(".main-scroll > [data-slot='scroll-area-viewport']");
  const timerViewportBox = await timerViewport.boundingBox();

  await expect(page.locator(".section-page-current .focus-context-pane")).toHaveCount(0);
  await expect(timerPane).toBeVisible();
  await expect(timerPane.locator("> [data-slot='scroll-area-scrollbar']")).toHaveCount(0);
  await expect(timerViewport).toHaveCount(1);
  const timerScrollMetrics = await timerViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(timerScrollMetrics.scrollHeight).toBeGreaterThan(timerScrollMetrics.clientHeight + 40);
  await timerViewport.evaluate((element) => {
    element.scrollTop = 50;
    return element.scrollTop;
  });
  await expect.poll(() => timerViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await timerViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await mainViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.mouse.move(
    (timerViewportBox?.x ?? 0) + (timerViewportBox?.width ?? 0) / 2,
    (timerViewportBox?.y ?? 0) + (timerViewportBox?.height ?? 0) / 2,
  );
  await page.mouse.wheel(0, 420);
  await expect.poll(() => timerViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  await timerViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.locator(".section-page-current .timer-face-row")).toHaveCount(0);
  expect(face?.width ?? 9999).toBeLessThanOrEqual(660);
  expect(Math.abs((face?.x ?? 0) + (face?.width ?? 0) / 2 - ((timerViewportBox?.x ?? 0) + (timerViewportBox?.width ?? 0) / 2))).toBeLessThanOrEqual(2);
  expect(startButton?.y ?? 0).toBeGreaterThan(viewport?.height ?? 0);
  const faceBottom = (face?.y ?? 0) + (face?.height ?? 0);
  const hintCenter = (hint?.y ?? 0) + (hint?.height ?? 0) / 2;
  const timerViewportBottom = (timerViewportBox?.y ?? 0) + (timerViewportBox?.height ?? viewport?.height ?? 0);
  expect(hintCenter).toBeGreaterThan(faceBottom);
  expect(hintCenter).toBeLessThanOrEqual(timerViewportBottom);

  const topbarActions = page.locator(".topbar-actions");
  const historyAction = topbarActions.getByRole("button", { name: "История фокуса" });
  const goalAction = topbarActions.getByRole("button", { name: "Цели фокусировки" });

  await historyAction.click({ force: true });
  await expect(historyAction).toHaveAttribute("aria-pressed", "true");
  const historyPaneLocator = page.locator('.focus-context-pane[aria-label="История фокуса"]');
  await expect(historyPaneLocator).toBeVisible();
  const historyScrollArea = historyPaneLocator.locator("> [data-slot='scroll-area']");
  const historyScrollViewport = historyScrollArea.locator("> [data-slot='scroll-area-viewport']");
  const historyScrollbar = historyScrollArea.locator("> [data-slot='scroll-area-scrollbar']");
  const historyPane = await historyPaneLocator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, width: rect.width };
  });
  await expect(page.locator(".section-page-current .focus-timer-pane[data-slot='scroll-area']")).toBeVisible();
  await expect(page.locator(".section-page-current .focus-timer-pane > [data-slot='scroll-area-scrollbar']")).toHaveCount(0);
  await expect(historyScrollArea).toHaveCount(1);
  const paneRightGap = await historyPaneLocator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return window.innerWidth - rect.right;
  });
  expect(paneRightGap).toBeLessThanOrEqual(6);
  await expect(historyScrollbar).toHaveAttribute("data-scrollbar-state", "hidden");
  await expect(historyScrollbar).toHaveCSS("opacity", "0");
  const historyViewportBox = await historyScrollViewport.boundingBox();
  await page.mouse.move(
    (historyViewportBox?.x ?? 0) + (historyViewportBox?.width ?? 0) / 2,
    (historyViewportBox?.y ?? 0) + (historyViewportBox?.height ?? 0) / 2,
  );
  const historyScrollMetrics = await historyScrollViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(historyScrollMetrics.scrollHeight).toBeGreaterThan(historyScrollMetrics.clientHeight + 80);
  await page.mouse.wheel(0, 420);
  await expect(historyScrollbar).toHaveAttribute("data-scrollbar-state", "visible", { timeout: 3_000 });
  await historyScrollViewport.evaluate((element) => {
    if (element.scrollTop === 0) element.scrollTop = 120;
  });
  const historyScrollAreaClass = await historyScrollArea.evaluate((element) => element.className);
  expect(historyScrollAreaClass).not.toContain("hidden");
  expect(historyScrollAreaClass).not.toContain("pr-3");
  expect(historyScrollAreaClass).not.toContain("pr-5");
  expect(historyScrollAreaClass).not.toContain("right-1");
  expect(historyScrollAreaClass).toContain("[--scroll-area-thumb-size:10px]");
  expect(historyScrollAreaClass).toContain("[--scroll-area-gap:calc(var(--scroll-area-thumb-size)/2)]");
  const historyCardEdges = await historyPaneLocator.evaluate((element) => {
    const card = element.querySelector<HTMLElement>(".history-group, [data-slot='frame'], [data-slot='card']");
    const scrollArea = element.querySelector<HTMLElement>("[data-slot='scroll-area']");
    const scrollbar = element.querySelector<HTMLElement>("[data-slot='scroll-area-scrollbar']");
    const thumb = element.querySelector<HTMLElement>("[data-slot='scroll-area-thumb']");
    if (!card || !scrollArea || !scrollbar || !thumb) return null;
    const cardRect = card.getBoundingClientRect();
    const scrollRect = scrollArea.getBoundingClientRect();
    const scrollbarRect = scrollbar.getBoundingClientRect();
    const thumbRect = thumb.getBoundingClientRect();
    return {
      cardLeft: cardRect.left,
      cardRight: cardRect.right,
      scrollLeft: scrollRect.left,
      scrollRight: scrollRect.right,
      scrollbarLeft: scrollbarRect.left,
      scrollbarRight: scrollbarRect.right,
      thumbWidth: thumbRect.width,
    };
  });
  expect(historyCardEdges).not.toBeNull();
  expect(historyCardEdges?.cardLeft ?? 0).toBeGreaterThanOrEqual((historyCardEdges?.scrollLeft ?? 0) - 1);
  const expectedScrollGap = (historyCardEdges?.thumbWidth ?? 0) / 2;
  const contentGap = (historyCardEdges?.scrollbarLeft ?? 0) - (historyCardEdges?.cardRight ?? 0);
  const edgeGap = (historyCardEdges?.scrollRight ?? 0) - (historyCardEdges?.scrollbarRight ?? 0);
  expect(Math.abs(contentGap - expectedScrollGap)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(edgeGap - expectedScrollGap)).toBeLessThanOrEqual(1.5);
  await page.waitForTimeout(1300);
  await expect(historyScrollbar).toHaveAttribute("data-scrollbar-state", "hidden");
  await expect(historyScrollbar).toHaveCSS("opacity", "0");
  expect(historyPane).not.toBeNull();
  expect(historyPane.x).toBeGreaterThan((stage?.x ?? 0) + (stage?.width ?? 0) / 2);
  expect(historyPane.width).toBeGreaterThan((stage?.width ?? 0) * 0.35);

  await expect(goalAction).toBeEnabled();
  await goalAction.evaluate((button: HTMLButtonElement) => button.click());
  await expect(goalAction).toHaveAttribute("aria-pressed", "true");
  await expect(historyAction).toHaveAttribute("aria-pressed", "false");
  const goalPane = page.locator('.focus-context-pane[aria-label="Цели фокусировки"]');
  await expect(goalPane).toBeVisible();
  expect(await goalPane.textContent()).toContain("Общий прогресс");
});

async function mockFocusApi(page: Page) {
  await page.route("**/api/v1/timer/state", (route) =>
    route.fulfill({
      json: {
        active_session: null,
        elapsed_seconds: 0,
        server_revision: 1,
        server_time_utc: "2026-06-21T12:00:00.000Z",
        timezone: "Europe/Moscow",
      },
    }),
  );
  await page.route("**/api/v1/timer/events/sync", async (route) => {
    const body = route.request().postDataJSON() as {
      events?: Array<{
        event_id: string;
        local_timer_id: string;
        occurred_at_utc: string;
        type: "start" | "stop";
      }>;
    };
    const events = body.events ?? [];
    const lastEvent = events.at(-1);
    await route.fulfill({
      json: {
        acknowledged_event_ids: events.map((event) => event.event_id),
        ignored_events: [],
        server_revision: 2,
        state: {
          active_session:
            lastEvent?.type === "start"
              ? {
                  id: lastEvent.local_timer_id,
                  started_at_utc: lastEvent.occurred_at_utc,
                  ended_at_utc: null,
                  duration_seconds: null,
                }
              : null,
          elapsed_seconds: 0,
          server_revision: 2,
          server_time_utc: "2026-06-21T12:00:00.000Z",
          timezone: "Europe/Moscow",
        },
      },
    });
  });
  await page.route("**/api/v1/sessions", (route) => route.fulfill({ json: focusHistoryOverflowFixture() }));
  await page.route("**/api/v1/goals/challenge", (route) =>
    route.fulfill({
      json: {
        achieved: false,
        completed_hours: 0,
        completed_seconds: 0,
        daily_goal_seconds: 43200,
        days: [],
        days_count: 28,
        end_date: "2026-07-09",
        percentage: 0,
        remaining_days: 28,
        remaining_seconds: 1209600,
        required_average_hours_per_remaining_day: 12,
        required_average_seconds_per_remaining_day: 43200,
        start_date: "2026-06-12",
        timezone: "Europe/Moscow",
        total_goal_seconds: 1209600,
      },
    }),
  );
  await page.route("**/api/v1/activities", (route) =>
    route.fulfill({
      json: {
        activities: [],
        archived_activities: [],
        server_revision: 1,
        server_time_utc: "2026-06-21T12:00:00.000Z",
      },
    }),
  );
}

function focusHistoryOverflowFixture() {
  const date = "2026-06-21";
  const sessions = Array.from({ length: 48 }, (_, index) => {
    const startedAt = new Date(Date.UTC(2026, 5, 21, Math.floor(index / 12), (index % 12) * 5, 0));
    const endedAt = new Date(startedAt.getTime() + 2 * 60 * 1000);
    return {
      duration_seconds: 120,
      ended_at_utc: endedAt.toISOString(),
      id: `focus-overflow-${index}`,
      started_at_utc: startedAt.toISOString(),
    };
  });
  return {
    groups: {
      [date]: {
        sessions,
        total_seconds: sessions.reduce((total, session) => total + session.duration_seconds, 0),
      },
    },
    sessions,
  };
}

test("keeps desktop Focus background and timer stable across rail and panel changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only focus background layout");
  test.setTimeout(90_000);

  await mockFocusApi(page);
  await page.goto("/focus");
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();

  const backgroundGap = (selector: string) =>
    page.evaluate((backgroundSelector) => {
      const background = document.querySelector(backgroundSelector)?.getBoundingClientRect();
      const canvas = document.querySelector(`${backgroundSelector} canvas`)?.getBoundingClientRect();
      if (!background || !canvas || canvas.width <= 0 || canvas.height <= 0) return 9999;
      return Math.max(
        canvas.x - background.x,
        canvas.y - background.y,
        background.x + background.width - (canvas.x + canvas.width),
        background.y + background.height - (canvas.y + canvas.height),
      );
    }, selector);
  const galaxyGap = () => backgroundGap(".timer-galaxy-background");
  const evilEyeGap = () => backgroundGap(".timer-evil-eye-background");

  await expect(page.locator(".timer-galaxy-background canvas")).toBeVisible();
  await expect.poll(galaxyGap, { timeout: 45_000 }).toBeLessThanOrEqual(4);
  await expect(page.getByRole("button", { name: "Фон Galaxy" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Фон Evil Eye" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole("button", { name: "Фон Evil Eye" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".timer-evil-eye-background")).toHaveClass(/opacity-100/);
  await expect(page.locator(".timer-evil-eye-background canvas")).toBeVisible();
  await expect.poll(evilEyeGap, { timeout: 45_000 }).toBeLessThanOrEqual(4);

  await expect(page.locator(".desktop-rail")).not.toHaveClass(/expanded/);
  await expect.poll(evilEyeGap, { timeout: 45_000 }).toBeLessThanOrEqual(4);

  const startButton = page.getByRole("button", { name: "Запустить" });
  const timerViewport = page.locator(".section-page-current .focus-timer-pane > [data-slot='scroll-area-viewport']");
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeEnabled({ timeout: 45_000 });
  await expect.poll(() => timerViewport.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(40);
  await timerViewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  await expect.poll(() => timerViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
  await startButton.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) => element.textContent?.includes("Запустить"));
        if (!(button instanceof HTMLButtonElement)) return false;
        const rect = button.getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return target === button || button.contains(target);
      }),
    )
    .toBe(true);
  await startButton.evaluate((element) => {
    element.click();
  });
  await expect(page.getByRole("button", { name: /Завершить/ })).toBeVisible({ timeout: 30_000 });
  const historyButton = page.locator(".section-page-current .topbar-actions").getByRole("button", { name: "История фокуса" });
  await historyButton.click({ force: true });
  await expect(page.locator(".section-page-current .focus-context-pane")).toHaveCount(1);

  await expect
    .poll(() =>
      page.evaluate(() => {
        const face = document.querySelector(".section-page-current .timer-face")?.getBoundingClientRect();
        const digits = document.querySelector(".section-page-current .timer-digits")?.getBoundingClientRect();
        return Boolean(
          face &&
            digits &&
            digits.x >= face.x - 1 &&
            digits.y >= face.y - 1 &&
            digits.x + digits.width <= face.x + face.width + 1 &&
            digits.y + digits.height <= face.y + face.height + 1,
        );
      }),
    )
    .toBe(true);
});

test("shows the desktop action delete button only on row hover", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only action delete control");

  await page.goto("/");
  await page.getByRole("textbox", { name: "Добавить" }).fill("Фокус");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Фокус" })).toBeVisible();

  const row = page.locator(".action-row").first();
  const deleteButton = row.locator(".action-delete-button");
  await expect(deleteButton).toHaveCSS("visibility", "hidden");
  await row.hover();
  await expect(page.getByRole("button", { name: "Удалить: Фокус" })).toBeVisible();
  await expect(deleteButton).toHaveCSS("opacity", "0.42");

  await deleteButton.click();
  await expect(page.getByRole("textbox", { name: "Название действия: Фокус" })).toHaveCount(0);
});

test("pins the active desktop action focus timer to the right edge", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only action focus control");

  await page.goto("/");
  await page.getByRole("textbox", { name: "Добавить" }).fill("Фокус");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Фокус" })).toBeVisible();

  const row = page.locator(".action-row").first();
  await row.hover();
  await page.getByRole("button", { name: "Фокусироваться: Фокус" }).click();

  const focusButton = row.locator(".action-focus-button");
  const deleteButton = row.locator(".action-delete-button");
  await expect(page.getByRole("button", { name: "Остановить фокус: Фокус" })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(deleteButton).toHaveCSS("visibility", "hidden");
  await expect(focusButton).not.toContainText("Стоп");

  await expect
    .poll(() =>
      row.evaluate((element) => {
        const rowRect = element.getBoundingClientRect();
        const focusRect = element.querySelector(".action-focus-button")?.getBoundingClientRect();
        const deleteRect = element.querySelector(".action-delete-button")?.getBoundingClientRect();
        if (!focusRect || !deleteRect) return null;
        return {
          deleteWidth: Math.round(deleteRect.width),
          rightGap: Math.round(rowRect.right - focusRect.right),
        };
      }),
    )
    .toEqual({ deleteWidth: 0, rightGap: 0 });

  const focusXBeforeHover = await focusButton.evaluate((element) => Math.round(element.getBoundingClientRect().x));
  await row.hover();
  await expect(deleteButton).toBeVisible();
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const deleteButtonElement = element.querySelector(".action-delete-button");
        const focusButtonElement = element.querySelector(".action-focus-button");
        const deleteRect = deleteButtonElement?.getBoundingClientRect();
        const focusRect = focusButtonElement?.getBoundingClientRect();
        if (!deleteButtonElement || !focusButtonElement || !deleteRect || !focusRect) return null;
        return {
          focusX: Math.round(focusRect.x),
          order: Boolean(deleteButtonElement.compareDocumentPosition(focusButtonElement) & Node.DOCUMENT_POSITION_FOLLOWING),
          touches: Math.abs(deleteRect.right - focusRect.left) <= 1,
        };
      }),
    )
    .toEqual({ focusX: focusXBeforeHover, order: true, touches: true });

  const focusDock = page.locator('.main-dock [aria-label="Фокус"]').filter({ visible: true });
  await focusDock.hover();
  await expect
    .poll(() =>
      focusDock.evaluate((element) => {
        const circle = element.querySelector(":scope > div")?.getBoundingClientRect();
        const icon = element.querySelector(".focus-dock-icon")?.getBoundingClientRect();
        const timer = element.querySelector(".focus-dock-timer")?.getBoundingClientRect();
        const orbit = element.querySelector(".focus-dock-orbit")?.parentElement;
        if (!circle || !icon || !timer || !orbit) return null;
        return {
          heightGap: Math.round(Math.abs(circle.height - icon.height)),
          slow: Number.parseFloat(getComputedStyle(orbit).animationDuration) >= 28,
          textFits: timer.width < icon.width * 0.74,
          textScales: timer.height > 18,
          widthGap: Math.round(Math.abs(circle.width - icon.width)),
        };
      }),
    )
    .toEqual({ heightGap: 0, slow: true, textFits: true, textScales: true, widthGap: 0 });
});

test("reorders desktop actions by dragging the row handle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only action sorting");

  await page.goto("/");
  const addInput = page.getByRole("textbox", { name: "Добавить" });
  await addInput.fill("Первое");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Первое" })).toBeVisible();
  await addInput.fill("Второе");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Второе" })).toBeVisible();

  const titles = page.locator('[aria-label="Новые действия"] .action-title');
  await expect.poll(() => titles.allTextContents()).toEqual(["Второе", "Первое"]);

  const rows = page.locator(".action-row");
  const handle = rows.nth(1).locator(".action-drag-handle");
  await expect
    .poll(() => handle.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeLessThanOrEqual(0.05);
  await rows.nth(1).hover();
  await expect
    .poll(() => handle.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.2);

  const source = await handle.boundingBox();
  const target = await rows.nth(0).boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();

  await page.mouse.move((source?.x ?? 0) + (source?.width ?? 0) / 2, (source?.y ?? 0) + (source?.height ?? 0) / 2);
  await page.mouse.down();
  await page.mouse.move((target?.x ?? 0) + (target?.width ?? 0) / 2, (target?.y ?? 0) + (target?.height ?? 0) / 2, {
    steps: 8,
  });
  await page.mouse.up();

  await expect.poll(() => titles.allTextContents()).toEqual(["Первое", "Второе"]);
});

test("reorders mobile actions by long-pressing a row", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only action sorting");

  await page.goto("/");
  await createMobileAction(page, "Первое");
  await createMobileAction(page, "Второе");

  const titles = page.locator('[aria-label="Новые действия"] .action-title');
  await expect.poll(() => titles.allTextContents()).toEqual(["Второе", "Первое"]);

  const rows = page.locator(".action-row");
  const source = await rows.nth(1).locator(".action-row-surface").boundingBox();
  const target = await rows.nth(0).boundingBox();
  expect(source).not.toBeNull();
  expect(target).not.toBeNull();

  await dragTouch(
    page,
    { x: (source?.x ?? 0) + (source?.width ?? 0) / 2, y: (source?.y ?? 0) + (source?.height ?? 0) / 2 },
    { x: (target?.x ?? 0) + (target?.width ?? 0) / 2, y: (target?.y ?? 0) + (target?.height ?? 0) / 2 },
  );

  await expect.poll(() => titles.allTextContents()).toEqual(["Первое", "Второе"]);
});

test("opens the desktop activity description split panel", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only detail panel");

  const title = "Пересобрать механизм страницы Действий с длинным заголовком который должен быть виден полностью";
  await page.goto("/");
  await expect
    .poll(() =>
      page
        .locator(".main-scroll > [data-slot='scroll-area-scrollbar']")
        .evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).display === "none")),
    )
    .toBe(true);
  await page.getByRole("textbox", { name: "Добавить" }).fill(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: `Название действия: ${title}` })).toBeVisible();

  await page.getByRole("textbox", { name: `Название действия: ${title}` }).click();
  await expect(page.getByRole("button", { name: "Закрыть редактор" })).toBeVisible();
  const detailTitle = page.getByRole("textbox", { name: "Название действия", exact: true });
  await expect(detailTitle).toHaveCSS("white-space", "pre-wrap");
  await expect(detailTitle).toHaveCSS("overflow-wrap", "anywhere");
  await expect.poll(() => detailTitle.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expect(page.locator(".actions-detail-tabs")).toHaveCSS("border-bottom-width", "1px");
  const workspace = await page.locator(".actions-workspace").boundingBox();
  const listPane = await page.locator(".actions-list-pane").boundingBox();
  const detailPanel = page.locator(".actions-detail-panel.desktop");
  const panel = await detailPanel.boundingBox();
  const viewport = page.viewportSize();
  expect((listPane?.width ?? 0) / (workspace?.width ?? 1)).toBeGreaterThan(0.49);
  expect((listPane?.width ?? 0) / (workspace?.width ?? 1)).toBeLessThan(0.51);
  expect((panel?.width ?? 0) / (workspace?.width ?? 1)).toBeGreaterThan(0.49);
  expect((panel?.width ?? 0) / (workspace?.width ?? 1)).toBeLessThan(0.51);
  expect((workspace?.x ?? 0) + (workspace?.width ?? 0)).toBeGreaterThan((viewport?.width ?? 0) - 36);
  expect(panel?.height ?? 0).toBeGreaterThan((viewport?.height ?? 0) - 140);
  await expect(detailPanel).toHaveCSS("border-left-width", "0px");
  await expect(detailPanel).toHaveCSS("overflow-y", "hidden");

  const resizer = await page.locator(".actions-split-resizer").boundingBox();
  expect(resizer).not.toBeNull();
  await expect(page.locator(".actions-split-resizer")).toHaveCSS("cursor", "ew-resize");
  await expect(page.locator(".desktop-rail")).not.toHaveCSS("cursor", "ew-resize");
  const resizerCursors = await page.locator(".actions-split-resizer").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return [2, rect.width / 2, rect.width - 2].map((offset) => {
      const target = document.elementFromPoint(rect.left + offset, rect.top + rect.height / 2);
      return target instanceof Element ? getComputedStyle(target).cursor : null;
    });
  });
  expect(resizerCursors).toEqual(["ew-resize", "ew-resize", "ew-resize"]);
  await page.mouse.move((resizer?.x ?? 0) + (resizer?.width ?? 0) / 2, (resizer?.y ?? 0) + (resizer?.height ?? 0) / 2);
  await page.mouse.down();
  await page.mouse.move((workspace?.x ?? 0) + (workspace?.width ?? 0) * 0.3, (resizer?.y ?? 0) + (resizer?.height ?? 0) / 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.documentElement.style.cursor)).not.toBe("ew-resize");
  await expect.poll(() => detailTitle.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expect.poll(async () => ((await page.locator(".actions-list-pane").boundingBox())?.width ?? 0) / ((await page.locator(".actions-workspace").boundingBox())?.width ?? 1)).toBeGreaterThan(0.29);
  await expect.poll(async () => ((await page.locator(".actions-list-pane").boundingBox())?.width ?? 0) / ((await page.locator(".actions-workspace").boundingBox())?.width ?? 1)).toBeLessThan(0.31);
  await page.getByRole("button", { name: "Закрыть редактор" }).click();
  await page.getByRole("textbox", { name: `Название действия: ${title}` }).click();
  await expect
    .poll(async () => ((await page.locator(".actions-list-pane").boundingBox())?.width ?? 0) / ((await page.locator(".actions-workspace").boundingBox())?.width ?? 1))
    .toBeGreaterThan(0.49);
  const overLimitTitle = "я".repeat(270);
  await detailTitle.fill(overLimitTitle);
  await expect.poll(async () => (await detailTitle.inputValue()).length).toBe(250);
  await expect(detailPanel.locator(".actions-detail-title-counter")).toHaveText("0");
  await expect(detailPanel.locator(".actions-detail-title-counter")).toHaveClass(/text-destructive/);
  await expect(page.locator(".actions-detail-tabs")).toBeVisible();

  const descriptionEditor = page.getByRole("textbox", { name: "Описание действия" });
  await expect(descriptionEditor).toBeVisible();
  expect(Math.abs(((await descriptionEditor.boundingBox())?.width ?? 0) - ((await detailTitle.boundingBox())?.width ?? 0))).toBeLessThanOrEqual(1);
  const descriptionText = `# Большое описание

## Цель

**важно** ${"длинная строка ".repeat(120)}`;
  await expect.poll(() => descriptionEditor.evaluate((node) => node.closest(".actions-detail-description-scroll")?.getAttribute("data-slot"))).toBe("scroll-area");
  await expect(descriptionEditor).toHaveClass(/overflow-hidden/);
  await expect(descriptionEditor).toHaveCSS("padding-right", "0px");
  await expect.poll(() => descriptionEditor.evaluate((node) => getComputedStyle(node, "::before").float)).toBe("right");
  await descriptionEditor.fill(descriptionText);
  const infoScrollArea = detailPanel.locator(".actions-detail-description-scroll");
  const infoScrollbar = infoScrollArea.locator("> [data-slot='scroll-area-scrollbar']");
  const panelBox = await detailPanel.boundingBox();
  const scrollbarBox = await infoScrollbar.boundingBox();
  expect(scrollbarBox).not.toBeNull();
  expect(
    Math.abs(
      ((panelBox?.x ?? 0) + (panelBox?.width ?? 0) - ((scrollbarBox?.x ?? 0) + (scrollbarBox?.width ?? 0))) -
        ((scrollbarBox?.width ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(1);
  const infoViewport = page.locator(".actions-detail-description-scroll > [data-slot='scroll-area-viewport']");
  await descriptionEditor.evaluate((node) => (node as HTMLElement).blur());
  await infoViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => infoViewport.evaluate((element) => element.scrollTop)).toBe(0);
  const titleTopBeforeScroll = (await detailTitle.boundingBox())?.y ?? 0;
  await infoViewport.evaluate((element) => {
    element.scrollTop = 120;
  });
  await expect.poll(() => infoViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await detailTitle.boundingBox())?.y ?? 0).toBeLessThan(titleTopBeforeScroll - 20);
  const readModeButton = page.getByRole("button", { name: "Читать описание" });
  await expect(readModeButton).toHaveAttribute("aria-pressed", "false");
  await readModeButton.click();
  await expect(page.getByRole("button", { name: "Редактировать описание" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("bright_os_activity_md_preview"))).toBe("true");
  await expect
    .poll(() =>
      page.locator(".actions-detail-description-preview").evaluate((node) =>
        node.closest(".actions-detail-description-scroll")?.getAttribute("data-slot"),
      ),
    )
    .toBe("scroll-area");
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Большое описание");
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Цель");
  await expect(page.locator(".actions-detail-description-preview")).toContainText("важно");
  await expect(page.locator(".actions-detail-description-preview")).not.toContainText("# Цель");
  await expect(page.locator(".actions-detail-description-preview")).not.toContainText("##");
  await expect(page.locator(".actions-detail-description-preview")).not.toContainText("**");
  await page.getByRole("button", { name: "Редактировать описание" }).click();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("bright_os_activity_md_preview"))).toBe("false");
  await expect(page.getByRole("textbox", { name: "Описание действия" })).toContainText(descriptionText);
  await page.getByRole("button", { name: "Закрыть редактор" }).click();
  const rowPreview = page.locator(".action-description-preview");
  await expect(rowPreview).toContainText("Большое описание");
  await expect(rowPreview).not.toContainText("# Цель");
  await expect(rowPreview).not.toContainText("##");
  await expect(rowPreview).toHaveCSS("white-space", "nowrap");
  await expect(rowPreview).toHaveCSS("overflow-x", "hidden");
  await expect(rowPreview).toHaveCSS("font-size", "12px");
  await expect.poll(() => rowPreview.evaluate((node) => getComputedStyle(node).maskImage)).toContain("linear-gradient");

  await rowPreview.click();
  await expect(page.getByRole("button", { name: "Закрыть редактор" })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть редактор" }).click();

  const rowSurface = page.locator(".action-row-surface").first();
  const rowSurfaceBox = await rowSurface.boundingBox();
  await rowSurface.click({
    position: {
      x: Math.max(12, (rowSurfaceBox?.width ?? 80) - 12),
      y: Math.min((rowSurfaceBox?.height ?? 54) / 2, 42),
    },
  });
  await expect(page.getByRole("button", { name: "Закрыть редактор" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Название действия", exact: true })).toBeFocused();
});

test("keeps the desktop inbox detail info after tab switches", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only inbox detail panel");

  const title = "Уже лучше, но теперь есть нюанс: когда я пытаюсь раскрывать длинный заголовок входящего";
  const descriptionText = [
    "# Контекст",
    "",
    "Описание",
    "Описание",
    "Описание",
    "Описание",
    "Описание",
    "О О О Л Л Л Л Ь Л Д Л",
  ].join("\n");
  await page.goto("/inbox");
  await page.getByRole("textbox", { name: "Добавить входящее" }).fill(title);
  await page.keyboard.press("Enter");
  const rowTitle = page.getByRole("textbox", { name: `Название входящего: ${title}` });
  await expect(rowTitle).toBeVisible();

  await rowTitle.click();
  const panel = page.locator(".actions-detail-panel.desktop");
  await expect(panel).toBeVisible();
  const detailTitle = page.getByRole("textbox", { name: "Название входящего", exact: true });
  const tabsBox = await panel.locator(".actions-detail-tabs").boundingBox();
  const titleBox = await detailTitle.boundingBox();
  await expect(detailTitle).toHaveValue(title);
  await expect(detailTitle).toHaveCSS("white-space", "pre-wrap");
  await expect(detailTitle).toHaveCSS("overflow-wrap", "anywhere");
  expect(tabsBox?.y ?? 0).toBeLessThan(titleBox?.y ?? 0);
  expect((titleBox?.y ?? 0) - ((tabsBox?.y ?? 0) + (tabsBox?.height ?? 0))).toBeGreaterThanOrEqual(20);
  expect((titleBox?.y ?? 0) - ((tabsBox?.y ?? 0) + (tabsBox?.height ?? 0))).toBeLessThanOrEqual(28);
  expect(titleBox?.height ?? 0).toBeGreaterThan(44);
  await expect.poll(() => detailTitle.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  const titleHeightBeforeTabSwitch = titleBox?.height ?? 0;
  await expect(panel.locator(".actions-detail-header .actions-detail-preview-toggle")).toHaveCount(0);
  await expect(panel.locator(".actions-detail-description-scroll .actions-detail-preview-toggle")).toBeVisible();

  const descriptionEditor = page.getByRole("textbox", { name: "Описание входящего" });
  await expect(descriptionEditor).toHaveCSS("padding-right", "0px");
  await expect.poll(() => descriptionEditor.evaluate((node) => getComputedStyle(node, "::before").float)).toBe("right");
  await descriptionEditor.fill(descriptionText);
  await page.getByRole("button", { name: "Читать описание" }).click();
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Контекст");
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Д Л");
  await page.getByRole("tab", { name: "Детали" }).click();
  await expect.poll(() => detailTitle.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  expect(Math.abs(((await detailTitle.boundingBox())?.height ?? 0) - titleHeightBeforeTabSwitch)).toBeLessThanOrEqual(2);
  await page.getByRole("tab", { name: "Инфо" }).click();
  await expect.poll(() => detailTitle.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  expect(Math.abs(((await detailTitle.boundingBox())?.height ?? 0) - titleHeightBeforeTabSwitch)).toBeLessThanOrEqual(2);
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Контекст");
  await expect(page.locator(".actions-detail-description-preview")).toContainText("Д Л");
});
