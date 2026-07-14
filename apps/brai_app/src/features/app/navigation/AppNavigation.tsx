"use client";

import { useCallback, useEffect, useRef, type TouchEventHandler } from "react";
import { Archive, ChevronDown, ChevronUp, Cpu, Download, Ellipsis, Flag, Menu, Pencil, Tag, type LucideIcon } from "lucide-react";
import { BraiUserAvatar, BraiUserDropdownMenu, BraiUserMenuPanel } from "@/components/shadcn-space/dropdown-menu/dropdown-menu-01";
import type { AppVersionState, AuthUser } from "@/shared/api/braiApi";
import { useAppVersion } from "@/shared/config/runtime";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { BraiOtaState } from "@/shared/platform/ota";
import { FloatingDock } from "@/shared/ui/floating-dock";
import { NavigationIndicator, UpdateNavigationDot } from "@/shared/ui/navigation-indicator";
import { formatHourMinute } from "@/shared/time/format";
import type { SyncStatus, TimerState } from "@/shared/types/timer";
import { Sidebar, SidebarContent, SidebarFooter, SidebarMenuButton } from "@/shared/ui/sidebar";
import { StatusPill } from "../chrome/AppChrome";
import { cx } from "../appUtils";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";
import type { PrimarySectionId, SectionId } from "../appModel";
import { isPrimarySection, navHref, navItems } from "../appModel";
import { engineSectionView } from "../sections/engine/engineModel";

export function DesktopRail({
  section,
  appVersionState,
  otaRefreshing,
  otaState,
  pendingCount,
  versionError,
  versionRefreshing,
  syncStatus,
  authUser,
  onProfile,
  onSettings,
  onBraiCmd,
  onEngine,
  onArchive,
  onLogout,
}: {
  section: SectionId;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BraiOtaState | null;
  pendingCount: number;
  versionError: boolean;
  versionRefreshing: boolean;
  syncStatus: SyncStatus;
  authUser: AuthUser | null;
  onProfile: () => void;
  onSettings: () => void;
  onBraiCmd: () => void;
  onEngine: () => void;
  onArchive: () => void;
  onLogout: () => Promise<void>;
}) {
  return (
    <Sidebar
      collapsible="icon"
      className="desktop-rail max-[860px]:hidden"
      aria-label="Основная навигация"
    >
      <SidebarContent className="min-h-0" />
      <SidebarFooter className="items-center gap-3">
        <div className="desktop-rail-slot grid size-10 place-items-center">
          <DesktopRailStatus syncStatus={syncStatus} pendingCount={pendingCount} />
        </div>
        <div className="desktop-rail-slot grid size-10 place-items-center">
          <EngineRailButton
            active={section === "engine"}
            appVersionState={appVersionState}
            otaRefreshing={otaRefreshing}
            otaState={otaState}
            versionError={versionError}
            versionRefreshing={versionRefreshing}
            onClick={onEngine}
          />
        </div>
        <div className="desktop-rail-slot grid size-10 place-items-center">
          <BraiUserDropdownMenu
            activeSection={section}
            align="end"
            showEngine={false}
            side="right"
            trigger={
              <button
                type="button"
                className="rail-profile flex size-10 items-center justify-center rounded-full border-0 bg-transparent p-0 outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
                aria-label="Открыть меню профиля"
              >
                <BraiUserAvatar user={authUser} className="size-8" />
              </button>
            }
            user={authUser}
            onArchive={onArchive}
            onBraiCmd={onBraiCmd}
            onEngine={onEngine}
            onLogout={onLogout}
            onProfile={onProfile}
            onSettings={onSettings}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function DesktopRailStatus({ syncStatus, pendingCount }: { syncStatus: SyncStatus; pendingCount: number }) {
  return (
    <div className="desktop-rail-status grid size-10 place-items-center">
      <StatusPill className="size-10" status={syncStatus} pendingCount={pendingCount} />
    </div>
  );
}

export function MobileMenuButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="mobile-menu-button relative z-[2] hidden h-9 w-9 flex-none place-items-center rounded-md border-0 bg-transparent text-muted-foreground max-[860px]:grid"
      aria-label="Открыть меню"
      onClick={onClick}
    >
      <Menu className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

export function MobileDockOverflowButton({
  hidden,
  open = false,
  side,
  onClick,
  hasUpdate = false,
}: {
  hidden: boolean;
  open?: boolean;
  side: "left" | "right";
  onClick: () => void;
  hasUpdate?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "mobile-dock-overflow-button pointer-events-auto fixed bottom-[calc(0.25rem+env(safe-area-inset-bottom))] z-[100] hidden h-11 w-11 place-items-center rounded-full border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring max-[860px]:grid",
        side === "left" ? "left-3" : "right-3",
        hidden && "max-[860px]:pointer-events-none max-[860px]:invisible max-[860px]:opacity-0",
      )}
      aria-label={side === "left" ? "Открыть левое меню" : open ? "Скрыть правое меню" : "Открыть правое меню"}
      onClick={onClick}
    >
      {side === "left" ? <Ellipsis className="h-5 w-5" aria-hidden="true" /> : open ? <ChevronDown className="h-5 w-5" aria-hidden="true" /> : <ChevronUp className="h-5 w-5" aria-hidden="true" />}
      {side === "left" && hasUpdate ? <NavigationIndicator position="bottom-center"><UpdateNavigationDot /></NavigationIndicator> : null}
    </button>
  );
}

const MOBILE_DOCK_PLACEHOLDER_ITEMS = [
  { label: "Флаг", icon: Flag },
  { label: "Тег", icon: Tag },
  { label: "Архив", icon: Archive },
] as const;

export function MobileDockOverflowSheet({
  side,
  section,
  authUser,
  onClose,
  onProfile,
  onSettings,
  onBraiCmd,
  onDraws,
  onEngine,
  onArchive,
  onLogout,
  engineDownloading = false,
  engineHasUpdate = false,
}: {
  side: "left" | "right";
  section: SectionId;
  authUser: AuthUser | null;
  onClose: () => void;
  onProfile: () => void;
  onSettings: () => void;
  onBraiCmd: () => void;
  onDraws: () => void;
  onEngine: () => void;
  onArchive: () => void;
  onLogout: () => Promise<void>;
  engineDownloading?: boolean;
  engineHasUpdate?: boolean;
}) {
  const suppressPopRef = useRef(false);
  const afterCloseRef = useRef<(() => void) | null>(null);
  const finishClose = useCallback(() => {
    onClose();
    afterCloseRef.current?.();
    afterCloseRef.current = null;
  }, [onClose]);
  const { backdropRef, backdropStyle, closeWithAnimation, resetOpen, sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({
    excludeControls: true,
    onClose: finishClose,
  });

  const closeSheet = useCallback((afterClose?: () => void) => {
    afterCloseRef.current = afterClose ?? null;
    if (window.history.state?.braiMobileDockMenu === side) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
  }, [closeWithAnimation, side]);

  useEffect(() => {
    resetOpen();
    if (window.history.state?.braiMobileDockMenu) {
      window.history.replaceState({ ...window.history.state, braiMobileDockMenu: side }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, braiMobileDockMenu: side }, "", window.location.href);
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
  }, [closeWithAnimation, resetOpen, side]);

  useEffect(() => installAndroidBackHandler(() => {
    closeSheet();
    return true;
  }), [closeSheet]);

  function closeThen(callback: () => void) {
    closeSheet(callback);
  }

  function closeThenAsync(callback: () => Promise<void>) {
    closeSheet(() => void callback());
  }

  return (
    <div
      className={cx(
        "mobile-dock-overflow-backdrop fixed inset-0 z-[110] hidden items-end max-[860px]:flex",
        side === "right" && "pointer-events-none justify-center pb-[calc(3.75rem+env(safe-area-inset-bottom))]",
      )}
      data-nav-swipe-exclusion
      onClick={() => closeSheet()}
    >
      <div
        ref={backdropRef}
        className={cx(
          "mobile-dock-overflow-dim absolute inset-x-0 top-0 bg-foreground/20 motion-safe:animate-[mobile-dock-dim-in_180ms_ease-out] dark:bg-background/80",
          side === "left" ? "bottom-0" : "pointer-events-auto bottom-[calc(7.75rem+env(safe-area-inset-bottom))]",
        )}
        style={backdropStyle}
        aria-hidden="true"
      />
      <div className="mobile-dock-overflow-motion relative z-[1] w-full animate-[mobile-detail-sheet-in_180ms_ease-out] will-change-transform">
        <aside
          ref={sheetRef}
          className={cx(
            "mobile-dock-overflow-sheet pointer-events-auto grid min-w-0 overflow-hidden shadow-xl will-change-transform",
            side === "left"
              ? "max-h-[60dvh] w-full grid-rows-[auto_minmax(0,1fr)] rounded-t-2xl border-t border-border bg-card pb-[env(safe-area-inset-bottom)] pt-2"
              : "h-16 w-full items-center justify-center border-y border-border/40 bg-background/95 px-8 py-1 shadow-none backdrop-blur-[14px] dark:bg-background/95",
          )}
          style={sheetStyle}
          aria-label={side === "left" ? "Левое меню" : "Правое меню"}
          {...sheetDragHandlers}
          onClick={(event) => event.stopPropagation()}
        >
          {side === "left" ? (
            <>
              <header className="relative min-h-6 px-6 pt-2">
                <button type="button" className="sr-only" aria-label="Закрыть панель: Левое меню" onClick={() => closeSheet()}>
                  Закрыть
                </button>
                <div className="mobile-dock-overflow-drag-zone absolute left-1/2 top-0 flex h-6 w-32 -translate-x-1/2 touch-none cursor-grab items-start justify-center pt-1.5 active:cursor-grabbing">
                  <span className="mobile-dock-overflow-grabber h-1 w-11 rounded-full bg-muted-foreground/30" aria-hidden="true" />
                </div>
              </header>
              <div className="min-h-0 px-3 pb-4">
                <BraiUserMenuPanel
                  activeSection={section}
                  engineDownloading={engineDownloading}
                  engineHasUpdate={engineHasUpdate}
                  user={authUser}
                  onArchive={() => closeThen(onArchive)}
                  onBraiCmd={() => closeThen(onBraiCmd)}
                  onEngine={() => closeThen(onEngine)}
                  onLogout={() => closeThenAsync(onLogout)}
                  onProfile={() => closeThen(onProfile)}
                  onSettings={() => closeThen(onSettings)}
                />
              </div>
            </>
          ) : (
            <div className="mobile-dock-overflow-icons flex min-h-0 w-full items-center justify-around gap-2">
              <MobileDockOverflowActionButton icon={Pencil} label="Draws" active={section === "draws"} onClick={() => closeThen(onDraws)} />
              {MOBILE_DOCK_PLACEHOLDER_ITEMS.map(({ icon: Icon, label }) => (
                <MobileDockOverflowActionButton key={label} icon={Icon} label={`Заглушка: ${label}`} disabled />
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function MobileDockOverflowActionButton({
  disabled,
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(
        "nav-button flex h-11 w-11 items-center justify-center rounded-full border-0 text-neutral-500 dark:text-neutral-300",
        active ? "bg-accent text-accent-foreground" : "bg-transparent",
      )}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

function EngineRailButton({
  active,
  appVersionState,
  otaRefreshing,
  otaState,
  versionError,
  versionRefreshing,
  onClick,
}: {
  active: boolean;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BraiOtaState | null;
  versionError: boolean;
  versionRefreshing: boolean;
  onClick: () => void;
}) {
  const appBuild = useAppVersion();
  const view = engineSectionView({
    appBuild,
    appVersionState,
    otaRefreshing,
    otaState,
    versionError,
    versionRefreshing,
  });
  const Icon = view.hasUpdate ? Download : Cpu;
  const downloading = view.updateAction === "downloading-web" || view.updateAction === "downloading-apk";

  return (
    <SidebarMenuButton
      type="button"
      aria-label={view.hasUpdate ? "Engine, доступно обновление" : "Engine"}
      className="relative size-10 justify-center p-0"
      isActive={active}
      tooltip="Engine"
      onClick={onClick}
    >
      <Icon className={cx(downloading && "motion-safe:animate-bounce")} aria-hidden="true" />
      {view.hasUpdate ? <NavigationIndicator><UpdateNavigationDot /></NavigationIndicator> : null}
      <span className="sr-only">Engine</span>
    </SidebarMenuButton>
  );
}

export function MainDock({
  section,
  hidden,
  mobileViewport,
  onSection,
  swipeHandlers,
  timer,
}: {
  section: SectionId;
  hidden: boolean;
  mobileViewport: boolean;
  onSection: (section: SectionId) => void;
  timer: TimerState;
  swipeHandlers?: {
    onTouchStart: TouchEventHandler<HTMLElement>;
    onTouchMove: TouchEventHandler<HTMLElement>;
    onTouchEnd: TouchEventHandler<HTMLElement>;
    onTouchCancel: TouchEventHandler<HTMLElement>;
  };
}) {
  const dockItems = navItems.filter((item) => !mobileViewport || item.id !== "draws").map((item) => {
    const Icon = item.icon;
    const focusActive = item.id === "focus" && Boolean(timer.active_session);
    return {
      title: item.label,
      href: navHref(item.id),
      active: isActiveNavItem(item.id, section),
      fillIcon: focusActive,
      onClick: () => onSection(item.id),
      icon: focusActive ? <FocusDockIcon seconds={timer.elapsed_seconds} /> : <Icon className="h-full w-full" aria-hidden="true" />,
    };
  });

  return (
    <nav
      className={cx(
        "main-dock pointer-events-auto fixed bottom-5 left-1/2 z-[70] -translate-x-1/2 max-[860px]:static max-[860px]:inset-auto max-[860px]:flex max-[860px]:translate-x-0 max-[860px]:justify-center max-[860px]:border-t max-[860px]:border-border max-[860px]:bg-background max-[860px]:pb-[env(safe-area-inset-bottom)] max-[860px]:[touch-action:none]",
        hidden && "max-[860px]:pointer-events-none max-[860px]:invisible max-[860px]:opacity-0",
      )}
      aria-label="Основная навигация"
      data-nav-swipe-exclusion
      data-nav-swipe-zone
      {...swipeHandlers}
    >
      <FloatingDock
        items={dockItems}
        desktopClassName="border border-border bg-card/95 shadow-xl backdrop-blur-[14px]"
        mobileClassName="mobile-nav"
      />
    </nav>
  );
}

function FocusDockIcon({ seconds }: { seconds: number }) {
  const value = formatHourMinute(seconds);
  const fontSize = value.length >= 5 ? 23 : value.length >= 4 ? 27 : 30;
  return (
    <svg className="focus-dock-icon block h-full w-full" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="text-primary/20" cx="50" cy="50" r="41" fill="none" stroke="currentColor" strokeWidth="5" />
      <g className="origin-center animate-[spin_28s_linear_infinite]">
        <circle
          className="focus-dock-orbit text-primary"
          cx="50"
          cy="50"
          r="41"
          fill="none"
          stroke="currentColor"
          strokeDasharray="34 258"
          strokeLinecap="round"
          strokeWidth="5"
        />
      </g>
      <text
        className="focus-dock-timer fill-current font-bold tabular-nums"
        dominantBaseline="middle"
        style={{ fontSize }}
        textAnchor="middle"
        x="50"
        y="52"
      >
        {value}
      </text>
    </svg>
  );
}

function isActiveNavItem(itemId: PrimarySectionId, section: SectionId): boolean {
  return isPrimarySection(section) && itemId === section;
}
