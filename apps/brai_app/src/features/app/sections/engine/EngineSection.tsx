"use client";

import { Download, RefreshCw } from "lucide-react";
import type { AppVersionState } from "@/shared/api/braiApi";
import { useAppVersion } from "@/shared/config/runtime";
import type { BraiOtaState } from "@/shared/platform/ota";
import { platformName } from "@/shared/platform/platform";
import { moscowTime } from "@/shared/time/format";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Field, FieldLabel } from "@/shared/ui/field";
import { Progress } from "@/shared/ui/progress";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";
import { engineSectionView, type EngineSectionView } from "./engineModel";

export function EngineSection({
  appVersionState,
  otaCheckedAt,
  otaRefreshing,
  otaState,
  versionCheckedAt,
  versionError,
  versionRefreshing,
  onDownloadApk,
  onInstallApk,
  onDownloadWebUpdate,
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
  onDownloadApk: () => Promise<BraiOtaState | null>;
  onInstallApk: () => Promise<BraiOtaState | null>;
  onDownloadWebUpdate: () => Promise<BraiOtaState | null>;
  onRefreshEngine: () => Promise<void>;
}) {
  const appBuild = useAppVersion();
  const view = engineSectionView({ appBuild, appVersionState, otaRefreshing, otaState, versionError, versionRefreshing });
  const checkedAt = [otaCheckedAt, versionCheckedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

  async function runAction() {
    if (view.updateAction === "check") {
      await onRefreshEngine();
    } else if (view.updateAction === "download-web") {
      if (platformName() === "android") await onDownloadWebUpdate();
      else window.location.reload();
    } else if (view.updateAction === "download-apk") {
      const state = await onDownloadApk();
      if (!state) window.open(view.apkReleaseUrl, "_blank", "noopener,noreferrer");
    } else if (view.updateAction === "install-apk") {
      await onInstallApk();
    }
  }

  const button = updateButton(view.updateAction, view.apkInstallPermissionRequired);
  const ButtonIcon = button.icon;

  return (
    <section className={cx(SECTION_GRID_CLASS, "w-full content-start items-start")} aria-label="Engine">
      <Card className="grid w-full content-start gap-3 self-start p-4 sm:gap-4 sm:p-5">
        <div className="grid gap-1.5">
          <h2 className="m-0 text-lg leading-tight tracking-normal sm:text-xl">Текущая версия {view.installedVersion}</h2>
          <p className="m-0 text-sm leading-5 text-muted-foreground">{view.updateStatus.body}</p>
        </div>

        {(view.hasUpdate && view.updateAction !== "web-ready") || ["downloading-web", "downloading-apk", "install-apk"].includes(view.updateAction)
          ? <UpdateNotice view={view} />
          : null}

        <div className="flex min-w-0 items-center gap-3">
          <Button type="button" variant="secondary" size="sm" disabled={button.disabled} onClick={() => void runAction()}>
            <ButtonIcon className={cx("size-4", button.animated && "motion-safe:animate-bounce", view.updateAction === "checking" && "motion-safe:animate-spin")} aria-hidden="true" />
            {button.text}
          </Button>
          {checkedAt ? <p className="m-0 ml-auto whitespace-nowrap text-xs text-muted-foreground">Проверено {moscowTime(checkedAt)}</p> : null}
        </div>
      </Card>
    </section>
  );
}

function UpdateNotice({ view }: { view: EngineSectionView }) {
  if (view.updateAction === "download-apk") {
    return <Notice text={`Доступна новая версия приложения. Для обновления нужен APK${view.requiredApkLabel ? ` ${view.requiredApkLabel}` : ""}.`} />;
  }
  if (view.updateAction === "downloading-apk") {
    const progress = view.downloadProgressPercent ?? 0;
    return (
      <Field className="gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5">
        <FieldLabel htmlFor="engine-apk-progress" className="flex w-full items-center gap-2 text-sm">
          <span className="min-w-0 truncate">Скачивается APK{view.requiredApkLabel ? ` ${view.requiredApkLabel}` : ""}</span>
          <span className="ml-auto tabular-nums">{progress}%</span>
        </FieldLabel>
        <Progress value={progress} id="engine-apk-progress" className="h-1.5" />
      </Field>
    );
  }
  if (view.updateAction === "install-apk") {
    return <Notice text={view.apkInstallPermissionRequired ? "APK скачан. Разрешите Brai устанавливать обновления, затем нажмите «Установить»." : "APK скачан и проверен. Если установщик был закрыт, нажмите «Установить»."} />;
  }
  if (view.updateAction === "downloading-web") {
    const progress = view.downloadProgressPercent ?? 0;
    const version = view.downloadProgressVersion ?? view.latestVersion;
    return (
      <Field className="gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5">
        <FieldLabel htmlFor="engine-update-progress" className="flex w-full items-center gap-2 text-sm">
          <span className="min-w-0 truncate">Скачивается обновление {version}</span>
          <span className="ml-auto tabular-nums">{progress}%</span>
        </FieldLabel>
        <Progress value={progress} id="engine-update-progress" className="h-1.5" />
      </Field>
    );
  }
  return <Notice text={`Доступна новая версия ${view.latestVersion}.`} />;
}

function Notice({ text }: { text: string }) {
  return <div className="rounded-md border border-border bg-muted/50 px-3 py-2.5"><p className="m-0 text-sm font-medium">{text}</p></div>;
}

function updateButton(action: EngineSectionView["updateAction"], permissionRequired = false) {
  switch (action) {
    case "checking": return { text: "Проверяем...", icon: RefreshCw, disabled: true, animated: false };
    case "download-web": return { text: "Скачать обновление", icon: Download, disabled: false, animated: false };
    case "downloading-web":
    case "downloading-apk": return { text: "Скачивается", icon: Download, disabled: true, animated: true };
    case "web-ready": return { text: "Скачано", icon: Download, disabled: true, animated: false };
    case "download-apk": return { text: "Скачать APK", icon: Download, disabled: false, animated: false };
    case "install-apk": return { text: permissionRequired ? "Разрешить установку" : "Установить", icon: Download, disabled: false, animated: false };
    default: return { text: "Проверить обновления", icon: RefreshCw, disabled: false, animated: false };
  }
}
