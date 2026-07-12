import { expect, test } from "@playwright/test";

test("shows the standalone auth page on mobile and desktop", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: false, user: null },
    }),
  );

  await page.goto("/auth");

  await expect(page.locator("[data-auth-page]")).toBeVisible();
  await expect(page.locator(".auth-galaxy-background canvas")).toBeVisible();
  await expect(page.locator("[data-app-shell]")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Получить код" })).toBeVisible();
  await expect(page.getByRole("link", { name: "На главную" })).toHaveAttribute("href", "https://brai.one/");
  await expect(page.getByRole("heading", { name: "Действия" })).toHaveCount(0);
});

test("keeps the auth card height stable when the OTP field appears", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: { authenticated: false, user: null },
    }),
  );
  await page.route("**/api/auth/otp/send", (route) =>
    route.fulfill({
      json: {
        success: true,
        expires_in_seconds: 300,
        resend_after_seconds: 60,
        resend_strategy: "reuse",
      },
    }),
  );

  await page.goto("/auth");

  const card = page.locator("[data-slot='card']").first();
  await expect(card).toBeVisible();
  const before = await card.boundingBox();
  await page.getByRole("textbox", { name: "Email" }).fill("primary@example.com");
  await page.getByRole("button", { name: "Получить код" }).click();
  await expect(page.getByTestId("auth-otp-input")).toBeVisible();
  const after = await card.boundingBox();

  expect(Math.abs((before?.height ?? 0) - (after?.height ?? 0))).toBeLessThanOrEqual(1);
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
