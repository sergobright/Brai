"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleHelp, Download, LoaderCircle, Trash2, X, XCircle } from "lucide-react";
import {
  deleteBraiCmdAudio,
  connectBraiCmdProvider,
  disconnectBraiCmdProvider,
  downloadBraiCmdAudio,
  getBraiCmdSettings,
  openBraiCmdPermission,
  listenBraiCmdStateChanges,
  probeBraiCmdProvider,
  testBraiCmdConnection,
  updateBraiCmdSettings,
  type BraiCmdAudioItem,
  type BraiCmdContextActions,
  type BraiCmdPermissionKey,
  type BraiCmdProviderId,
  type BraiCmdProviderCapability,
  type BraiCmdProviderMode,
  type BraiCmdProviderConnectResult,
  type BraiCmdProviderTestResult,
  type BraiCmdSettingsPatch,
  type BraiCmdSnapshot,
} from "@/shared/platform/braiCmd";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
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
import { loadOnboardingState } from "../../../onboarding/onboardingModel";

const PROVIDERS: Array<{ id: BraiCmdProviderId; label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "groq", label: "Groq" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "gemini", label: "Gemini" },
  { id: "custom-openai", label: "OpenAI-compatible" },
];
const SPEECH_PROVIDERS = PROVIDERS.filter((provider) => provider.id === "openai" || provider.id === "groq");

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
type ConnectionState = { status: ConnectionStatus; message: string; stages?: NonNullable<Awaited<ReturnType<typeof testBraiCmdConnection>>>["stages"] };

const initialConnection: ConnectionState = { status: "idle", message: "Протестируйте подключение" };
const CMD_SECTION_CLASS = "max-w-3xl content-start gap-4 [&_[data-slot=card]]:rounded-xl [&_[data-slot=card-header]]:p-4 [&_[data-slot=card-panel]]:px-4 [&_[data-slot=card-panel]]:pb-4 [&_[data-slot=field-content]]:gap-1 [&_[data-slot=field-content]>[data-slot=field-label]]:text-base [&_[data-slot=field-content]>[data-slot=field-label]]:font-semibold [&_[data-slot=field-description]]:text-muted-foreground/75";
const PROVIDER_RECONNECT_NOTICE_KEY = "brai_cmd_provider_reconnect_notice_dismissed";

export function BraiCmdSection() {
  const [snapshot, setSnapshot] = useState<BraiCmdSnapshot | null>(null);
  const [page, setPage] = useState<CmdPage>("main");
  const [providerCapability, setProviderCapability] = useState<BraiCmdProviderCapability>("text");
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>(initialConnection);
  const [settingsError, setSettingsError] = useState("");
  const [providerReconnectNoticeDismissed, setProviderReconnectNoticeDismissed] = useState(() =>
    typeof window !== "undefined" && getBraiLocalStorageItem(PROVIDER_RECONNECT_NOTICE_KEY) === "true");

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    let remove: (() => void) | undefined;
    void listenBraiCmdStateChanges((next) => {
      if (!active) return;
      receivedEvent = true;
      setSnapshot(next);
      setLoading(false);
    }).then((handle) => {
      if (!active) {
        void handle?.remove();
        return;
      }
      remove = () => void handle?.remove();
      void getBraiCmdSettings().then((next) => {
        if (!active) return;
        if (next && !receivedEvent) setSnapshot(next);
        setLoading(false);
      });
    });
    const onVisibility = () => {
      if (document.visibilityState === "visible") void getBraiCmdSettings().then((next) => { if (next) setSnapshot(next); });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      remove?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => installAndroidBackHandler(() => {
    if (page === "main") return false;
    setPage("main");
    return true;
  }), [page]);

  async function patchSettings(patch: BraiCmdSettingsPatch) {
    const next = await updateBraiCmdSettings(patch);
    if (!next) {
      setSettingsError("Не удалось сохранить настройку. Повторите ещё раз.");
      return;
    }
    setSettingsError("");
    setSnapshot(next);
  }

  async function testConnection() {
    setConnection({ status: "testing", message: "Проверка..." });
    const result = await testBraiCmdConnection();
    setConnection(result?.ok
      ? { status: "ok", message: result.message || "Подключение к Brai работает", stages: result.stages }
      : { status: "error", message: result?.message || "Подключение к Brai не работает", stages: result?.stages });
  }

  if (loading) {
    return <section className={cx(SECTION_GRID_CLASS, CMD_SECTION_CLASS)} aria-label="Brai CMD"><Card className="p-5 text-sm text-muted-foreground">Загрузка</Card></section>;
  }

  if (!snapshot) {
    return (
      <section className={cx(SECTION_GRID_CLASS, CMD_SECTION_CLASS)} aria-label="Brai CMD">
        <Card>
          <CardHeader>
            <CardTitle>Android</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">Настройки Brai CMD доступны в Android-приложении Brai.</CardContent>
        </Card>
      </section>
    );
  }

  const onboardingUsedProvider = loadOnboardingState().voiceMode === "provider";
  const hasSpeechProfile = snapshot.settings.providerProfiles.some((profile) =>
    profile.configured && (profile.providerId === "openai" || profile.providerId === "groq"));
  const showProviderReconnectNotice = onboardingUsedProvider && !hasSpeechProfile && !providerReconnectNoticeDismissed;

  return (
    <section className={cx(SECTION_GRID_CLASS, CMD_SECTION_CLASS)} aria-label="Brai CMD">
      {settingsError ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>{settingsError}</AlertTitle>
        </Alert>
      ) : null}
      {showProviderReconnectNotice && page === "main" ? (
        <Alert>
          <CircleHelp />
          <AlertTitle>Подключите поставщика заново</AlertTitle>
          <AlertDescription>Ранее введённый в онбординге ключ не был сохранён. Сейчас используется безопасный облачный режим Brai.</AlertDescription>
          <AlertAction>
            <Button type="button" variant="outline" onClick={() => {
              setBraiLocalStorageItem(PROVIDER_RECONNECT_NOTICE_KEY, "true");
              setProviderReconnectNoticeDismissed(true);
            }}>Понятно</Button>
          </AlertAction>
        </Alert>
      ) : null}
      {page === "main" ? (
        <MainPage
          snapshot={snapshot}
          connection={connection}
          onAudio={() => { setPage("audio"); void getBraiCmdSettings().then((next) => { if (next) setSnapshot(next); }); }}
          onConnectionTest={() => void testConnection()}
          onPatch={(patch) => void patchSettings(patch)}
          onPermission={(permission) => void openBraiCmdPermission(permission).then((next) => { if (next) setSnapshot(next); })}
          onProvider={(capability) => { setProviderCapability(capability); setPage("provider"); }}
        />
      ) : page === "provider" ? (
        <ProviderPage capability={providerCapability} snapshot={snapshot} onBack={() => setPage("main")} onSnapshot={setSnapshot} />
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
  onPatch,
  onPermission,
  onProvider,
}: {
  snapshot: BraiCmdSnapshot;
  connection: ConnectionState;
  onAudio: () => void;
  onConnectionTest: () => void;
  onPatch: (patch: BraiCmdSettingsPatch) => void;
  onPermission: (permission: BraiCmdPermissionKey) => void;
  onProvider: (capability: BraiCmdProviderCapability) => void;
}) {
  const { settings } = snapshot;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Главная кнопка диктовки</CardTitle>
          <CardDescription>Превращает голос в текст и вставляет его в активное поле.</CardDescription>
        </CardHeader>
        <CardContent>
          <SwitchRow
            checked={settings.mainDictationEnabled}
            text="Управляет только главной кнопкой. Кнопки контекста настраиваются отдельно."
            title="Главная кнопка включена"
            onCheckedChange={(checked) => onPatch({ mainDictationEnabled: checked })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Разрешения</CardTitle>
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
          <CardTitle>Подключение к Brai</CardTitle>
          <CardDescription>Проверяет серверы Brai, доступ устройства и доставку контекста. Пользовательский AI-провайдер проверяется отдельно.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <ConnectionAlert connection={connection} />
          <Button className="w-full sm:w-fit" disabled={connection.status === "testing"} type="button" onClick={onConnectionTest}>
            {connection.status === "testing" ? "Проверка" : "Проверить подключение к Brai"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Кнопки контекста</CardTitle>
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
          <CardTitle>Настройки кнопок</CardTitle>
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
          <CardTitle>Распознавание речи</CardTitle>
          <CardDescription>Выберите, куда приложение отправляет голос для получения текста.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="responsive">
            <FieldContent>
              <FieldTitle>{settings.transcriptionMode === "cloud" ? "Облако Brai" : PROVIDERS.find((item) => item.id === settings.transcriptionProviderId)?.label}</FieldTitle>
              <FieldDescription>
                {settings.transcriptionMode === "cloud"
                  ? "Аудио расшифровывается на серверах Brai."
                  : settings.transcriptionConfigured
                    ? `Модель: ${settings.transcriptionModel}`
                    : "Подключение не завершено. Проверьте ключ и выберите модель."}
              </FieldDescription>
            </FieldContent>
            <Button className="w-full sm:w-auto" type="button" variant="outline" onClick={() => onProvider("speech")}>Настроить</Button>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Постобработка</CardTitle>
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
                    <FieldTitle>Поставщик</FieldTitle>
                    <FieldDescription>{settings.providerConfigured ? "Поставщик подключён." : "Нужно выбрать облако Brai или подключить ключ поставщика."}</FieldDescription>
                  </FieldContent>
                  <Button className="w-full justify-start sm:w-auto sm:justify-center" type="button" variant="outline" onClick={() => onProvider("text")}>
                    {settings.providerConfigured ? <Check className="text-emerald-600 dark:text-emerald-300" /> : <X className="text-destructive" />}
                    Настроить
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
          <CardTitle>Статистика Транскриптов</CardTitle>
        </CardHeader>
        <CardContent>
          <StatsGrid snapshot={snapshot} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Аудиозаписи</CardTitle>
          <CardDescription>По умолчанию на телефоне сохраняются только аудиозаписи, которые ещё не удалось обработать. Вы можете их скачать или удалить.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full sm:w-fit" type="button" variant="outline" onClick={onAudio}>Аудиозаписи</Button>
        </CardContent>
      </Card>
    </>
  );
}

function ProviderPage({ capability, snapshot, onBack, onSnapshot }: { capability: BraiCmdProviderCapability; snapshot: BraiCmdSnapshot; onBack: () => void; onSnapshot: (snapshot: BraiCmdSnapshot) => void }) {
  const speech = capability === "speech";
  const accountCredentialsActive = snapshot.accountCredentialsActive === true;
  const availableProviders = speech ? SPEECH_PROVIDERS : PROVIDERS;
  const accountProviderIds = new Set(snapshot.settings.providerProfiles
    .filter((profile) => profile.configured)
    .map((profile) => profile.providerId));
  const providers = accountCredentialsActive
    ? availableProviders.filter((provider) => accountProviderIds.has(provider.id))
    : availableProviders;
  const storedProviderId = speech ? snapshot.settings.transcriptionProviderId : snapshot.settings.providerId;
  const [mode, setMode] = useState<BraiCmdProviderMode>(speech ? snapshot.settings.transcriptionMode : snapshot.settings.providerMode);
  const [providerId, setProviderId] = useState<BraiCmdProviderId>(() =>
    providers.some((provider) => provider.id === storedProviderId) ? storedProviderId : providers[0]?.id ?? storedProviderId);
  const [baseUrl, setBaseUrl] = useState(snapshot.settings.providerBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(speech ? snapshot.settings.transcriptionModel : snapshot.settings.providerModel);
  const [models, setModels] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<BraiCmdProviderConnectResult | null>(null);
  const providerRequestRef = useRef(0);
  const hasProfile = snapshot.settings.providerProfiles.some((profile) => profile.providerId === providerId && profile.configured);

  async function saveCloud() {
    const next = await updateBraiCmdSettings(speech ? { transcriptionMode: "cloud" } : { providerMode: "cloud" });
    if (next) onSnapshot(next);
  }

  function chooseMode(value: string) {
    providerRequestRef.current += 1;
    const nextMode = value as BraiCmdProviderMode;
    setMode(nextMode);
    setResult(null);
    setVerified(false);
    if (nextMode === "cloud") void saveCloud();
  }

  async function probeProvider() {
    const requestId = ++providerRequestRef.current;
    setTesting(true);
    try {
      const tested = await probeBraiCmdProvider({ providerId, apiKey, baseUrl, capability });
      if (requestId !== providerRequestRef.current) return;
      setResult(tested);
      if (tested?.ok) {
        const nextModels = tested.models ?? [];
        setModels(nextModels);
        setModel("");
        setManualModel(Boolean(tested.manualModel));
        setVerified(true);
      }
    } finally {
      if (requestId === providerRequestRef.current) setTesting(false);
    }
  }

  async function connectProvider() {
    const requestId = ++providerRequestRef.current;
    setTesting(true);
    try {
      const connected = await connectBraiCmdProvider({ providerId, apiKey, model, baseUrl, capability });
      if (requestId !== providerRequestRef.current) return;
      setResult(connected);
      if (connected?.ok && connected.state) onSnapshot(connected.state);
    } finally {
      if (requestId === providerRequestRef.current) setTesting(false);
    }
  }

  async function disconnectProvider() {
    if (!window.confirm("Отключить поставщика? Использующие его функции переключатся на облако Brai.")) return;
    providerRequestRef.current += 1;
    setTesting(false);
    const next = await disconnectBraiCmdProvider(providerId);
    if (next) {
      onSnapshot(next);
      setMode("cloud");
      setVerified(false);
      setResult(null);
    }
  }

  return (
    <>
      <PageBack title={speech ? "Распознавание речи" : "Поставщик постобработки"} onBack={onBack} />
      <Card>
        <CardHeader>
          <CardTitle>Режим</CardTitle>
        </CardHeader>
        <CardContent>
          <ChoiceRadioGroup value={mode} onValueChange={chooseMode}>
            <ChoiceRadio id="brai-cmd-provider-cloud" text={speech ? "Распознавание на серверах Brai." : "Постобработка на серверах Brai."} title="Облако Brai" value="cloud" />
            <ChoiceRadio
              id="brai-cmd-provider-key"
              text={accountCredentialsActive ? "Ключ аккаунта и локально выбранная модель." : "Ваш ключ и выбранная модель."}
              title={accountCredentialsActive ? "Ключ аккаунта" : "Свой API-ключ"}
              value="key"
            />
          </ChoiceRadioGroup>
        </CardContent>
      </Card>

      {mode === "cloud" ? (
        <Card>
          <CardHeader>
            <CardTitle>Облако Brai</CardTitle>
            <CardDescription>{speech ? "Распознавание речи происходит на серверах Brai." : "Постобработка происходит на серверах Brai."} Данные удаляются сразу после доставки на ваше устройство.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm text-muted-foreground">
            <p className="m-0">Сейчас бесплатное использование. В дальнейшем будет лимитировано + подписка.</p>
            {!speech ? <><p className="m-0">Используемая модель OpenAI gpt-oss-20b: 20 млрд параметров.</p><StatsGrid snapshot={snapshot} cloudOnly /></> : null}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{accountCredentialsActive ? "Ключ поставщика в аккаунте" : "Ключ поставщика"}</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup className="gap-4">
              {accountCredentialsActive ? (
                <p className="m-0 text-sm text-muted-foreground">
                  Ключи добавляются, заменяются и удаляются в Общих настройках → Модели. Здесь сохраняется только модель для этого устройства.
                </p>
              ) : null}
              {accountCredentialsActive && providers.length === 0 ? (
                <p className="m-0 text-sm text-destructive">Сначала подключите подходящий ключ в Общих настройках → Модели.</p>
              ) : null}
              <Field>
                <FieldLabel htmlFor="brai-cmd-provider-id">Поставщик</FieldLabel>
                <Select value={providerId} onValueChange={(value) => { providerRequestRef.current += 1; setTesting(false); setProviderId(value as BraiCmdProviderId); setVerified(false); setResult(null); setModel(""); }}>
                  <SelectTrigger id="brai-cmd-provider-id" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{providers.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              {!accountCredentialsActive && providerId === "custom-openai" ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-base-url">Base URL</FieldLabel>
                  <Input id="brai-cmd-provider-base-url" placeholder="https://example.com/v1" value={baseUrl} onChange={(event) => { providerRequestRef.current += 1; setTesting(false); setBaseUrl(event.target.value); setVerified(false); setResult(null); }} />
                </Field>
              ) : null}
              {!accountCredentialsActive ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-key">API ключ</FieldLabel>
                  <Input id="brai-cmd-provider-key" autoComplete="off" placeholder={hasProfile ? "Ключ сохранён; оставьте пустым, чтобы использовать его" : "API-ключ"} type="password" value={apiKey} onChange={(event) => { providerRequestRef.current += 1; setTesting(false); setApiKey(event.target.value); setVerified(false); setResult(null); }} />
                </Field>
              ) : null}
              {!verified ? (
                <Button className="w-full sm:w-fit" disabled={testing || providers.length === 0} type="button" onClick={() => void probeProvider()}>
                  {testing ? "Проверка" : "Проверить подключение"}
                </Button>
              ) : models.length > 0 ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-model-select">Модель</FieldLabel>
                  <Select value={model} onValueChange={(value) => { providerRequestRef.current += 1; setTesting(false); setModel(value); setResult(null); }}>
                    <SelectTrigger id="brai-cmd-provider-model-select" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{models.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
              ) : manualModel ? (
                <Field>
                  <FieldLabel htmlFor="brai-cmd-provider-model">Модель</FieldLabel>
                  <Input id="brai-cmd-provider-model" placeholder="Введите идентификатор модели" value={model} onChange={(event) => { providerRequestRef.current += 1; setTesting(false); setModel(event.target.value); setResult(null); }} />
                </Field>
              ) : null}
              {verified ? <Button className="w-full sm:w-fit" disabled={testing || model.trim().length === 0} type="button" onClick={() => void connectProvider()}>{testing ? "Проверка модели" : "Подключить"}</Button> : null}
              {!accountCredentialsActive && hasProfile ? <Button className="w-full sm:w-fit" type="button" variant="destructive" onClick={() => void disconnectProvider()}>Отключить поставщика</Button> : null}
              {result ? <ProviderResultAlert result={result} successTitle={result.state ? "Подключено" : "Проверка пройдена"} /> : null}
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

  function changeRetention(value: string) {
    const enabled = value === "processed";
    if (!enabled && settings.processedAudioRetentionEnabled && !window.confirm("Удалить все обработанные аудиозаписи? Записи в очереди останутся.")) return;
    onPatch({ processedAudioRetentionEnabled: enabled });
  }

  return (
    <>
      <PageBack title="Аудиозаписи" onBack={onBack} />
      <Card>
        <CardHeader>
          <CardTitle>Настройки</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="gap-4">
            <ChoiceRadioGroup value={settings.processedAudioRetentionEnabled ? "processed" : "queue"} onValueChange={changeRetention}>
              <ChoiceRadio id="brai-cmd-audio-queue" text="Обработанные записи удаляются. Очередь хранится без лимита." title="Только очередь" value="queue" />
              <ChoiceRadio id="brai-cmd-audio-processed" text="Сохранять обработанные записи." title="Хранить больше аудиозаписей" value="processed" />
            </ChoiceRadioGroup>
            {settings.processedAudioRetentionEnabled ? (
              <Field orientation="responsive">
                <FieldContent>
                  <FieldLabel htmlFor="brai-cmd-audio-limit">Сколько аудиозаписей хранить?</FieldLabel>
                  <FieldDescription>Лишние обработанные записи удаляются сразу. Очередь не затрагивается.</FieldDescription>
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
          <CardTitle>Файлы</CardTitle>
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
    <RadioGroup className="grid gap-2 sm:grid-cols-2" value={value} onValueChange={onValueChange}>
      {children}
    </RadioGroup>
  );
}

function ChoiceRadio({ id, text, title, value }: { id: string; text: string; title: string; value: string }) {
  return (
    <FieldLabel className="w-full cursor-pointer" htmlFor={id}>
      <Field className="rounded-md border p-3" orientation="horizontal">
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
      {connection.stages ? (
        <AlertDescription>
          {connection.stages.server ? <span className="block">Сервер: {stageLabel(connection.stages.server.status)}</span> : null}
          {connection.stages.access ? <span className="block">Доступ устройства: {stageLabel(connection.stages.access.status)}</span> : null}
          {connection.stages.contextDelivery ? <span className="block">Доставка контекста: {stageLabel(connection.stages.contextDelivery.status)}</span> : null}
          {connection.stages.cloudTranscription ? <span className="block">Облачная расшифровка: {stageLabel(connection.stages.cloudTranscription.status)}</span> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

function stageLabel(status: "ok" | "error" | "skipped") {
  return status === "ok" ? "работает" : status === "skipped" ? "не используется" : "ошибка";
}

function ProviderResultAlert({ result, successTitle = "Подключено" }: { result: BraiCmdProviderTestResult; successTitle?: string }) {
  return (
    <Alert variant={result.ok ? "success" : "destructive"}>
      {result.ok ? <CheckCircle2 /> : <XCircle />}
      <AlertTitle>{result.ok ? successTitle : "Не удалось подключить"}</AlertTitle>
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
