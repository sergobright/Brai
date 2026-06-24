import { describe, expect, it } from "vitest";
import { resolveBrightOsIconAssets } from "@/shared/config/appIcons";

describe("Bright OS app icons", () => {
  it("uses production icons for production and unknown environments", () => {
    expect(resolveBrightOsIconAssets("prod")).toMatchObject({
      favicon: "/favicon.png",
      icon192: "/icons/Icon-192.png",
    });
    expect(resolveBrightOsIconAssets("unknown").favicon).toBe("/favicon.png");
  });

  it("uses environment-specific icons for dev and preview builds", () => {
    expect(resolveBrightOsIconAssets("dev").favicon).toBe("/icons/dev/favicon.png");
    expect(resolveBrightOsIconAssets("preview-b").icon512).toBe("/icons/preview-b/Icon-512.png");
  });
});
