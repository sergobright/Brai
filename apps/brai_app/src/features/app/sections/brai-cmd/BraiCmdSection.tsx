"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleHelp, Download, LoaderCircle, Trash2, X, XCircle } from "lucide-react";
import {
  deleteBraiCmdAudio,
  downloadBraiCmdAudio,
  getBraiCmdSettings,
  openBraiCmdPermission,
  saveBraiCmdProvider,
  setBraiCmdOverlayEnabled,
  testBraiCmdConnection,
  testBraiCmdProvider,
  updateBraiCmdSettings,
  type BraiCmdAudioItem,
  type BraiCmdContextActions,
  type BraiCmdPermissionKey,
  type BraiCmdProviderId,
  type BraiCmdProviderMode,
  type BraiCmdProviderTestResult,
  type BraiCmdSettingsPatch,
  type BraiCmdSnapshot,
} from "@/shared/platform/braiCmd";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/shared/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Separator } from "@/shared/ui/separator";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { SECTION_GRID_CLASS } from "../../appModel";
import { cx } from "../../appUtils";

const PROVIDERS: Array<{ id: BraiCmdProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "groq", label: "Groq" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "gemini", label: "Gemini" },
  { id: "custom-openai", label: "OpenAI-compatible" },
];

const PERMISSIONS: Array<{ id: BraiCmdPermissionKey; title: string; text: string }> = [
  { id: "accessibility", title: "Специальные возможности", text: "Чтение контекста и вставка текста." },
  { id: "overlay", title: "Поверх приложений", text: "Плавающие кнопки Brai CMD." },
  { id: "microphone", title: "Микрофон", text: "Запись голосовых команд." },
  { id: "notifications", title: "Уведомления", text: "Статус записи и отправки." },
];

const CONTEXT_ACTIONS: Array<{ id: keyof BraiCmdContextActions; title: string; text: string }> = [
  { id: "voiceCommand", title: "Команда голосом", text: "Отправить голосовое во Входящие" },
  { id: "screenshotInbox", title: "Скриншот во Входящие", text: "Текущий экран во входящие" },
  { id: "screenshotVoice", title: "Скриншот + голос", text: "Скриншот вместе с голосовой командой" },
  { id: "contextInbox", title: "Контекст во Входящие", text: "Структурный текст со страницы во Входящие" },
  { id: "contextReply", title: "Ответ с контекстом", text: "Подготовить ответ и вставить в поле ввода" },
];

type CmdPage = "main" | "provider" | "audio";
type ConnectionStatus = "idle" | "testing" | "ok" | "error";
type ConnectionState = { status: ConnectionStatus; message: string };

const initialConnection: ConnectionState = { status: "idle", message: "Протестируйте подключение" };

export function BraiCmdSection() {
  const [snapshot, setSnapshot] = useState<BraiCmdSnapshot | null>(null);
  const [page, setPage] = useState<CmdPage>("main");
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>(initialConnection);

  useEffect(() => {
    let active = true;
    void getBraiCmdSettings().then((next) => {
      if (!active) return;
      setSnapshot(next);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => installAndroidBackHandler(() => {
    if (page === "main") return false;
    setPage("main");
    return true;
  }), [page]);

  async function patchSettings(patch: BraiCmdSettingsPatch) {
    const next = await updateBraiCmdSettings(patch);
    if (next) setSnapshot(next);
  }

  async function toggleOverlay(enabled: boolean) {
    const next = await setBraiCmdOverlayEnabled(enabled);
    if (!next) return;
    setSnapshot((current) => current ? { ...current, ...next, overlayEnabled: next.overlayEnabled ?? enabled } : current);
  }

  async function testConnection() {
    setConnection({ status: "testing", message: "Проверка..." });
    const result = await testBraiCmdConnection();
    setConnection(result?.ok ? { status: "ok", message: "Всё работает" } : { status: "error", message: "Подключение не работает" });
  }

  if (loading) {
    return <section className={cx(SECTION_GRID_CLASS, "max-w-3xl content-start")} aria-label="Brai CMD"><Card className="p-5 text-sm text-muted-foreground">Загрузка</Card></section>;
  }

  if (!snapshot) {
    return (
      <section className={cx(SECTION_GRID_CLASS, "max-w-3xl content-start pb-[calc(6rem+env(safe-area-inset-bottom))]")} aria-label="Brai CMD">
        <h1 className="text-2xl font-semibold">Brai CMD</h1>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Android</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Настройки Brai CMD доступны в Android-приложении Brai.</CardContent>
        </Card>
      </section>
    );
  }

  return (
    <section className={cx(SECTION_GRID_CLASS, "max-w-3xl content-start pb-[calc(6rem+env(safe-area-inset-bottom))] max-[860px]:pb-[calc(7rem+env(safe-area-inset-bottom))]")} aria-label="Brai CMD">
      {page === "main" ? (
        <MainPage
          snapshot={snapshot}
          connection={connection}
          onAudio={() => setPage("audio")}
          onConnectionTest={() => void testConnection()}
          onOverlayChange={(enabled) => void toggleOverlay(enabled)}
          onPatch={(patch) => void patchSettings(patch)}
          onPermission={(permission) => void openBraiCmdPermission(permission).then((next) => { if (next) setSnapshot(next); })}
          onProvider={() => setPage("provider")}
        />
      ) : page === "provider" ? (
        <ProviderPage snapshot={snapshot} onBack={() => setPage("main")} onSnapshot={setSnapshot} />
      ) : (
        <AudioPage snapshot={snapshot} onBack={() => setPage("main")} onPatch={(patch) => void patchSettings(patch)} onSnapshot={setSnapshot} />
      )}
    </section>
  );
}

function MainPage({
  snapshot,
  connection,
  onAudio,
  onConnectionTest,
  onOverlayChange,
  onPatch,
  onPermission,
  onProvider,
}: {
  snapshot: BraiCmdSnapshot;
  connection: ConnectionState;
  onAudio: () => void;
  onConnectionTest: () => void;
  onOverlayChange: (enabled: boolean) => void;
  onPatch: (patch: BraiCmdSettingsPatch) => void;
  onPermission: (permission: BraiCmdPermissionKey) => void;
  onProvider: () => void;
}) {
  const { settings } = snapshot;
  return (
    <>
      <h1 className="text-2xl font-semibold">Brai CMD</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Главная кнопка диктовки</CardTitle>
          <CardDescription>Основная кнопка, которая превращает голос в текст, вставляй в поле ввода.</CardDescription>
        </CardHeader>
        <CardContent>
          <SwitchRow
            checked={Boolean(snapshot.overlayEnabled)}
            text="Выключает основную кнопку и кнопки контекста."
            title="Переключатель активен"
            onCheckedChange={onOverlayChange}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Разрешения</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            {PERMISSIONS.map((permission, index) => {
              const granted = snapshot.permissions[permission.id];
              return (
                <Fragment key={permission.id}>
                  {index > 0 ? <Separator /> : null}
                  <Field orientation="responsive">
                    <FieldContent>
                      <FieldTitle>{permission.title}</FieldTitle>
                      <FieldDescription>{permission.text}</FieldDescription>
                    </FieldContent>
                    <Button className="w-full sm:w-auto" disabled={granted} type="button" variant={granted ? "secondary" : "default"} onClick={() => onPermission(permission.id)}>
                      {granted ? "Выдано" : "Разрешить"}
                    </Button>
                  </Field>
                </Fragment>
              );
            })}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Проверка связи</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ConnectionAlert connection={connection} />
          <Button className="w-full sm:w-fit" disabled={connection.status === "testing"} type="button" onClick={onConnectionTest}>
            {connection.status === "testing" ? "Проверка" : "Тест"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Кнопки контекста</CardTitle>
          <CardDescription>Вы можете включать и выключать набор кнопок</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            {CONTEXT_ACTIONS.map((action, index) => (
              <Fragment key={action.id}>
                {index > 0 ? <Separator /> : null}
                <SwitchRow
                  checked={settings.contextActions[action.id]}
                  text={action.text}
                  title={action.title}
                  onCheckedChange={(checked) => onPatch({ contextActions: { [action.id]: checked } as Partial<BraiCmdContextActions> })}
                />
              </Fragment>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Настройки кнопок</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-5">
            <RangeRow title="Основная иконка: непрозрачность" value={settings.mainIconOpacityPercent} min={35} max={100} onChange={(value) => onPatch({ mainIconOpacityPercent: value })} />
            <RangeRow title="Основная иконка: размер" value={settings.mainIconSizePercent} min={70} max={130} onChange={(value) => onPatch({ mainIconSizePercent: value })} />
            <Separator />
            <RangeRow title="Контекст: непрозрачность" value={settings.contextIconOpacityPercent} min={35} max={100} onChange={(value) => onPatch({ contextIconOpacityPercent: value })} />
            <RangeRow title="Контекст: размер" value={settings.contextIconSizePercent} min={70} max={130} onChange={(value) => onPatch({ contextIconSizePercent: value })} />
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Постобработка</CardTitle>
          <CardDescription>Улучшаем с ИИ текст полученный после расшифровки.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            <SwitchRow
              checked={settings.postProcessingEnabled}
              text="После расшифровки текст будет улучшаться через выбранного поставщика LLM."
              title="Постобработка включена"
              onCheckedChange={(checked) => onPatch({ postProcessingEnabled: checked })}
            />
            {settings.postProcessingEnabled ? (
              <>
                <Separator />
                <Field orientation="responsive">
                  <FieldContent>
                    <FieldTitle>Поставщик LLM</FieldTitle>
                    <FieldDescription>{settings.providerConfigured ? "Поставщик подключён." : "Нужно выбрать облако Brai или подключить ключ поставщика."}</FieldDescription>
                  </FieldContent>
                  <Button className="w-full justify-start sm:w-auto sm:justify-center" type="button" variant="outline" onClick={onProvider}>
                    {settings.providerConfigured ? <Check className="text-emerald-600 dark:text-emerald-300" /> : <X className="text-destructive" />}
                    Поставщик LLM
                  </Button>
                </Field>
                <Field>
                  <FieldLabel htmlFor="brai-cmd-post-processing-prompt">Промпт постобработки</FieldLabel>
                  <Textarea
                    id="brai-cmd-post-processing-prompt"
                    rows={6}
                    value={settings.postProcessingPrompt}
                    onChange={(event) => onPatch({ postProcessingPrompt: event.target.value })}
                  />
                </Field>
              </>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Статистика Транскриптов</CardTitle>
        </CardHeader>
        <CardContent>
          <StatsGrid snapshot={snapshot} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Аудиозаписи</CardTitle>
          <CardDescription>По умолчанию на телефоне сохраняются только аудиозаписи, которые ещё не удалось обработать. Вы можете их скачать или удалить.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full sm:w-fit" type="button" variant="outline" onClick={onAudio}>Аудиозаписи</Button>
        </CardContent>
      </Card>
    </>
  );
}

function ProviderPage({ snapshot, onBack, onSnapshot }: { snapshot: BraiCmdSnapshot; onBack: () => void; onSnapshot: (snapshot: BraiCmdSnapshot) => void }) {
  const [mode, setMode] = useState<BraiCmdProviderMode>(snapshot.settings.providerMode);
  const [providerId, setProviderId] = useState<BraiCmdProviderId>(snapshot.settings.providerId);
  const [baseUrl, setBaseUrl] = useState(snapshot.settings.providerBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(snapshot.settings.providerModel);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<BraiCmdProviderTestResult | null>(null);

  async function saveCloud() {
    const next = await updateBraiCmdSettings({ providerMode: "cloud" });
    if (next) onSnapshot(next);
  }

  function chooseMode(value: string) {
    const nextMode = value as BraiCmdProviderMode;
    setMode(nextMode);
    setResult(null);
    if (nextMode === "cloud") void saveCloud();
  }

  async function connectProvider() {
    setTesting(true);
    try {
      const tested = await testBraiCmdProvider({ providerId, apiKey, model, baseUrl });
      setResult(tested);
      if (tested?.ok) {
        const nextModels = tested.models ?? [];
        const nextModel = tested.model || model || nextModels[0] || "";
        setModels(nextModels);
        setModel(nextModel);
        const next = await saveBraiCmdProvider({ providerMode: "key", providerId, apiKey, model: nextModel, baseUrl });
        if (next) onSnapshot(next);
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <PageBack title="Поставщик LLM" onBack={onBack} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Режим</CardTitle>
        </CardHeader>
        <CardContent>
          <ChoiceRadioGroup value={mode} onValueChange={chooseMode}>
            <ChoiceRadio id="brai-cmd-provider-cloud" text="Постобработка на серверах Brai." title="Облако Brai" value="cloud" />
            <ChoiceRadio id="brai-cmd-provider-key" text="Ваш API ключ и модель поставщика." title="Ключ поставщика" value="key" />
          </ChoiceRadioGroup>
        </CardContent>
      </Card>

      {mode === "cloud" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Облако Brai</CardTitle>
            <CardDescription>Постобработка происходит на серверах Brai. Данные удаляются сразу после доставки на ваше устройство.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm text-muted-foreground">
            <p className="m-0">Сейчас бесплатное использование. В дальнейшем будет лимитировано + подписка.</p>
            <p className="m-0">Используемая модель OpenAI gpt-oss-20b: 20 млрд параметров.</p>
            <StatsGrid snapshot={snapshot} cloudOnly />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ключ поставщика</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="brai-cmd-provider-id">Поставщик</FieldLabel>
                <Select value={providerId} onValueChange={(value) => setProviderId(value as BraiCmdProviderId)}>
                  <SelectTrigger id="brai-cmd-provider-id" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{PROVIDERS.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {providerId === "custom-openai" ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-base-url">Base URL</FieldLabel>
                  <Input id="brai-cmd-provider-base-url" placeholder="https://example.com/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="brai-cmd-provider-key">API ключ</FieldLabel>
                <Input id="brai-cmd-provider-key" autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} />
              </Field>
              {models.length > 0 ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-model-select">Модель</FieldLabel>
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger id="brai-cmd-provider-model-select" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{models.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-model">Модель</FieldLabel>
                  <Input id="brai-cmd-provider-model" placeholder="Оставьте пустым, если поставщик отдаёт список" value={model} onChange={(event) => setModel(event.target.value)} />
                </Field>
              )}
              <Button className="w-full sm:w-fit" disabled={testing || apiKey.trim().length === 0} type="button" onClick={() => void connectProvider()}>
                {testing ? "Проверка" : "Подключить"}
              </Button>
              {result ? <ProviderResultAlert result={result} /> : null}
            </FieldGroup>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function AudioPage({
  snapshot,
  onBack,
  onPatch,
  onSnapshot,
}: {
  snapshot: BraiCmdSnapshot;
  onBack: () => void;
  onPatch: (patch: BraiCmdSettingsPatch) => void;
  onSnapshot: (snapshot: BraiCmdSnapshot) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<BraiCmdAudioItem | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const settings = snapshot.settings;
  const [limitDraft, setLimitDraft] = useState(String(settings.processedAudioRetentionLimit));

  function commitLimit(value = limitDraft) {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.trunc(parsed) : 25;
    const clamped = Math.min(999, Math.max(1, next));
    setLimitDraft(String(clamped));
    onPatch({ processedAudioRetentionLimit: clamped });
  }

  function changeLimit(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 3);
    setLimitDraft(digits);
    if (!digits) return;
    const parsed = Number(digits);
    if (parsed >= 1 && parsed <= 999) onPatch({ processedAudioRetentionLimit: parsed });
  }

  return (
    <>
      <PageBack title="Аудиозаписи" onBack={onBack} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Настройки</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            <ChoiceRadioGroup value={settings.processedAudioRetentionEnabled ? "processed" : "queue"} onValueChange={(value) => onPatch({ processedAudioRetentionEnabled: value === "processed" })}>
              <ChoiceRadio id="brai-cmd-audio-queue" text="Без лимита для очереди." title="Только очередь" value="queue" />
              <ChoiceRadio id="brai-cmd-audio-processed" text="Сохранять обработанные записи." title="Хранить больше аудиозаписей" value="processed" />
            </ChoiceRadioGroup>
            {settings.processedAudioRetentionEnabled ? (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel htmlFor="brai-cmd-audio-limit">Сколько аудиозаписей хранить?</FieldLabel>
                  <FieldDescription>Лимит применяется только к обработанным аудиозаписям.</FieldDescription>
                </FieldContent>
                <Input
                  id="brai-cmd-audio-limit"
                  className="w-full sm:w-24"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  type="text"
                  value={limitDraft}
                  onBlur={() => commitLimit()}
                  onChange={(event) => changeLimit(event.target.value)}
                />
              </Field>
            ) : null}
          </FieldGroup>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Файлы</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            {snapshot.audio.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Аудиозаписей нет</p> : null}
            {snapshot.audio.map((item, index) => (
              <Fragment key={item.id}>
                {index > 0 ? <Separator /> : null}
                <div className="grid gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="grid min-w-0 gap-1.5">
                      <div className="font-medium leading-snug">{item.title}</div>
                      <div>
                        <Badge variant={item.status === "queued" ? "error" : "success"}>{item.status === "queued" ? "в очереди" : "обработано"}</Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">{item.megabytes.toFixed(2)} МБ</div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button type="button" size="icon-sm" variant="outline" aria-label="Скачать" onClick={() => void downloadBraiCmdAudio(item.id).then((result) => setDownloadStatus(result?.message ?? ""))}><Download /></Button>
                      <Button type="button" size="icon-sm" variant="outline" aria-label="Удалить" onClick={() => item.status === "queued" ? setPendingDelete(item) : void deleteBraiCmdAudio(item.id).then((next) => { if (next) onSnapshot(next); })}><Trash2 /></Button>
                    </div>
                  </div>
                  {pendingDelete?.id === item.id ? (
                    <Alert variant="destructive">
                      <Trash2 />
                      <AlertTitle>Удалить запись из очереди?</AlertTitle>
                      <AlertDescription>Эта аудиозапись ещё не обработана.</AlertDescription>
                      <AlertAction>
                        <Button type="button" size="sm" variant="destructive" onClick={() => void deleteBraiCmdAudio(item.id).then((next) => { setPendingDelete(null); if (next) onSnapshot(next); })}>Удалить</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setPendingDelete(null)}>Отмена</Button>
                      </AlertAction>
                    </Alert>
                  ) : null}
                </div>
              </Fragment>
            ))}
            {downloadStatus ? <p className="m-0 text-sm text-muted-foreground">{downloadStatus}</p> : null}
          </FieldGroup>
        </CardContent>
      </Card>
    </>
  );
}

function PageBack({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button type="button" size="icon-sm" variant="ghost" aria-label="Назад" onClick={onBack}><ArrowLeft /></Button>
      <h1 className="text-xl font-semibold">{title}</h1>
    </div>
  );
}

function SwitchRow({ title, text, checked, onCheckedChange }: { title: string; text: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{text}</FieldDescription>
      </FieldContent>
      <Switch aria-label={title} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  );
}

function RangeRow({ title, value, min, max, onChange }: { title: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <Label>{title}</Label>
        <span className="text-sm font-medium text-muted-foreground">{value}%</span>
      </div>
      <input className="h-2 w-full accent-primary" type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Field>
  );
}

function ChoiceRadioGroup({ children, onValueChange, value }: { children: ReactNode; value: string; onValueChange: (value: string) => void }) {
  return (
    <RadioGroup className="grid gap-3 sm:grid-cols-2" value={value} onValueChange={onValueChange}>
      {children}
    </RadioGroup>
  );
}

function ChoiceRadio({ id, text, title, value }: { id: string; text: string; title: string; value: string }) {
  return (
    <FieldLabel className="w-full cursor-pointer" htmlFor={id}>
      <Field className="min-h-full rounded-md border p-4" orientation="horizontal">
        <RadioGroupItem id={id} value={value} />
        <FieldContent>
          <FieldTitle>{title}</FieldTitle>
          <FieldDescription>{text}</FieldDescription>
        </FieldContent>
      </Field>
    </FieldLabel>
  );
}

function ConnectionAlert({ connection }: { connection: ConnectionState }) {
  const Icon = connection.status === "testing" ? LoaderCircle : connection.status === "ok" ? CheckCircle2 : connection.status === "error" ? XCircle : CircleHelp;
  return (
    <Alert variant={connection.status === "ok" ? "success" : connection.status === "error" ? "destructive" : "default"}>
      <Icon className={connection.status === "testing" ? "animate-spin" : undefined} />
      <AlertTitle>{connection.message}</AlertTitle>
    </Alert>
  );
}

function ProviderResultAlert({ result }: { result: BraiCmdProviderTestResult }) {
  return (
    <Alert variant={result.ok ? "success" : "destructive"}>
      {result.ok ? <CheckCircle2 /> : <XCircle />}
      <AlertTitle>{result.ok ? "Подключено" : "Не удалось подключить"}</AlertTitle>
      <AlertDescription>{result.message}</AlertDescription>
    </Alert>
  );
}

function StatsGrid({ snapshot, cloudOnly = false }: { snapshot: BraiCmdSnapshot; cloudOnly?: boolean }) {
  const stats = snapshot.stats;
  const rows = useMemo(() => cloudOnly ? [
    ["Запросов", stats.cloudRequests.toLocaleString("ru-RU")],
    ["Символов на вход", stats.cloudInputChars.toLocaleString("ru-RU")],
    ["Символов на выход", stats.cloudOutputChars.toLocaleString("ru-RU")],
  ] : [
    ["Секунд аудио", stats.audioSeconds.toLocaleString("ru-RU")],
    ["Мегабайт", stats.audioMegabytes.toFixed(2)],
    ["Символов", stats.transcriptChars.toLocaleString("ru-RU")],
    ["Запросов", stats.requests.toLocaleString("ru-RU")],
  ], [cloudOnly, stats]);
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-4">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="m-0 font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
