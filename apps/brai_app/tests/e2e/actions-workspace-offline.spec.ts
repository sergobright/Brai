import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

test("keeps an API-offline Goal in the Actions workspace after desktop and mobile reloads", async ({ page }, testInfo) => {
  await mockAuthenticatedEmptyWorkspace(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();
  await expect(page.getByText("Новых действий нет", { exact: true })).toBeVisible();

  await page.route("**/api/v1/**", (route) => route.abort("internetdisconnected"));
  await page.evaluate(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
  });

  const goalTitle = "База на Луне";
  const navigation = await openWorkspaceNavigation(page, testInfo);
  await navigation.getByRole("button", { name: "Создать цель" }).click();
  await navigation.getByRole("textbox", { name: "Название новой цели" }).fill(goalTitle);
  await navigation.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(navigation.getByRole("button", { name: goalTitle, exact: true })).toBeVisible();

  await page.unroute("**/api/auth/session");
  await page.route("**/api/auth/session", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Действия", exact: true })).toBeVisible();
  const restoredNavigation = await openWorkspaceNavigation(page, testInfo);
  await expect(restoredNavigation.getByRole("button", { name: goalTitle, exact: true })).toBeVisible();
});

async function openWorkspaceNavigation(page: Page, testInfo: TestInfo): Promise<Locator> {
  if (testInfo.project.name === "mobile") {
    await page.locator(".section-page-current").getByRole("button", { name: "Информация о действиях" }).click();
    const navigation = page.locator(".mobile-context-sheet").getByRole("navigation", { name: "Списки действий" });
    await expect(navigation).toBeVisible();
    return navigation;
  }
  const navigation = page.locator(".section-page-current").getByRole("navigation", { name: "Списки действий" });
  await expect(navigation).toBeVisible();
  return navigation;
}

async function mockAuthenticatedEmptyWorkspace(page: Page): Promise<void> {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        user: {
          id: "e2e-actions-workspace-offline",
          email: "e2e-actions-workspace-offline@example.test",
          name: "E2E",
        },
      },
    }),
  );
  await page.route("**/api/v1/activities", (route) =>
    route.fulfill({
      json: {
        activities: [],
        archived_activities: [],
        server_revision: 1,
        server_time_utc: "2026-07-13T00:00:00.000Z",
      },
    }),
  );
}
