"use client";

import { Children, createContext, type FormEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  ChevronLeft,
  Cloud,
  Command,
  CircleX,
  ExternalLink,
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
import { ensureBraiCmdAccess, listenBraiCmdOnboardingEvents, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode, vibrateBraiCmdPress } from "@/shared/platform/braiCmd";
import { installAndroidBackHandler, isNativeShell, platformName } from "@/shared/platform/platform";
import { AnimatedShinyText } from "@/shared/ui/animated-shiny-text";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { GlareHover } from "@/shared/ui/glare-hover";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/shared/ui/carousel";
import { cx } from "../app/appUtils";
import {
  initialOnboardingState,
  loadOnboardingState,
  saveOnboardingState,
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

type CheckStatus = "idle" | "checking" | "ready" | "error";
type ChromeStatusTone = "neutral" | "ok" | "bad";

const OnboardingChromeContext = createContext<{
  canBack: boolean;
  onBack: () => void;
  screenIcon: LucideIcon;
  statusText: string;
  statusTone: ChromeStatusTone;
  transitionActive: boolean;
}>({
  canBack: false,
  onBack: () => undefined,
  screenIcon: Sparkles,
  statusText: "",
  statusTone: "neutral",
  transitionActive: false,
});

const startButtonDelayMs = process.env.NODE_ENV === "test" ? 1 : 3000;
const startupLogoDelayMs = process.env.NODE_ENV === "test" ? 0 : 220;
const screenTransitionDelayMs = process.env.NODE_ENV === "test" ? 0 : 280;
const startLogoGlareDelayMs = 1000;
const startLogoGlareDurationMs = 1000;
const providerOptions = ["Groq", "OpenAI", "Deepgram", "AssemblyAI"] as const;
const manualConfirmDelayMs = 3000;
const verificationMinVisibleMs = process.env.NODE_ENV === "test" ? 1 : 1000;
const failedCheckVisibleMs = process.env.NODE_ENV === "test" ? 100 : 2000;
const welcomeSlides = [
  { step: "welcome-1", title: "Brai рядом с вашим экраном", text: "Голос, текст и контекст доступны без переключения между приложениями.", icon: TextCursorInput },
  { step: "welcome-2", title: "Голос превращается в действие", text: "Надиктуйте мысль, ответ или команду — Brai подготовит текст там, где вы работаете.", icon: Mic },
  { step: "welcome-3", title: "Идеи не теряются", text: "Сохраняйте важное прямо с экрана и отправляйте агенту задачи вместе с контекстом.", icon: Send },
  { step: "welcome-4", title: "Пора настроить основу", text: "Дальше выберем профиль, голосовой модуль и системные разрешения.", icon: Sparkles },
] as const satisfies ReadonlyArray<{ step: OnboardingStep; title: string; text: string; icon: LucideIcon }>;
const startButtonCss = `
@keyframes brai-onboarding-start-button {
  0% { opacity: 0; }
  100% { opacity: 1; }
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
  const reduceMotion = Boolean(useReducedMotion()) || process.env.NODE_ENV === "test";
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
  const [failedCheckStep, setFailedCheckStep] = useState<OnboardingStep | null>(null);
  const [trainingDictated, setTrainingDictated] = useState(false);
  const [queueSaved, setQueueSaved] = useState(false);
  const [queueInserted, setQueueInserted] = useState(false);
  const [screenTransitioning, setScreenTransitioning] = useState(false);
  const [startupSplashVisible, setStartupSplashVisible] = useState(startButtonDelayMs > 0);
  const [startupLogoVisible, setStartupLogoVisible] = useState(startupLogoDelayMs === 0);
  const [permissionFallbackStep, setPermissionFallbackStep] = useState<OnboardingStep | null>(null);
  const stepRef = useRef<OnboardingStep>(state.step);
  const stateRef = useRef<OnboardingState>(state);
  const manualConfirmTimerRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const transitionFrameRef = useRef<number | null>(null);
  const failedCheckTimerRef = useRef<number | null>(null);
  const isAndroid = isNativeShell() && platformName() === "android";

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      const next = loadInitialOnboardingState(authRequired);
      stateRef.current = next;
      stepRef.current = next.step;
      setState(next);
    }, 0);
    const logoTimer = window.setTimeout(() => setStartupLogoVisible(true), startupLogoDelayMs);
    const splashTimer = window.setTimeout(() => setStartupSplashVisible(false), startButtonDelayMs);
    void refreshCapabilities();
    return () => {
      window.clearTimeout(loadTimer);
      window.clearTimeout(logoTimer);
      window.clearTimeout(splashTimer);
    };
  }, [authRequired]);

  useEffect(() => {
    if (state.complete && !authRequired) onDone();
  }, [authRequired, onDone, state.complete]);

  useEffect(() => () => {
    if (manualConfirmTimerRef.current != null) window.clearTimeout(manualConfirmTimerRef.current);
    if (transitionTimerRef.current != null) window.clearTimeout(transitionTimerRef.current);
    if (transitionFrameRef.current != null) window.cancelAnimationFrame(transitionFrameRef.current);
    if (failedCheckTimerRef.current != null) window.clearTimeout(failedCheckTimerRef.current);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    stepRef.current = state.step;
  }, [state]);

  useEffect(() => installAndroidBackHandler(() => {
    const current = stateRef.current;
    const previous = previousOnboardingStep(current);
    if (previous) {
      setError("");
      setMessage("");
      const next = { ...current, step: previous.step, history: current.history.slice(0, previous.historyIndex) };
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
    void setBraiCmdVoiceOnlyMode(!(state.complete || state.step === "voice-ready"));
  }, [isAndroid, state.complete, state.step]);

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

  function transitionTo(next: OnboardingState) {
    if (screenTransitionDelayMs === 0) {
      saveOnboardingState(next);
      stateRef.current = next;
      setState(next);
      return;
    }
    if (transitionTimerRef.current != null) window.clearTimeout(transitionTimerRef.current);
    if (transitionFrameRef.current != null) window.cancelAnimationFrame(transitionFrameRef.current);
    setScreenTransitioning(true);
    transitionTimerRef.current = window.setTimeout(() => {
      saveOnboardingState(next);
      stateRef.current = next;
      setState(next);
      transitionTimerRef.current = null;
      transitionFrameRef.current = window.requestAnimationFrame(() => {
        setScreenTransitioning(false);
        transitionFrameRef.current = null;
      });
    }, screenTransitionDelayMs);
  }

  function go(step: OnboardingStep, next?: Partial<OnboardingState>) {
    setError("");
    setMessage("");
    setCheckingStep(null);
    setReadyStep(null);
    clearFailedCheck();
    setPermissionFallbackStep(null);
    setManualConfirmReadyStep(null);
    if (manualConfirmTimerRef.current != null) {
      window.clearTimeout(manualConfirmTimerRef.current);
      manualConfirmTimerRef.current = null;
    }
    const current = stateRef.current;
    transitionTo({ ...current, ...next, step, history: [...current.history, current.step] });
  }

  function back() {
    const current = stateRef.current;
    const previous = previousOnboardingStep(current);
    if (!previous) return;
    setError("");
    setMessage("");
    setCheckingStep(null);
    setReadyStep(null);
    clearFailedCheck();
    setPermissionFallbackStep(null);
    setManualConfirmReadyStep(null);
    transitionTo({ ...current, step: previous.step, history: current.history.slice(0, previous.historyIndex) });
  }

  function replaceCurrentStep(step: OnboardingStep) {
    const current = stateRef.current;
    if (current.step === step) return;
    const next = { ...current, step };
    saveOnboardingState(next);
    stateRef.current = next;
    stepRef.current = step;
    if (!current.step.startsWith("welcome-") || !step.startsWith("welcome-")) setState(next);
  }

  function completeSetup() {
    void setBraiCmdQueuePausedMode(false);
    void setBraiCmdVoiceOnlyMode(false);
    const current = stateRef.current;
    transitionTo({ ...current, complete: true, step: "login-check", history: [...current.history, current.step] });
  }

  function checkStatus(step: OnboardingStep): CheckStatus {
    if (checkingStep === step) return "checking";
    if (failedCheckStep === step) return "error";
    if (readyStep === step) return "ready";
    return "idle";
  }

  function resetCheck(step: OnboardingStep) {
    if (readyStep === step) setReadyStep(null);
    if (checkingStep === step) setCheckingStep(null);
    if (failedCheckStep === step) clearFailedCheck();
  }

  function clearFailedCheck() {
    setFailedCheckStep(null);
    if (failedCheckTimerRef.current != null) {
      window.clearTimeout(failedCheckTimerRef.current);
      failedCheckTimerRef.current = null;
    }
  }

  function unlockManualConfirmAfterDelay(step: OnboardingStep) {
    setManualConfirmReadyStep(null);
    if (manualConfirmTimerRef.current != null) window.clearTimeout(manualConfirmTimerRef.current);
    manualConfirmTimerRef.current = window.setTimeout(() => {
      setManualConfirmReadyStep(step);
      manualConfirmTimerRef.current = null;
    }, manualConfirmDelayMs);
  }

  async function runVerification(step: OnboardingStep, verify: () => Promise<boolean>, errorText: string): Promise<boolean> {
    setError("");
    setMessage("");
    clearFailedCheck();
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
      setFailedCheckStep(step);
      failedCheckTimerRef.current = window.setTimeout(() => {
        setFailedCheckStep((current) => current === step ? null : current);
        failedCheckTimerRef.current = null;
      }, failedCheckVisibleMs);
    }
    setCheckingStep(null);
    return ok;
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
    if (readyStep === "microphone") {
      go("notifications");
      return;
    }
    const checkOnly = permissionFallbackStep === "microphone";
    const ok = await runVerification("microphone", async () => {
      const next = isAndroid ? (checkOnly ? await refreshCapabilities() : await requestAndroidMicrophone()) : null;
      return !isAndroid || Boolean(next?.microphoneGranted);
    }, "Микрофон не разрешен.");
    setPermissionFallbackStep(ok ? null : "microphone");
  }

  async function requestNotifications() {
    if (readyStep === "notifications") {
      go("training-start");
      return;
    }
    const checkOnly = permissionFallbackStep === "notifications";
    const ok = await runVerification("notifications", async () => {
      const next = isAndroid ? (checkOnly ? await refreshCapabilities() : await requestAndroidNotifications()) : null;
      return !isAndroid || Boolean(next?.notificationsGranted);
    }, "Уведомления не разрешены.");
    setPermissionFallbackStep(ok ? null : "notifications");
  }

  async function openPermissionAppSettings(step: OnboardingStep) {
    setPermissionFallbackStep(step);
    if (!isAndroid) return;
    await openAndroidAppSettings();
    await refreshCapabilities();
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
  const previousStep = previousOnboardingStep(state);
  const statusText = error || message || statusPromptForStep(state.step);
  const chrome = {
    canBack: Boolean(previousStep),
    onBack: back,
    screenIcon: screenIconForStep(state.step),
    statusText,
    statusTone: error ? "bad" as const : message ? "ok" as const : "neutral" as const,
    transitionActive: screenTransitioning,
  };

  function renderStep(): ReactNode {
    if (state.step === "start") {
      return null;
    }

    if (state.step.startsWith("welcome-")) {
      return (
        <WelcomeCarousel
          currentStep={state.step}
          onStart={() => go("path")}
          onStepChange={replaceCurrentStep}
        />
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
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={(event) => {
          event.preventDefault();
          if (!state.name.trim()) return setError("Введите имя.");
          go("setup-start");
        }}>
          <div className="grid min-h-0 flex-1 content-center gap-5 overflow-hidden py-4">
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
        <OnboardingAuthForm
          busy={busy}
          intro={<InfoBlock icon={Lock} title="Вход в облачный профиль" text="Пока для входа нужен только пароль." />}
          mode="password"
          onLogin={submitCloudLogin}
          onRequestOtp={onRequestOtp}
          onVerifyOtp={onVerifyOtp}
        />
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
    if (state.step === "voice-intro") return <InfoScreen icon={Mic} title="Сначала голосовой модуль" text="Без распознавания голоса Brai CMD не сможет принимать команды и вставлять продиктованный текст."><PrimaryButton onClick={() => go("voice-choice")}>Настроить Brai CMD</PrimaryButton></InfoScreen>;

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
          <SecondaryButton icon={ExternalLink} onClick={openOverlay}>Открыть настройки</SecondaryButton>
          <CheckActionButton status={checkStatus("overlay")} onClick={checkOverlay} />
        </PermissionScreen>
      );
    }

    if (state.step === "accessibility-why") return <InfoScreen icon={ShieldCheck} title="Специальные возможности" text="Они нужны, чтобы вставлять текст в поля, работать с буфером и выполнять действия на экране."><PrimaryButton onClick={() => go("accessibility-blocked")}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-blocked") return <InfoScreen icon={Lock} title="Шаг 1: получить отказ" text="Откройте специальные возможности и попробуйте включить Brai. Android должен показать, что настройка заблокирована."><SecondaryButton icon={ExternalLink} onClick={openAccessibility}>Открыть</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-blocked"} icon={CheckCircle2} onClick={() => go("accessibility-restricted")}>Да, доступ заблокирован</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-restricted") return <InfoScreen icon={ShieldCheck} title="Шаг 2: снять ограничение" text="Откройте карточку приложения, нажмите меню с тремя точками и выберите «Разрешить ограниченные настройки»."><SecondaryButton icon={ExternalLink} onClick={openAppSettings}>Открыть карточку приложения</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-restricted"} icon={CheckCircle2} onClick={() => go("accessibility-enable")}>Ограничение снято</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-enable") return <InfoScreen icon={ShieldCheck} title="Шаг 3: включить доступ" text="Теперь снова откройте специальные возможности и включите Brai. После возврата мы проверим состояние."><SecondaryButton icon={ExternalLink} onClick={openAccessibility}>Открыть</SecondaryButton><CheckActionButton status={checkStatus("accessibility-enable")} onClick={checkAccessibility} /></InfoScreen>;

    if (state.step === "microphone") return (
      <PermissionScreen icon={Mic} title="Микрофон" text="Микрофон нужен для голосового ввода и команд.">
        {permissionFallbackStep === "microphone" ? <SecondaryButton icon={ExternalLink} onClick={() => openPermissionAppSettings("microphone")}>Открыть настройки приложения</SecondaryButton> : null}
        <CheckActionButton idleLabel={permissionFallbackStep === "microphone" ? "Проверить" : "Разрешить микрофон"} status={checkStatus("microphone")} onClick={requestMic} />
      </PermissionScreen>
    );
    if (state.step === "notifications") return (
      <PermissionScreen icon={Bell} title="Уведомления" text="Уведомления нужны для фоновой записи, очереди и статуса отправки.">
        {permissionFallbackStep === "notifications" ? <SecondaryButton icon={ExternalLink} onClick={() => openPermissionAppSettings("notifications")}>Открыть настройки приложения</SecondaryButton> : null}
        <CheckActionButton idleLabel={permissionFallbackStep === "notifications" ? "Проверить" : "Разрешить уведомления"} status={checkStatus("notifications")} onClick={requestNotifications} />
      </PermissionScreen>
    );

    if (state.step === "training-start") return <InfoScreen icon={CheckCircle2} title="Готово к обучению" text="Базовая настройка завершена. Осталось проверить голосовой сценарий в четыре шага."><SecondaryButton onClick={completeSetup}>Пропустить</SecondaryButton><PrimaryButton onClick={startTraining}>Обучение</PrimaryButton></InfoScreen>;
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
    if (state.step === "locked") return <InfoScreen icon={Lock} title="Нужен вход" text="Пока вы не вошли, доступны только вход и настройки Brai CMD."><SecondaryButton onClick={openCmdSettings}>Настройки Brai CMD</SecondaryButton><PrimaryButton onClick={() => go("login")}>Войти</PrimaryButton></InfoScreen>;
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

  if (startupSplashVisible || state.step === "start") {
    return (
      <OnboardingChromeContext.Provider value={chrome}>
        <main className={cx("fixed inset-0 overflow-hidden bg-black text-foreground transition-opacity duration-300 ease-out", screenTransitioning ? "opacity-0" : "opacity-100")} data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
          <style>{startButtonCss}</style>
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div
              className="transition-opacity duration-300 ease-out"
              style={{
                width: "min(20rem, calc(100vw - 3rem))",
                aspectRatio: "779 / 368",
                opacity: startupLogoVisible ? 1 : 0,
              }}
            >
              <GlareHover
                width="100%"
                height="100%"
                background="transparent"
                borderColor="transparent"
                borderRadius="0"
                className="border-0"
                glareAngle={18}
                glareOpacity={1}
                glareSize={64}
                glareMaskImage="/brand/brai-logo-transparent.svg"
                transitionDuration={startLogoGlareDurationMs}
                autoPlayDelayMs={reduceMotion ? undefined : startLogoGlareDelayMs}
                interactive={false}
                playOnce
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- stable startup geometry matters here more than Next image optimization. */}
                <img
                  className="block h-full w-full select-none object-contain"
                  src="/brand/brai-logo-transparent.svg"
                  alt="Brai"
                  width="779"
                  height="368"
                  decoding="sync"
                  fetchPriority="high"
                  draggable={false}
                />
              </GlareHover>
            </div>
          </div>
          <div
            className={cx(
              "absolute inset-x-6 z-10 mx-auto max-w-md",
              !startupSplashVisible && state.step === "start" ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{
              bottom: "calc(env(safe-area-inset-bottom) + 1.5rem)",
              opacity: !startupSplashVisible && state.step === "start" ? 1 : 0,
              animation: !startupSplashVisible && state.step === "start" ? `brai-onboarding-start-button 300ms ease-out both` : undefined,
            }}
          >
            <ShinyButton onClick={() => go("welcome-1")}>Приступить</ShinyButton>
          </div>
        </main>
      </OnboardingChromeContext.Provider>
    );
  }

  return (
    <OnboardingChromeContext.Provider value={chrome}>
      <main className="fixed inset-0 min-h-0 overflow-hidden bg-black text-foreground" data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
        <div
          className={cx(
            "mx-auto flex h-dvh w-full max-w-md flex-col px-6 pb-0 pt-[calc(env(safe-area-inset-top)+1.5rem)] [@media(max-height:700px)]:px-4 [@media(max-height:700px)]:pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:max-w-2xl sm:px-6 sm:pt-6",
            "transition-opacity duration-300 ease-out",
            screenTransitioning ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {body}
          </section>
        </div>
      </main>
    </OnboardingChromeContext.Provider>
  );
}

function ShinyButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <PrimaryButton onClick={onClick}>{children}</PrimaryButton>;
}

function CheckActionButton({ disabled, idleLabel = "Проверить", onClick, status }: { disabled?: boolean; idleLabel?: string; onClick: () => void | Promise<void>; status: CheckStatus }) {
  const checking = status === "checking";
  const failed = status === "error";
  const ready = status === "ready";
  return (
    <PrimaryButton
      disabled={disabled || checking || failed}
      icon={checking ? LoaderCircle : failed ? CircleX : ready ? CheckCircle2 : ShieldCheck}
      iconClassName={checking ? "animate-spin" : ready ? "text-emerald-400" : undefined}
      tone={failed ? "danger" : "default"}
      trailingArrow={false}
      onClick={onClick}
    >
      {checking ? "Проверка" : failed ? "Ошибка" : ready ? "Продолжить" : idleLabel}
    </PrimaryButton>
  );
}

type ActionButtonProps = React.ComponentProps<typeof Button> & {
  icon?: LucideIcon | null;
  iconClassName?: string;
  tone?: "default" | "danger";
  trailingArrow?: boolean;
};

function PrimaryButton({ children, className, disabled, icon, iconClassName, tone = "default", trailingArrow = true, ...props }: ActionButtonProps) {
  const { screenIcon: ContextIcon, transitionActive } = useContext(OnboardingChromeContext);
  const Icon = icon === undefined ? ContextIcon : icon;
  const danger = tone === "danger";
  const [pressed, setPressed] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const { onPointerDown, onPointerLeave, onPointerUp, ...buttonProps } = props;

  function holdPressed() {
    if (disabled) return;
    setPressed(true);
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = window.setTimeout(() => {
      setPressed(false);
      pressTimerRef.current = null;
    }, 160);
  }

  function releasePressed() {
    if (pressTimerRef.current != null) return;
    setPressed(false);
  }

  useEffect(() => () => {
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
  }, []);

  return (
    <Button
      size="lg"
      variant="outline"
      className={cx(
        "group min-h-12 w-full overflow-hidden rounded-full px-5 text-base font-semibold shadow-lg transition-all duration-150 active:scale-[0.97] disabled:shadow-none disabled:active:scale-100 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:min-h-10 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-sm",
        danger
          ? "border-destructive/45 bg-destructive/10 text-destructive shadow-destructive/10 disabled:border-destructive/45 disabled:bg-destructive/10 disabled:opacity-100"
          : "border-primary/35 bg-primary/10 text-foreground shadow-primary/10 hover:bg-primary/15 active:border-primary/80 active:bg-primary/30 active:shadow-primary/30 disabled:border-muted/30 disabled:bg-muted/20 disabled:opacity-60 disabled:hover:bg-muted/20",
        (transitionActive || pressed) && !disabled ? "scale-[0.97] border-primary/90 bg-primary/35 shadow-primary/40" : "",
        className,
      )}
      disabled={disabled}
      onPointerDown={(event) => {
        if (!disabled) void vibrateBraiCmdPress();
        holdPressed();
        onPointerDown?.(event);
      }}
      onPointerLeave={(event) => {
        releasePressed();
        onPointerLeave?.(event);
      }}
      onPointerUp={(event) => {
        releasePressed();
        onPointerUp?.(event);
      }}
      {...buttonProps}
    >
      {Icon ? <Icon className={cx("size-4 transition-all", iconClassName)} aria-hidden="true" /> : null}
      <AnimatedShinyText shimmerWidth={160} className={cx("min-w-0 flex-1 text-center text-base font-semibold via-black dark:via-white", danger ? "text-destructive/80 dark:text-destructive/80" : disabled ? "text-muted-foreground/70 dark:text-muted-foreground/70" : "text-foreground/85 dark:text-foreground/90")}>
        {children}
      </AnimatedShinyText>
      {trailingArrow ? <ArrowRight className={cx("size-4 transition-transform duration-200 group-active:translate-x-1", transitionActive && !disabled ? "translate-x-1" : "")} aria-hidden="true" /> : null}
    </Button>
  );
}

function SecondaryButton({ children, className, icon: Icon, iconClassName, ...props }: ActionButtonProps) {
  const { transitionActive } = useContext(OnboardingChromeContext);
  return (
    <Button
      variant="outline"
      className={cx("min-h-12 w-full rounded-full border-primary/20 bg-transparent px-5 text-base font-semibold transition-all duration-200 hover:bg-primary/10 active:scale-[0.98] active:border-primary/40 active:bg-primary/15 disabled:opacity-50 disabled:active:scale-100", transitionActive ? "scale-[0.98] bg-primary/10" : "", className)}
      {...props}
    >
      {Icon ? <Icon className={cx("size-4 transition-all", iconClassName)} aria-hidden="true" /> : null}
      <AnimatedShinyText shimmerWidth={120} className="min-w-0 flex-1 text-center text-base font-semibold text-foreground/85 dark:text-foreground/90">
        {children}
      </AnimatedShinyText>
    </Button>
  );
}

function StepScreen({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 content-center gap-5 overflow-hidden py-4">{children}</div>
      {actions ? <StepActions>{actions}</StepActions> : null}
    </div>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  const { canBack, onBack, statusText, statusTone } = useContext(OnboardingChromeContext);
  const actions = Children.toArray(children).filter(Boolean);
  const mainAction = actions.at(-1);
  const extraActions = actions.slice(0, -1);

  if (!statusText && !mainAction && !canBack) return null;

  return (
    <div className="grid shrink-0 gap-3 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5 [@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:pb-[calc(env(safe-area-inset-bottom)+0.5rem)] [@media(max-height:700px)]:pt-2 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pb-[calc(env(safe-area-inset-bottom)+0.25rem)] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pt-1">
      {statusText ? <StatusCard text={statusText} tone={statusTone} /> : null}
      {extraActions.length ? <div className="grid gap-2">{extraActions}</div> : null}
      <div className={cx("grid gap-3", canBack && mainAction ? "grid-cols-[3rem_minmax(0,1fr)]" : canBack ? "grid-cols-[3rem]" : "grid-cols-1")}>
        {canBack ? (
          <Button type="button" variant="outline" className="size-12 rounded-full border-primary/20 bg-transparent p-0 transition-all duration-200 hover:bg-primary/10 active:scale-[0.96] active:bg-primary/15 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:size-10" aria-label="Назад" onClick={onBack}>
            <ChevronLeft className="size-5" aria-hidden="true" />
          </Button>
        ) : null}
        {mainAction}
      </div>
    </div>
  );
}

function InfoBlock({ compactOnShort = false, icon: Icon, title, text }: { compactOnShort?: boolean; icon: LucideIcon; title: string; text: string }) {
  return (
    <div className={cx("grid min-w-0 gap-4", compactOnShort ? "[@media(max-height:700px)]:gap-2 [@media(max-height:650px)]:gap-1.5 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:gap-1" : "")}>
      <span className={cx("grid size-11 place-items-center rounded-full border border-primary/25 bg-primary/10 text-primary", compactOnShort ? "[@media(max-height:700px)]:size-9 [@media(max-height:650px)]:size-8 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:hidden" : "")}>
        <Icon className={cx("size-5", compactOnShort ? "[@media(max-height:700px)]:size-4 [@media(max-height:650px)]:size-3.5" : "")} aria-hidden="true" />
      </span>
      <div className={cx("grid min-w-0 gap-2", compactOnShort ? "[@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:gap-1" : "")}>
        <h2 className={cx("m-0 break-words text-2xl font-semibold leading-tight", compactOnShort ? "[@media(max-height:700px)]:text-xl [@media(max-height:650px)]:text-lg [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-base" : "")}>{title}</h2>
        <p className={cx("m-0 break-words text-sm leading-5 text-muted-foreground", compactOnShort ? "[@media(max-height:700px)]:text-xs [@media(max-height:700px)]:leading-4 [@media(max-height:650px)]:text-[0.72rem] [@media(max-height:650px)]:leading-[0.95rem] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-[0.68rem] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:leading-[0.82rem]" : "")}>{text}</p>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 content-center gap-4 overflow-hidden py-4">
        <InfoBlock icon={Radio} title={title} text={text} />
        <div className="grid gap-3 sm:grid-cols-2">
          {choices.map((choice) => (
            <button key={choice.title} type="button" className="grid min-h-28 content-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-left transition-all duration-200 hover:bg-primary/10 active:scale-[0.98] active:border-primary/40 active:bg-primary/15 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40" onClick={choice.onClick}>
              <choice.icon className="size-5 text-primary" aria-hidden="true" />
              <span className="text-base font-semibold">{choice.title}</span>
              <span className="text-sm leading-5 text-muted-foreground">{choice.text}</span>
            </button>
          ))}
        </div>
      </div>
      <StepActions>{null}</StepActions>
    </div>
  );
}

function WelcomeCarousel({ currentStep, onStart, onStepChange }: { currentStep: OnboardingStep; onStart: () => void; onStepChange: (step: OnboardingStep) => void }) {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(() => welcomeStepIndex(currentStep));
  const canStart = current === welcomeSlides.length - 1;

  useEffect(() => {
    if (!api) return;
    const index = welcomeStepIndex(currentStep);
    if (api.selectedScrollSnap() === index) return;
    api.scrollTo(index, true);
  }, [api, currentStep]);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      const index = api.selectedScrollSnap();
      setCurrent(index);
      onStepChange(welcomeSlides[index]?.step ?? "welcome-1");
    };
    onSelect();
    api.on("select", onSelect);
    api.on("reInit", onSelect);
    return () => {
      api.off("select", onSelect);
      api.off("reInit", onSelect);
    };
  }, [api, onStepChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-5 overflow-hidden pt-[clamp(3rem,10dvh,7rem)] [@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:pt-2 [@media(max-height:650px)]:pt-1">
        <Carousel setApi={setApi} opts={{ align: "start" }} className="h-full w-full min-w-0 overflow-hidden" aria-label="Приветствие Brai" data-nav-swipe-exclusion>
          <CarouselContent viewportClassName="h-full" className="h-full w-full touch-pan-y">
            {welcomeSlides.map(({ icon: Icon, step, text, title }, index) => (
              <CarouselItem key={step} className="h-full basis-full">
                <Card className="grid h-full w-full min-w-0 content-center gap-6 overflow-hidden rounded-2xl border-primary/15 bg-card/80 p-6 shadow-none [@media(max-height:700px)]:gap-3 [@media(max-height:700px)]:p-4 [@media(max-height:650px)]:gap-2 [@media(max-height:650px)]:p-3 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:gap-1.5">
                  <p className="m-0 text-sm font-medium text-muted-foreground [@media(max-height:700px)]:text-xs [@media(max-height:650px)]:text-[0.72rem] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-[0.68rem]">Карточка {index + 1} из 4</p>
                  <InfoBlock compactOnShort icon={Icon} title={title} text={text} />
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>
        <div className="flex justify-center gap-2" aria-hidden="true">
          {welcomeSlides.map((slide, index) => (
            <span key={slide.step} className={cx("h-2 rounded-full transition-all duration-300", index === current ? "w-6 bg-primary" : "w-2 bg-muted-foreground/30")} />
          ))}
        </div>
      </div>
      <StepActions>
        <PrimaryButton className={canStart ? "" : "invisible"} disabled={!canStart} aria-hidden={!canStart} tabIndex={canStart ? 0 : -1} onClick={onStart}>Начать</PrimaryButton>
      </StepActions>
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
    <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={(event) => {
      event.preventDefault();
      onSubmit(key);
    }}>
      <div className="grid min-h-0 flex-1 content-center gap-4 overflow-hidden py-4">
        <InfoBlock icon={KeyRound} title="Ключ доступа" text="Введите ключ self-hosted профиля, чтобы связать приложение с вашим сервером." />
        <Input value={key} type="password" aria-label="Ключ доступа" placeholder="Ключ доступа" onChange={(event) => setKey(event.target.value)} />
      </div>
      <StepActions><PrimaryButton disabled={key.trim().length < 8}>Подключить</PrimaryButton></StepActions>
    </form>
  );
}

function OnboardingAuthForm({
  busy,
  intro,
  mode,
  onLogin,
  onRequestOtp,
  onVerifyOtp,
}: {
  busy: boolean;
  intro?: ReactNode;
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
      <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submitPassword}>
        <div className="grid min-h-0 flex-1 content-center gap-4 overflow-hidden py-4">
          {intro}
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
        </div>
        <StepActions>
          <PrimaryButton disabled={busy || !password}>Открыть</PrimaryButton>
        </StepActions>
      </form>
    );
  }

  return (
    <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={submitOtp}>
      <div className="grid min-h-0 flex-1 content-center gap-4 overflow-hidden py-4">
        {intro}
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
      </div>
      <StepActions>
        <PrimaryButton disabled={busy || !email || (otpSent && !otp)}>{otpSent ? "Проверить код" : "Получить код"}</PrimaryButton>
      </StepActions>
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
        className="min-h-28 resize-none pr-14"
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

function StatusCard({ text, tone }: { text: string; tone: ChromeStatusTone }) {
  return (
    <Card
      className={cx(
        "h-14 justify-center rounded-2xl px-4 py-2 text-sm leading-5 shadow-none",
        tone === "bad" ? "border-destructive/35 bg-destructive/10 text-destructive" : tone === "ok" ? "border-primary/30 bg-primary/10 text-foreground" : "border-primary/15 bg-card/60 text-muted-foreground",
      )}
    >
      <p className="m-0 line-clamp-2">{text}</p>
    </Card>
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

function previousOnboardingStep(state: OnboardingState): { step: OnboardingStep; historyIndex: number } | null {
  for (let historyIndex = state.history.length - 1; historyIndex >= 0; historyIndex -= 1) {
    const step = state.history[historyIndex];
    if (step !== "start") return { step, historyIndex };
  }
  return null;
}

function screenIconForStep(step: OnboardingStep): LucideIcon {
  if (step === "locked" || step === "login" || step === "login-check") return Lock;
  if (step.startsWith("training")) return step === "training-offline" ? WifiOff : step === "training-storage" ? FileAudio : Mic;
  if (step === "voice-choice" || step === "provider-key") return KeyRound;
  if (step === "local-server") return Server;
  if (step === "cloud-privacy") return Cloud;
  if (step === "overlay") return MonitorUp;
  if (step.startsWith("accessibility")) return ShieldCheck;
  if (step === "microphone") return Mic;
  if (step === "notifications") return Bell;
  if (step === "name") return UserRound;
  return Sparkles;
}

function statusPromptForStep(step: OnboardingStep): string {
  if (step === "provider-key") return "Выберите поставщика, введите ключ и нажмите Проверить.";
  if (step === "local-server") return "Введите URL локального сервера и нажмите Проверить.";
  if (step === "overlay") return "Включите разрешение поверх экрана и нажмите Проверить.";
  if (step === "accessibility-blocked") return "Откройте специальные возможности, получите отказ и подтвердите шаг.";
  if (step === "accessibility-restricted") return "Разрешите ограниченные настройки в карточке приложения.";
  if (step === "accessibility-enable") return "Включите специальные возможности Brai и нажмите Проверить.";
  if (step === "microphone") return "Разрешите микрофон и нажмите Продолжить после успешной проверки.";
  if (step === "notifications") return "Разрешите уведомления и нажмите Продолжить после успешной проверки.";
  return "";
}

function welcomeStepIndex(step: OnboardingStep): number {
  const index = welcomeSlides.findIndex((slide) => slide.step === step);
  return index >= 0 ? index : 0;
}
