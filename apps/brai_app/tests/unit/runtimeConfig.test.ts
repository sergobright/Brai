import { afterEach, describe, expect, it } from "vitest";
import {
  appEnvironment,
  appPreviewSlot,
  appVersion,
  defaultApiBase,
  environmentBadgeLabel,
  isProductionEnvironment,
} from "@/shared/config/runtime";

describe("client runtime config", () => {
  afterEach(() => {
    delete window.__BRAI_RUNTIME_CONFIG__;
    delete window.Capacitor;
  });

  it("prefers window runtime config over build-time defaults", () => {
    window.__BRAI_RUNTIME_CONFIG__ = {
      appVersion: "9.9.9",
      environment: "preview-b",
      previewSlot: "B",
      webApiBase: "/preview-api",
      androidApiBase: "https://b.test.brai.one/api",
    };

    expect(appVersion()).toBe("9.9.9");
    expect(appEnvironment()).toBe("preview-b");
    expect(appPreviewSlot()).toBe("B");
    expect(environmentBadgeLabel()).toBe("B");
    expect(isProductionEnvironment()).toBe(false);
    expect(defaultApiBase()).toBe("/preview-api");
  });

  it("uses runtime Android API base inside the native shell", () => {
    window.__BRAI_RUNTIME_CONFIG__ = {
      webApiBase: "/preview-api",
      androidApiBase: "https://b.test.brai.one/api",
    };
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    };

    expect(defaultApiBase()).toBe("https://b.test.brai.one/api");
  });
});
