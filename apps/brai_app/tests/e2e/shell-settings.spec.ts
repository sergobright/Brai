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
  await page.route("**/v1/version", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      server_time_utc: "2026-06-29T12:00:00.000Z",
      version: "0.11.52",
      ota_version: "0.11.52",
      latest: {
        canon: null,
        release: null,
        build: null,
        apk: {
          id: 52,
          version_type_id: "apk",
          version: 2,
          included_in_version_id: null,
          short_changes: "Первичная публичная APK-сборка.",
          detailed_changes: "APK v2.",
          reason: "Актуальная APK-линейка Brai.",
          released_at_utc: "2026-06-29T12:00:00.000Z",
          created_at_utc: "2026-06-29T12:00:00.000Z",
        },
      },
      target_apk: { version: 2, file: "brai-v2.apk", release_url: "/releases/", capabilities: [] },
    }),
  }));

  await page.goto("/");
  await openEngineFromProfile(page);

  await expect(page.getByRole("heading", { name: "Engine", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Текущая версия (unknown|0\.\d+\.\d+)/ })).toBeVisible();
  await expect(page.getByText("Доступна новая версия 0.11.52.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Скачать обновление" })).toBeVisible();
});

test("keeps Android Engine download progress compact on mobile", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only layout");

  await page.addInitScript(() => {
    const win = window as Window & {
      androidBridge?: unknown;
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
        PluginHeaders?: Array<{ name: string; methods: Array<{ name: string; rtype: "promise" }> }>;
        nativePromise?: (pluginName: string, methodName: string) => Promise<unknown>;
      };
    };
    const state = {
      activeBundleVersion: "0.11.51",
      activeOperation: "web_download",
      availableBundleVersion: "0.11.52",
      updateAvailable: true,
      downloadProgressPercent: 42,
      downloadProgressVersion: "0.11.52",
      checkInProgress: false,
      lastCheckStatus: "downloading",
    };
    win.androidBridge = {};
    win.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      PluginHeaders: [
        {
          name: "BraiOta",
          methods: [
            { name: "getState", rtype: "promise" },
            { name: "checkForUpdates", rtype: "promise" },
            { name: "downloadUpdate", rtype: "promise" },
            { name: "downloadApk", rtype: "promise" },
            { name: "markReady", rtype: "promise" },
          ],
        },
      ],
      nativePromise: async (pluginName, methodName) => {
        if (pluginName !== "BraiOta") throw new Error(`Unexpected plugin: ${pluginName}`);
        return methodName === "markReady" ? { ...state, promoted: true } : state;
      },
    };
  });
  await page.route("**/v1/**", (route) => {
    const now = "2026-06-29T12:00:00.000Z";
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/v1/version" ? {
        server_time_utc: now,
        version: "0.11.52",
        ota_version: "0.11.52",
        latest: { canon: null, release: null, build: null, apk: null },
        target_apk: { version: 2, file: "brai-v2.apk", release_url: "/releases/", capabilities: [] },
      } :
      path === "/v1/timer/state" ? {
        server_time_utc: now,
        server_revision: 1,
        timezone: "Europe/Moscow",
        active_session: null,
        elapsed_seconds: 0,
      } :
      path === "/v1/sessions" ? { sessions: [], groups: {} } :
      path === "/v1/goals/challenge" ? {
        timezone: "Europe/Moscow",
        start_date: "2026-06-29",
        end_date: "2026-06-29",
        days_count: 1,
        daily_goal_seconds: 0,
        total_goal_seconds: 0,
        completed_seconds: 0,
        completed_hours: 0,
        percentage: 0,
        remaining_seconds: 0,
        remaining_days: 0,
        required_average_seconds_per_remaining_day: 0,
        required_average_hours_per_remaining_day: 0,
        achieved: false,
        days: [],
      } :
      path === "/v1/activities" ? { server_time_utc: now, server_revision: 1, activities: [], archived_activities: [] } :
      path === "/v1/inbox" ? { server_time_utc: now, server_revision: 1, inbox: [] } :
      null;
    if (!body) return route.continue();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto("/engine");

  await expect(page.getByText("Скачивается обновление 0.11.52")).toBeVisible();
  const card = page.locator('[aria-label="Engine"] [data-slot="card"]').first();
  const progressBlock = page.locator('[data-slot="field"]').filter({ has: page.locator("#engine-update-progress") });
  await expect
    .poll(async () => (await card.boundingBox())?.height ?? 0)
    .toBeLessThan(260);
  await expect
    .poll(async () => (await progressBlock.boundingBox())?.height ?? 0)
    .toBeLessThan(72);
});

test("shows Engine in the mobile dock overflow menu", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only layout");

  await page.goto("/");
  await page.getByRole("button", { name: "Открыть левое меню" }).click();

  const sheet = page.locator(".mobile-dock-overflow-sheet");
  const engineButton = sheet.getByRole("button", { name: "Engine" });
  await expect(sheet).toBeVisible();
  await expect(engineButton).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Brai Cmd" })).toBeVisible();
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
    window.localStorage.setItem("brai_theme_mode", "dark");
  });
  await page.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, (route) => route.abort());

  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe("rgb(5, 6, 7)");
});
