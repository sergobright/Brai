import { expect, test, type Page } from "@playwright/test";
import { swipeTouch } from "./shell-helpers";

test("tracks mobile tab swipes with page transforms from the bottom dock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile touch gesture only");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия" })).toBeVisible();

  const dockBox = await page.locator(".main-dock").boundingBox();
  if (!dockBox) throw new Error("Missing bottom menu geometry");
  const y = Math.round(dockBox.y + dockBox.height / 2);

  await dispatchTouch(page, "touchstart", { x: 320, y }, ".main-dock");
  await dispatchTouch(page, "touchmove", { x: 240, y: y + 4 }, ".main-dock");

  await expect(page.locator('[data-section-page="actions"]')).toHaveAttribute(
    "style",
    /translate3d\(-80px, 0px, 0px\)/,
  );
  await expect(page.locator('[data-section-page="focus"]')).toHaveCount(1);

  await dispatchTouch(page, "touchend", { x: 180, y: y + 4 }, ".main-dock");
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();
});

test("keeps current and adjacent screen gutters aligned during mobile swipes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile touch gesture only");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия" })).toBeVisible();

  const dockBox = await page.locator(".main-dock").boundingBox();
  if (!dockBox) throw new Error("Missing bottom menu geometry");
  const y = Math.round(dockBox.y + dockBox.height / 2);

  await dispatchTouch(page, "touchstart", { x: 320, y }, ".main-dock");
  await dispatchTouch(page, "touchmove", { x: 240, y: y + 4 }, ".main-dock");

  const geometry = await page.evaluate(() => {
    function read(selector: string) {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        paddingLeft: style.paddingLeft,
        paddingTop: style.paddingTop,
      };
    }

    return {
      adjacent: read(".section-page-adjacent"),
      current: read(".section-page-current"),
      stage: read(".section-swipe-stage"),
    };
  });

  expect(geometry.stage.paddingLeft).toBe("0px");
  expect(geometry.stage.paddingTop).toBe("0px");
  expect(geometry.current.paddingLeft).toBe("14px");
  expect(geometry.adjacent.paddingLeft).toBe(geometry.current.paddingLeft);
  expect(geometry.adjacent.paddingTop).toBe(geometry.current.paddingTop);
  expect(geometry.adjacent.top).toBe(geometry.current.top);
  expect(geometry.adjacent.width).toBe(geometry.current.width);
});

test("tracks mobile tab swipes from the full-width bottom menu zone", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile touch gesture only");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия" })).toBeVisible();

  const viewport = page.viewportSize();
  const dockBox = await page.locator(".main-dock").boundingBox();
  const visualBox = await page.locator(".mobile-nav").boundingBox();
  if (!viewport || !dockBox || !visualBox) throw new Error("Missing bottom menu geometry");
  expect(Math.round(dockBox.x)).toBe(0);
  expect(Math.round(dockBox.width)).toBe(viewport.width);

  const y = Math.round(dockBox.y + dockBox.height / 2);
  const startX = viewport.width - 20;
  expect(startX).toBeGreaterThan(visualBox.x + visualBox.width);

  await dispatchTouch(page, "touchstart", { x: startX, y }, ".main-dock");
  await dispatchTouch(page, "touchmove", { x: startX - 80, y: y + 4 }, ".main-dock");

  await expect(page.locator('[data-section-page="actions"]')).toHaveAttribute(
    "style",
    /translate3d\(-80px, 0px, 0px\)/,
  );
  await expect(page.locator('[data-section-page="focus"]')).toHaveCount(1);

  await dispatchTouch(page, "touchend", { x: startX - 140, y: y + 4 }, ".main-dock");
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();
});

test("opens the mobile menu from the left edge outside the bottom dock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile touch gesture only");

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия" })).toBeVisible();

  await dispatchTouch(page, "touchstart", { x: 2, y: 220 });
  await dispatchTouch(page, "touchmove", { x: 88, y: 224 });
  await dispatchTouch(page, "touchend", { x: 116, y: 224 });

  const drawer = page.locator(".mobile-profile-drawer");
  await expect(drawer).toBeVisible();
  const viewport = page.viewportSize();
  const box = await drawer.boundingBox();
  if (!viewport || !box) throw new Error("Missing mobile menu geometry");
  expect(Math.round(box.width)).toBe(Math.round(viewport.width * 0.8));
});

test("keeps horizontal page swipes from moving the vertical scroll", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile touch gesture only");

  await page.goto("/focus");
  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();

  const viewport = page.locator(".section-page-current .focus-timer-pane > [data-slot='scroll-area-viewport']");
  await viewport.evaluate((element) => {
    element.scrollTop = 64;
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(64);

  const box = await viewport.boundingBox();
  if (!box) throw new Error("Missing focus timer viewport");
  await swipeTouch(
    page,
    { x: box.x + box.width - 40, y: box.y + 220 },
    { x: box.x + box.width - 180, y: box.y + 244 },
  );

  await expect(page.getByRole("heading", { name: "Фокус" })).toBeVisible();
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(64);
});

async function dispatchTouch(
  page: Page,
  type: "touchstart" | "touchmove" | "touchend",
  point: { x: number; y: number },
  selector = "main",
) {
  await page.evaluate(
    ({ type, point, selector }) => {
      const target = document.querySelector(selector);
      if (!target) throw new Error(`Missing gesture target: ${selector}`);

      const touch = {
        identifier: 1,
        target,
        clientX: point.x,
        clientY: point.y,
        pageX: point.x,
        pageY: point.y,
        screenX: point.x,
        screenY: point.y,
      };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        changedTouches: { value: [touch] },
        touches: { value: type === "touchend" ? [] : [touch] },
        targetTouches: { value: type === "touchend" ? [] : [touch] },
      });
      target.dispatchEvent(event);
    },
    { type, point, selector },
  );
}
