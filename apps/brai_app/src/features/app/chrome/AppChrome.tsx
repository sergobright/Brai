"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Lock, Mail, TriangleAlert, WifiOff, X, type LucideIcon } from "lucide-react";
import { useEnvironmentBadgeLabel } from "@/shared/config/runtime";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { OtpSendResult } from "@/shared/api/braiApi";
import type { SyncStatus } from "@/shared/types/timer";
import { AnimatedThemeToggler } from "@/shared/ui/animated-theme-toggler";
import { AuthOtpEntry, type AuthOtpTimer } from "@/shared/ui/auth-otp-entry";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/shared/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/shared/ui/field";
import { Input } from "@/shared/ui/input";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Separator } from "@/shared/ui/separator";
import { TextEffect } from "@/shared/ui/text-effect";
import type { ThemeMode, Tone } from "../appModel";
import { cx } from "../appUtils";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";
import { useMobileSheetTop } from "../hooks/useMobileSheetTop";

const syncStatusIconToneClasses: Record<Tone, string> = {
  ok: "text-primary",
  warn: "text-foreground",
  bad: "text-destructive",
  muted: "text-muted-foreground",
} as const;

export { syncStatusIconToneClasses };

export const authDarkThemeStyle = {
  "--background": "#050607",
  "--foreground": "#f4f4f5",
  "--card": "rgb(15 17 21 / 0.7)",
  "--card-foreground": "#f4f4f5",
  "--popover": "#0f1115",
  "--popover-foreground": "#f4f4f5",
  "--primary": "#f4f4f5",
  "--primary-foreground": "#15171a",
  "--secondary": "#1b2026",
  "--secondary-foreground": "#f4f4f5",
  "--muted": "#1b2026",
  "--muted-foreground": "#a1a1aa",
  "--accent": "#20252d",
  "--accent-foreground": "#f4f4f5",
  "--border": "#2a3038",
  "--input": "#343a44",
  "--ring": "#d4d4d8",
} as CSSProperties;

export function ScreenHeader({
  title,
  icon: Icon,
  syncStatus,
  pendingCount,
  leading,
  desktopLeading,
  trailing,
}: {
  title: string;
  icon: LucideIcon;
  syncStatus: SyncStatus;
  pendingCount: number;
  leading?: ReactNode;
  desktopLeading?: ReactNode;
  trailing?: ReactNode;
}) {
  const environmentLabel = useEnvironmentBadgeLabel();

  return (
    <header className="topbar sticky top-[var(--sticky-top-offset)] z-[18] mb-2 grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 bg-transparent py-2 max-[860px]:min-h-[50px] max-[860px]:gap-2.5 max-[860px]:py-1 max-[860px]:pb-2">
      <div className="topbar-leading hidden max-[860px]:flex" data-galaxy-interaction-block>{leading}</div>
      <div className="hidden items-center gap-2 min-[861px]:flex">
        {desktopLeading ?? <Icon className="size-5 text-foreground" data-screen-icon aria-hidden="true" />}
        <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      </div>
      <div className="screen-title min-w-0">
        <TextEffect key={title} as="h1" per="char" preset="fade" className="m-0 text-2xl font-semibold leading-tight">
          {title}
        </TextEffect>
      </div>
      <div className="topbar-actions flex shrink-0 items-center gap-2.5 max-[860px]:max-w-[min(184px,50vw)] max-[460px]:max-w-[min(174px,50vw)]" data-galaxy-interaction-block>
        {trailing}
        {environmentLabel ? <EnvironmentBadge className="min-[861px]:hidden" label={environmentLabel} /> : null}
        <StatusPill className="min-[861px]:hidden" status={syncStatus} pendingCount={pendingCount} />
      </div>
    </header>
  );
}

export function EnvironmentBadge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={cx("inline-grid h-[30px] min-w-[30px] place-items-center rounded-md border border-border bg-card px-2 text-xs font-semibold text-muted-foreground", className)}>
      {label}
    </span>
  );
}

export function ThemeButton({ theme, onTheme }: { theme: ThemeMode; onTheme: (theme: ThemeMode) => void }) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <AnimatedThemeToggler
      className="theme-button inline-grid h-[42px] w-[42px] place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary focus-visible:text-primary [&_svg]:h-5 [&_svg]:w-5"
      title={next === "dark" ? "Темная тема" : "Светлая тема"}
      aria-label={next === "dark" ? "Включить темную тему" : "Включить светлую тему"}
      theme={theme}
      onThemeChange={onTheme}
      variant="circle"
    />
  );
}

export function IconButton({
  icon: Icon,
  label,
  active,
  className,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(
        "theme-button inline-grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary focus-visible:text-primary [&_svg]:pointer-events-none",
        active && "border-primary/40 bg-accent text-accent-foreground",
        className,
      )}
      title={label}
      aria-label={label}
      aria-pressed={active ?? undefined}
      onClick={onClick}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

export function MobileContextSheet({
  label,
  className,
  children,
  contentInset = "balanced",
  onClose,
  onCloseStart,
  scroll = true,
  variant = "context",
}: {
  label: string;
  className?: string;
  children: ReactNode;
  contentInset?: "balanced" | "end" | "none";
  onClose: () => void;
  onCloseStart?: () => void;
  scroll?: boolean;
  variant?: "context" | "detail";
}) {
  const suppressPopRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const sheetTop = useMobileSheetTop();
  const { backdropRef, backdropStyle, closeWithAnimation, resetOpen, sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({ onClose, onCloseStart });

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    resetOpen();
    if (window.history.state?.braiMobileSheet) {
      window.history.replaceState({ ...window.history.state, braiMobileSheet: label }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, braiMobileSheet: label }, "", window.location.href);
    }

    function onPopState() {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      closeWithAnimation();
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeWithAnimation, label, resetOpen]);

  function closeSheet() {
    if (window.history.state?.braiMobileSheet === label) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
  }

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.braiMobileSheet === label) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
    return true;
  }), [closeWithAnimation, label]);

  return (
    <div
      className={cx("mobile-context-backdrop pointer-events-none fixed inset-0 z-[84] hidden items-end max-[860px]:flex", className)}
      style={{ top: sheetTop } as CSSProperties}
      data-nav-swipe-exclusion
    >
      <div
        ref={backdropRef}
        className="pointer-events-none absolute inset-0 z-0 bg-foreground/20 dark:bg-background/80"
        style={backdropStyle}
        aria-hidden="true"
      />
      <aside
        ref={sheetRef}
        className={cx(
          "pointer-events-auto relative z-[1] grid max-h-full w-full min-w-0 overflow-hidden rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] shadow-xl animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform",
          variant === "detail"
            ? "actions-detail-panel mobile h-full grid-rows-[auto_minmax(0,1fr)] gap-0 pt-1"
            : "mobile-context-sheet grid-rows-[auto_minmax(0,1fr)] pt-2",
        )}
        style={sheetStyle}
        aria-label={label}
        {...sheetDragHandlers}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={cx("relative flex items-start justify-center", variant === "detail" ? "h-3 min-h-3 pt-0" : "min-h-12 pt-4")}>
          <button type="button" className="sr-only" aria-label={`Закрыть панель: ${label}`} onClick={closeSheet}>
            Закрыть
          </button>
          <div
            className={cx(
              "absolute left-1/2 top-0 flex w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center active:cursor-grabbing",
              variant === "detail" ? "actions-detail-drag-zone h-3 pt-0.5" : "mobile-context-drag-zone h-6 pt-1.5",
            )}
          >
            <span className={cx("h-1 w-11 rounded-full bg-muted-foreground/30", variant === "detail" ? "actions-detail-grabber" : "mobile-context-grabber")} aria-hidden="true" />
          </div>
          {variant === "context" ? <h2 className="m-0 text-lg font-semibold leading-tight">{label}</h2> : null}
        </header>
        {scroll ? <ScrollArea className="min-h-0" contentInset={contentInset}>{children}</ScrollArea> : children}
        {variant === "detail" ? <MobileDetailFloatingCloseButton ariaLabel={`Закрыть панель: ${label}`} onClick={closeSheet} /> : null}
      </aside>
    </div>
  );
}

export function MobileDetailFloatingCloseButton({
  ariaLabel = "Закрыть панель",
  onClick,
}: {
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="actions-detail-close fixed bottom-[calc(20px+env(safe-area-inset-bottom))] right-[18px] z-[2] grid h-[58px] w-[58px] place-items-center rounded-full border-0 bg-primary text-primary-foreground shadow-lg"
      aria-label={ariaLabel}
      title="Закрыть"
      onClick={onClick}
    >
      <X className="h-7 w-7" aria-hidden="true" />
    </button>
  );
}

export function StatusPill({ className, status, pendingCount }: { className?: string; status: SyncStatus; pendingCount: number }) {
  const { label, tone, icon: Icon, spinning } = syncStatusMeta(status, pendingCount);

  return (
    <span
      className={cx(
        "status-pill inline-grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border-0 bg-transparent p-0",
        syncStatusIconToneClasses[tone],
        className,
      )}
      title={label}
      aria-label={label}
      role="status"
    >
      <Icon className={cx("size-5", spinning && "animate-spin")} aria-hidden="true" />
    </span>
  );
}

export function syncStatusMeta(status: SyncStatus, pendingCount: number): { label: string; tone: Tone; icon: LucideIcon; spinning?: boolean } {
  if (status === "synced") return { label: "синхронизировано", tone: "ok", icon: CheckCircle2 };
  if (status === "pending_sync") {
    return {
      label: pendingCount > 0 ? `в очереди: ${pendingCount}` : "ожидает синхронизации",
      tone: "warn",
      icon: Loader2,
      spinning: true,
    };
  }
  if (status === "offline") return { label: "оффлайн", tone: "muted", icon: WifiOff };
  if (status === "auth_required") return { label: "нужен вход", tone: "bad", icon: Lock };
  if (status === "sync_failed") return { label: "сбой", tone: "bad", icon: TriangleAlert };
  return { label: "подключение", tone: "muted", icon: Loader2, spinning: true };
}

function IconGlyph({ emoji, className = "" }: { emoji: string; className?: string }) {
  return (
    <span
      className={cx(
        "ui-emoji inline-grid h-[1.2em] w-[1.2em] flex-[0_0_auto] place-items-center leading-none [font-family:'Apple_Color_Emoji','Segoe_UI_Emoji','Noto_Color_Emoji',sans-serif]",
        className,
      )}
      aria-hidden="true"
    >
      {emoji}
    </span>
  );
}

export function AuthPanel({
  busy,
  className = "mt-[52px]",
  mode = "otp",
  onAuthenticated,
  onEmailLogin,
  onRequestOtp,
  onVerifyOtp,
}: {
  busy: boolean;
  className?: string;
  mode?: "email" | "otp";
  onAuthenticated?: () => void;
  onEmailLogin?: (email: string) => Promise<void>;
  onRequestOtp: (email: string) => Promise<OtpSendResult>;
  onVerifyOtp: (email: string, otp: string) => Promise<void>;
}) {
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpFocusKey, setOtpFocusKey] = useState(0);
  const [otpTimer, setOtpTimer] = useState<AuthOtpTimer>(defaultOtpTimer);
  const [error, setError] = useState("");

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      if (mode === "email") {
        if (!onEmailLogin) throw new Error("email_login_unavailable");
        await onEmailLogin(email);
        onAuthenticated?.();
        return;
      }
      if (!otpSent) {
        await requestOtpCode();
        return;
      }
      await onVerifyOtp(email, otp);
      onAuthenticated?.();
    } catch {
      setError(mode === "email" ? "Email не подошёл" : otpSent ? "Код не подошел" : "Не удалось отправить код");
    }
  }

  async function requestOtpCode() {
    setOtpSent(true);
    setOtp("");
    setOtpTimer((current) => ({ ...current, sentAtMs: null }));
    setOtpFocusKey((current) => current + 1);
    try {
      applyOtpResult(await onRequestOtp(email));
    } catch (error) {
      setOtpSent(false);
      throw error;
    }
  }

  async function resendOtpCode() {
    setError("");
    setOtp("");
    applyOtpResult(await onRequestOtp(email));
  }

  const emailInputId = `${inputId}-email`;
  const otpInputId = `${inputId}-otp`;

  return (
    <Card
      className={cx(className, "w-full backdrop-blur-md sm:max-w-md")}
      style={authDarkThemeStyle}
      render={<form onSubmit={submitAuth} />}
    >
      <CardHeader>
        <CardTitle>Вход в Brai</CardTitle>
        <CardDescription>
          {mode === "email" ? "Введите почту для входа в тестовый аккаунт." : "Введите почту, чтобы получить код для входа или регистрации."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup className="gap-4">
          <Field data-invalid={Boolean(error && (mode === "email" || !otpSent))}>
            <FieldLabel htmlFor={emailInputId}>Почта</FieldLabel>
            <Input
              id={emailInputId}
              value={email}
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="Введите почту"
              aria-label="Email"
              aria-invalid={Boolean(error && (mode === "email" || !otpSent))}
              disabled={busy || (mode === "otp" && otpSent)}
              onChange={(event) => setEmail(event.target.value)}
            />
            <FieldDescription>
              {mode === "email" ? "Код подтверждения в этом режиме не нужен." : "Мы отправим одноразовый код на эту почту."}
            </FieldDescription>
          </Field>
          <div className="h-[140px]">
            {mode === "otp" && otpSent ? (
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor={otpInputId}>Код</FieldLabel>
                <AuthOtpEntry
                  id={otpInputId}
                  value={otp}
                  timer={otpTimer}
                  autoFocusKey={otpFocusKey}
                  ariaInvalid={Boolean(error)}
                  disabled={busy && otpTimer.sentAtMs !== null}
                  onChange={setOtp}
                  onResend={resendOtpCode}
                />
              </Field>
            ) : (
              <div className="invisible h-full" aria-hidden="true" />
            )}
          </div>
          <div className="min-h-5">
            {error ? <FieldError>{error}</FieldError> : null}
          </div>
        </FieldGroup>
      </CardContent>
      <CardFooter>
        <Button className="w-full" disabled={busy || !email || (mode === "otp" && otpSent && !otp)}>
          {mode === "otp" && otpSent ? <KeyRound aria-hidden="true" /> : <Mail aria-hidden="true" />}
          {mode === "email" || otpSent ? "Войти" : "Получить код"}
        </Button>
      </CardFooter>
    </Card>
  );

  function applyOtpResult(result: OtpSendResult) {
    const nowMs = Date.now();
    const previousSentAtMs = otpTimer.sentAtMs;
    const previousStillValid =
      previousSentAtMs !== null && nowMs < previousSentAtMs + otpTimer.expiresInSeconds * 1000;
    setOtpTimer({
      sentAtMs: result.resend_strategy === "reuse" && previousStillValid ? previousSentAtMs : nowMs,
      expiresInSeconds: positiveSeconds(result.expires_in_seconds, defaultOtpTimer.expiresInSeconds),
      resendAfterSeconds: positiveSeconds(result.resend_after_seconds, defaultOtpTimer.resendAfterSeconds),
    });
    setOtpFocusKey((current) => current + 1);
  }
}

const defaultOtpTimer: AuthOtpTimer = {
  sentAtMs: null,
  expiresInSeconds: 5 * 60,
  resendAfterSeconds: 60,
};

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function EmptyState({
  emoji,
  title,
  body,
}: {
  emoji: string;
  title: string;
  body: string;
}) {
  return (
    <Card className="mt-[52px] grid w-[min(520px,100%)] justify-items-start gap-3 p-6">
      <IconGlyph emoji={emoji} />
      <h2 className="m-0 text-base leading-[1.2]">{title}</h2>
      <p className="m-0 font-normal text-muted-foreground">{body}</p>
    </Card>
  );
}
