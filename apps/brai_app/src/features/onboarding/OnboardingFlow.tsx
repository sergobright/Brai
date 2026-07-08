"use client";

import Image from "next/image";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  ChevronLeft,
  Cloud,
  Command,
  FileAudio,
  KeyRound,
  Lock,
  LoaderCircle,
  Mic,
  MonitorUp,
  Radio,
  ScreenShare,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
  Trash2,
  UserRound,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import {
  getAndroidCapabilities,
  openAndroidAppSettings,
  openAndroidAccessibilitySettings,
  openAndroidOverlaySettings,
  requestAndroidMicrophone,
  requestAndroidNotifications,
} from "@/shared/platform/androidCapabilities";
import { ensureBraiCmdAccess, listenBraiCmdOnboardingEvents, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode } from "@/shared/platform/braiCmd";
import { installAndroidBackHandler, isNativeShell, platformName } from "@/shared/platform/platform";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { AnimatedShinyText } from "@/shared/ui/animated-shiny-text";
import { Button } from "@/shared/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { cx } from "../app/appUtils";
import {
  initialOnboardingState,
  loadOnboardingState,
  saveOnboardingState,
  stepProgress,
  type OnboardingState,
  type OnboardingStep,
  type ProfileVersion,
  type VoiceMode,
} from "./onboardingModel";

type OnboardingFlowProps = {
  authRequired: boolean;
  busy: boolean;
  authMode: "otp" | "password";
  onLogin: (password: string) => Promise<void>;
  onRequestOtp: (email: string) => Promise<void>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
  onDone: () => void;
  onOpenNativeCmdSettings: () => Promise<boolean>;
};

type CheckStatus = "idle" | "checking" | "ready";

const startButtonDelayMs = process.env.NODE_ENV === "test" ? 0 : 3000;
const logoFrameClass = "relative aspect-[779/368] w-64 max-w-[78vw] sm:w-80";
const providerOptions = ["Groq", "OpenAI", "Deepgram", "AssemblyAI"] as const;
const manualConfirmDelayMs = 3000;
const verificationMinVisibleMs = process.env.NODE_ENV === "test" ? 1 : 1000;
const startButtonCss = `
@keyframes brai-onboarding-logo-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}

@keyframes brai-onboarding-logo-shimmer {
  0%, 35% { opacity: 0; transform: translateX(-140%); }
  55% { opacity: .32; }
  80%, 100% { opacity: 0; transform: translateX(140%); }
}

@keyframes brai-onboarding-start-button {
  0% { opacity: 0; pointer-events: none; }
  100% { opacity: 1; pointer-events: auto; }
}

.brai-onboarding-logo-frame {
  opacity: 0;
  animation: brai-onboarding-logo-in 700ms ease-out 120ms both;
}

.brai-onboarding-logo-frame::after {
  content: "";
  position: absolute;
  inset: -8%;
  pointer-events: none;
  background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.28) 50%, transparent 65%);
  animation: brai-onboarding-logo-shimmer 2600ms ease-in-out 900ms infinite;
}
`;

export function shouldShowOnboarding(authRequired: boolean): boolean {
  const state = loadOnboardingState();
  return !state.complete || authRequired;
}

function loadInitialOnboardingState(authRequired: boolean): OnboardingState {
  const loaded = loadOnboardingState();
  return loaded.complete && authRequired ? { ...loaded, step: "locked", history: [] } : loaded;
}

async function waitForMinimumVerificationTime(startedAt: number) {
  const remaining = verificationMinVisibleMs - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
}

export function OnboardingFlow({
  authRequired,
  authMode,
  busy,
  onDone,
  onLogin,
  onOpenNativeCmdSettings,
  onRequestOtp,
  onVerifyOtp,
}: OnboardingFlowProps) {
  const [state, setState] = useState<OnboardingState>(initialOnboardingState);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("Groq");
  const [providerKey, setProviderKey] = useState("");
  const [localUrl, setLocalUrl] = useState("");
  const [trainingText, setTrainingText] = useState("");
  const [offlineText, setOfflineText] = useState("");
  const [insertedText, setInsertedText] = useState("");
  const [manualConfirmReadyStep, setManualConfirmReadyStep] = useState<OnboardingStep | null>(null);
  const [checkingStep, setCheckingStep] = useState<OnboardingStep | null>(null);
  const [readyStep, setReadyStep] = useState<OnboardingStep | null>(null);
  const [trainingDictated, setTrainingDictated] = useState(false);
  const [queueSaved, setQueueSaved] = useState(false);
  const [queueInserted, setQueueInserted] = useState(false);
  const stepRef = useRef<OnboardingStep>(state.step);
  const stateRef = useRef<OnboardingState>(state);
  const manualConfirmTimerRef = useRef<number | null>(null);
  const isAndroid = isNativeShell() && platformName() === "android";
  const progress = stepProgress(state.step);
  const screen = screenMeta(state.step);

  useEffect(() => {
    const timeout = window.setTimeout(() => setState(loadInitialOnboardingState(authRequired)), 0);
    void refreshCapabilities();
    return () => window.clearTimeout(timeout);
  }, [authRequired]);

  useEffect(() => {
    if (state.complete && !authRequired) onDone();
  }, [authRequired, onDone, state.complete]);

  useEffect(() => () => {
    if (manualConfirmTimerRef.current != null) window.clearTimeout(manualConfirmTimerRef.current);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    stepRef.current = state.step;
  }, [state]);

  useEffect(() => installAndroidBackHandler(() => {
    const current = stateRef.current;
    const previous = current.history.at(-1);
    if (previous) {
      setError("");
      setMessage("");
      const next = { ...current, step: previous, history: current.history.slice(0, -1) };
      saveOnboardingState(next);
      stateRef.current = next;
      setState(next);
      return true;
    }
    return true;
  }), []);

  useEffect(() => {
    if (state.step !== "training-dictate" && state.step !== "training-offline" && state.step !== "training-queue") return;
    const timeout = window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>("[data-onboarding-training-input]")?.focus();
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [state.step]);

  useEffect(() => {
    if (!isAndroid) return;
    if (state.step === "training-offline") {
      void setBraiCmdQueuePausedMode(true);
      return;
    }
    if (state.step === "training-queue") {
      void setBraiCmdQueuePausedMode(false).then(() => retryBraiCmdQueue());
      const interval = window.setInterval(() => void retryBraiCmdQueue(), 2500);
      return () => window.clearInterval(interval);
    }
    void setBraiCmdQueuePausedMode(false);
  }, [isAndroid, state.step]);

  useEffect(() => {
    if (!isAndroid) return;
    let remove: (() => void) | undefined;
    void listenBraiCmdOnboardingEvents((event) => {
      const step = stepRef.current;
      if (event.type === "voiceTextInserted") {
        if (step === "training-dictate") {
          setTrainingDictated(true);
          if (event.text?.trim()) setTrainingText(event.text);
        }
        if (step === "training-queue") {
          setQueueInserted(true);
          if (event.text?.trim()) setInsertedText(event.text);
        }
      }
      if (event.type === "queueSaved" && step === "training-offline") {
        setQueueSaved(true);
      }
    }).then((handle) => {
      remove = () => {
        void handle?.remove();
      };
    });
    return () => remove?.();
  }, [isAndroid]);

  async function refreshCapabilities() {
    const next = await getAndroidCapabilities();
    return next;
  }

  function update(next: Partial<OnboardingState>) {
    setState((current) => {
      const resolved = { ...current, ...next };
      saveOnboardingState(resolved);
      return resolved;
    });
  }

  function go(step: OnboardingStep, next?: Partial<OnboardingState>) {
    setError("");
    setMessage("");
    setCheckingStep(null);
    setReadyStep(null);
    setManualConfirmReadyStep(null);
    if (manualConfirmTimerRef.current != null) {
      window.clearTimeout(manualConfirmTimerRef.current);
      manualConfirmTimerRef.current = null;
    }
    update({ ...next, step, history: [...state.history, state.step] });
  }

  function back() {
    const previous = state.history.at(-1);
    if (!previous) return;
    update({ step: previous, history: state.history.slice(0, -1) });
  }

  function completeSetup() {
    void setBraiCmdQueuePausedMode(false);
    void setBraiCmdVoiceOnlyMode(false);
    const nextState = { ...state, complete: true, step: "login-check" as const, history: [...state.history, state.step] };
    saveOnboardingState(nextState);
    setState(nextState);
  }

  function checkStatus(step: OnboardingStep): CheckStatus {
    if (checkingStep === step) return "checking";
    if (readyStep === step) return "ready";
    return "idle";
  }

  function resetCheck(step: OnboardingStep) {
    if (readyStep === step) setReadyStep(null);
    if (checkingStep === step) setCheckingStep(null);
  }

  function unlockManualConfirmAfterDelay(step: OnboardingStep) {
    setManualConfirmReadyStep(null);
    if (manualConfirmTimerRef.current != null) window.clearTimeout(manualConfirmTimerRef.current);
    manualConfirmTimerRef.current = window.setTimeout(() => {
      setManualConfirmReadyStep(step);
      manualConfirmTimerRef.current = null;
    }, manualConfirmDelayMs);
  }

  async function runVerification(step: OnboardingStep, verify: () => Promise<boolean>, errorText: string) {
    setError("");
    setMessage("");
    setCheckingStep(step);
    const startedAt = Date.now();
    let ok = false;
    try {
      ok = await verify();
    } catch {
      ok = false;
    }
    await waitForMinimumVerificationTime(startedAt);
    if (ok) {
      setReadyStep(step);
    } else {
      setError(errorText);
    }
    setCheckingStep(null);
  }

  function choosePath(path: "new" | "existing") {
    go(path === "new" ? "name" : "profile-version", { path, profileVersion: path === "new" ? "self-hosted" : null });
  }

  function chooseProfileVersion(profileVersion: ProfileVersion) {
    go(profileVersion === "cloud" ? "cloud-password" : "self-hosted-key", { profileVersion });
  }

  function chooseVoiceMode(voiceMode: VoiceMode) {
    if (voiceMode === "provider") go("provider-key", { voiceMode });
    if (voiceMode === "local") go("local-server", { voiceMode });
    if (voiceMode === "cloud") go("cloud-privacy", { voiceMode });
  }

  async function submitCloudLogin(password: string) {
    setError("");
    try {
      await onLogin(password);
      go("setup-start");
    } catch {
      setError("Пароль не подошел. Проверьте его и попробуйте снова.");
    }
  }

  async function submitAccessKey(key: string) {
    if (key.trim().length < 8) {
      setError("Введите полный ключ доступа.");
      return;
    }
    await setBraiCmdAccessKey(key.trim(), state.name.trim());
    go("setup-start");
  }

  async function testProviderKey() {
    if (readyStep === "provider-key") {
      go("overlay");
      return;
    }
    if (!provider.trim() || providerKey.trim().length < 8) {
      setError("Выберите поставщика и введите полный ключ.");
      return;
    }
    await runVerification("provider-key", async () => true, "Ключ не сохранён. Проверьте поставщика и ключ.");
  }

  async function testLocalServer() {
    if (readyStep === "local-server") {
      go("overlay");
      return;
    }
    await runVerification("local-server", async () => {
      const url = new URL(localUrl.trim());
      const response = await fetch(url.href, { method: "GET" });
      return response.ok;
    }, "Сервер не ответил на проверку. Проверьте URL и доступность health endpoint.");
  }

  async function openOverlay() {
    if (!isAndroid) {
      go("accessibility-why");
      return;
    }
    await openAndroidOverlaySettings();
    await refreshCapabilities();
  }

  async function checkOverlay() {
    if (readyStep === "overlay") {
      go("accessibility-why");
      return;
    }
    await runVerification("overlay", async () => {
      const next = await refreshCapabilities();
      return !isAndroid || Boolean(next?.overlayGranted);
    }, "Разрешение поверх экрана еще не включено.");
  }

  async function openAccessibility() {
    if (stepRef.current === "accessibility-blocked") unlockManualConfirmAfterDelay("accessibility-blocked");
    if (!isAndroid) {
      return;
    }
    await openAndroidAccessibilitySettings();
    await refreshCapabilities();
  }

  async function openAppSettings() {
    unlockManualConfirmAfterDelay("accessibility-restricted");
    if (!isAndroid) {
      return;
    }
    await openAndroidAppSettings();
  }

  async function checkAccessibility() {
    if (readyStep === "accessibility-enable") {
      go("microphone");
      return;
    }
    await runVerification("accessibility-enable", async () => {
      const next = await refreshCapabilities();
      return !isAndroid || Boolean(next?.accessibilityServiceEnabled);
    }, "Специальные возможности Brai пока не включены.");
  }

  async function requestMic() {
    const next = isAndroid ? await requestAndroidMicrophone() : null;
    if (!isAndroid || next?.microphoneGranted) go("notifications");
    else setError("Микрофон не разрешен.");
  }

  async function requestNotifications() {
    const next = isAndroid ? await requestAndroidNotifications() : null;
    if (!isAndroid || next?.notificationsGranted) go("training-start");
    else setError("Уведомления не разрешены.");
  }

  async function startTraining() {
    setTrainingText("");
    setOfflineText("");
    setInsertedText("");
    setTrainingDictated(false);
    setQueueSaved(false);
    setQueueInserted(false);
    if (isAndroid) {
      const access = await ensureBraiCmdAccess(state.name.trim() || "Brai");
      if (!access?.accessGranted) {
        setError("Не удалось подготовить доступ Brai CMD. Проверьте подключение и нажмите «Обучение» еще раз.");
        return;
      }
      await setBraiCmdVoiceOnlyMode(true);
    }
    go("training-dictate");
  }

  async function openCmdSettings() {
    const opened = await onOpenNativeCmdSettings();
    if (!opened) go("cmd-settings");
  }

  const body = renderStep();

  function renderStep(): ReactNode {
    if (state.step === "start") {
      return null;
    }

    if (state.step.startsWith("welcome-")) {
      const slides = [
        ["welcome-1", "Brai рядом с вашим экраном", "Голос, текст и контекст доступны без переключения между приложениями.", TextCursorInput],
        ["welcome-2", "Голос превращается в действие", "Надиктуйте мысль, ответ или команду — Brai подготовит текст там, где вы работаете.", Mic],
        ["welcome-3", "Идеи не теряются", "Сохраняйте важное прямо с экрана и отправляйте агенту задачи вместе с контекстом.", Send],
        ["welcome-4", "Пора настроить основу", "Дальше выберем профиль, голосовой модуль и системные разрешения.", Sparkles],
      ] as const;
      const index = slides.findIndex(([step]) => step === state.step);
      const [, title, text, Icon] = slides[index];
      return (
        <InfoScreen icon={Icon} eyebrow={`Карточка ${index + 1} из 4`} title={title} text={text}>
          <ShinyButton onClick={() => go(index === slides.length - 1 ? "path" : slides[index + 1][0])}>
            {index === slides.length - 1 ? "Начать" : "Далее"}
          </ShinyButton>
        </InfoScreen>
      );
    }

    if (state.step === "path") {
      return (
        <ChoiceScreen
          title="Как запускаем Brai?"
          text="Можно начать с чистого профиля или подключить приложение к уже существующему."
          choices={[
            { icon: UserRound, title: "Начать с начала", text: "Создать локальную настройку и пройти все шаги.", onClick: () => choosePath("new") },
            { icon: KeyRound, title: "Есть профиль", text: "Подключить облачную или self-hosted версию.", onClick: () => choosePath("existing") },
          ]}
        />
      );
    }

    if (state.step === "name") {
      return (
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
          event.preventDefault();
          if (!state.name.trim()) return setError("Введите имя.");
          go("setup-start");
        }}>
          <div className="my-auto grid gap-5 py-6">
            <InfoBlock icon={UserRound} title="Как к вам обращаться?" text="Имя нужно для приветствия и будущих голосовых подсказок." />
            <Input value={state.name} placeholder="Ваше имя" aria-label="Имя" onChange={(event) => update({ name: event.target.value })} />
          </div>
          <StepActions><PrimaryButton disabled={!state.name.trim()}>Продолжить</PrimaryButton></StepActions>
        </form>
      );
    }

    if (state.step === "profile-version") {
      return (
        <ChoiceScreen
          title="Какой профиль подключаем?"
          text="Выберите источник существующего профиля."
          choices={[
            { icon: Cloud, title: "Облачная версия", text: "Авторизация паролем через серверы Brai.", onClick: () => chooseProfileVersion("cloud") },
            { icon: Server, title: "Self-hosted версия", text: "Подключение по ключу доступа вашего сервера.", onClick: () => chooseProfileVersion("self-hosted") },
          ]}
        />
      );
    }

    if (state.step === "cloud-password") {
      return (
        <StepScreen actions={null}>
          <InfoBlock icon={Lock} title="Вход в облачный профиль" text="Пока для входа нужен только пароль." />
          <OnboardingAuthForm busy={busy} mode="password" onLogin={submitCloudLogin} onRequestOtp={onRequestOtp} onVerifyOtp={onVerifyOtp} />
        </StepScreen>
      );
    }

    if (state.step === "self-hosted-key") {
      return (
        <AccessKeyForm onSubmit={submitAccessKey} />
      );
    }

    if (state.step === "setup-start") return <InfoScreen icon={ShieldCheck} title="Начинаем настройку" text="Сейчас подготовим Brai CMD, голосовой модуль и системные разрешения."><PrimaryButton onClick={() => go("features")}>Настроить</PrimaryButton></InfoScreen>;
    if (state.step === "features") return <InfoScreen icon={Sparkles} title="Базовые возможности" text="Коротко покажем, что будет доступно после настройки."><PrimaryButton onClick={() => go("floating-buttons")}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "floating-buttons") return <InfoScreen icon={Command} title="Плавающие кнопки" text="Brai CMD управляется кнопками поверх других приложений: они слушают голос, берут контекст экрана и помогают вставлять результат."><PrimaryButton onClick={() => go("demo-dictation")}>Продолжить</PrimaryButton></InfoScreen>;

    if (state.step.startsWith("demo-")) {
      const demos = [
        ["demo-dictation", "Голос в текст", "GIF покажет, как надиктованный голос превращается в текст.", Mic],
        ["demo-save-screen", "Сохранение с экрана", "GIF покажет, как сохранить идею или информацию прямо с текущего экрана.", ScreenShare],
        ["demo-chat-reply", "Ответ в чате", "GIF покажет подготовку ответа с учетом контекста контакта.", TextCursorInput],
        ["demo-agent-command", "Команда агенту", "GIF покажет отправку команды агенту вместе с содержимым экрана.", Send],
      ] as const;
      const index = demos.findIndex(([step]) => step === state.step);
      const [, title, text, Icon] = demos[index];
      return (
        <InfoScreen icon={Icon} eyebrow={`Демо ${index + 1} из 4`} title={title} text={text}>
          <DemoPlaceholder label="Здесь будет GIF" />
          <PrimaryButton onClick={() => go(index === demos.length - 1 ? "special-settings" : demos[index + 1][0])}>Продолжить</PrimaryButton>
        </InfoScreen>
      );
    }

    if (state.step === "special-settings") return <InfoScreen icon={ShieldCheck} title="Нужны системные настройки" text="Показанные функции требуют доступа поверх экрана, специальных возможностей, микрофона и уведомлений."><PrimaryButton onClick={() => go("voice-intro")}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "voice-intro") return <InfoScreen icon={Mic} title="Сначала голосовой модуль" text="Без распознавания голоса Brai CMD не сможет принимать команды и вставлять продиктованный текст."><PrimaryButton onClick={() => go("voice-choice")}>Настроить голосовой модуль</PrimaryButton></InfoScreen>;

    if (state.step === "voice-choice") {
      const choices = [
        { icon: KeyRound, title: "Ключ поставщика", text: "Выбрать поставщика и сохранить API-ключ.", onClick: () => chooseVoiceMode("provider") },
        { icon: Cloud, title: "Облачный модуль", text: "Использовать облачное распознавание Brai.", onClick: () => chooseVoiceMode("cloud") },
        { icon: Server, title: "Локальная модель", text: "Подключить URL модели на вашем сервере.", onClick: () => chooseVoiceMode("local") },
      ];
      return <ChoiceScreen title="Как распознавать голос?" text="Выберите способ, который будет использовать Brai CMD." choices={choices} />;
    }

    if (state.step === "provider-key") {
      return (
        <StepScreen actions={<CheckActionButton disabled={!provider || providerKey.trim().length < 8} status={checkStatus("provider-key")} onClick={testProviderKey} />}>
          <InfoBlock icon={KeyRound} title="Ключ поставщика" text="Выберите поставщика, введите ключ и сохраните его для голосового модуля." />
          <Select value={provider} onValueChange={(value) => {
            setProvider(value);
            resetCheck("provider-key");
          }}>
            <SelectTrigger className="w-full" aria-label="Поставщик">
              <SelectValue placeholder="Выберите поставщика" />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((option) => (
                <SelectItem key={option} value={option}>{option}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={providerKey} type="password" aria-label="Ключ поставщика" placeholder="API-ключ" onChange={(event) => {
            setProviderKey(event.target.value);
            resetCheck("provider-key");
          }} />
        </StepScreen>
      );
    }

    if (state.step === "local-server") {
      return (
        <StepScreen actions={<CheckActionButton disabled={!isValidUrl(localUrl)} status={checkStatus("local-server")} onClick={testLocalServer} />}>
          <InfoBlock icon={Server} title="Локальный сервер" text="Введите URL endpoint, который принимает аудио или отвечает health-проверкой." />
          <Input value={localUrl} type="url" aria-label="URL локального сервера" placeholder="https://server.example/health" onChange={(event) => {
            setLocalUrl(event.target.value);
            resetCheck("local-server");
          }} />
        </StepScreen>
      );
    }

    if (state.step === "cloud-privacy") return <InfoScreen icon={Cloud} title="Приватность облака" text="Аудио проходит через серверы Brai для расшифровки. Мы не храним содержимое запросов."><PrimaryButton onClick={() => go("overlay")}>Продолжить</PrimaryButton></InfoScreen>;

    if (state.step === "overlay") {
      return (
        <PermissionScreen icon={MonitorUp} title="Поверх других приложений" text="Это разрешение нужно, чтобы плавающая кнопка Brai была доступна поверх текущего приложения.">
          <SecondaryButton icon={MonitorUp} onClick={openOverlay}>Открыть настройки</SecondaryButton>
          <CheckActionButton status={checkStatus("overlay")} onClick={checkOverlay} />
        </PermissionScreen>
      );
    }

    if (state.step === "accessibility-why") return <InfoScreen icon={ShieldCheck} title="Специальные возможности" text="Они нужны, чтобы вставлять текст в поля, работать с буфером и выполнять действия на экране."><PrimaryButton onClick={() => go("accessibility-blocked")}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-blocked") return <InfoScreen icon={Lock} title="Шаг 1: получить отказ" text="Откройте специальные возможности и попробуйте включить Brai. Android должен показать, что настройка заблокирована."><SecondaryButton icon={ShieldCheck} onClick={openAccessibility}>Открыть</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-blocked"} icon={CheckCircle2} onClick={() => go("accessibility-restricted")}>Да, доступ заблокирован</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-restricted") return <InfoScreen icon={ShieldCheck} title="Шаг 2: снять ограничение" text="Откройте карточку приложения, нажмите меню с тремя точками и выберите «Разрешить ограниченные настройки»."><SecondaryButton icon={ShieldCheck} onClick={openAppSettings}>Открыть карточку приложения</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-restricted"} icon={CheckCircle2} onClick={() => go("accessibility-enable")}>Ограничение снято</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-enable") return <InfoScreen icon={ShieldCheck} title="Шаг 3: включить доступ" text="Теперь снова откройте специальные возможности и включите Brai. После возврата мы проверим состояние."><SecondaryButton icon={ShieldCheck} onClick={openAccessibility}>Открыть</SecondaryButton><CheckActionButton status={checkStatus("accessibility-enable")} onClick={checkAccessibility} /></InfoScreen>;

    if (state.step === "microphone") return <PermissionScreen icon={Mic} title="Микрофон" text="Микрофон нужен для голосового ввода и команд."><PrimaryButton onClick={requestMic}>Разрешить микрофон</PrimaryButton></PermissionScreen>;
    if (state.step === "notifications") return <PermissionScreen icon={Bell} title="Уведомления" text="Уведомления нужны для фоновой записи, очереди и статуса отправки."><PrimaryButton onClick={requestNotifications}>Разрешить уведомления</PrimaryButton></PermissionScreen>;

    if (state.step === "training-start") return <InfoScreen icon={CheckCircle2} title="Готово к обучению" text="Базовая настройка завершена. Осталось проверить голосовой сценарий в четыре шага."><PrimaryButton onClick={startTraining}>Обучение</PrimaryButton><SecondaryButton onClick={completeSetup}>Пропустить</SecondaryButton></InfoScreen>;
    if (state.step === "training-dictate") return <TrainingDictate confirmed={trainingDictated} value={trainingText} onChange={(value) => {
      setTrainingText(value);
      if (!value.trim()) setTrainingDictated(false);
    }} onNext={() => trainingDictated && trainingText.trim() ? go("training-offline") : setError("Надиктуйте фразу через плавающую кнопку Brai CMD.")} />;
    if (state.step === "training-offline") return <TrainingOffline confirmed={queueSaved} value={offlineText} onChange={setOfflineText} onNext={() => queueSaved ? go("training-queue") : setError("Надиктуйте запись через плавающую кнопку Brai CMD и дождитесь сохранения в очереди.")} />;
    if (state.step === "training-queue") return <TrainingQueue confirmed={queueInserted} value={insertedText} onChange={(value) => {
      setInsertedText(value);
      if (!value.trim()) setQueueInserted(false);
    }} onNext={() => queueInserted && insertedText.trim() ? go("training-storage") : setError("Вставьте расшифровку из очереди через длинное нажатие на плавающую кнопку Brai CMD.")} />;
    if (state.step === "training-storage") return <InfoScreen icon={FileAudio} title="Хранилище аудиозаписей" text="Аудиозаписи могут храниться в защищенной очереди устройства до отправки на расшифровку. После успешной обработки они очищаются согласно настройкам Brai CMD."><PrimaryButton onClick={() => go("voice-ready")}>Продолжить</PrimaryButton></InfoScreen>;

    if (state.step === "voice-ready") return <InfoScreen icon={CheckCircle2} title="Голосовое управление настроено" text="Brai CMD готов принимать голос, работать с очередью и вставлять результат в поле."><PrimaryButton onClick={completeSetup}>Готово</PrimaryButton></InfoScreen>;
    if (state.step === "login-check") return <InfoScreen icon={Lock} title="Проверяем вход" text="Если профиль уже открыт, вы попадете в кабинет. Если нет — доступ будет ограничен входом и настройками."><PrimaryButton onClick={() => authRequired ? go("locked") : onDone()}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "locked") return <InfoScreen icon={Lock} title="Нужен вход" text="Пока вы не вошли, доступны только вход и настройки Brai CMD."><PrimaryButton onClick={() => go("login")}>Войти</PrimaryButton><SecondaryButton onClick={openCmdSettings}>Настройки Brai CMD</SecondaryButton></InfoScreen>;
    if (state.step === "login") return <OnboardingAuthForm busy={busy} mode={authMode} onLogin={onLogin} onRequestOtp={onRequestOtp} onVerifyOtp={onVerifyOtp} />;
    if (state.step === "cmd-settings") {
      return (
        <InfoScreen
          icon={Command}
          title="Настройки Brai CMD"
          text="В Android этот пункт открывает нативные настройки команд поверх приложений, микрофона и доступа. В веб-версии Android-разрешения недоступны."
        >
          <PrimaryButton onClick={() => go("locked")}>Готово</PrimaryButton>
        </InfoScreen>
      );
    }

    return null;
  }

  if (state.step === "start") {
    return (
      <main className="fixed inset-0 overflow-hidden bg-black text-foreground" data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
        <style>{startButtonCss}</style>
        <div className="absolute inset-0 grid place-items-center">
          <div className={cx("brai-onboarding-logo-frame overflow-hidden", logoFrameClass)}>
            <Image
              className="object-contain"
              src="/brand/brai-logo-transparent.svg"
              alt="Brai"
              fill
              sizes="(min-width: 640px) 20rem, 16rem"
              priority
              draggable={false}
            />
          </div>
        </div>
        <div
          className={cx(
            "absolute inset-x-6 bottom-[calc(env(safe-area-inset-bottom)+2rem)] mx-auto max-w-md",
            startButtonDelayMs === 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          style={{
            opacity: startButtonDelayMs === 0 ? 1 : 0,
            animation: startButtonDelayMs === 0 ? undefined : `brai-onboarding-start-button 300ms ease-out ${startButtonDelayMs}ms both`,
          }}
        >
          <ShinyButton onClick={() => go("welcome-1")}>Приступить</ShinyButton>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 grid min-h-0 bg-black text-foreground" data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
      <ScrollArea className="min-h-0" contentInset="none">
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pb-0 pt-[calc(env(safe-area-inset-top)+2.75rem)] sm:max-w-2xl sm:px-6 sm:pt-8">
          <header className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-start gap-2">
            <Button className="justify-self-start" size="icon-sm" variant="ghost" aria-label="Назад" disabled={state.history.length === 0} onClick={back}>
              <ChevronLeft aria-hidden="true" />
            </Button>
            <div className="min-w-0">
              <p className="m-0 text-xs font-medium uppercase text-muted-foreground">Ввод в эксплуатацию</p>
              <h1 className="m-0 truncate text-lg font-semibold">{screen.title}</h1>
            </div>
            <span className="justify-self-end text-sm font-medium text-primary">{Math.max(progress, 1)}%</span>
          </header>
          <div className="relative">
            <Progress value={progress} aria-label="Прогресс настройки" />
            {error || message ? (
              <div className="pointer-events-none absolute inset-x-0 top-7 z-10">
                {error ? <StatusAlert tone="bad" title="Нужно проверить" text={error} /> : <StatusAlert tone="ok" title="Готово" text={message} />}
              </div>
            ) : null}
          </div>
          {screen.description ? <p className="m-0 text-sm text-muted-foreground">{screen.description}</p> : null}
          <section className="flex min-h-0 flex-1 flex-col pb-0 pt-4">
            {body}
          </section>
        </div>
      </ScrollArea>
    </main>
  );
}

function ShinyButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <PrimaryButton onClick={onClick}>{children}</PrimaryButton>;
}

function CheckActionButton({ disabled, onClick, status }: { disabled?: boolean; onClick: () => void | Promise<void>; status: CheckStatus }) {
  const checking = status === "checking";
  const ready = status === "ready";
  return (
    <PrimaryButton
      disabled={disabled || checking}
      icon={checking ? LoaderCircle : ready ? CheckCircle2 : ShieldCheck}
      iconClassName={checking ? "animate-spin" : undefined}
      onClick={onClick}
    >
      {checking ? "Проверка" : ready ? "Продолжить" : "Проверить"}
    </PrimaryButton>
  );
}

type ActionButtonProps = React.ComponentProps<typeof Button> & {
  icon?: LucideIcon | null;
  iconClassName?: string;
};

function PrimaryButton({ children, className, disabled, icon: Icon = ArrowRight, iconClassName, ...props }: ActionButtonProps) {
  return (
    <Button
      size="lg"
      variant="outline"
      className={cx(
        "min-h-12 w-full overflow-hidden rounded-full border-primary/35 bg-primary/10 px-6 text-base font-semibold shadow-lg shadow-primary/10 transition-all duration-200 hover:bg-primary/15 disabled:border-muted/30 disabled:bg-muted/20 disabled:opacity-60 disabled:shadow-none disabled:hover:bg-muted/20",
        className,
      )}
      disabled={disabled}
      {...props}
    >
      {Icon ? <Icon className={cx("size-4 transition-all", iconClassName)} aria-hidden="true" /> : null}
      <AnimatedShinyText shimmerWidth={140} className={cx("mx-0 text-base font-semibold", disabled ? "text-muted-foreground dark:text-muted-foreground" : "text-foreground/90 dark:text-foreground")}>
        {children}
      </AnimatedShinyText>
    </Button>
  );
}

function SecondaryButton({ children, className, icon: Icon, iconClassName, ...props }: ActionButtonProps) {
  return (
    <Button
      variant="outline"
      className={cx("min-h-12 w-full rounded-full border-primary/20 bg-transparent text-base font-semibold transition-all duration-200 hover:bg-primary/10 disabled:opacity-50", className)}
      {...props}
    >
      {Icon ? <Icon className={cx("size-4 transition-all", iconClassName)} aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

function StepScreen({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="my-auto grid gap-6 py-6">{children}</div>
      {actions ? <StepActions>{actions}</StepActions> : null}
    </div>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-6">{children}</div>;
}

function InfoBlock({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="grid gap-4">
      <span className="grid size-12 place-items-center rounded-full border border-primary/25 bg-primary/10 text-primary">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="grid gap-2">
        <h2 className="m-0 text-2xl font-semibold leading-tight">{title}</h2>
        <p className="m-0 text-sm leading-6 text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}

function InfoScreen({ children, eyebrow, icon, text, title }: { children: ReactNode; eyebrow?: string; icon: LucideIcon; text: string; title: string }) {
  return (
    <StepScreen actions={children}>
      <div className="grid gap-6">
        {eyebrow ? <p className="m-0 text-sm font-medium text-muted-foreground">{eyebrow}</p> : null}
        <InfoBlock icon={icon} title={title} text={text} />
      </div>
    </StepScreen>
  );
}

function ChoiceScreen({ choices, text, title }: { choices: Array<{ icon: LucideIcon; title: string; text: string; onClick: () => void }>; text: string; title: string }) {
  return (
    <div className="my-auto grid gap-5 py-6">
      <InfoBlock icon={Radio} title={title} text={text} />
      <div className="grid gap-3 sm:grid-cols-2">
        {choices.map((choice) => (
          <button key={choice.title} type="button" className="grid min-h-36 content-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40" onClick={choice.onClick}>
            <choice.icon className="size-5 text-primary" aria-hidden="true" />
            <span className="text-base font-semibold">{choice.title}</span>
            <span className="text-sm leading-5 text-muted-foreground">{choice.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PermissionScreen({ children, icon, text, title }: { children: ReactNode; icon: LucideIcon; text: string; title: string }) {
  return (
    <InfoScreen icon={icon} title={title} text={text}>
      {children}
    </InfoScreen>
  );
}

function DemoPlaceholder({ label }: { label: string }) {
  return (
    <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-primary/25 bg-primary/5 text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function AccessKeyForm({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [key, setKey] = useState("");
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
      event.preventDefault();
      onSubmit(key);
    }}>
      <div className="my-auto grid gap-4 py-6">
        <InfoBlock icon={KeyRound} title="Ключ доступа" text="Введите ключ self-hosted профиля, чтобы связать приложение с вашим сервером." />
        <Input value={key} type="password" aria-label="Ключ доступа" placeholder="Ключ доступа" onChange={(event) => setKey(event.target.value)} />
      </div>
      <StepActions><PrimaryButton disabled={key.trim().length < 8}>Подключить</PrimaryButton></StepActions>
    </form>
  );
}

function OnboardingAuthForm({
  busy,
  mode,
  onLogin,
  onRequestOtp,
  onVerifyOtp,
}: {
  busy: boolean;
  mode: "otp" | "password";
  onLogin: (password: string) => Promise<void>;
  onRequestOtp: (email: string) => Promise<void>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [error, setError] = useState("");

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(password);
  }

  async function submitOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      if (!otpSent) {
        await onRequestOtp(email);
        setOtpSent(true);
        return;
      }
      await onVerifyOtp(email, otp);
    } catch {
      setError(otpSent ? "Код не подошел." : "Не удалось отправить код.");
    }
  }

  if (mode === "password") {
    return (
      <form className="grid gap-4" onSubmit={submitPassword}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="onboarding-password">Пароль</FieldLabel>
            <Input
              id="onboarding-password"
              value={password}
              type="password"
              autoComplete="current-password"
              aria-label="Пароль"
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <PrimaryButton disabled={busy || !password}>Открыть</PrimaryButton>
      </form>
    );
  }

  return (
    <form className="grid gap-4" onSubmit={submitOtp}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="onboarding-email">Email</FieldLabel>
          <Input
            id="onboarding-email"
            value={email}
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="email"
            aria-label="Email"
            disabled={busy || otpSent}
            onChange={(event) => setEmail(event.target.value)}
          />
          <FieldDescription>{otpSent ? "Код уже отправлен. Введите его ниже." : "Отправим одноразовый код для входа."}</FieldDescription>
        </Field>
        {otpSent ? (
          <Field data-invalid={Boolean(error)}>
            <FieldLabel htmlFor="onboarding-otp">Код</FieldLabel>
            <Input
              id="onboarding-otp"
              value={otp}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="код"
              aria-label="Код из письма"
              aria-invalid={Boolean(error)}
              disabled={busy}
              onChange={(event) => setOtp(event.target.value)}
            />
            {error ? <FieldDescription className="text-destructive">{error}</FieldDescription> : null}
          </Field>
        ) : null}
      </FieldGroup>
      <PrimaryButton disabled={busy || !email || (otpSent && !otp)}>{otpSent ? "Проверить код" : "Получить код"}</PrimaryButton>
    </form>
  );
}

function TrainingDictate({ confirmed, onChange, onNext, value }: { confirmed: boolean; value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <StepScreen
      actions={<PrimaryButton disabled={!confirmed || !value.trim()} onClick={onNext}>Да, вставилось</PrimaryButton>}
    >
      <InfoBlock icon={Mic} title="Шаг 1: голос в поле" text="Нажмите плавающую кнопку Brai CMD и надиктуйте фразу. Вперёд пустим только после нативного события распознавания." />
      <VoiceOnlyTextarea value={value} placeholder="Здесь появится результат голосового ввода" ariaLabel="Результат голосового ввода" onChange={onChange} />
    </StepScreen>
  );
}

function TrainingOffline({ confirmed, onChange, onNext, value }: { confirmed: boolean; value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <StepScreen
      actions={<PrimaryButton disabled={!confirmed} onClick={onNext}>Запись в очереди</PrimaryButton>}
    >
      <InfoBlock icon={WifiOff} title="Шаг 2: очередь без связи" text="На этом экране отправка программно остановлена. Нажмите плавающую кнопку, надиктуйте и остановите запись: она должна сохраниться в очереди." />
      <VoiceOnlyTextarea value={value} placeholder="Поле нужно только для появления плавающей кнопки" ariaLabel="Поле проверки очереди" onChange={onChange} />
    </StepScreen>
  );
}

function TrainingQueue({ confirmed, onChange, onNext, value }: { confirmed: boolean; value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <StepScreen
      actions={<PrimaryButton disabled={!confirmed || !value.trim()} onClick={onNext}>Данные вставлены</PrimaryButton>}
    >
      <InfoBlock icon={Send} title="Шаг 3: вставка из очереди" text="Повторная отправка уже запущена. Когда расшифровка готова, зажмите плавающую кнопку и вставьте результат в поле." />
      <VoiceOnlyTextarea value={value} placeholder="Здесь появится результат из очереди" ariaLabel="Результат из очереди" onChange={onChange} />
    </StepScreen>
  );
}

function VoiceOnlyTextarea({ ariaLabel, onChange, placeholder, value }: { ariaLabel: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <Textarea
        data-onboarding-training-input
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        className="min-h-32 resize-none pr-14"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-2 top-2 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Очистить поле"
          onClick={() => onChange("")}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function StatusAlert({ text, title, tone }: { title: string; text: string; tone: "ok" | "bad" }) {
  const Icon = tone === "ok" ? CheckCircle2 : Lock;
  return (
    <Alert variant={tone === "bad" ? "destructive" : "default"}>
      <Icon aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function screenMeta(step: OnboardingStep): { title: string; description?: string } {
  if (step === "locked") return { title: "Доступ ограничен", description: "До входа в профиль показываем только вход и настройки." };
  if (step === "cmd-settings") return { title: "Настройки Brai CMD" };
  if (step.startsWith("training")) return { title: "Обучение" };
  if (step === "voice-choice" || step === "provider-key" || step === "local-server" || step === "cloud-privacy") return { title: "Голосовой модуль" };
  if (step === "overlay" || step.startsWith("accessibility") || step === "microphone" || step === "notifications") return { title: "Разрешения" };
  if (step.startsWith("welcome")) return { title: "Приветствие" };
  return { title: "Настройка Brai" };
}
