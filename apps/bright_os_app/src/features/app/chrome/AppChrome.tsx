"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Lock, TriangleAlert, WifiOff, type LucideIcon } from "lucide-react";
import { ENVIRONMENT_BADGE_LABEL, isProductionEnvironment } from "@/shared/config/runtime";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { SyncStatus } from "@/shared/types/timer";
import { AnimatedThemeToggler } from "@/shared/ui/animated-theme-toggler";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
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

export function ScreenHeader({
  title,
  icon: Icon,
  syncStatus,
  pendingCount,
  leading,
  trailing,
}: {
  title: string;
  icon: LucideIcon;
  syncStatus: SyncStatus;
  pendingCount: number;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <header className="topbar sticky top-[var(--sticky-top-offset)] z-[18] mb-2 grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 bg-transparent py-2 max-[860px]:min-h-[50px] max-[860px]:gap-2.5 max-[860px]:py-1 max-[860px]:pb-2">
      <div className="topbar-leading hidden max-[860px]:flex" data-galaxy-interaction-block>{leading}</div>
      <div className="hidden items-center gap-2 min-[861px]:flex">
        <Icon className="size-5 text-foreground" data-screen-icon aria-hidden="true" />
        <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
      </div>
      <div className="screen-title min-w-0">
        <TextEffect key={title} as="h1" per="char" preset="fade" className="m-0 text-2xl font-semibold leading-tight">
          {title}
        </TextEffect>
      </div>
      <div className="topbar-actions flex shrink-0 items-center gap-2.5 max-[860px]:max-w-[min(184px,50vw)] max-[460px]:max-w-[min(174px,50vw)]" data-galaxy-interaction-block>
        {trailing}
        {!isProductionEnvironment() && ENVIRONMENT_BADGE_LABEL ? <EnvironmentBadge label={ENVIRONMENT_BADGE_LABEL} /> : null}
        <StatusPill status={syncStatus} pendingCount={pendingCount} />
      </div>
    </header>
  );
}

function EnvironmentBadge({ label }: { label: string }) {
  return (
    <span className="inline-grid h-[30px] min-w-[30px] place-items-center rounded-md border border-border bg-card px-2 text-xs font-semibold text-muted-foreground">
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
        "theme-button inline-grid h-[42px] w-[42px] place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:text-primary focus-visible:text-primary",
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
  onClose,
  onCloseStart,
}: {
  label: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
  onCloseStart?: () => void;
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
    if (window.history.state?.brightMobileSheet) {
      window.history.replaceState({ ...window.history.state, brightMobileSheet: label }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, brightMobileSheet: label }, "", window.location.href);
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
    if (window.history.state?.brightMobileSheet === label) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
  }

  useEffect(() => installAndroidBackHandler(() => {
    if (window.history.state?.brightMobileSheet === label) {
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
        className="mobile-context-sheet pointer-events-auto relative z-[1] grid max-h-full w-full min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] pt-2 shadow-xl animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform"
        style={sheetStyle}
        aria-label={label}
        {...sheetDragHandlers}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="relative flex min-h-12 items-start justify-center pt-4">
          <button type="button" className="sr-only" aria-label={`Закрыть панель: ${label}`} onClick={closeSheet}>
            Закрыть
          </button>
          <div
            className="mobile-context-drag-zone absolute left-1/2 top-0 flex h-6 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-1.5 active:cursor-grabbing"
          >
            <span className="mobile-context-grabber h-1 w-11 rounded-full bg-muted-foreground/30" aria-hidden="true" />
          </div>
          <h2 className="m-0 text-lg font-semibold leading-tight">{label}</h2>
        </header>
        <ScrollArea className="min-h-0" contentInset="balanced">{children}</ScrollArea>
      </aside>
    </div>
  );
}

function StatusPill({ status, pendingCount }: { status: SyncStatus; pendingCount: number }) {
  const { label, tone, icon: Icon, spinning } = statusMeta(status, pendingCount);

  return (
    <span
      className={cx(
        "status-pill inline-grid h-[42px] w-[42px] shrink-0 place-items-center rounded-lg border-0 bg-transparent p-0",
        syncStatusIconToneClasses[tone],
      )}
      title={label}
      aria-label={label}
      role="status"
    >
      <Icon className={cx("size-5", spinning && "animate-spin")} aria-hidden="true" />
    </span>
  );
}

function statusMeta(status: SyncStatus, pendingCount: number): { label: string; tone: Tone; icon: LucideIcon; spinning?: boolean } {
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

export function AuthPanel({ busy, onLogin }: { busy: boolean; onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onLogin(password);
  }

  return (
    <Card className="mt-[52px] grid w-[min(520px,100%)] justify-items-start gap-3 p-6" render={<form onSubmit={submit} />}>
      <Lock aria-hidden="true" className="size-5 text-muted-foreground" />
      <h2 className="m-0 text-base leading-[1.2]">Вход</h2>
      <Input
        className="my-0.5 mb-1"
        value={password}
        type="password"
        autoComplete="current-password"
        onChange={(event) => setPassword(event.target.value)}
      />
      <Button disabled={busy || !password}>
        <Lock aria-hidden="true" />
        Открыть
      </Button>
    </Card>
  );
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
