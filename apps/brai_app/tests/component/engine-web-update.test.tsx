import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppVersionState } from "@/shared/api/braiApi";
import { EngineSection } from "@/features/app/sections/engine/EngineSection";

vi.mock("@/shared/config/runtime", () => ({ useAppVersion: () => "1.0.0" }));

describe("Engine browser update", () => {
  it("refreshes the page instead of offering a download in a browser", async () => {
    const reload = vi.fn();
    const downloadWeb = vi.fn(async () => null);
    renderEngine({ nativeAndroid: false, onDownloadWebUpdate: downloadWeb, onReloadPage: reload });

    const button = screen.getByRole("button", { name: "Обновить страницу" });
    expect(button.querySelector(".lucide-refresh-cw")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Скачать обновление/ })).not.toBeInTheDocument();
    fireEvent.click(button);

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(downloadWeb).not.toHaveBeenCalled();
  });

  it("keeps the Android OTA download action", async () => {
    const downloadWeb = vi.fn(async () => null);
    renderEngine({ nativeAndroid: true, onDownloadWebUpdate: downloadWeb, onReloadPage: vi.fn() });

    const button = screen.getByRole("button", { name: "Скачать обновление" });
    expect(button.querySelector(".lucide-download")).toBeInTheDocument();
    fireEvent.click(button);

    await waitFor(() => expect(downloadWeb).toHaveBeenCalledOnce());
  });
});

function renderEngine({
  nativeAndroid,
  onDownloadWebUpdate,
  onReloadPage,
}: {
  nativeAndroid: boolean;
  onDownloadWebUpdate: () => Promise<null>;
  onReloadPage: () => void;
}) {
  return render(
    <EngineSection
      appVersionState={versionState()}
      bundlePublishedAt={null}
      nativeAndroid={nativeAndroid}
      otaCheckedAt={null}
      otaRefreshing={false}
      otaState={null}
      versionCheckedAt={null}
      versionError={false}
      versionRefreshing={false}
      onDownloadApk={async () => null}
      onInstallApk={async () => null}
      onDownloadWebUpdate={onDownloadWebUpdate}
      onRefreshEngine={async () => undefined}
      onReloadPage={onReloadPage}
    />,
  );
}

function versionState(): AppVersionState {
  return {
    server_time_utc: "2026-07-15T00:00:00.000Z",
    version: "1.0.1",
    ota_version: "1.0.1",
    parts: { canon: 1, release: 0, build: 1, apk: 2 },
    latest: { canon: null, release: null, build: null, apk: null },
    target_apk: null,
    apk_release: null,
  };
}
