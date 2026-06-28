import { expect, test, type Locator, type Page } from "@playwright/test";
import { createMobileAction, dispatchElementTouch, dispatchTouch, dragTouch, horizontalCenterOffset, openProfileMenuItem, swipeActionRowLeft, swipeTouch } from "./shell-helpers";

test("opens the mobile profile drawer with navigation over dimmed content", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only drawer");

  await page.goto("/");
  await page.locator(".section-page-current .mobile-menu-button").click();
  await expect(page.locator(".mobile-menu-backdrop")).toBeVisible();
  await expect(page.locator(".mobile-profile-drawer")).toContainText("Workspace");
  await expect(page.locator(".mobile-profile-drawer")).not.toContainText("Platform");
  await expect(page.locator(".mobile-profile-drawer")).not.toContainText("Time");

  const drawer = await page.locator(".mobile-profile-drawer").boundingBox();
  const viewport = page.viewportSize();
  expect(drawer?.width ?? 0).toBeGreaterThan((viewport?.width ?? 0) * 0.66);
  expect(drawer?.width ?? 0).toBeLessThan((viewport?.width ?? 0) * 0.74);

  await dispatchTouch(page, "touchstart", { x: 320, y: 220 });
  await dispatchTouch(page, "touchend", { x: 180, y: 224 });
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();

  await page.locator(".mobile-menu-backdrop").click({ position: { x: 360, y: 120 } });
  await expect(page.locator(".mobile-menu-backdrop")).toHaveCount(0);
});

test("opens Settings from the mobile profile dropdown", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only profile menu");

  await page.goto("/");
  await page.locator(".section-page-current .mobile-menu-button").click();
  await expect(page.locator(".mobile-profile-drawer")).toContainText("Workspace");

  await page.getByRole("button", { name: "Открыть меню профиля" }).click();
  await expect(page.getByRole("menuitem", { name: "Настройки" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Архив" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Выйти" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Настройки" }).click();

  await expect(page.locator(".mobile-menu-backdrop")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
});

test("opens mobile action input overlay from the floating plus button", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only action overlay");

  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  await page.locator(".actions-fab").click();
  await expect(page.getByRole("textbox", { name: "Добавить действие" })).toBeFocused();
  await expect(page.locator(".actions-add-submit")).toBeVisible();
  await expect(page.locator(".actions-add-submit svg")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeHidden();

  const editor = await page.locator(".actions-mobile-editor").boundingBox();
  expect(editor?.height ?? 999).toBeLessThanOrEqual(96);

  await expect.poll(() => page.evaluate(() => (window as Window & { BrightOsAndroidBack?: () => boolean }).BrightOsAndroidBack?.())).toBe(true);
  await expect(page.locator(".actions-mobile-overlay")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
});

test("keeps the mobile Actions FAB vertically stable when a dock swipe starts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only action swipe layout");

  await page.goto("/");
  const fab = page.locator(".actions-fab");
  await expect(fab).toBeVisible();
  const before = await fab.boundingBox();
  const dock = await page.locator(".main-dock").boundingBox();
  const start = {
    x: (dock?.x ?? 0) + (dock?.width ?? 0) / 2,
    y: (dock?.y ?? 0) + (dock?.height ?? 0) / 2,
  };

  await dispatchElementTouch(page, ".main-dock", "touchstart", start);
  await dispatchElementTouch(page, ".main-dock", "touchmove", { x: start.x - 36, y: start.y + 1 });

  const during = await fab.boundingBox();
  expect(Math.abs((during?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);

  await dispatchElementTouch(page, ".main-dock", "touchend", { x: start.x - 36, y: start.y + 1 });
});

test("opens and closes mobile Actions info as a bottom sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only actions info");

  await page.goto("/");
  await page.getByRole("button", { name: "Информация о действиях" }).click();
  const sheet = page.locator(".mobile-context-sheet");
  const visualBackdrop = page.locator(".mobile-context-backdrop > div").first();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".mobile-context-grabber")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(0);

  const backdropBox = await visualBackdrop.boundingBox();
  const topbar = await page.locator(".section-page-current .topbar").boundingBox();
  const topbarBottom = (topbar?.y ?? 0) + (topbar?.height ?? 0);
  expect(Math.abs((backdropBox?.y ?? 0) - topbarBottom)).toBeLessThanOrEqual(1);

  await dispatchTouch(page, "touchstart", { x: 320, y: 220 });
  await dispatchTouch(page, "touchend", { x: 180, y: 224 });
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();
  await expect(sheet).toBeVisible();

  const dragZone = await sheet.locator(".mobile-context-drag-zone").boundingBox();
  const viewport = page.viewportSize();
  const dragX = (dragZone?.x ?? 0) + (dragZone?.width ?? 0) / 2;
  await page.mouse.move(dragX, (dragZone?.y ?? 0) + 8);
  await page.mouse.down();
  await page.mouse.move(dragX, (viewport?.height ?? 640) - 12, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".mobile-context-sheet")).toHaveCount(0);
});

test("opens and closes mobile Inbox info as a bottom sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only inbox info");

  await page.goto("/inbox");
  await page.getByRole("button", { name: "Информация о входящих" }).click();
  const sheet = page.locator(".mobile-context-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".mobile-context-grabber")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(0);

  const dragZone = await sheet.locator(".mobile-context-drag-zone").boundingBox();
  const viewport = page.viewportSize();
  const dragX = (dragZone?.x ?? 0) + (dragZone?.width ?? 0) / 2;
  await page.mouse.move(dragX, (dragZone?.y ?? 0) + 8);
  await page.mouse.down();
  await page.mouse.move(dragX, (viewport?.height ?? 640) - 12, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".mobile-context-sheet")).toHaveCount(0);
});

test("keeps a single mobile action compact without creating empty scroll", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only action layout");

  await page.goto("/");
  await createMobileAction(page, "Фокус");
  await expect(page.getByRole("button", { name: /Выполнено 0/ })).toHaveCount(0);

  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(24);

  const checkboxBox = await page.locator(".action-checkbox-label").first().boundingBox();
  const titleBox = await page.locator(".action-title").first().boundingBox();
  const checkboxCenterY = (checkboxBox?.y ?? 0) + (checkboxBox?.height ?? 0) / 2;
  const titleCenterY = (titleBox?.y ?? 0) + (titleBox?.height ?? 0) / 2;
  expect(Math.abs(checkboxCenterY - titleCenterY)).toBeLessThanOrEqual(2);

  await page.locator(".action-checkbox-label").first().click();
  await expect(page.locator(".action-row.done .action-title")).toContainText("Фокус");
  await expect(page.locator(".action-row.done .action-title")).toHaveCSS("text-decoration-line", "none");
  await expect.poll(async () => (await page.locator(".action-row.done .action-main").boundingBox())?.width ?? 0).toBeGreaterThan(220);
});

test("does not complete a desktop action when its title is clicked", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only inline title behavior");

  await page.goto("/");
  await expect(page.getByText("Новых действий нет")).toBeVisible();
  const addInput = page.getByRole("textbox", { name: "Добавить" });
  await addInput.fill("Клик заголовка");
  await addInput.press("Enter");

  const title = page.getByRole("textbox", { name: "Название действия: Клик заголовка" });
  await expect(title).toBeVisible();
  await title.click();

  await expect(page.getByRole("button", { name: "Закрыть редактор" })).toBeVisible();
  await expect(title).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Название действия", exact: true })).not.toBeFocused();
  await expect(page.getByRole("checkbox", { name: "Клик заголовка" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: /Выполнено 1/ })).toHaveCount(0);
  await expect(page.locator(".action-row.done")).toHaveCount(0);
});

test("opens the mobile activity detail editor from a title tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only title tap");

  await page.goto("/");
  await createMobileAction(page, "Title tap mobile");

  await page.getByRole("textbox", { name: "Название действия: Title tap mobile" }).click();
  await expect(page.getByRole("button", { name: "Сохранить и закрыть" })).toBeVisible();
  await expect(page.locator(".actions-detail-panel.mobile")).toBeVisible();
});

test("scrolls the mobile Actions page from completed rows", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only completed scroll");

  await page.goto("/");
  for (let index = 1; index <= 14; index += 1) {
    const title = `Готово ${index}`;
    await createMobileAction(page, title);
    await page.locator(".action-row").first().locator(".action-checkbox-label").click();
  }

  const mainViewport = page.locator(".main-scroll > [data-slot='scroll-area-viewport']");
  const listViewport = page.locator(".actions-list-pane > [data-slot='scroll-area-viewport']");
  await listViewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBe(0);

  const rowBox = await page.locator(".action-row.done").first().boundingBox();
  expect(rowBox).not.toBeNull();
  const x = (rowBox?.x ?? 0) + (rowBox?.width ?? 0) / 2;
  const y = (rowBox?.y ?? 0) + Math.min((rowBox?.height ?? 54) / 2, 42);
  await swipeTouch(page, { x, y }, { x, y: y - 300 });

  await expect.poll(() => listViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBe(0);
});

test("reveals and hides the mobile action delete menu by swipe", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only action delete gesture");

  await page.goto("/");
  await createMobileAction(page, "Фокус");

  const row = page.locator(".action-row").first();
  const surface = row.locator(".action-row-surface");
  const box = await row.boundingBox();
  const y = (box?.y ?? 120) + (box?.height ?? 54) / 2;
  const startX = (box?.x ?? 14) + (box?.width ?? 360) - 20;

  await dispatchElementTouch(page, ".action-row", "touchstart", { x: startX, y });
  await dispatchElementTouch(page, ".action-row", "touchmove", { x: startX - 44, y });
  await expect(surface).toHaveAttribute("style", /translate3d\(-44px, 0px, 0px\)/);

  await dispatchElementTouch(page, ".action-row", "touchend", { x: startX - 72, y });
  await expect(row).toHaveClass(/delete-open/);
  await expect(surface).toHaveAttribute("style", /translate3d\(0px, 0px, 0px\)/);

  await surface.click({ position: { x: 24, y: 24 } });
  await expect(row).not.toHaveClass(/delete-open/);

  await dispatchElementTouch(page, ".action-row", "touchstart", { x: startX, y });
  await dispatchElementTouch(page, ".action-row", "touchmove", { x: startX - 44, y });
  await dispatchElementTouch(page, ".action-row", "touchend", { x: startX - 72, y });
  await expect(row).toHaveClass(/delete-open/);
  await page.getByRole("button", { name: "Удалить: Фокус" }).click();
  await expect(page.getByRole("textbox", { name: "Название действия: Фокус" })).toHaveCount(0);
});

test("deletes and restores a mobile action after real touch swipes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only archive flow");

  await page.goto("/");
  await createMobileAction(page, "Мобильный архив");

  await swipeActionRowLeft(page, page.locator(".action-row").first());
  await page.getByRole("button", { name: "Удалить: Мобильный архив" }).click();
  await expect(page.getByRole("textbox", { name: "Название действия: Мобильный архив" })).toHaveCount(0);

  await openProfileMenuItem(page, "Архив");
  await expect(page.getByRole("heading", { name: "Архив" })).toBeVisible();
  await expect(page.getByText("Мобильный архив")).toBeVisible();

  await swipeActionRowLeft(page, page.locator(".action-row").first());
  await page.getByRole("button", { name: "Восстановить: Мобильный архив" }).click();
  await expect(page.getByText("Мобильный архив")).toHaveCount(0);

  await page.getByRole("button", { name: "Действия" }).last().click();
  await expect(page.getByRole("textbox", { name: "Название действия: Мобильный архив" })).toBeVisible();
});

test("opens the mobile bottom-sheet activity detail editor", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only detail editor");

  await page.goto("/");
  await createMobileAction(page, "Описание mobile");

  const rowSurface = page.locator(".action-row-surface").first();
  const rowSurfaceBox = await rowSurface.boundingBox();
  await rowSurface.click({
    position: {
      x: Math.max(80, (rowSurfaceBox?.width ?? 320) - 24),
      y: Math.min((rowSurfaceBox?.height ?? 54) / 2, 42),
    },
  });
  await expect(page.getByRole("button", { name: "Сохранить и закрыть" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeHidden();
  await expect(page.locator(".actions-detail-backdrop")).toBeVisible();
  await expect(page.locator(".actions-detail-grabber")).toBeVisible();
  const editorLocator = page.locator(".actions-detail-panel.mobile");
  await expect.poll(async () => (await editorLocator.boundingBox())?.y ?? 999).toBeLessThanOrEqual(20);
  const editor = await editorLocator.boundingBox();
  const viewport = page.viewportSize();
  expect(editor?.y ?? 0).toBeGreaterThanOrEqual(0);
  expect(editor?.height ?? 999).toBeLessThanOrEqual((viewport?.height ?? 0) + 1);
  expect((editor?.y ?? 0) + (editor?.height ?? 0)).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 1);
  await expect(editorLocator).toHaveCSS("border-top-width", "1px");

  await page.locator(".actions-detail-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("button", { name: "Сохранить и закрыть" })).toBeVisible();

  const dragZone = page.locator(".actions-detail-drag-zone");
  const dragZoneBox = await dragZone.boundingBox();
  const dragStart = {
    x: (dragZoneBox?.x ?? 0) + (dragZoneBox?.width ?? 0) / 2,
    y: (dragZoneBox?.y ?? 0) + (dragZoneBox?.height ?? 0) / 2,
  };
  await swipeTouch(page, dragStart, { x: dragStart.x, y: dragStart.y + 80 });
  await expect(page.getByRole("button", { name: "Сохранить и закрыть" })).toBeVisible();
  await expect.poll(async () => (await editorLocator.boundingBox())?.y ?? 999).toBeLessThanOrEqual(20);

  await page.getByRole("textbox", { name: "Описание действия" }).fill("мобильное **описание**");
  await page.getByRole("button", { name: "Читать описание" }).click();
  await expect(page.locator(".actions-detail-description-preview")).toContainText("мобильное описание");
  await expect(page.locator(".actions-detail-description-preview")).not.toContainText("**");
  await page.getByRole("button", { name: "Редактировать описание" }).click();
  await expect(page.getByRole("textbox", { name: "Описание действия" })).toHaveValue("мобильное **описание**");
  await page.getByRole("textbox", { name: "Описание действия" }).fill(
    Array.from({ length: 36 }, (_, index) => `строка ${index + 1} для проверки прокрутки`).join("\n\n"),
  );
  await page.getByRole("button", { name: "Читать описание" }).click();
  await expect(page.locator(".actions-detail-description-preview")).toContainText("строка 36");
  const descriptionViewport = page.locator(".actions-detail-description-scroll [data-slot='scroll-area-viewport']");
  await descriptionViewport.evaluate((element) => {
    element.scrollTop = 180;
  });
  await expect.poll(() => descriptionViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const previewBox = await page.locator(".actions-detail-description-preview").boundingBox();
  const bodyDragX = (previewBox?.x ?? 0) + (previewBox?.width ?? 320) / 2;
  const bodyDragY = (previewBox?.y ?? 0) + Math.min((previewBox?.height ?? 320) / 2, 220);
  await swipeTouch(page, { x: bodyDragX, y: bodyDragY }, { x: bodyDragX, y: bodyDragY + 420 });
  await expect(editorLocator).toHaveCount(0);
  await expect(page.locator(".action-description-preview")).toContainText("строка 36");
});

test("closes the mobile activity detail editor with Back", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only detail editor back");

  await page.goto("/");
  await createMobileAction(page, "Back detail");

  const rowSurface = page.locator(".action-row-surface").first();
  const rowSurfaceBox = await rowSurface.boundingBox();
  await rowSurface.click({
    position: {
      x: Math.max(80, (rowSurfaceBox?.width ?? 320) - 24),
      y: Math.min((rowSurfaceBox?.height ?? 54) / 2, 42),
    },
  });
  await expect(page.locator(".actions-detail-panel.mobile")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".actions-detail-panel.mobile")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();
});

test("closes the mobile activity detail editor from its drag handle", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only detail editor");

  await page.goto("/");
  await createMobileAction(page, "Описание drag");

  const rowSurface = page.locator(".action-row-surface").first();
  const rowSurfaceBox = await rowSurface.boundingBox();
  await rowSurface.click({
    position: {
      x: Math.max(80, (rowSurfaceBox?.width ?? 320) - 24),
      y: Math.min((rowSurfaceBox?.height ?? 54) / 2, 42),
    },
  });
  const editorLocator = page.locator(".actions-detail-panel.mobile");
  await expect(editorLocator).toBeVisible();
  const dragZone = page.locator(".actions-detail-drag-zone");
  const secondDragZoneBox = await dragZone.boundingBox();
  await swipeTouch(
    page,
    {
      x: (secondDragZoneBox?.x ?? 0) + (secondDragZoneBox?.width ?? 0) / 2,
      y: (secondDragZoneBox?.y ?? 0) + (secondDragZoneBox?.height ?? 0) / 2,
    },
    { x: (secondDragZoneBox?.x ?? 0) + (secondDragZoneBox?.width ?? 0) / 2, y: ((secondDragZoneBox?.y ?? 0) + (secondDragZoneBox?.height ?? 0) / 2) + 420 },
  );
  await expect(editorLocator).toHaveCount(0);
});

test("keeps Android mobile header below the status bar area", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only Android shell spacing");

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-platform", "web");
  await page.locator("html").evaluate((element) => element.setAttribute("data-platform", "android"));
  await page.locator("[data-app-shell]").evaluate((element) => {
    (element as HTMLElement).style.setProperty("--mobile-top-padding", "36px");
  });

  await expect(page.locator("html")).toHaveAttribute("data-platform", "android");
  await expect(page.locator(".section-page-current .eyebrow")).toHaveCount(0);
  await expect(page.locator(".section-page-current .topbar .status-pill")).toBeVisible();
  await expect(page.locator('.section-page-current .topbar [aria-label="Обновить"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Фокус" }).last().click();
  await expect(page.locator(".section-page-current .timer-face .status-pill")).toHaveCount(0);

  const topbar = await page.locator(".section-page-current .topbar").boundingBox();
  expect(topbar?.y ?? 0).toBeGreaterThanOrEqual(32);
  expect(topbar?.y ?? 999).toBeLessThanOrEqual(48);
});

test("uses system dark before a saved mobile theme exists", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only initial theme");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(5, 6, 7)");
});

test("keeps mobile Focus controls below the first screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only timer layout");
  test.setTimeout(60_000);

  await mockTimerSyncApi(page);
  await page.goto("/");
  await page.locator("html").evaluate((element) => element.setAttribute("data-platform", "android"));
  await page.getByRole("button", { name: "Фокус" }).last().click();

  await expect(page.locator(".section-page-current .timer-scroll-hint svg")).toBeVisible();
  const timerPane = page.locator(".section-page-current .focus-timer-pane[data-slot='scroll-area']");
  const timerViewport = timerPane.locator("> [data-slot='scroll-area-viewport']");
  await expect(timerPane).toBeVisible();
  await expect(timerPane.locator("> [data-slot='scroll-area-scrollbar']")).toHaveCount(0);
  const timerScrollMetrics = await timerViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(timerScrollMetrics.scrollHeight).toBeGreaterThan(timerScrollMetrics.clientHeight + 40);
  const mainViewport = page.locator(".main-scroll > [data-slot='scroll-area-viewport']");
  const mainMetrics = await mainViewport.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(mainMetrics.scrollHeight).toBeLessThanOrEqual(mainMetrics.clientHeight + 1);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBe(0);
  const nav = await page.locator(".mobile-nav").boundingBox();
  const initialStartButton = await page.getByRole("button", { name: "Запустить" }).boundingBox();
  expect(initialStartButton?.y ?? 0).toBeGreaterThanOrEqual(nav?.y ?? page.viewportSize()?.height ?? 0);
  const timerBox = await timerViewport.boundingBox();
  await dragTouch(
    page,
    {
      x: (timerBox?.x ?? 0) + (timerBox?.width ?? 0) / 2,
      y: (timerBox?.y ?? 0) + (timerBox?.height ?? 0) * 0.78,
    },
    {
      x: (timerBox?.x ?? 0) + (timerBox?.width ?? 0) / 2,
      y: (timerBox?.y ?? 0) + (timerBox?.height ?? 0) * 0.28,
    },
  );
  await expect.poll(() => timerViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => mainViewport.evaluate((element) => element.scrollTop)).toBe(0);
  const startButton = await page.getByRole("button", { name: "Запустить" }).boundingBox();
  expect((startButton?.y ?? 0) + (startButton?.height ?? 0)).toBeLessThanOrEqual((nav?.y ?? page.viewportSize()?.height ?? 0) - 4);

  await page.getByRole("button", { name: "Запустить" }).click();

  await expect(page.locator(".section-page-current .timer-screen")).toHaveClass(/is-active/);
  await expect(page.locator(".section-page-current .timer-scroll-hint")).toHaveCount(0);

  const stopButton = await page.getByRole("button", { name: /Завершить/ }).boundingBox();
  const sessionLine = await page.locator(".section-page-current .session-line").boundingBox();
  expect((sessionLine?.y ?? 0) + (sessionLine?.height ?? 0)).toBeLessThanOrEqual((stopButton?.y ?? 0) - 2);
  expect((stopButton?.y ?? 0) + (stopButton?.height ?? 0)).toBeLessThanOrEqual((nav?.y ?? page.viewportSize()?.height ?? 0) - 4);
});

async function mockTimerSyncApi(page: Page) {
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
}

test("opens and closes mobile Focus history as a bottom sheet", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only focus history");
  test.setTimeout(60_000);

  await page.goto("/focus");
  await expect(page.getByRole("heading", { name: "Фокус", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "История фокуса" }).click();
  const sheet = page.locator(".mobile-context-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.locator(".mobile-context-grabber")).toBeVisible();
  await expect(page.getByRole("button", { name: "Закрыть историю" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(0);
  const sheetBox = await sheet.boundingBox();
  const viewport = page.viewportSize();
  expect(sheetBox?.x ?? 1).toBeLessThanOrEqual(1);
  expect(sheetBox?.width ?? 0).toBeGreaterThanOrEqual((viewport?.width ?? 0) - 1);
  const grabberBox = await sheet.locator(".mobile-context-grabber").boundingBox();
  const titleBox = await sheet.getByRole("heading", { name: "История фокуса" }).boundingBox();
  expect(horizontalCenterOffset(grabberBox, sheetBox)).toBeLessThanOrEqual(1);
  expect(horizontalCenterOffset(titleBox, sheetBox)).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const grabber = await sheet.locator(".mobile-context-grabber").boundingBox();
    const title = await sheet.getByRole("heading", { name: "История фокуса" }).boundingBox();
    return (title?.y ?? 0) - ((grabber?.y ?? 0) + (grabber?.height ?? 0));
  }).toBeGreaterThanOrEqual(8);
  await expectMobileSheetScrollbarGeometry(sheet, ".history-group, [data-slot='card']");

  await dispatchTouch(page, "touchstart", { x: 320, y: 220 });
  await dispatchTouch(page, "touchend", { x: 180, y: 224 });
  await expect(page.getByRole("heading", { name: "Фокус", exact: true })).toBeVisible();
  await expect(sheet).toBeVisible();

  const dragZone = await sheet.locator(".mobile-context-drag-zone").boundingBox();
  await page.mouse.move((dragZone?.x ?? 0) + (dragZone?.width ?? 0) / 2, (dragZone?.y ?? 0) + 8);
  await page.mouse.down();
  await page.mouse.move((dragZone?.x ?? 0) + (dragZone?.width ?? 0) / 2, (viewport?.height ?? 640) - 12, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".mobile-context-sheet")).toHaveCount(0);
});

test("keeps the mobile Focus timer fixed while context sheets move", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only focus sheet layout");

  await page.goto("/focus");
  const timerFace = page.locator(".section-page-current .timer-face");
  await expect(timerFace).toBeVisible();
  const before = await timerFace.boundingBox();

  await page.getByRole("button", { name: "История фокуса" }).click();
  const sheet = page.locator(".focus-history-backdrop .mobile-context-sheet");
  await expect(sheet).toBeVisible();
  const opened = await timerFace.boundingBox();
  expect(Math.abs((opened?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);

  const dragZone = await sheet.locator(".mobile-context-drag-zone").boundingBox();
  const viewport = page.viewportSize();
  const dragX = (dragZone?.x ?? 0) + (dragZone?.width ?? 0) / 2;
  await page.mouse.move(dragX, (dragZone?.y ?? 0) + 8);
  await page.mouse.down();
  await page.mouse.move(dragX, (viewport?.height ?? 640) - 12, { steps: 3 });
  const dragging = await timerFace.boundingBox();
  expect(Math.abs((dragging?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(page.locator(".section-page-current .topbar").getByRole("button", { name: "История фокуса", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".mobile-context-sheet")).toHaveCount(0);

  const closed = await timerFace.boundingBox();
  expect(Math.abs((closed?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(1);
});

test("switches mobile Focus sheets with one tap after a body drag close", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only focus sheet switching");
  test.setTimeout(60_000);

  await page.goto("/focus");
  await page.getByRole("button", { name: "Цели фокусировки" }).click();
  const goalSheet = page.locator(".mobile-context-sheet");
  await expect(goalSheet.getByRole("heading", { name: "Цели фокусировки" })).toBeVisible();

  await page.locator(".section-page-current .topbar").getByRole("button", { name: "История фокуса", exact: true }).click();
  await expect(page.locator(".focus-history-backdrop .mobile-context-sheet")).toBeVisible();
  await expect(page.locator(".focus-history-backdrop").getByRole("heading", { name: "История фокуса" })).toBeVisible();
  await expect(page.locator(".section-page-current .topbar").getByRole("button", { name: "История фокуса", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page.locator(".mobile-context-sheet")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Фокус", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Цели фокусировки" }).click();
  await expect(goalSheet.getByRole("heading", { name: "Цели фокусировки" })).toBeVisible();

  const historyButton = await page.getByRole("button", { name: "История фокуса" }).boundingBox();
  const goalSheetBox = await goalSheet.boundingBox();
  const viewport = page.viewportSize();
  const dragX = (goalSheetBox?.x ?? 0) + (goalSheetBox?.width ?? 360) / 2;
  const dragStartY = (goalSheetBox?.y ?? 0) + (goalSheetBox?.height ?? 420) / 2;
  await swipeTouch(page, { x: dragX, y: dragStartY }, { x: dragX, y: (viewport?.height ?? 640) - 12 });

  await page.touchscreen.tap((historyButton?.x ?? 0) + (historyButton?.width ?? 0) / 2, (historyButton?.y ?? 0) + (historyButton?.height ?? 0) / 2);
  await expect(page.locator(".focus-history-backdrop .mobile-context-sheet")).toBeVisible();
  await expect(page.locator(".focus-history-backdrop").getByRole("heading", { name: "История фокуса" })).toBeVisible();
  await expect(page.locator(".section-page-current .topbar").getByRole("button", { name: "История фокуса", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("keeps the mobile Goal panel inside the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only goal layout");
  test.setTimeout(60_000);

  await page.goto("/focus");
  await page.getByRole("button", { name: "Цели фокусировки" }).click();
  await expect(page.getByRole("heading", { name: "Цели фокусировки" })).toBeVisible();

  const viewport = page.viewportSize();
  const viewportWidth = viewport?.width ?? 0;
  const viewportHeight = viewport?.height ?? 0;
  const sheet = page.locator(".mobile-context-sheet");
  const sheetBox = await sheet.boundingBox();
  const topbar = await page.locator(".section-page-current .topbar").boundingBox();
  await expect(page.locator(".section-page-current .topbar")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const title = await sheet.getByRole("heading", { name: "Цели фокусировки" }).boundingBox();
  const grabber = await sheet.locator(".mobile-context-grabber").boundingBox();
  const goalButton = await page.locator(".section-page-current .topbar").getByRole("button", { name: "Цели фокусировки" }).boundingBox();
  const historyButton = await page.locator(".section-page-current .topbar").getByRole("button", { name: "История фокуса" }).boundingBox();
  const topbarBottom = (topbar?.y ?? 0) + (topbar?.height ?? 0);
  expect(Math.abs((sheetBox?.y ?? 0) - Math.ceil(topbarBottom))).toBeLessThanOrEqual(1);
  expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeGreaterThanOrEqual(viewportHeight - 1);
  expect(sheetBox?.height ?? 999).toBeLessThanOrEqual(viewportHeight - topbarBottom + 1);
  expect((goalButton?.y ?? 0) + (goalButton?.height ?? 0)).toBeLessThanOrEqual((sheetBox?.y ?? 0) + 1);
  expect((historyButton?.y ?? 0) + (historyButton?.height ?? 0)).toBeLessThanOrEqual((sheetBox?.y ?? 0) + 1);
  expect(Math.abs(((title?.x ?? 0) + (title?.width ?? 0) / 2) - ((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0) / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(((grabber?.x ?? 0) + (grabber?.width ?? 0) / 2) - ((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0) / 2))).toBeLessThanOrEqual(1);

  const mainMetrics = await page.locator(".main-scroll > [data-slot='scroll-area-viewport']").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(mainMetrics.scrollHeight).toBeLessThanOrEqual(mainMetrics.clientHeight + 1);

  const panels = await page.locator(".mobile-context-sheet [data-slot='card']").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    }),
  );
  for (const panel of panels) {
    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(panel.right).toBeLessThanOrEqual(viewportWidth);
    expect(panel.width).toBeLessThanOrEqual(viewportWidth);
  }
  await expectMobileSheetScrollbarGeometry(sheet, "[data-slot='card']");
  await expect(sheet.locator("[data-goal-chart] [data-slot='scroll-area-scrollbar']")).toHaveCount(0);

  const chart = await page.locator(".mobile-context-sheet [data-goal-chart]").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(chart.scrollWidth).toBeLessThanOrEqual(chart.clientWidth + 1);

  const sheetScroll = sheet.locator("> [data-slot='scroll-area']");
  const sheetViewport = sheetScroll.locator("> [data-slot='scroll-area-viewport']");
  const sheetScrollbar = sheetScroll.locator("> [data-slot='scroll-area-scrollbar']");
  await sheetViewport.evaluate((element) => {
    element.scrollTop = 96;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(sheetScrollbar).toHaveAttribute("data-scrollbar-state", "visible");
  await page.waitForTimeout(1100);
  await expect(sheetScrollbar).toHaveAttribute("data-scrollbar-state", "hidden");
});

test("keeps injected mobile debug console launchers hidden", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only debug launcher guard");

  await page.goto("/");
  await page.evaluate(() => {
    const eruda = document.createElement("button");
    eruda.className = "eruda-entry-btn";
    eruda.textContent = ">_";
    document.body.appendChild(eruda);

    const vconsole = document.createElement("div");
    vconsole.className = "__vconsole";
    const switcher = document.createElement("button");
    switcher.className = "vc-switch";
    switcher.textContent = ">_";
    vconsole.appendChild(switcher);
    document.body.appendChild(vconsole);
  });

  await expect(page.locator(".eruda-entry-btn")).toBeHidden();
  await expect(page.locator(".__vconsole .vc-switch")).toBeHidden();
});

async function expectMobileSheetScrollbarGeometry(sheet: Locator, contentSelector: string) {
  const sheetBox = await sheet.boundingBox();
  const contentBox = await sheet.locator(contentSelector).first().boundingBox();
  const scrollbarBox = await sheet.locator("> [data-slot='scroll-area'] > [data-slot='scroll-area-scrollbar']").boundingBox();
  expect(sheetBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(scrollbarBox).not.toBeNull();

  const expectedGap = (scrollbarBox?.width ?? 0) / 2;
  const sheetLeft = sheetBox?.x ?? 0;
  const sheetRight = sheetLeft + (sheetBox?.width ?? 0);
  const contentLeft = contentBox?.x ?? 0;
  const contentRight = contentLeft + (contentBox?.width ?? 0);
  const scrollbarLeft = scrollbarBox?.x ?? 0;
  const scrollbarRight = scrollbarLeft + (scrollbarBox?.width ?? 0);
  const leftInset = contentLeft - sheetLeft;
  const rightInset = sheetRight - contentRight;
  const contentToScrollbar = scrollbarLeft - contentRight;
  const scrollbarToEdge = sheetRight - scrollbarRight;
  expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(1);
  expect(Math.abs(contentToScrollbar - expectedGap)).toBeLessThanOrEqual(1);
  expect(Math.abs(scrollbarToEdge - expectedGap)).toBeLessThanOrEqual(1);
}
