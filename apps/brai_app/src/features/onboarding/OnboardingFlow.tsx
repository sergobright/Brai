"use client";

import Image from "next/image";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  Cloud,
  Command,
  FileAudio,
  KeyRound,
  Lock,
  Mic,
  MonitorUp,
  Radio,
  ScreenShare,
  Send,
  Server,
  ShieldCheck,
  Sparkles,
  TextCursorInput,
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
import { getBraiCmdState, setBraiCmdVoiceOnlyMode } from "@/shared/platform/braiCmd";
import { isNativeShell, platformName } from "@/shared/platform/platform";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { AnimatedShinyText } from "@/shared/ui/animated-shiny-text";
import { Button } from "@/shared/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import { ScrollArea } from "@/shared/ui/scroll-area";
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

const cloudHealthPath = "/v1/brai-cmd/health";

export function shouldShowOnboarding(authRequired: boolean): boolean {
  const state = loadOnboardingState();
  return !state.complete || authRequired;
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
  const [queuedText, setQueuedText] = useState("");
  const [insertedText, setInsertedText] = useState("");
  const isAndroid = isNativeShell() && platformName() === "android";
  const progress = stepProgress(state.step);
  const screen = screenMeta(state.step);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      const loaded = loadOnboardingState();
      setState(loaded.complete && authRequired ? { ...loaded, step: "locked", history: [] } : loaded);
    }, 0);
    void refreshCapabilities();
    return () => window.clearTimeout(timeout);
  }, [authRequired]);

  useEffect(() => {
    if (state.complete && !authRequired) onDone();
  }, [authRequired, onDone, state.complete]);

  useEffect(() => {
    if (state.step !== "training-dictate" && state.step !== "training-offline" && state.step !== "training-queue") return;
    const timeout = window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>("[data-onboarding-training-input]")?.focus();
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [state.step]);

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
    update({ ...next, step, history: [...state.history, state.step] });
  }

  function back() {
    const previous = state.history.at(-1);
    if (!previous) return;
    update({ step: previous, history: state.history.slice(0, -1) });
  }

  function completeSetup() {
    void setBraiCmdVoiceOnlyMode(false);
    const nextState = { ...state, complete: true, step: "login-check" as const, history: [...state.history, state.step] };
    saveOnboardingState(nextState);
    setState(nextState);
  }

  function choosePath(path: "new" | "existing") {
    go(path === "new" ? "name" : "profile-version", { path });
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

  function submitAccessKey(key: string) {
    if (key.trim().length < 8) {
      setError("Введите полный ключ доступа.");
      return;
    }
    go("setup-start");
  }

  async function testProviderKey() {
    if (!provider.trim() || providerKey.trim().length < 8) {
      setError("Выберите поставщика и введите полный ключ.");
      return;
    }
    setMessage("Ключ сохранен. Полная проверка пройдет при первой расшифровке аудио.");
    window.setTimeout(() => go("overlay"), 450);
  }

  async function testLocalServer() {
    setError("");
    try {
      const url = new URL(localUrl.trim());
      const response = await fetch(url.href, { method: "GET" });
      if (!response.ok) throw new Error("bad_status");
      go("overlay");
    } catch {
      setError("Сервер не ответил на проверку. Проверьте URL и доступность health endpoint.");
    }
  }

  async function testCloudVoice() {
    setError("");
    try {
      const response = await fetch(cloudHealthPath);
      if (!response.ok) throw new Error("bad_status");
      go("overlay");
    } catch {
      setError("Облачный модуль сейчас недоступен. Можно вернуться и выбрать другой способ.");
    }
  }

  async function openOverlay() {
    if (!isAndroid) {
      setMessage("В веб-просмотре системное разрешение считается включенным.");
      go("accessibility-why");
      return;
    }
    await openAndroidOverlaySettings();
    setMessage("Вернитесь сюда после включения разрешения поверх экрана.");
    await refreshCapabilities();
  }

  async function checkOverlay() {
    const next = await refreshCapabilities();
    if (!isAndroid || next?.overlayGranted) go("accessibility-why");
    else setError("Разрешение поверх экрана еще не включено.");
  }

  async function openAccessibility() {
    if (!isAndroid) {
      setMessage("В веб-просмотре шаг считается пройденным.");
      return;
    }
    await openAndroidAccessibilitySettings();
    setMessage("Вернитесь сюда после системного шага.");
    await refreshCapabilities();
  }

  async function openAppSettings() {
    if (!isAndroid) {
      setMessage("В веб-просмотре карточка приложения недоступна.");
      return;
    }
    await openAndroidAppSettings();
    setMessage("Откройте меню с тремя точками и выберите «Разрешить ограниченные настройки».");
  }

  async function checkAccessibility() {
    const next = await refreshCapabilities();
    if (!isAndroid || next?.accessibilityServiceEnabled) go("microphone");
    else setError("Специальные возможности Brai пока не включены.");
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
    if (isAndroid) {
      const cmdState = await getBraiCmdState();
      if (cmdState?.accessGranted === false) {
        setError("Сначала откройте Brai CMD и получите доступ. После возврата нажмите «Обучение» еще раз.");
        await onOpenNativeCmdSettings();
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
      return (
        <div className="grid justify-items-center gap-8 text-center">
          <Image className="h-auto w-72 max-w-full" src="/brand/brai-logo-transparent.svg" width="779" height="368" alt="Brai" priority draggable={false} />
          <div className="grid w-full gap-4">
            <p className="m-0 text-sm text-muted-foreground">Приложение скачано, но еще не подготовлено к работе.</p>
            <ShinyButton onClick={() => go("welcome-1")}>Приступить</ShinyButton>
          </div>
        </div>
      );
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
        <form className="grid gap-5" onSubmit={(event) => {
          event.preventDefault();
          if (!state.name.trim()) return setError("Введите имя.");
          go("setup-start");
        }}>
          <InfoBlock icon={UserRound} title="Как к вам обращаться?" text="Имя нужно для приветствия и будущих голосовых подсказок." />
          <Input value={state.name} placeholder="Ваше имя" aria-label="Имя" onChange={(event) => update({ name: event.target.value })} />
          <PrimaryButton>Продолжить</PrimaryButton>
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
        <div className="grid gap-4">
          <InfoBlock icon={Lock} title="Вход в облачный профиль" text="Пока для входа нужен только пароль." />
          <OnboardingAuthForm busy={busy} mode="password" onLogin={submitCloudLogin} onRequestOtp={onRequestOtp} onVerifyOtp={onVerifyOtp} />
        </div>
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
        state.profileVersion === "self-hosted"
          ? { icon: Server, title: "Локальная модель", text: "Подключить URL модели на вашем сервере.", onClick: () => chooseVoiceMode("local") }
          : { icon: Cloud, title: "Облачный модуль", text: "Использовать облачное распознавание Brai.", onClick: () => chooseVoiceMode("cloud") },
      ];
      return <ChoiceScreen title="Как распознавать голос?" text="Выберите способ, который будет использовать Brai CMD." choices={choices} />;
    }

    if (state.step === "provider-key") {
      return (
        <div className="grid gap-4">
          <InfoBlock icon={KeyRound} title="Ключ поставщика" text="Выберите поставщика, введите ключ и сохраните его для голосового модуля." />
          <Input value={provider} aria-label="Поставщик" onChange={(event) => setProvider(event.target.value)} />
          <Input value={providerKey} type="password" aria-label="Ключ поставщика" placeholder="API-ключ" onChange={(event) => setProviderKey(event.target.value)} />
          <PrimaryButton onClick={testProviderKey}>Проверить</PrimaryButton>
        </div>
      );
    }

    if (state.step === "local-server") {
      return (
        <div className="grid gap-4">
          <InfoBlock icon={Server} title="Локальный сервер" text="Введите URL endpoint, который принимает аудио или отвечает health-проверкой." />
          <Input value={localUrl} type="url" aria-label="URL локального сервера" placeholder="https://server.example/health" onChange={(event) => setLocalUrl(event.target.value)} />
          <PrimaryButton onClick={testLocalServer}>Проверить сервер</PrimaryButton>
        </div>
      );
    }

    if (state.step === "cloud-privacy") return <InfoScreen icon={Cloud} title="Приватность облака" text="Аудио проходит через серверы Brai для расшифровки. Мы не храним содержимое запросов."><PrimaryButton onClick={testCloudVoice}>Согласен</PrimaryButton></InfoScreen>;

    if (state.step === "overlay") {
      return (
        <PermissionScreen icon={MonitorUp} title="Поверх других приложений" text="Это разрешение нужно, чтобы плавающая кнопка Brai была доступна поверх текущего приложения.">
          <PrimaryButton onClick={openOverlay}>Открыть настройки</PrimaryButton>
          <Button variant="outline" onClick={checkOverlay}>Я включил</Button>
        </PermissionScreen>
      );
    }

    if (state.step === "accessibility-why") return <InfoScreen icon={ShieldCheck} title="Специальные возможности" text="Они нужны, чтобы вставлять текст в поля, работать с буфером и выполнять действия на экране."><PrimaryButton onClick={() => go("accessibility-blocked")}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "accessibility-blocked") return <InfoScreen icon={Lock} title="Шаг 1: получить отказ" text="Откройте специальные возможности и попробуйте включить Brai. Android должен показать, что настройка заблокирована."><PrimaryButton onClick={openAccessibility}>Открыть</PrimaryButton><Button variant="outline" onClick={() => go("accessibility-restricted")}>Да, доступ заблокирован</Button></InfoScreen>;
    if (state.step === "accessibility-restricted") return <InfoScreen icon={ShieldCheck} title="Шаг 2: снять ограничение" text="Откройте карточку приложения, нажмите меню с тремя точками и выберите «Разрешить ограниченные настройки»."><PrimaryButton onClick={openAppSettings}>Открыть карточку приложения</PrimaryButton><Button className="min-h-12 rounded-full" variant="outline" onClick={() => go("accessibility-enable")}>Ограничение снято</Button></InfoScreen>;
    if (state.step === "accessibility-enable") return <InfoScreen icon={ShieldCheck} title="Шаг 3: включить доступ" text="Теперь снова откройте специальные возможности и включите Brai. После возврата мы проверим состояние."><PrimaryButton onClick={openAccessibility}>Открыть</PrimaryButton><Button variant="outline" onClick={checkAccessibility}>Проверить</Button></InfoScreen>;

    if (state.step === "microphone") return <PermissionScreen icon={Mic} title="Микрофон" text="Микрофон нужен для голосового ввода и команд."><PrimaryButton onClick={requestMic}>Разрешить микрофон</PrimaryButton></PermissionScreen>;
    if (state.step === "notifications") return <PermissionScreen icon={Bell} title="Уведомления" text="Уведомления нужны для фоновой записи, очереди и статуса отправки."><PrimaryButton onClick={requestNotifications}>Разрешить уведомления</PrimaryButton></PermissionScreen>;

    if (state.step === "training-start") return <InfoScreen icon={CheckCircle2} title="Готово к обучению" text="Базовая настройка завершена. Осталось проверить голосовой сценарий в четыре шага."><PrimaryButton onClick={startTraining}>Обучение</PrimaryButton><Button variant="outline" onClick={completeSetup}>Пропустить</Button></InfoScreen>;
    if (state.step === "training-dictate") return <TrainingDictate value={trainingText} onChange={setTrainingText} onNext={() => trainingText.trim() ? go("training-offline") : setError("Надиктуйте фразу через плавающую кнопку Brai CMD.")} />;
    if (state.step === "training-offline") return <TrainingOffline value={queuedText} onChange={setQueuedText} onNext={() => queuedText.trim() ? go("training-queue") : setError("Надиктуйте сообщение через плавающую кнопку Brai CMD.")} />;
    if (state.step === "training-queue") return <TrainingQueue value={insertedText} queued={queuedText} onChange={setInsertedText} onNext={() => insertedText.trim() ? go("training-storage") : setError("Вставьте результат через плавающую кнопку Brai CMD.")} />;
    if (state.step === "training-storage") return <InfoScreen icon={FileAudio} title="Хранилище аудиозаписей" text="Аудиозаписи могут храниться в защищенной очереди устройства до отправки на расшифровку. После успешной обработки они очищаются согласно настройкам Brai CMD."><PrimaryButton onClick={() => go("voice-ready")}>Продолжить</PrimaryButton></InfoScreen>;

    if (state.step === "voice-ready") return <InfoScreen icon={CheckCircle2} title="Голосовое управление настроено" text="Brai CMD готов принимать голос, работать с очередью и вставлять результат в поле."><PrimaryButton onClick={completeSetup}>Готово</PrimaryButton></InfoScreen>;
    if (state.step === "login-check") return <InfoScreen icon={Lock} title="Проверяем вход" text="Если профиль уже открыт, вы попадете в кабинет. Если нет — доступ будет ограничен входом и настройками."><PrimaryButton onClick={() => authRequired ? go("locked") : onDone()}>Продолжить</PrimaryButton></InfoScreen>;
    if (state.step === "locked") return <InfoScreen icon={Lock} title="Нужен вход" text="Пока вы не вошли, доступны только вход и настройки Brai CMD."><PrimaryButton onClick={() => go("login")}>Войти</PrimaryButton><Button variant="outline" onClick={openCmdSettings}>Настройки Brai CMD</Button></InfoScreen>;
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

  return (
    <main className="grid h-dvh min-h-0 bg-black text-foreground" data-onboarding-flow data-theme="dark" style={{ colorScheme: "dark" }}>
      <ScrollArea className="min-h-0">
        <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] pt-[calc(env(safe-area-inset-top)+2.75rem)] sm:max-w-2xl sm:px-8 sm:pt-8">
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
          <Progress value={progress} aria-label="Прогресс настройки" />
          {screen.description ? <p className="m-0 text-sm text-muted-foreground">{screen.description}</p> : null}
          {error ? <StatusAlert tone="bad" title="Нужно проверить" text={error} /> : null}
          {message ? <StatusAlert tone="ok" title="Готово" text={message} /> : null}
          <section className="flex min-h-0 flex-1 flex-col justify-center py-8">
            {body}
          </section>
        </div>
      </ScrollArea>
    </main>
  );
}

function ShinyButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button
      size="lg"
      variant="outline"
      className="min-h-12 w-full overflow-hidden rounded-full border-primary/35 bg-primary/10 px-6 text-base shadow-lg shadow-primary/10 hover:bg-primary/15"
      onClick={onClick}
    >
      <AnimatedShinyText shimmerWidth={140} className="font-semibold text-foreground/90 dark:text-foreground">
        {children}
      </AnimatedShinyText>
    </Button>
  );
}

function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return <Button className={cx("min-h-12 w-full rounded-full sm:w-auto", props.className)} {...props} />;
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
    <div className="grid gap-6">
      {eyebrow ? <p className="m-0 text-sm font-medium text-muted-foreground">{eyebrow}</p> : null}
      <InfoBlock icon={icon} title={title} text={text} />
      <div className="grid gap-3 sm:flex sm:flex-wrap">{children}</div>
    </div>
  );
}

function ChoiceScreen({ choices, text, title }: { choices: Array<{ icon: LucideIcon; title: string; text: string; onClick: () => void }>; text: string; title: string }) {
  return (
    <div className="grid gap-5">
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
      <div className="flex flex-wrap gap-2">{children}</div>
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
    <form className="grid gap-4" onSubmit={(event) => {
      event.preventDefault();
      onSubmit(key);
    }}>
      <InfoBlock icon={KeyRound} title="Ключ доступа" text="Введите ключ self-hosted профиля, чтобы связать приложение с вашим сервером." />
      <Input value={key} type="password" aria-label="Ключ доступа" placeholder="Ключ доступа" onChange={(event) => setKey(event.target.value)} />
      <PrimaryButton>Подключить</PrimaryButton>
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

function TrainingDictate({ onChange, onNext, value }: { value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <div className="grid gap-4">
      <InfoBlock icon={Mic} title="Шаг 1: голос в поле" text="Надиктуйте фразу. Она должна появиться в поле ввода." />
      <VoiceOnlyTextarea value={value} placeholder="Здесь появится результат голосового ввода" ariaLabel="Результат голосового ввода" onChange={onChange} />
      {value.trim() ? <PrimaryButton onClick={onNext}>Да, вставилось</PrimaryButton> : null}
    </div>
  );
}

function TrainingOffline({ onChange, onNext, value }: { value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <div className="grid gap-4">
      <InfoBlock icon={WifiOff} title="Шаг 2: очередь без связи" text="Имитируем отсутствие связи: надиктованное сообщение должно попасть в очередь." />
      <VoiceOnlyTextarea value={value} placeholder="Здесь появится сообщение для очереди" ariaLabel="Текст в очереди" onChange={onChange} />
      {value.trim() ? <PrimaryButton onClick={onNext}>Сообщение в очереди</PrimaryButton> : null}
    </div>
  );
}

function TrainingQueue({ onChange, onNext, queued, value }: { queued: string; value: string; onChange: (value: string) => void; onNext: () => void }) {
  return (
    <div className="grid gap-4">
      <InfoBlock icon={Send} title="Шаг 3: расшифровка из очереди" text="Данные из очереди отправляются на расшифровку. После обработки вставьте результат в поле." />
      <Alert>
        <FileAudio aria-hidden="true" />
        <AlertTitle>В очереди</AlertTitle>
        <AlertDescription>{queued}</AlertDescription>
      </Alert>
      <VoiceOnlyTextarea value={value} placeholder="Здесь появится результат из очереди" ariaLabel="Результат из очереди" onChange={onChange} />
      {value.trim() ? <PrimaryButton onClick={onNext}>Данные вставлены</PrimaryButton> : null}
    </div>
  );
}

function VoiceOnlyTextarea({ ariaLabel, onChange, placeholder, value }: { ariaLabel: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <Textarea
      data-onboarding-training-input
      autoFocus
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Tab" || event.key === "Escape") return;
        event.preventDefault();
      }}
      onPaste={(event) => event.preventDefault()}
    />
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

function screenMeta(step: OnboardingStep): { title: string; description?: string } {
  if (step === "locked") return { title: "Доступ ограничен", description: "До входа в профиль показываем только вход и настройки." };
  if (step === "cmd-settings") return { title: "Настройки Brai CMD" };
  if (step.startsWith("training")) return { title: "Обучение" };
  if (step === "voice-choice" || step === "provider-key" || step === "local-server" || step === "cloud-privacy") return { title: "Голосовой модуль" };
  if (step === "overlay" || step.startsWith("accessibility") || step === "microphone" || step === "notifications") return { title: "Разрешения" };
  if (step.startsWith("welcome")) return { title: "Приветствие" };
  return { title: "Настройка Brai" };
}
