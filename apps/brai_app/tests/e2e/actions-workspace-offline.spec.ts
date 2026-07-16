import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { DEFAULT_APP_SETTINGS } from "@/shared/api/braiApi";
import { emptyActivitiesState } from "@/shared/types/activities";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyGoal, emptyHistory, emptyTimerState } from "@/shared/types/timer";

test("keeps an API-offline Goal in the Actions workspace after desktop and mobile reloads", async ({ page }, testInfo) => {
  await mockAuthenticatedEmptyWorkspace(page);
  await page.goto("/activities");
  await page.locator("[data-startup-splash]").waitFor({ state: "detached" });
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
    await page.getByRole("button", { name: "Открыть меню" }).click();
    const navigation = page.locator(".mobile-profile-drawer").getByRole("navigation", { name: "Списки действий" });
    await expect(navigation).toBeVisible();
    return navigation;
  }
  const navigation = page.locator(".contextual-rail").getByRole("navigation", { name: "Списки действий" });
  await expect(navigation).toBeVisible();
  return navigation;
}

async function mockAuthenticatedEmptyWorkspace(page: Page): Promise<void> {
  const now = new Date("2026-07-13T00:00:00.000Z");
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
  for (const [path, json] of [
    ["settings", DEFAULT_APP_SETTINGS],
    ["timer/state", { ...emptyTimerState(now), server_revision: 1 }],
    ["sessions", emptyHistory()],
    ["goals/challenge", emptyGoal()],
    ["activities", { ...emptyActivitiesState(now), server_revision: 1 }],
    ["inbox", { ...emptyInboxState(now), server_revision: 1 }],
  ] as const) {
    await page.route(`**/api/v1/${path}`, (route) => route.fulfill({ json }));
  }
}
