import { expect, test } from "@playwright/test";
import { openEngineFromProfile, openProfileMenuItem, openSettingsFromProfile } from "./shell-helpers";

test("shows Settings without update state", async ({ page }, testInfo) => {
  await page.goto("/");
  await openSettingsFromProfile(page);

  await expect(page.getByRole("heading", { name: "Настройки" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Включить темную тему" })).toBeVisible();
  await page.getByRole("button", { name: "Включить темную тему" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Включить светлую тему" })).toBeVisible();
  await expect(page.getByRole("button", { name: /открыть выбор цвета/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Обновление" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Архив" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Синхронизация" })).toHaveCount(0);
  await expect(page.getByText("APK", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выйти" })).toHaveCount(testInfo.project.name === "desktop" ? 1 : 0);
});

test("opens Engine from the profile menu", async ({ page }) => {
  await page.route("**/api/v1/version", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      server_time_utc: "2026-06-29T12:00:00.000Z",
      version: "0.11.52.1",
      parts: { canon: 0, release: 11, build: 52, apk: 1 },
      latest: {
        canon: null,
        release: null,
        build: {
          id: 52,
          version_type_id: "build",
          version: 52,
          included_in_version_id: null,
          short_changes: "Fix single-line title editing",
          detailed_changes: "Fix single-line title editing",
          reason: "Fix single-line title editing",
          released_at_utc: "2026-06-29T12:00:00.000Z",
          created_at_utc: "2026-06-29T12:00:00.000Z",
        },
        apk: null,
      },
    }),
  }));

  await page.goto("/");
  await openEngineFromProfile(page);

  await expect(page.getByRole("heading", { name: "Engine", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Engine v0.11.52.1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить обновление" })).toBeVisible();
  await expect(page.getByText("Build 52")).toBeVisible();
});

test("keeps Engine text out of the collapsed desktop rail on load", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only rail");

  await page.context().addCookies([{ name: "sidebar_state", value: "false", url: "http://127.0.0.1:3201" }]);
  await page.goto("/engine");

  const rail = page.locator(".desktop-rail");
  await expect(rail).not.toHaveClass(/expanded/);
  await expect(rail.locator("[data-rail-page-title]")).toBeHidden();
  await expect
    .poll(async () => (await rail.locator(".rail-profile").boundingBox())?.width ?? 0)
    .toBeLessThanOrEqual(42);
});

test("opens Archive from the profile menu and restores a deleted action", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only archive flow");

  await page.goto("/");
  await page.getByRole("textbox", { name: "Добавить" }).fill("Архивируемое");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Название действия: Архивируемое" })).toBeVisible();

  const row = page.locator(".action-row").first();
  const deleteButton = row.locator(".action-delete-button");
  await row.hover();
  await expect
    .poll(() => deleteButton.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.2);
  await deleteButton.click();
  await expect(page.getByRole("textbox", { name: "Название действия: Архивируемое" })).toHaveCount(0);

  await openProfileMenuItem(page, "Архив");
  await expect(page.getByRole("heading", { name: "Архив" })).toBeVisible();
  await expect(page.getByText("Архивируемое")).toBeVisible();

  const archiveRow = page.locator(".action-row").first();
  const restoreButton = archiveRow.locator(".action-delete-button");
  await archiveRow.hover();
  await expect
    .poll(() => restoreButton.evaluate((element) => Number(getComputedStyle(element).opacity)))
    .toBeGreaterThan(0.2);
  await restoreButton.click();
  await expect(page.getByText("Архивируемое")).toHaveCount(0);

  await page.getByRole("button", { name: "Действия" }).last().click();
  await expect(page.getByRole("textbox", { name: "Название действия: Архивируемое" })).toBeVisible();
});

test("applies saved dark theme before client JavaScript runs", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("bright_os_theme_mode", "dark");
  });
  await page.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, (route) => route.abort());

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(5, 6, 7)");
});
