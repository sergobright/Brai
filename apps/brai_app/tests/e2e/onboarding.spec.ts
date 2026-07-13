import { expect, test, type Page } from "@playwright/test";

type PreliminaryMode = "ready" | "retry";

async function installAndroidOnboarding(page: Page, step: string, preliminaryMode: PreliminaryMode = "ready") {
  await page.addInitScript(({ preliminaryMode, step }) => {
    localStorage.setItem("brai_onboarding_state_v1", JSON.stringify({
      complete: false,
      history: step === "name" ? ["path"] : ["setup-start"],
      name: step === "name" ? "" : "QA",
      path: "new",
      profileVersion: "cloud",
      step,
      voiceMode: null,
    }));
    Reflect.set(window, "androidBridge", {});
    let preliminaryCalls = 0;
    const methods = [
      "getState", "vibratePress", "openSettings", "preparePreliminaryProfile", "ensureAccess", "setAccessKey",
      "setOverlayEnabled", "setVoiceOnlyMode", "setQueuePausedMode", "retryQueue", "addListener", "removeListener",
      "openAccessibilitySettings", "openAppSettings", "openOverlaySettings", "requestMicrophone", "requestNotifications",
      "markReady", "checkForUpdates", "acknowledgeStatusChanges", "clear", "pendingStatusChanges", "saveSnapshot",
    ];
    Reflect.set(window, "Capacitor", {
      PluginHeaders: ["BraiCmd", "BraiAndroidCapabilities", "BraiOta", "BraiTimerNotification", "BraiActionsWidget"]
        .map((name) => ({ name, methods: methods.map((name) => ({ name, rtype: "promise" })) })),
      nativeCallback: () => "qa-callback",
      nativePromise: (plugin: string, method: string) => {
        if (plugin === "BraiCmd" && method === "preparePreliminaryProfile") {
          preliminaryCalls += 1;
          if (preliminaryMode === "retry" && preliminaryCalls === 1) {
            return Promise.reject(Object.assign(new Error("private detail"), { code: "preliminary_timeout" }));
          }
          return Promise.resolve({
            deviceFingerprint: "qa-fingerprint",
            preliminaryClaimToken: "qa-claim",
            preliminaryStatus: "ready",
            preliminaryUserId: "qa-preliminary",
          });
        }
        if (plugin === "BraiCmd" && method === "getState") return Promise.resolve({ native: true });
        if (method === "addListener") return Promise.resolve("qa-listener");
        return Promise.resolve({});
      },
    });
    Reflect.set(window, "__qaPreliminaryCalls", () => preliminaryCalls);
  }, { preliminaryMode, step });
}

test("walks through all six Brai CMD floating-button demos", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Android onboarding is mobile-only");
  await installAndroidOnboarding(page, "floating-buttons");
  await page.goto("/");
  await page.locator("[data-startup-splash]").waitFor({ state: "detached" });

  await page.getByRole("button", { name: "Ознакомиться" }).click();
  for (const [index, title] of [
    "Главная кнопка диктовки",
    "Команда голосом",
    "Скриншот во Входящие",
    "Скриншот + голос",
    "Контекст во Входящие",
    "Ответ с контекстом",
  ].entries()) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText(`Кнопка ${index + 1} из 6`)).toBeVisible();
    const image = page.locator("main img[alt]:not([alt=''])");
    await expect(image).toBeVisible();
    expect(await image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
    await page.getByRole("button", { name: "Продолжить" }).click();
  }

  await expect(page.getByRole("heading", { name: "Требуется особая настройка" })).toBeVisible();
});

test("keeps preliminary onboarding fail-closed and retries successfully", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Android onboarding is mobile-only");
  await installAndroidOnboarding(page, "name", "retry");
  await page.goto("/");
  await page.locator("[data-startup-splash]").waitFor({ state: "detached" });

  await page.getByRole("textbox", { name: "Имя" }).fill("Тестовый QA");
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByText("Не удалось проверить устройство на сервере Brai. Повторите.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Как к вам обращаться" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Продолжить" })).toBeEnabled();

  const failedState = await page.evaluate(() => JSON.parse(localStorage.getItem("brai_onboarding_state_v1") || "{}"));
  expect(failedState).toMatchObject({ preliminaryClaimToken: "", preliminaryUserId: "", step: "name" });
  await page.getByRole("button", { name: "Продолжить" }).click();
  await expect(page.getByRole("heading", { name: "Brai CMD" })).toBeVisible();

  const result = await page.evaluate(() => ({
    calls: Reflect.get(window, "__qaPreliminaryCalls")(),
    state: JSON.parse(localStorage.getItem("brai_onboarding_state_v1") || "{}"),
  }));
  expect(result.calls).toBe(2);
  expect(result.state).toMatchObject({ preliminaryClaimToken: "qa-claim", preliminaryUserId: "qa-preliminary", step: "setup-start" });
});
