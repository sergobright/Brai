"use client";

import { RefreshCw } from "lucide-react";
import type { AppVersionState } from "@/shared/api/braiApi";
import { APP_VERSION } from "@/shared/config/runtime";
import type { BraiOtaState } from "@/shared/platform/ota";
import { platformName } from "@/shared/platform/platform";
import { moscowTime } from "@/shared/time/format";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Field, FieldLabel } from "@/shared/ui/field";
import { Progress } from "@/shared/ui/progress";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";
import { engineSectionView } from "./engineModel";

export function EngineSection({
  appVersionState,
  otaCheckedAt,
  otaRefreshing,
  otaState,
  versionCheckedAt,
  versionError,
  versionRefreshing,
  onRefreshEngine,
}: {
  appVersionState: AppVersionState | null;
  bundlePublishedAt: string | null;
  otaCheckedAt: string | null;
  otaRefreshing: boolean;
  otaState: BraiOtaState | null;
  versionCheckedAt: string | null;
  versionError: boolean;
  versionRefreshing: boolean;
  onRefreshEngine: () => Promise<void>;
}) {
  const view = engineSectionView({
    appBuild: APP_VERSION,
    appVersionState,
    otaRefreshing,
    otaState,
    versionError,
    versionRefreshing,
  });
  const isAndroid = platformName() === "android";
  const checkedAt = versionCheckedAt ?? otaCheckedAt;

  return (
    <section className={cx(SECTION_GRID_CLASS, "content-start items-start xl:w-1/2")} aria-label="Engine">
      <Card className="grid w-full content-start gap-3 self-start p-4 sm:gap-4 sm:p-5">
        <div className="grid gap-1.5">
          <h2 className="m-0 text-lg leading-tight tracking-normal sm:text-xl">Текущая OTA-версия {view.installedVersion}</h2>
          <p className="m-0 text-sm leading-5 text-muted-foreground">{view.updateStatus.body}</p>
          {checkedAt ? <p className="m-0 text-xs text-muted-foreground">Проверено {moscowTime(checkedAt)}</p> : null}
        </div>

        {!isAndroid && view.hasUpdate ? <WebUpdateNotice latestVersion={view.latestVersion} /> : null}
        {isAndroid && view.androidUpdateStage !== "idle" ? <AndroidUpdateNotice view={view} /> : null}

        <Button className="justify-self-start" type="button" variant="secondary" size="sm" disabled={view.isChecking} onClick={() => void onRefreshEngine()}>
          <RefreshCw className={cx("size-4", view.isChecking && "animate-spin")} aria-hidden="true" />
          {view.isChecking ? "Проверяем..." : "Проверить обновления"}
        </Button>
      </Card>
    </section>
  );
}

function WebUpdateNotice({ latestVersion }: { latestVersion: string }) {
  return (
    <div className="grid gap-1 rounded-md border border-border bg-muted/50 px-3 py-2.5">
      <p className="m-0 text-sm font-medium">Доступна OTA-версия {latestVersion}</p>
      <p className="m-0 text-sm text-muted-foreground">Перезагрузите страницу, чтобы получить новую версию.</p>
    </div>
  );
}

function AndroidUpdateNotice({ view }: { view: ReturnType<typeof engineSectionView> }) {
  if (view.apkUpdateAvailable) {
    return (
      <div className="grid gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5">
        <p className="m-0 text-sm font-medium">Нужен новый APK</p>
        <p className="m-0 text-sm text-muted-foreground">
          {view.requiredApkLabel ? `Требуется APK ${view.requiredApkLabel}.` : "Требуется более новый APK."}
        </p>
        <a className="text-sm font-semibold text-primary underline-offset-4 hover:underline" href={view.apkReleaseUrl}>
          Открыть APK-релизы
        </a>
      </div>
    );
  }

  if (view.androidUpdateStage === "ready") {
    return (
      <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5">
        <p className="m-0 text-sm font-medium">OTA-версия {view.latestVersion} загружена</p>
        <p className="m-0 text-sm text-muted-foreground">Закройте приложение, чтобы новая версия применилась.</p>
      </div>
    );
  }

  if (view.androidUpdateStage === "downloading") {
    const progress = view.downloadProgressPercent ?? 0;
    const version = view.downloadProgressVersion ?? view.latestVersion;
    return (
      <Field className="gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5">
        <FieldLabel htmlFor="engine-update-progress" className="flex w-full items-center gap-2 text-sm">
          <span className="min-w-0 truncate">Загрузка OTA-версии {version}</span>
          <span className="ml-auto tabular-nums">{progress}%</span>
        </FieldLabel>
        <Progress value={progress} id="engine-update-progress" className="h-1.5" />
      </Field>
    );
  }

  return (
    <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5">
      <p className="m-0 text-sm font-medium">Доступна OTA-версия {view.latestVersion}</p>
      <p className="m-0 text-sm text-muted-foreground">Нажмите «Проверить обновления», чтобы скачать её.</p>
    </div>
  );
}
