"use client";

import { useEffect, useState } from "react";
import { Bell, ExternalLink, Mic, RefreshCw, Settings } from "lucide-react";
import {
  getAirWhisperState,
  openAirWhisperAccessibilitySettings,
  openAirWhisperOverlaySettings,
  openAirWhisperSettings,
  requestAirWhisperMicrophone,
  requestAirWhisperNotifications,
  type BraiAirWhisperState,
} from "@/shared/platform/airwhisper";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";

export function AirWhisperSection() {
  const [state, setState] = useState<BraiAirWhisperState | null>(null);
  const [busy, setBusy] = useState(false);
  const nativeAvailable = Boolean(state?.native);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setBusy(true);
    try {
      setState(await getAirWhisperState());
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<BraiAirWhisperState | null>) {
    setBusy(true);
    try {
      const next = await action();
      setState(next ?? await getAirWhisperState());
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cx(SECTION_GRID_CLASS, "content-start items-start xl:w-1/2")} aria-label="AirWhisper">
      <Card className="grid w-full content-start gap-4 self-start p-4 sm:p-5">
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <h2 className="m-0 text-lg leading-tight tracking-normal sm:text-xl">AirWhisper</h2>
            <Badge variant={nativeAvailable ? "secondary" : "outline"}>{nativeAvailable ? "Android" : "Web"}</Badge>
          </div>
          <p className="m-0 text-sm leading-5 text-muted-foreground">
            {nativeAvailable ? "Нативный модуль диктовки встроен в этот APK." : "Нативные настройки доступны в Android APK."}
          </p>
        </div>

        <div className="grid gap-2">
          <StatusRow label="Экран настроек" status={builtInStatus(state?.settingsDeclared)} />
          <StatusRow
            label="Специальные возможности"
            status={switchStatus(state?.accessibilityServiceDeclared, state?.accessibilityServiceEnabled, "Включено", "Нужно включить")}
          />
          <StatusRow label="Сервис записи" status={builtInStatus(state?.recordingServiceDeclared)} />
          <StatusRow label="Overlay" status={switchStatus(state?.overlayDeclared, state?.overlayGranted, "Разрешено", "Нужно разрешение")} />
          <StatusRow label="Микрофон" status={switchStatus(state?.microphoneDeclared, state?.microphoneGranted, "Разрешено", "Нужно разрешение")} />
          <StatusRow label="Уведомления" status={switchStatus(state?.notificationsDeclared, state?.notificationsGranted, "Разрешено", "Нужно разрешение")} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!nativeAvailable || busy} onClick={() => void run(openAirWhisperSettings)}>
            <Settings className="size-4" aria-hidden="true" />
            Открыть настройки
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw className={cx("size-4", busy && "animate-spin")} aria-hidden="true" />
            Обновить
          </Button>
        </div>

        {nativeAvailable ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(openAirWhisperAccessibilitySettings)}>
              <ExternalLink className="size-4" aria-hidden="true" />
              Accessibility
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(openAirWhisperOverlaySettings)}>
              <ExternalLink className="size-4" aria-hidden="true" />
              Overlay
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(requestAirWhisperMicrophone)}>
              <Mic className="size-4" aria-hidden="true" />
              Микрофон
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void run(requestAirWhisperNotifications)}>
              <Bell className="size-4" aria-hidden="true" />
              Уведомления
            </Button>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

type StatusView = { label: string; ok: boolean };

function builtInStatus(declared?: boolean): StatusView {
  if (declared === true) return { label: "Встроено", ok: true };
  if (declared === false) return { label: "Нет", ok: false };
  return { label: "Не проверено", ok: false };
}

function switchStatus(declared: boolean | undefined, active: boolean | undefined, activeLabel: string, inactiveLabel: string): StatusView {
  if (declared === false) return { label: "Нет", ok: false };
  if (active === true) return { label: activeLabel, ok: true };
  if (active === false) return { label: inactiveLabel, ok: false };
  return { label: "Не проверено", ok: false };
}

function StatusRow({ label, status }: { label: string; status: StatusView }) {
  return (
    <div className="flex min-h-9 items-center gap-3 rounded-md border border-border bg-muted/35 px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      <Badge variant={status.ok ? "secondary" : "outline"}>{status.label}</Badge>
    </div>
  );
}
