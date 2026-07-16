"use client";

import { useEffect, useMemo, useState } from "react";
import { KeyRound, LoaderCircle, Plus, RotateCw, Save, Trash2, TriangleAlert, X } from "lucide-react";
import type { AiCapability, AiModel, AiProfile, AiProviderCredential, AiProviderId, AiSettings, BraiApi, BraiApiError } from "@/shared/api/braiApi";
import { invalidateBraiCmdProviderCredentials, syncBraiCmdProviderCredentials } from "@/shared/platform/braiCmd";
import { isNativeShell, platformName } from "@/shared/platform/platform";
import { formatDisplayDateTime } from "@/shared/time/format";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import { Switch } from "@/shared/ui/switch";

const PROVIDERS: Array<{ id: AiProviderId; name: string }> = [
  { id: "openai", name: "OpenAI" }, { id: "groq", name: "Groq" },
  { id: "openrouter", name: "OpenRouter" }, { id: "gemini", name: "Google Gemini" },
];

type ProviderForm = { providerId: AiProviderId; replacing: boolean } | null;

export function AiModelsCard({ api, busy }: { api: BraiApi; busy: boolean }) {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [draft, setDraft] = useState<AiSettings | null>(null);
  const [providers, setProviders] = useState<AiProviderCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [providerForm, setProviderForm] = useState<ProviderForm>(null);
  const [apiKey, setApiKey] = useState("");
  const [deletePending, setDeletePending] = useState<AiProviderId | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [modelsRevision, setModelsRevision] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([api.aiSettings(), api.aiProviders()])
      .then(([nextSettings, response]) => {
        if (!active) return;
        setSettings(nextSettings);
        setDraft(nextSettings);
        setProviders(response.providers);
      })
      .catch((reason: unknown) => {
        if (active) setError(apiErrorMessage(reason, "Не удалось загрузить настройки моделей."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, loadAttempt]);

  async function reloadMetadata() {
    const [nextSettings, response] = await Promise.all([api.aiSettings(), api.aiProviders()]);
    setSettings(nextSettings);
    setDraft(nextSettings);
    setProviders(response.providers);
    setModelsRevision((revision) => revision + 1);
  }

  async function saveProvider() {
    if (!providerForm || !apiKey.trim()) return;
    setWorking(true);
    setError("");
    try {
      await api.saveAiProvider(providerForm.providerId, apiKey.trim());
      setProviderForm(null);
      await reloadMetadata();
      await syncNativeProviderCredentials();
    } catch (reason) {
      setError(apiErrorMessage(reason, "Не удалось проверить и сохранить ключ."));
    } finally {
      setApiKey("");
      setWorking(false);
    }
  }

  async function deleteProvider(providerId: AiProviderId) {
    setWorking(true);
    setError("");
    try {
      await api.deleteAiProvider(providerId);
      setDeletePending(null);
      await reloadMetadata();
      await syncNativeProviderCredentials();
    } catch (reason) {
      setError(apiErrorMessage(reason, "Не удалось удалить ключ."));
    } finally {
      setWorking(false);
    }
  }

  async function saveRouting() {
    if (!draft) return;
    setWorking(true);
    setError("");
    try {
      const nextSettings = await api.updateAiSettings(draft);
      setSettings(nextSettings);
      setDraft(nextSettings);
      setProviders((await api.aiProviders()).providers);
    } catch (reason) {
      setError(apiErrorMessage(reason, "Не удалось сохранить выбор моделей."));
    } finally {
      setWorking(false);
    }
  }

  function openProviderForm(providerId: AiProviderId, replacing: boolean) {
    setApiKey("");
    setDeletePending(null);
    setProviderForm({ providerId, replacing });
  }

  const connectedIds = useMemo(() => new Set(providers.map((provider) => provider.provider_id)), [providers]);
  const availableProviders = PROVIDERS.filter((provider) => !connectedIds.has(provider.id));
  const locked = busy || loading || working;
  const profilesReady = Boolean(
    draft?.text?.model.trim() &&
    connectedIds.has(draft.text.provider_id) &&
    draft?.vision?.model.trim() &&
    connectedIds.has(draft.vision.provider_id),
  );
  const profilesValid = Boolean(draft && [draft.text, draft.vision].every((profile) => (
    !profile || Boolean(profile.model.trim() && connectedIds.has(profile.provider_id))
  )));
  const changed = Boolean(settings && draft && !sameSettings(settings, draft));
  const external = draft?.model_provider_mode === "external";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Модели</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        {error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>
              <span>{error}</span>
              {!draft ? (
                <Button type="button" variant="outline" size="sm" onClick={() => {
                  setLoading(true);
                  setError("");
                  setLoadAttempt((attempt) => attempt + 1);
                }}>
                  Повторить
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <LoaderCircle className="animate-spin" />
            Загружаем настройки моделей…
          </div>
        ) : draft ? (
          <>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-4">
                <div className="grid min-w-0 gap-1">
                  <Label htmlFor="settings-external-models">Внешние модели по ключам</Label>
                  <p id="settings-model-mode-help" className="text-sm text-muted-foreground">
                    {external
                      ? "Агенты используют выбранные модели и ключи аккаунта."
                      : "Агенты используют модель Brai по подписке."}
                  </p>
                </div>
                <Switch
                  id="settings-external-models"
                  aria-describedby="settings-model-mode-help"
                  checked={external}
                  disabled={locked || (!external && !profilesReady)}
                  onCheckedChange={(checked) => setDraft((current) => current ? {
                    ...current,
                    model_provider_mode: checked ? "external" : "internal",
                  } : current)}
                />
              </div>
              {!external && !profilesReady ? (
                <p className="text-xs text-muted-foreground">Чтобы включить внешние модели, подключите ключи и выберите текстовую и vision-модель.</p>
              ) : null}
            </div>

            <Separator />

            <div className="grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-medium">Ключи поставщиков</h3>
                  <p className="text-xs text-muted-foreground">Ключи хранятся в аккаунте; полное значение после сохранения не показывается.</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={locked || availableProviders.length === 0}
                  onClick={() => openProviderForm(availableProviders[0].id, false)}
                >
                  <Plus />
                  Добавить ключ
                </Button>
              </div>

              {providerForm ? (
                <ProviderKeyForm
                  form={providerForm}
                  apiKey={apiKey}
                  availableProviders={availableProviders}
                  locked={locked}
                  onApiKeyChange={setApiKey}
                  onCancel={() => {
                    setApiKey("");
                    setProviderForm(null);
                  }}
                  onProviderChange={(providerId) => setProviderForm({ providerId, replacing: false })}
                  onSave={() => void saveProvider()}
                />
              ) : null}

              {providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Пока нет подключённых поставщиков.</p>
              ) : (
                <div className="grid gap-3">
                  {providers.map((provider, index) => (
                    <div key={provider.provider_id} className="grid gap-3">
                      {index > 0 ? <Separator /> : null}
                      <ProviderRow
                        provider={provider}
                        locked={locked}
                        deletePending={deletePending === provider.provider_id}
                        onDelete={() => setDeletePending(provider.provider_id)}
                        onDeleteCancel={() => setDeletePending(null)}
                        onDeleteConfirm={() => void deleteProvider(provider.provider_id)}
                        onReplace={() => openProviderForm(provider.provider_id, true)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <ProfileSelector
                api={api}
                capability="text"
                label="Текстовые агенты"
                description="Inbox и Activity normalizer"
                providers={providers}
                profile={draft.text}
                revision={modelsRevision}
                disabled={locked}
                onChange={(text) => setDraft((current) => current ? { ...current, text } : current)}
              />
              <ProfileSelector
                api={api}
                capability="vision"
                label="Описание изображений"
                description="Inbox image describer"
                providers={providers}
                profile={draft.vision}
                revision={modelsRevision}
                disabled={locked}
                onChange={(vision) => setDraft((current) => current ? { ...current, vision } : current)}
              />
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                disabled={locked || !changed || !profilesValid || (external && !profilesReady)}
                onClick={() => void saveRouting()}
              >
                <Save />
                Сохранить модели
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

async function syncNativeProviderCredentials(): Promise<void> {
  if (!isNativeShell() || platformName() !== "android") return;
  const result = await syncBraiCmdProviderCredentials();
  if (result?.ok) return;
  await invalidateBraiCmdProviderCredentials();
  throw new Error("native_provider_sync_failed");
}

function ProviderKeyForm(props: {
  form: Exclude<ProviderForm, null>;
  apiKey: string;
  availableProviders: Array<{ id: AiProviderId; name: string }>;
  locked: boolean;
  onApiKeyChange: (value: string) => void;
  onCancel: () => void;
  onProviderChange: (providerId: AiProviderId) => void;
  onSave: () => void;
}) {
  const { form, apiKey, availableProviders, locked, onApiKeyChange, onCancel, onProviderChange, onSave } = props;
  const options = form.replacing ? PROVIDERS.filter((provider) => provider.id === form.providerId) : availableProviders;
  return (
    <form className="grid gap-3" onSubmit={(event) => {
      event.preventDefault();
      onSave();
    }}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <div className="grid gap-2">
          <Label htmlFor="settings-provider">Поставщик</Label>
          <Select
            name="provider"
            value={form.providerId}
            disabled={locked || form.replacing}
            onValueChange={(value) => onProviderChange(value as AiProviderId)}
          >
            <SelectTrigger id="settings-provider" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {options.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="settings-provider-key">API-ключ</Label>
          <Input
            id="settings-provider-key"
            name="api_key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={locked}
            placeholder="Вставьте ключ"
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={onCancel}>
          <X />
          Отмена
        </Button>
        <Button type="submit" size="sm" disabled={locked || !apiKey.trim()}>
          <KeyRound />
          Проверить и сохранить
        </Button>
      </div>
    </form>
  );
}

function ProviderRow(props: {
  provider: AiProviderCredential;
  locked: boolean;
  deletePending: boolean;
  onDelete: () => void;
  onDeleteCancel: () => void;
  onDeleteConfirm: () => void;
  onReplace: () => void;
}) {
  const { provider, locked, deletePending, onDelete, onDeleteCancel, onDeleteConfirm, onReplace } = props;
  const inUse = provider.in_use_by.length > 0;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{providerName(provider.provider_id)}</span>
          <Badge variant="success">Подключён</Badge>
          <span className="font-mono text-xs text-muted-foreground">•••• {provider.key_hint}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Проверен {formatDate(provider.verified_at_utc)}
          {inUse ? ` · Используется: ${provider.in_use_by.map(capabilityName).join(", ")}` : ""}
        </p>
        {inUse ? <p className="text-xs text-muted-foreground">Сначала переназначьте профиль или выключите внешние модели.</p> : null}
      </div>
      {deletePending ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={onDeleteCancel}>Отмена</Button>
          <Button type="button" variant="destructive" size="sm" disabled={locked} onClick={onDeleteConfirm}>
            <Trash2 />
            Удалить ключ
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={locked} onClick={onReplace}>
            <RotateCw />
            Заменить
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={locked || inUse} onClick={onDelete}>
            <Trash2 />
            Удалить
          </Button>
        </div>
      )}
    </div>
  );
}

function ProfileSelector(props: {
  api: BraiApi;
  capability: AiCapability;
  label: string;
  description: string;
  providers: AiProviderCredential[];
  profile: AiProfile | null;
  revision: number;
  disabled: boolean;
  onChange: (profile: AiProfile) => void;
}) {
  const { api, capability, label, description, providers, profile, revision, disabled, onChange } = props;
  const [result, setResult] = useState<{ providerId: AiProviderId; models: AiModel[]; error: string } | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const providerId = profile?.provider_id;
  const loading = Boolean(providerId && result?.providerId !== providerId);
  const models = result && result.providerId === providerId ? result.models : [];
  const modelError = result && result.providerId === providerId ? result.error : "";

  useEffect(() => {
    if (!providerId) return;
    let active = true;
    api.aiModels(providerId, capability)
      .then((response) => {
        if (active) setResult({ providerId, models: response.models, error: "" });
      })
      .catch(() => {
        if (active) setResult({ providerId, models: [], error: "Не удалось загрузить модели." });
      });
    return () => {
      active = false;
    };
  }, [api, capability, providerId, retryAttempt, revision]);

  const modelOptions = profile?.model && !models.some((model) => model.id === profile.model)
    ? [{ id: profile.model, name: profile.model, capabilities: [capability] }, ...models]
    : models;

  return (
    <div className="grid content-start gap-3">
      <div>
        <h3 className="text-sm font-medium">{label}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`settings-${capability}-provider`}>Поставщик</Label>
        <Select
          value={providerId ?? ""}
          disabled={disabled || providers.length === 0}
          onValueChange={(value) => onChange({ provider_id: value as AiProviderId, model: "" })}
        >
          <SelectTrigger id={`settings-${capability}-provider`} className="w-full">
            <SelectValue placeholder="Выберите поставщика" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectItem key={provider.provider_id} value={provider.provider_id}>{providerName(provider.provider_id)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`settings-${capability}-model`}>Модель</Label>
        <Select
          value={profile?.model ?? ""}
          disabled={disabled || !providerId || loading || modelOptions.length === 0}
          onValueChange={(model) => providerId && onChange({ provider_id: providerId, model })}
        >
          <SelectTrigger id={`settings-${capability}-model`} className="w-full">
            <SelectValue placeholder={loading ? "Загрузка…" : "Выберите модель"} />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((model) => <SelectItem key={model.id} value={model.id}>{model.name || model.id}</SelectItem>)}
          </SelectContent>
        </Select>
        {modelError ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-destructive">{modelError}</p>
            <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
              setResult(null);
              setRetryAttempt((attempt) => attempt + 1);
            }}>
              Повторить
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
function sameSettings(left: AiSettings, right: AiSettings): boolean {
  return left.model_provider_mode === right.model_provider_mode &&
    left.text?.provider_id === right.text?.provider_id &&
    left.text?.model === right.text?.model &&
    left.vision?.provider_id === right.vision?.provider_id &&
    left.vision?.model === right.vision?.model;
}
function providerName(providerId: AiProviderId): string {
  return PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
}
function capabilityName(capability: string): string {
  if (capability === "text") return "текст";
  if (capability === "vision") return "изображения";
  return capability;
}
function formatDate(value: string): string {
  return formatDisplayDateTime(value, { dateStyle: "short" }) || "—";
}

function apiErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message === "native_provider_sync_failed") {
    return "Ключи аккаунта сохранены, но Brai CMD не смог обновить локальную копию. Старые копии удалены; синхронизация повторится автоматически.";
  }
  const { code, status } = (reason as BraiApiError | undefined) ?? {};
  if (status === 401) return "Сессия завершилась. Войдите снова.";
  if (code === "provider_in_use" || status === 409) return "Ключ используется выбранной моделью. Сначала измените настройки моделей.";
  if (code === "invalid_key") return "Поставщик отклонил API-ключ.";
  if (code === "quota_exceeded") return "У поставщика закончился доступный лимит.";
  if (code === "model_unavailable") return "Выбранная модель сейчас недоступна.";
  if (code === "capability_unsupported") return "Модель не поддерживает требуемую возможность.";
  if (code === "provider_timeout" || code === "provider_unavailable") return "Поставщик временно недоступен. Повторите позже.";
  if (status === 400 || status === 422) return "Поставщик отклонил ключ или выбранную модель.";
  return fallback;
}
