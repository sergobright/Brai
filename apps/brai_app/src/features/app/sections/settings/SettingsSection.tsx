"use client";

import { useMemo, useState } from "react";
import { Save } from "lucide-react";
import type { AppSettings, BraiApi } from "@/shared/api/braiApi";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { SECTION_GRID_CLASS } from "../../appModel";
import { AiModelsCard } from "./AiModelsCard";

const TIMEZONE_OPTIONS = [
  "Europe/Moscow",
  "UTC",
  "Europe/Belgrade",
  "Asia/Dubai",
  "America/New_York",
  "America/Los_Angeles",
];

type SettingsPatch = Partial<Pick<AppSettings, "display_timezone">>;

export function SettingsSection({
  settings,
  api,
  busy,
  onUpdate,
}: {
  settings: AppSettings;
  api: BraiApi;
  busy: boolean;
  onUpdate: (patch: SettingsPatch) => Promise<void>;
}) {
  return <SettingsForm key={settings.display_timezone} settings={settings} api={api} busy={busy} onUpdate={onUpdate} />;
}

function SettingsForm({
  settings,
  api,
  busy,
  onUpdate,
}: {
  settings: AppSettings;
  api: BraiApi;
  busy: boolean;
  onUpdate: (patch: SettingsPatch) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const changed = useMemo(() => draft.display_timezone !== settings.display_timezone, [draft, settings]);

  async function saveSettings() {
    setSaving(true);
    try {
      await onUpdate({
        display_timezone: draft.display_timezone,
      });
    } finally {
      setSaving(false);
    }
  }

  const locked = busy || saving;

  return (
    <section className={SECTION_GRID_CLASS} aria-label="Настройки">
      <div className="grid max-w-3xl content-start gap-4 pb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Время</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <Label htmlFor="settings-timezone">Часовой пояс</Label>
            <Input
              id="settings-timezone"
              list="settings-timezone-options"
              value={draft.display_timezone}
              disabled={locked}
              onChange={(event) => setDraft((current) => ({ ...current, display_timezone: event.target.value }))}
            />
            <datalist id="settings-timezone-options">
              {TIMEZONE_OPTIONS.map((zone) => <option key={zone} value={zone} />)}
            </datalist>
          </CardContent>
        </Card>

        <AiModelsCard api={api} busy={busy} />

        <div className="flex justify-end">
          <Button type="button" disabled={locked || !changed} onClick={() => void saveSettings()}>
            <Save />
            Сохранить
          </Button>
        </div>
      </div>
    </section>
  );
}
