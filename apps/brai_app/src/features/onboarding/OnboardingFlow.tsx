"use client";

import { Children, createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import Image from "next/image";
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
import { ensureBraiCmdAccess, listenBraiCmdOnboardingEvents, prepareBraiCmdPreliminaryProfile, retryBraiCmdQueue, setBraiCmdAccessKey, setBraiCmdOverlayEnabled, setBraiCmdQueuePausedMode, setBraiCmdVoiceOnlyMode, vibrateBraiCmdPress } from "@/shared/platform/braiCmd";
import { installAndroidBackHandler, isNativeShell, platformName } from "@/shared/platform/platform";
import type { AuthOnboardingContext, OtpSendResult } from "@/shared/api/braiApi";
import { AnimatedShinyText } from "@/shared/ui/animated-shiny-text";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";
import { Carousel, CarouselContent, CarouselItem, type CarouselApi } from "@/shared/ui/carousel";
import { cx } from "../app/appUtils";
import { AuthScreen } from "../app/AuthScreen";
import {
  isValidOnboardingName,
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
  onRequestOtp: (email: string) => Promise<OtpSendResult>;
  onStartupScreenChange: (active: boolean) => void;
  onVerifyOtp: (email: string, otp: string, context?: AuthOnboardingContext) => Promise<void>;
  onDone: () => void;
  onOpenNativeCmdSettings: () => Promise<boolean>;
  startupIntroComplete: boolean;
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

const screenTransitionDelayMs = process.env.NODE_ENV === "test" ? 0 : 280;
const providerOptions = ["Groq", "OpenAI", "Deepgram", "AssemblyAI"] as const;
const manualConfirmDelayMs = 3000;
const nameSubmitMuteMs = 2000;
const verificationMinVisibleMs = process.env.NODE_ENV === "test" ? 1 : 1000;
const failedCheckVisibleMs = process.env.NODE_ENV === "test" ? 100 : 2000;
const welcomeSlides = [
  { step: "welcome-1", title: "А что, если исполнитель желаний существует?", text: "Люди веками мечтали найти джинна, философский камень или силу, способную воплощать желания. Представь, что теперь такая сила доступна тебе.", image: "/onboarding/welcome-1.webp" },
  { step: "welcome-2", title: "Тебе достаточно сказать, чего ты хочешь", text: "Не нужно знать правильные команды, изучать сложные инструменты или разбираться, с чего начать. Брай поможет найти путь.", image: "/onboarding/welcome-2.webp" },
  { step: "welcome-3", title: "У него только одна цель", text: "Понять, чего ты действительно хочешь, и помочь тебе этого достичь. Твои желания становятся его задачей.", image: "/onboarding/welcome-3.webp" },
  { step: "welcome-4", title: "Он не просто советует", text: "Брай превращает желания в конкретные шаги, помогает принимать решения и может брать на себя часть задач.", image: "/onboarding/welcome-4.webp" },
  { step: "welcome-5", title: "Вся твоя жизнь — в одном разуме", text: "Брай помнит твои цели, идеи, проекты, решения и заботы. Он видит не отдельный вопрос, а всю картину — и понимает тебя всё лучше.", image: "/onboarding/welcome-5.webp" },
  { step: "welcome-6", title: "Твой исполнитель желаний уже здесь", text: "Не волшебством, а интеллектом, действиями и радикальной ясностью Брай помогает превращать желаемое в реальность.\n\nОн уже в твоих руках.", image: "/onboarding/welcome-6.webp" },
] as const satisfies ReadonlyArray<{ step: OnboardingStep; title: string; text: string; image: string }>;
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
  busy,
  onDone,
  onOpenNativeCmdSettings,
  onRequestOtp,
  onStartupScreenChange,
  onVerifyOtp,
  startupIntroComplete,
}: OnboardingFlowProps) {
  const [state, setState] = useState<OnboardingState>(() => loadInitialOnboardingState(authRequired));
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
  const [permissionFallbackStep, setPermissionFallbackStep] = useState<OnboardingStep | null>(null);
  const [nameSubmitting, setNameSubmitting] = useState(false);
  const [nameDuplicateBlocked, setNameDuplicateBlocked] = useState(false);
  const [preliminaryDeviceFingerprint, setPreliminaryDeviceFingerprint] = useState("");
  const stepRef = useRef<OnboardingStep>(state.step);
  const stateRef = useRef<OnboardingState>(state);
  const manualConfirmTimerRef = useRef<number | null>(null);
  const transitionTimerRef = useRef<number | null>(null);
  const transitionFrameRef = useRef<number | null>(null);
  const failedCheckTimerRef = useRef<number | null>(null);
  const nameSubmitTimerRef = useRef<number | null>(null);
  const isAndroid = isNativeShell() && platformName() === "android";

  useEffect(() => {
    const initialStep = stepRef.current;
    const loadTimer = window.setTimeout(() => {
      if (stepRef.current !== initialStep) return;
      const next = loadInitialOnboardingState(authRequired);
      stateRef.current = next;
      stepRef.current = next.step;
      setState(next);
    }, 0);
    void refreshCapabilities();
    return () => window.clearTimeout(loadTimer);
  }, [authRequired]);

  useEffect(() => {
    if (state.complete && !authRequired) onDone();
  }, [authRequired, onDone, state.complete]);

  useEffect(() => () => {
    if (manualConfirmTimerRef.current != null) window.clearTimeout(manualConfirmTimerRef.current);
    if (transitionTimerRef.current != null) window.clearTimeout(transitionTimerRef.current);
    if (transitionFrameRef.current != null) window.cancelAnimationFrame(transitionFrameRef.current);
    if (failedCheckTimerRef.current != null) window.clearTimeout(failedCheckTimerRef.current);
    if (nameSubmitTimerRef.current != null) window.clearTimeout(nameSubmitTimerRef.current);
  }, []);

  useEffect(() => {
    stateRef.current = state;
    stepRef.current = state.step;
  }, [state]);

  useEffect(() => {
    onStartupScreenChange(state.step === "start");
  }, [onStartupScreenChange, state.step]);

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
    void setBraiCmdVoiceOnlyMode(true);
  }, [isAndroid]);

  useEffect(() => {
    if (!isAndroid) return;
    const dictationAvailable = state.complete || state.step.startsWith("training-") || state.step === "voice-ready";
    void setBraiCmdOverlayEnabled(dictationAvailable);
  }, [isAndroid, state.complete, state.step]);

  useEffect(() => {
    if (!isAndroid || !state.complete || !authRequired) return;
    void ensureBraiCmdAccess(state.name.trim() || "Brai");
  }, [authRequired, isAndroid, state.complete, state.name]);

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
      stepRef.current = next.step;
      setState(next);
      return;
    }
    if (transitionTimerRef.current != null) window.clearTimeout(transitionTimerRef.current);
    if (transitionFrameRef.current != null) window.cancelAnimationFrame(transitionFrameRef.current);
    stateRef.current = next;
    stepRef.current = next.step;
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

  async function completeSetup() {
    await setBraiCmdOverlayEnabled(true);
    await setBraiCmdQueuePausedMode(false);
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
    if (path === "new") setNameDuplicateBlocked(false);
    go(path === "new" ? "name" : "profile-version", { path, profileVersion: path === "new" ? "self-hosted" : null });
  }

  function chooseProfileVersion(profileVersion: ProfileVersion) {
    go(profileVersion === "cloud" ? "cloud-login" : "self-hosted-key", { profileVersion });
  }

  function chooseVoiceMode(voiceMode: VoiceMode) {
    if (voiceMode === "provider") go("provider-key", { voiceMode });
    if (voiceMode === "local") go("local-server", { voiceMode });
    if (voiceMode === "cloud") go("microphone", { voiceMode });
  }

  async function submitName() {
    const displayName = stateRef.current.name.trim();
    if (!isValidOnboardingName(displayName)) {
      setError("Используйте минимум два символа: буквы, цифры или пробел.");
      return;
    }
    if (nameSubmitting || nameDuplicateBlocked) return;
    setError("");
    setNameSubmitting(true);
    const startedAt = Date.now();
    try {
      if (isAndroid) {
        const profile = await prepareBraiCmdPreliminaryProfile(displayName);
        if (!profile) {
          setError("Нет соединения с серверами Brai, повторите.");
          return;
        }
        setPreliminaryDeviceFingerprint(profile.deviceFingerprint ?? "");
        if (profile.duplicateDevice || profile.preliminaryStatus === "duplicate") {
          update({
            duplicatePreliminaryUserId: profile.preliminaryUserId ?? "",
            preliminaryUserId: "",
            preliminaryClaimToken: "",
          });
          setNameDuplicateBlocked(true);
          setError("Повторная регистрация невозможна. Войдите в профиль по email.");
          return;
        }
        setNameDuplicateBlocked(false);
        go("setup-start", {
          name: displayName,
          preliminaryUserId: profile.preliminaryUserId ?? "",
          preliminaryClaimToken: profile.preliminaryClaimToken ?? "",
          duplicatePreliminaryUserId: "",
        });
        return;
      }
      go("setup-start", { name: displayName });
    } finally {
      const remaining = Math.max(0, nameSubmitMuteMs - (Date.now() - startedAt));
      if (nameSubmitTimerRef.current != null) window.clearTimeout(nameSubmitTimerRef.current);
      nameSubmitTimerRef.current = window.setTimeout(() => {
        setNameSubmitting(false);
        nameSubmitTimerRef.current = null;
      }, remaining);
    }
  }

  function authOnboardingContext(): AuthOnboardingContext {
    const current = stateRef.current;
    return {
      name: current.name.trim(),
      preliminaryUserId: current.preliminaryUserId,
      duplicatePreliminaryUserId: current.duplicatePreliminaryUserId,
      preliminaryClaimToken: current.preliminaryClaimToken,
      deviceFingerprint: preliminaryDeviceFingerprint,
    };
  }

  async function submitCloudVerifyOtp(email: string, otp: string) {
    await onVerifyOtp(email, otp, authOnboardingContext());
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
      go("microphone");
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
      go("microphone");
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
      go("notifications");
      return;
    }
    await runVerification("accessibility-enable", async () => {
      const next = await refreshCapabilities();
      return !isAndroid || Boolean(next?.accessibilityServiceEnabled);
    }, "Специальные возможности Brai пока не включены.");
  }

  async function requestMic() {
    if (readyStep === "microphone") {
      go("overlay");
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
      await setBraiCmdOverlayEnabled(true);
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
          choices={[
            { icon: UserRound, title: "С чистого листа", text: "Начнём с нуля, познакомимся и всё настроим", onClick: () => choosePath("new") },
            { icon: KeyRound, title: "Есть профиль", text: "Вы уже создавали профиль или вам его кто-то создал и передал ключ активации", onClick: () => choosePath("existing") },
          ]}
        />
      );
    }

    if (state.step === "name") {
      return (
        <form className="flex min-h-0 flex-1 flex-col overflow-hidden" onSubmit={(event) => {
          event.preventDefault();
          void submitName();
        }}>
          <div className="grid min-h-0 flex-1 content-center gap-5 overflow-hidden py-2">
            <InfoBlock icon={UserRound} title="Как к вам обращаться" text="Имя будет использоваться для персонализации в обращениях Brai и будет в аккаунте при регистрации" />
            <Input autoFocus value={state.name} placeholder="Только буквы и пробел" aria-label="Имя" className="placeholder:text-muted-foreground/35" onChange={(event) => {
              if (!nameDuplicateBlocked) setError("");
              update({ name: event.target.value });
            }} />
          </div>
          <StepActions preserveBottomGap>
            <PrimaryButton
              disabled={!isValidOnboardingName(state.name) || nameSubmitting || nameDuplicateBlocked}
              icon={nameSubmitting ? LoaderCircle : undefined}
              iconClassName={nameSubmitting ? "animate-spin" : undefined}
              trailingArrow={!nameSubmitting}
            >
              {nameSubmitting ? "Проверка" : "Продолжить"}
            </PrimaryButton>
          </StepActions>
        </form>
      );
    }

    if (state.step === "profile-version") {
      return (
        <ChoiceScreen
          choices={[
            { icon: Cloud, title: "Облачная версия", text: "Авторизация по e-mail на серверах Brai", onClick: () => chooseProfileVersion("cloud") },
            { icon: Server, title: "Self-hosted версия", text: "Подключение по URL и ключу доступа к частному приватному серверу", disabled: true, badge: "В разработке" },
          ]}
        />
      );
    }

    if (state.step === "cloud-login") {
      return (
        <OnboardingAuthForm
          busy={busy}
          onAuthenticated={() => go("setup-start")}
          onRequestOtp={onRequestOtp}
          onVerifyOtp={submitCloudVerifyOtp}
        />
      );
    }

    if (state.step === "self-hosted-key") {
      return (
        <AccessKeyForm onSubmit={submitAccessKey} />
      );
    }

    if (state.step === "setup-start") return <InfoScreen icon={Command} title="Brai CMD" text="Превращает смартфон в командный центр, упрощая и ускоряя взаимодействие с Брай."><PrimaryButton onClick={() => go("floating-buttons")}>Далее</PrimaryButton></InfoScreen>;
    if (state.step === "features") return <InfoScreen icon={Command} title="Плавающие кнопки" text="Brai CMD управляется кнопками поверх других приложений. Они слушают голос, берут контекст экрана, вставляют данные, добавляя магии в повседневные действия."><PrimaryButton onClick={() => go("demo-dictation")}>Ознакомиться</PrimaryButton></InfoScreen>;
    if (state.step === "floating-buttons") return <InfoScreen icon={Command} title="Плавающие кнопки" text="Brai CMD управляется кнопками поверх других приложений. Они слушают голос, берут контекст экрана, вставляют данные, добавляя магии в повседневные действия."><PrimaryButton onClick={() => go("demo-dictation")}>Ознакомиться</PrimaryButton></InfoScreen>;

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

    if (state.step === "special-settings") {
      return (
        <InfoScreen
          icon={ShieldCheck}
          title="Требуется особая настройка"
          text={"Продемонстрированные функции не могут работать без специальной настройки\n\nПоэтому далее мы проведём вас по шагам, чтобы всё заработало\n\nНичего сложного. Просто следуйте инструкциям шаг за шагом."}
        >
          <PrimaryButton onClick={() => go("security")}>Продолжить</PrimaryButton>
        </InfoScreen>
      );
    }

    if (state.step === "security") {
      return (
        <StepScreen actions={<PrimaryButton onClick={() => go("voice-intro")}>Продолжить</PrimaryButton>}>
          <div className="grid gap-5">
            <InfoBlock
              icon={ShieldCheck}
              title="Не беспокойтесь о безопасности"
              text={"Приложение не шпионит за вами и ничего не делает без вашего ведома.\n\nУ приложения открыт исходный код, который может проверить любой человек или агент.\n\nПоэтому, несмотря на уведомления о нарушении безопасности, вы можете ему доверять."}
            />
            <Card className="rounded-2xl border-primary/15 bg-card/70 p-4 shadow-none">
              <p className="m-0 text-base leading-6 text-muted-foreground">
                Вот ссылка на исходный код.{" "}
                <a className="font-medium text-primary underline-offset-4 hover:underline" href="https://github.com/sergobright/Brai" rel="noreferrer" target="_blank">
                  sergobright/Brai
                </a>
              </p>
            </Card>
          </div>
        </StepScreen>
      );
    }

    if (state.step === "voice-intro") {
      return (
        <InfoScreen
          icon={Mic}
          title="Давайте настроим Brai CMD"
          text={"Brai обладает мощными ИИ-функциями и может работать даже без этих настроек.\n\nНо Андроид приложение спроектировано так, чтобы телефон был вашим командным центром.\n\nПоэтому давайте настроим всё по шагам."}
        >
          <PrimaryButton onClick={() => go("voice-choice")}>Настроить Brai CMD</PrimaryButton>
        </InfoScreen>
      );
    }

    if (state.step === "voice-choice") {
      const choices = [
        { icon: KeyRound, title: "API ключ", text: "Расшифровка напрямую через поставщика LLM. Нужен API ключ", onClick: () => chooseVoiceMode("provider") },
        { icon: Server, title: "Локальная модель", text: "Расшифровка на вашем сервере. Нужен эндпойнт и ключ", disabled: true, badge: "В разработке" },
        { icon: Cloud, title: "Облако Brai", text: "Расшифровка через серверы Брай. Ничего не требует, но есть лимиты на бесплатное использование", badge: "Самое простое", onClick: () => chooseVoiceMode("cloud") },
      ];
      return <ChoiceScreen compact title="Как распознавать голос" text="Без распознавания голоса Brai CMD не сможет принимать команды и вставлять продиктованный текст" choices={choices} />;
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

    if (state.step === "cloud-privacy") return <InfoScreen icon={Cloud} title="Мы ничего не храним" text={"Ваши аудио с голосом и расшифровки обрабатываются на серверах Брай.\n\nНо после успешной доставки расшифровки вам мы всё сразу удаляем. Это наши принципы.\n\nДля полной приватности используйте локальные модели"}><PrimaryButton onClick={() => go("microphone")}>Согласен</PrimaryButton></InfoScreen>;

    if (state.step === "overlay") {
      return (
        <SettingsImageScreen icon={MonitorUp} imageAlt="Включение плавающих кнопок Brai" imageHeight={1280} imageSrc="/onboarding/settings-2-floating-buttons.jpg" imageWidth={1280} title="Плавающие кнопки">
          <SecondaryButton icon={ExternalLink} onClick={openOverlay}>Открыть настройки</SecondaryButton>
          <CheckActionButton status={checkStatus("overlay")} onClick={checkOverlay} />
        </SettingsImageScreen>
      );
    }

    if (state.step === "accessibility-why") {
      return (
        <StepScreen actions={<PrimaryButton onClick={() => go("accessibility-blocked")}>Три шага</PrimaryButton>}>
          <InfoBlock
            icon={ShieldCheck}
            title="Особый доступ"
            text={"Делает возможным всё остальное, но требует особых разрешений.\n\nПозволяет:\n\nВставить текст в поле ввода\n\nРаботать с буфером обмена\n\nДелать снимки экрана\n\nВидеть то, что видите вы, чтобы помогать\n\nВсё под вашим контролем"}
          />
        </StepScreen>
      );
    }
    if (state.step === "accessibility-blocked") return <SettingsImageScreen icon={Lock} imageAlt="Шаг 1: получите отказ в специальных возможностях" imageHeight={1280} imageSrc="/onboarding/settings-3-accessibility.jpg" imageWidth={1280} title="Шаг 1: Получить отказ"><SecondaryButton icon={ExternalLink} onClick={openAccessibility}>Открыть специальные возможности</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-blocked"} icon={CheckCircle2} onClick={() => go("accessibility-restricted")}>Продолжить</PrimaryButton></SettingsImageScreen>;
    if (state.step === "accessibility-restricted") return <SettingsImageScreen icon={ShieldCheck} imageAlt="Шаг 2: снимите ограничение в карточке приложения" imageHeight={1181} imageSrc="/onboarding/settings-4-restricted.jpg" imageWidth={1280} title="Шаг 2: Снять ограничение"><SecondaryButton icon={ExternalLink} onClick={openAppSettings}>Открыть карточку приложения</SecondaryButton><PrimaryButton disabled={isAndroid && manualConfirmReadyStep !== "accessibility-restricted"} icon={CheckCircle2} onClick={() => go("accessibility-enable")}>Продолжить</PrimaryButton></SettingsImageScreen>;
    if (state.step === "accessibility-enable") return <SettingsImageScreen icon={ShieldCheck} imageAlt="Шаг 3: включите особый доступ Brai" imageHeight={1280} imageSrc="/onboarding/settings-3-accessibility.jpg" imageWidth={1280} title="Шаг 3: Включить доступ"><SecondaryButton icon={ExternalLink} onClick={openAccessibility}>Открыть специальные возможности</SecondaryButton><CheckActionButton status={checkStatus("accessibility-enable")} onClick={checkAccessibility} /></SettingsImageScreen>;

    if (state.step === "microphone") return (
      <SettingsImageScreen icon={Mic} imageAlt="Разрешение микрофона Brai" imageHeight={960} imageSrc="/onboarding/settings-1-microphone.jpg" imageWidth={1280} title="Микрофон">
        {permissionFallbackStep === "microphone" ? <SecondaryButton icon={ExternalLink} onClick={() => openPermissionAppSettings("microphone")}>Открыть настройки приложения</SecondaryButton> : null}
        <CheckActionButton idleLabel={permissionFallbackStep === "microphone" ? "Проверить" : "Разрешить микрофон"} status={checkStatus("microphone")} onClick={requestMic} />
      </SettingsImageScreen>
    );
    if (state.step === "notifications") return (
      <SettingsImageScreen icon={Bell} imageAlt="Разрешение уведомлений Brai" imageHeight={1280} imageSrc="/onboarding/settings-5-notifications.jpg" imageWidth={1280} title="Уведомления">
        {permissionFallbackStep === "notifications" ? <SecondaryButton icon={ExternalLink} onClick={() => openPermissionAppSettings("notifications")}>Открыть настройки приложения</SecondaryButton> : null}
        <CheckActionButton idleLabel={permissionFallbackStep === "notifications" ? "Проверить" : "Разрешить уведомления"} status={checkStatus("notifications")} onClick={requestNotifications} />
      </SettingsImageScreen>
    );

    if (state.step === "training-start") return <InfoScreen icon={CheckCircle2} title="Готово к обучению" text={"Базовая настройка завершена. Осталось проверить голосовой сценарий в четыре шага.\n\nЕсли вы ещё не пользовались Brai CMD, то не пропускайте этот шаг."}><SecondaryButton onClick={completeSetup}>Пропустить</SecondaryButton><PrimaryButton onClick={startTraining}>Обучение</PrimaryButton></InfoScreen>;
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
    if (state.step === "login") return <OnboardingAuthForm busy={busy} onRequestOtp={onRequestOtp} onVerifyOtp={submitCloudVerifyOtp} />;
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
      <OnboardingChromeContext.Provider value={chrome}>
        <main className={cx("fixed inset-0 z-[10000] overflow-hidden bg-transparent text-foreground transition-opacity duration-300 ease-out", screenTransitioning ? "opacity-0" : "opacity-100")} data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
          <style>{startButtonCss}</style>
          <div
            className={cx(
              "absolute inset-x-6 z-10 mx-auto max-w-md",
              startupIntroComplete ? "pointer-events-auto" : "pointer-events-none",
            )}
            style={{
              bottom: "calc(env(safe-area-inset-bottom) + 1.5rem)",
              opacity: startupIntroComplete ? 1 : 0,
              animation: startupIntroComplete ? "brai-onboarding-start-button 300ms ease-out both" : undefined,
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
  const { transitionActive } = useContext(OnboardingChromeContext);
  const checking = status === "checking";
  const failed = status === "error";
  const ready = status === "ready";
  const continuing = transitionActive && !checking && !failed;
  return (
    <PrimaryButton
      disabled={disabled || checking || failed}
      icon={checking ? LoaderCircle : failed ? CircleX : ready || continuing ? CheckCircle2 : ShieldCheck}
      iconClassName={checking ? "animate-spin" : ready || continuing ? "text-emerald-400" : undefined}
      tone={failed ? "danger" : "default"}
      trailingArrow={false}
      onClick={onClick}
    >
      {checking ? "Проверка" : failed ? "Ошибка" : ready || continuing ? "Продолжить" : idleLabel}
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

function StepActions({ children, preserveBottomGap = false }: { children: ReactNode; preserveBottomGap?: boolean }) {
  const { canBack, onBack, statusText, statusTone } = useContext(OnboardingChromeContext);
  const actions = Children.toArray(children).filter(Boolean);
  const mainAction = actions.at(-1);
  const extraActions = actions.slice(0, -1);

  if (!statusText && !mainAction && !canBack) return null;

  return (
    <div className={cx(
      "grid shrink-0 gap-3 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] pt-5",
      preserveBottomGap
        ? "[@media(max-height:700px)]:pb-[calc(env(safe-area-inset-bottom)+1rem)] [@media(max-height:700px)]:pt-3 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pb-[calc(env(safe-area-inset-bottom)+1rem)] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pt-3"
        : "[@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:pb-[calc(env(safe-area-inset-bottom)+0.5rem)] [@media(max-height:700px)]:pt-2 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pb-[calc(env(safe-area-inset-bottom)+0.25rem)] [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:pt-1",
    )}>
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

function InfoBlock({ compactOnShort = false, icon: Icon, title, text }: { compactOnShort?: boolean; icon: LucideIcon; title: string; text?: string }) {
  return (
    <div className={cx("grid min-w-0 gap-4", compactOnShort ? "[@media(max-height:700px)]:gap-2 [@media(max-height:650px)]:gap-1.5 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:gap-1" : "")}>
      <span className={cx("grid size-11 place-items-center rounded-full border border-primary/25 bg-primary/10 text-primary", compactOnShort ? "[@media(max-height:700px)]:size-9 [@media(max-height:650px)]:size-8 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:hidden" : "")}>
        <Icon className={cx("size-5", compactOnShort ? "[@media(max-height:700px)]:size-4 [@media(max-height:650px)]:size-3.5" : "")} aria-hidden="true" />
      </span>
      <div className={cx("grid min-w-0 gap-2", compactOnShort ? "[@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:gap-1" : "")}>
        <h2 className={cx("m-0 break-words text-3xl font-semibold leading-tight", compactOnShort ? "[@media(max-height:700px)]:text-2xl [@media(max-height:650px)]:text-xl [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-xl" : "")}>{title}</h2>
        {text ? <p className={cx("m-0 whitespace-pre-line break-words text-base leading-6 text-muted-foreground", compactOnShort ? "[@media(max-height:700px)]:text-sm [@media(max-height:700px)]:leading-5 [@media(max-height:650px)]:text-sm [@media(max-height:650px)]:leading-5 [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:text-sm [@media(max-height:800px)_and_(min-aspect-ratio:2/3)]:leading-5" : "")}>{text}</p> : null}
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

type OnboardingChoice = {
  badge?: string;
  disabled?: boolean;
  icon?: LucideIcon;
  onClick?: () => void;
  text: string;
  title: string;
};

function ChoiceScreen({ choices, compact = false, text, title }: { choices: OnboardingChoice[]; compact?: boolean; text?: string; title?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className={cx("grid min-h-0 flex-1 content-center overflow-hidden", compact ? "gap-3 py-2 [@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:py-1" : "gap-4 py-4")}>
        {title ? text ? <InfoBlock icon={Radio} title={title} text={text} /> : <h2 className={cx("m-0 break-words font-semibold leading-tight", compact ? "text-3xl [@media(max-height:700px)]:text-2xl [@media(max-height:650px)]:text-xl" : "text-3xl")}>{title}</h2> : null}
        <div className={cx("grid", compact ? "gap-2 sm:grid-cols-3" : "gap-3 sm:grid-cols-2")}>
          {choices.map((choice) => (
            <button key={choice.title} type="button" disabled={choice.disabled} className={cx("group grid items-start rounded-2xl border border-primary/20 bg-card/80 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-primary/10 hover:shadow-md active:translate-y-0 active:scale-[0.98] active:bg-primary/15 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:border-primary/10 disabled:bg-card/35 disabled:text-muted-foreground disabled:opacity-55 disabled:shadow-none", compact ? "min-h-32 grid-cols-[2.75rem_minmax(0,1fr)_auto] gap-x-4 gap-y-2.5 p-4 [@media(max-height:700px)]:min-h-0 [@media(max-height:700px)]:grid-cols-[2.25rem_minmax(0,1fr)_auto] [@media(max-height:700px)]:gap-x-3 [@media(max-height:700px)]:gap-y-1.5 [@media(max-height:700px)]:p-3 [@media(max-height:650px)]:grid-cols-[2rem_minmax(0,1fr)_auto] [@media(max-height:650px)]:gap-x-2 [@media(max-height:650px)]:p-2.5" : "min-h-36 grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 p-5")} onClick={choice.onClick}>
              {choice.icon ? <span className={cx("row-span-2 grid place-items-center border border-primary/20 bg-primary/10 text-primary", compact ? "size-11 rounded-xl [@media(max-height:700px)]:size-9 [@media(max-height:700px)]:rounded-lg [@media(max-height:650px)]:size-8" : "size-10 rounded-xl")}><choice.icon className={compact ? "size-5 [@media(max-height:700px)]:size-4" : "size-5"} aria-hidden="true" /></span> : null}
              <span className={cx("col-start-2 font-semibold leading-tight", compact ? "text-lg [@media(max-height:700px)]:text-base [@media(max-height:650px)]:text-sm" : "text-lg")}>{choice.title}</span>
              {choice.badge ? <span className="col-start-3 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary [@media(max-height:650px)]:px-2 [@media(max-height:650px)]:py-0.5">{choice.badge}</span> : <ArrowRight className="col-start-3 mt-0.5 size-4 text-muted-foreground transition-transform group-hover:translate-x-1" aria-hidden="true" />}
              <span className={cx("col-start-2 col-end-4 text-muted-foreground", compact ? "text-base leading-6 [@media(max-height:700px)]:text-sm [@media(max-height:700px)]:leading-5 [@media(max-height:650px)]:text-xs [@media(max-height:650px)]:leading-4" : "text-base leading-6")}>{choice.text}</span>
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
  const [showStartButton, setShowStartButton] = useState(false);
  const isLastSlide = current === welcomeSlides.length - 1;

  useEffect(() => {
    if (!isLastSlide) return;
    const timer = window.setTimeout(() => setShowStartButton(true), 2000);
    return () => window.clearTimeout(timer);
  }, [isLastSlide]);

  useEffect(() => {
    if (!api) return;
    const index = welcomeStepIndex(currentStep);
    if (api.selectedScrollSnap() !== index) api.scrollTo(index, true);
  }, [api, currentStep]);

  useEffect(() => {
    if (!api) return;
    const onSelect = () => {
      const index = api.selectedScrollSnap();
      setShowStartButton(false);
      setCurrent(index);
      onStepChange(welcomeSlides[index]?.step ?? "welcome-1");
    };
    api.on("select", onSelect);
    return () => {
      api.off("select", onSelect);
    };
  }, [api, onStepChange]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-5 overflow-hidden pt-[clamp(3rem,10dvh,7rem)] [@media(max-height:700px)]:gap-2 [@media(max-height:700px)]:pt-2 [@media(max-height:650px)]:pt-1">
        <Carousel setApi={setApi} opts={{ align: "start", startIndex: welcomeStepIndex(currentStep) }} className="h-full w-full min-w-0 overflow-hidden" aria-label="Приветствие Brai" data-nav-swipe-exclusion>
          <CarouselContent viewportClassName="h-full" className="!ml-0 h-full w-full touch-pan-y gap-4">
            {welcomeSlides.map(({ image, step, text, title }) => (
              <CarouselItem key={step} className="h-full basis-full !pl-0">
                <Card className="relative h-full w-full min-w-0 overflow-hidden rounded-2xl border-primary/15 bg-black p-0 shadow-none">
                  <Image src={image} alt="" width={640} height={1280} className="absolute inset-x-0 top-0 h-auto w-full max-w-none" aria-hidden="true" />
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/45 to-black" aria-hidden="true" />
                  <div className="absolute inset-x-0 bottom-0 flex h-2/3 min-h-0 flex-col px-6 pt-6 [@media(max-height:700px)]:px-4 [@media(max-height:700px)]:pt-4 [@media(max-height:650px)]:px-3 [@media(max-height:650px)]:pt-3">
                    <div className="grid min-h-0 gap-4 [@media(max-height:700px)]:gap-3">
                      <h2 className="m-0 break-words text-3xl font-semibold leading-tight text-white [@media(max-height:700px)]:text-2xl [@media(max-height:650px)]:text-xl">{title}</h2>
                      <p className="m-0 whitespace-pre-line break-words text-base leading-6 text-white/90 [@media(max-height:700px)]:text-sm [@media(max-height:700px)]:leading-5">{text}</p>
                    </div>
                  </div>
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
        <PrimaryButton className={showStartButton ? "opacity-100 duration-500" : "pointer-events-none opacity-0 duration-500"} disabled={!showStartButton} aria-hidden={!showStartButton} tabIndex={showStartButton ? 0 : -1} onClick={onStart}>Начать</PrimaryButton>
      </StepActions>
    </div>
  );
}

function SettingsImageScreen({ children, icon, imageAlt, imageHeight, imageSrc, imageWidth, title }: { children: ReactNode; icon: LucideIcon; imageAlt: string; imageHeight: number; imageSrc: string; imageWidth: number; title: string }) {
  return (
    <StepScreen actions={children}>
      <div className="grid gap-4 [@media(max-height:700px)]:gap-3">
        <InfoBlock icon={icon} title={title} />
        <Card className="overflow-hidden rounded-2xl border-primary/15 bg-card/70 p-0 shadow-none">
          <Image alt={imageAlt} className="h-auto max-h-[34dvh] w-full object-contain [@media(max-height:700px)]:max-h-[28dvh] [@media(max-height:620px)]:max-h-[22dvh]" height={imageHeight} src={imageSrc} unoptimized width={imageWidth} />
        </Card>
      </div>
    </StepScreen>
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

function OnboardingAuthForm(props: {
  busy: boolean;
  onAuthenticated?: () => void;
  onRequestOtp: (email: string) => Promise<OtpSendResult>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
}) {
  return <AuthScreen layout="embedded" {...props} />;
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
        "max-h-[32dvh] min-h-14 justify-center overflow-auto rounded-2xl px-4 py-2 text-base leading-6 shadow-none",
        tone === "bad" ? "border-destructive/35 bg-destructive/10 text-destructive" : tone === "ok" ? "border-primary/30 bg-primary/10 text-foreground" : "border-primary/15 bg-card/60 text-muted-foreground",
      )}
    >
      <p className="m-0 whitespace-pre-line break-words">{text}</p>
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
  if (step === "security") return ShieldCheck;
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
  if (step === "microphone") return "Нужен для голосового ввода команд и диктовки для транскрибации";
  if (step === "overlay") return "Они должны появляться поверх других приложений, чтобы выполнять своё предназначение. Кнопки не собирают никакие данные.";
  if (step === "accessibility-why") return "";
  if (step === "accessibility-blocked") return "Android просто так не разрешает получить этот доступ. Откройте «Специальные возможности» по кнопке ниже и попробуйте включить Brai. Android должен показать, что настройка заблокирована. Это важно. Потом вернитесь назад и нажмите на продолжение.";
  if (step === "accessibility-restricted") return "Откройте карточку приложения, нажмите меню с тремя точками и выберите «разрешить ограниченные настройки». Это меню появляется только, если вы на предыдущем шаге получили отказ.";
  if (step === "accessibility-enable") return "Теперь снова откройте специальные возможности и ещё раз попробуйте включить Brai. Откроется меню, где нужно будет только включить доступ, а затем Разрешить. После вернитесь сюда и нажмите на кнопку Проверки";
  if (step === "notifications") return "Уведомления нужны для фоновой записи, работы очереди, когда нет сети, для получения обратной связи от Брай. Разработчики не шлют вам никаких уведомлений. Это только для вас.";
  return "";
}

function welcomeStepIndex(step: OnboardingStep): number {
  const index = welcomeSlides.findIndex((slide) => slide.step === step);
  return index >= 0 ? index : 0;
}
