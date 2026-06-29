"use client";

import { Cpu, Download, RefreshCw } from "lucide-react";
import type { AppVersionState } from "@/shared/api/brightOsApi";
import { APP_BRANCH, APP_COMMIT, APP_ENVIRONMENT, APP_OTA_CHANNEL, APP_PREVIEW_SLOT, APP_VERSION } from "@/shared/config/runtime";
import type { BrightOtaState } from "@/shared/platform/ota";
import { moscowDateTime, moscowTime } from "@/shared/time/format";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { Tone } from "../../appModel";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";
import { engineSectionView } from "./engineModel";

const updateStatusVariants: Record<Tone, "secondary" | "outline" | "destructive"> = {
  ok: "secondary",
  warn: "outline",
  bad: "destructive",
  muted: "secondary",
};

export function EngineSection({
  appVersionState,
  bundlePublishedAt,
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
  otaState: BrightOtaState | null;
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
  const Icon = view.hasUpdate ? Download : Cpu;
  const rows = [
    { label: "Web", value: view.activeWebVersion },
    { label: "Последняя", value: view.latestVersion },
    { label: "APK", value: view.nativeApk },
    otaState?.candidateBundleVersion ? { label: "Готово", value: otaState.candidateBundleVersion } : null,
    bundlePublishedAt ? { label: "Опубликовано", value: moscowDateTime(bundlePublishedAt) } : null,
    versionCheckedAt || otaCheckedAt ? { label: "Проверено", value: moscowTime(versionCheckedAt ?? otaCheckedAt ?? "") } : null,
    ...nonProductionRows(otaState),
  ].filter((row): row is { label: string; value: string } => Boolean(row?.value));

  return (
    <section className={SECTION_GRID_CLASS} aria-label="Engine">
      <Card className="grid gap-5 p-4">
        <div className="flex items-start justify-between gap-3.5 max-[560px]:flex-col">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cx("grid size-10 flex-none place-items-center rounded-md bg-accent text-accent-foreground", view.hasUpdate && "text-primary")}>
              <Icon className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="m-0 text-xs font-semibold uppercase text-muted-foreground">Bright OS Engine</p>
              <h2 className="m-0 text-2xl leading-tight tracking-normal">Engine v{view.latestVersion}</h2>
              <p className="m-0 text-sm leading-6 text-muted-foreground">{view.updateStatus.body}</p>
            </div>
          </div>
          <Badge className="min-h-[30px] flex-none px-2.5 text-xs font-semibold" variant={updateStatusVariants[view.updateStatus.tone]}>
            {view.updateStatus.label}
          </Badge>
        </div>

        <dl className="m-0 grid gap-2 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="min-w-0 rounded-md border border-border px-3 py-2">
              <dt className="text-xs font-normal uppercase text-muted-foreground">{row.label}</dt>
              <dd className="m-0 [overflow-wrap:anywhere] text-sm tabular-nums text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>

        <Button className="justify-self-start" type="button" variant="secondary" disabled={view.isChecking} onClick={() => void onRefreshEngine()}>
          <RefreshCw className={cx("size-4", view.isChecking && "animate-spin")} aria-hidden="true" />
          {view.isChecking ? "Проверяем..." : "Проверить обновление"}
        </Button>
      </Card>

      {view.ledgerRows.length > 0 ? (
        <Card className="grid gap-3 p-4">
          <div>
            <h2 className="m-0 text-base leading-tight">Журнал версий</h2>
            <p className="m-0 text-sm text-muted-foreground">Последние записи runtime ledger.</p>
          </div>
          <div className="grid gap-2">
            {view.ledgerRows.map((row) => (
              <div key={row.id} className="grid gap-1 rounded-md border border-border px-3 py-2">
                <div className="flex items-baseline justify-between gap-3 max-[460px]:grid max-[460px]:gap-0.5">
                  <span className="text-sm font-medium">{row.label} {row.version}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{moscowDateTime(row.releasedAtUtc)}</span>
                </div>
                <p className="m-0 text-sm text-muted-foreground">{row.shortChanges}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </section>
  );
}

function nonProductionRows(otaState: BrightOtaState | null): Array<{ label: string; value: string }> {
  const nativeEnvironment = otaState?.nativeEnvironment;
  const environment = APP_ENVIRONMENT !== "prod" ? APP_ENVIRONMENT : nativeEnvironment;
  if (!environment || environment === "prod") return [];

  const slot = APP_PREVIEW_SLOT || otaState?.nativePreviewSlot || "";
  const rows = [
    { label: "Окружение", value: environment === "dev" ? "Dev" : slot || environment },
  ];
  if (APP_BRANCH) rows.push({ label: "Ветка", value: APP_BRANCH });
  if (APP_COMMIT) rows.push({ label: "Commit", value: APP_COMMIT.slice(0, 12) });
  rows.push({ label: "OTA", value: APP_OTA_CHANNEL || otaState?.nativeOtaChannel || "" });
  return rows.filter((row) => row.value);
}
