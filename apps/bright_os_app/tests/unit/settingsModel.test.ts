import { describe, expect, it } from "vitest";
import { settingsSectionView } from "@/features/app/sections/settings/settingsModel";

describe("settingsSectionView", () => {
  it("does not treat stale Android OTA checking status as active work", () => {
    const view = settingsSectionView({
      appBuild: "0.0.10.1",
      otaRefreshing: false,
      otaState: {
        activeBundleVersion: "0.0.10.1",
        lastCheckStatus: "checking",
        checkInProgress: false,
      },
    });

    expect(view.isChecking).toBe(false);
    expect(view.updateStatus.label).toBe("активно");
  });
});
