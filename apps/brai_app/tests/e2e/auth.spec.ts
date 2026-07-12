import { expect, test } from "@playwright/test";

test("shows the standalone auth page on mobile and desktop", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: false, user: null },
    }),
  );

  await page.goto("/auth");

  await expect(page.locator("[data-auth-page]")).toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Получить код" })).toBeVisible();
  await expect(page.getByRole("link", { name: "На главную" })).toHaveAttribute("href", "https://brai.one/");
  await expect(page.getByRole("heading", { name: "Действия" })).toHaveCount(0);
});

test("redirects anonymous cabinet visits to auth", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: false, user: null },
    }),
  );

  await page.goto("/");

  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.locator("[data-auth-page]")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveCount(0);
});
