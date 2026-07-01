import { expect, type Locator, type Page } from "@playwright/test";

export async function dispatchTouch(
  page: Page,
  type: "touchstart" | "touchmove" | "touchend",
  point: { x: number; y: number },
) {
  await page.evaluate(
    ({ type, point }) => {
      const target = document.querySelector("main");
      if (!target) throw new Error("Missing main gesture target");

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
    { type, point },
  );
}

export async function dispatchElementTouch(
  page: Page,
  selector: string,
  type: "touchstart" | "touchmove" | "touchend",
  point: { x: number; y: number },
) {
  await page.evaluate(
    ({ selector, type, point }) => {
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
    { selector, type, point },
  );
}

export async function swipeActionRowLeft(
  page: Page,
  row: Locator,
) {
  const box = await row.boundingBox();
  const y = (box?.y ?? 120) + (box?.height ?? 54) / 2;
  const startX = (box?.x ?? 14) + (box?.width ?? 360) - 20;

  await dispatchElementTouch(page, ".action-row", "touchstart", { x: startX, y });
  await dispatchElementTouch(page, ".action-row", "touchmove", { x: startX - 44, y });
  await dispatchElementTouch(page, ".action-row", "touchend", { x: startX - 72, y });
  await expect(row).toHaveClass(/delete-open/);
}

export async function createMobileAction(page: Page, title: string) {
  await page.locator(".actions-fab").click();
  await page.getByRole("textbox", { name: "Добавить действие" }).fill(title);
  await page.locator(".actions-add-submit").click();
  await expect(page.getByRole("textbox", { name: `Название действия: ${title}` })).toBeVisible();
}

export async function swipeTouch(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (const step of [0.35, 0.7, 1]) {
      await page.waitForTimeout(16);
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + (to.x - from.x) * step,
            y: from.y + (to.y - from.y) * step,
          },
        ],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

export async function dragTouch(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    await page.waitForTimeout(320);
    for (const step of [0.35, 0.7, 1]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: from.x + (to.x - from.x) * step,
            y: from.y + (to.y - from.y) * step,
          },
        ],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

export async function desktopContentColumnWidth(page: Page) {
  return (await page.locator(".main-view").boundingBox())?.width ?? 0;
}

export async function openSettingsFromProfile(page: Page) {
  await openProfileMenuItem(page, "Настройки");
}

export async function openEngineFromProfile(page: Page) {
  await openProfileMenuItem(page, /^Engine(?: v.+)?$/);
}

export async function openProfileMenuItem(page: Page, name: string | RegExp) {
  const drawer = page.locator(".mobile-profile-drawer");
  if ((await drawer.count()) > 0 && await drawer.isVisible()) {
    await drawer.getByRole("button", { name }).click();
    return;
  }

  const button = page.getByRole("button", { name }).first();
  if ((await button.count()) === 0 || !(await button.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Открыть левое меню" }).click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name }).click();
    return;
  }

  await button.click();
}

export function horizontalCenterOffset(
  inner: { x: number; width: number } | null,
  outer: { x: number; width: number } | null,
) {
  if (!inner || !outer) return Number.POSITIVE_INFINITY;
  return Math.abs(inner.x + inner.width / 2 - (outer.x + outer.width / 2));
}
