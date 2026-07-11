"use client";

import { useMemo, useState } from "react";
import { Check, Save, TriangleAlert } from "lucide-react";
import type { AppSettings, ModelProviderMode } from "@/shared/api/braiApi";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Switch } from "@/shared/ui/switch";
import { SECTION_GRID_CLASS } from "../../appModel";

const TIMEZONE_OPTIONS = [
  "Europe/Moscow",
  "UTC",
  "Europe/Belgrade",
  "Asia/Dubai",
  "America/New_York",
  "America/Los_Angeles",
];

type SettingsPatch = Partial<Pick<AppSettings, "display_timezone" | "model_provider_mode" | "inbox_text_model" | "inbox_image_model">>;

export function SettingsSection({
  settings,
  busy,
  onUpdate,
}: {
  settings: AppSettings;
  busy: boolean;
  onUpdate: (patch: SettingsPatch) => Promise<void>;
}) {
  const formKey = `${settings.display_timezone}:${settings.model_provider_mode}:${settings.inbox_text_model}:${settings.inbox_image_model}`;
  return <SettingsForm key={formKey} settings={settings} busy={busy} onUpdate={onUpdate} />;
}

function SettingsForm({
  settings,
  busy,
  onUpdate,
}: {
  settings: AppSettings;
  busy: boolean;
  onUpdate: (patch: SettingsPatch) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const changed = useMemo(() => (
    draft.display_timezone !== settings.display_timezone ||
    draft.model_provider_mode !== settings.model_provider_mode ||
    draft.inbox_text_model !== settings.inbox_text_model ||
    draft.inbox_image_model !== settings.inbox_image_model
  ), [draft, settings]);

  async function saveSettings() {
    setSaving(true);
    try {
      await onUpdate({
        display_timezone: draft.display_timezone,
        model_provider_mode: draft.model_provider_mode,
        inbox_text_model: draft.inbox_text_model,
        inbox_image_model: draft.inbox_image_model,
      });
    } finally {
      setSaving(false);
    }
  }

  function setMode(external: boolean) {
    setDraft((current) => ({
      ...current,
      model_provider_mode: (external ? "external" : "internal") satisfies ModelProviderMode,
    }));
  }

  const locked = busy || saving;
  const external = draft.model_provider_mode === "external";

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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Модели</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="settings-external-models" className="min-w-0">Внешние модели</Label>
              <Switch
                id="settings-external-models"
                checked={external}
                disabled={locked}
                onCheckedChange={setMode}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="settings-text-model">Groq text model</Label>
                <Input
                  id="settings-text-model"
                  value={draft.inbox_text_model}
                  disabled={locked || !external}
                  onChange={(event) => setDraft((current) => ({ ...current, inbox_text_model: event.target.value }))}
                />
                <ProviderStatus ok={settings.external_ai.groq_configured} label="Groq API key" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="settings-image-model">OpenAI image model</Label>
                <Input
                  id="settings-image-model"
                  value={draft.inbox_image_model}
                  disabled={locked || !external}
                  onChange={(event) => setDraft((current) => ({ ...current, inbox_image_model: event.target.value }))}
                />
                <ProviderStatus ok={settings.external_ai.openai_configured} label="OpenAI API key" />
              </div>
            </div>
          </CardContent>
        </Card>

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

function ProviderStatus({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? Check : TriangleAlert;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      {label}: {ok ? "есть" : "нет"}
    </span>
  );
}
