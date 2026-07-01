"use client";

import { useCallback, useEffect, useRef, type TouchEventHandler } from "react";
import { Archive, Cpu, Download, LogOut, Menu, PanelLeftClose, Settings, type LucideIcon } from "lucide-react";
import type { AppVersionState } from "@/shared/api/brightOsApi";
import { APP_VERSION, ENVIRONMENT_BADGE_LABEL, isProductionEnvironment } from "@/shared/config/runtime";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import type { BrightOtaState } from "@/shared/platform/ota";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { FloatingDock } from "@/shared/ui/floating-dock";
import { formatHourMinute } from "@/shared/time/format";
import type { SyncStatus, TimerState } from "@/shared/types/timer";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from "@/shared/ui/sidebar";
import { cx } from "../appUtils";
import { EnvironmentBadge, syncStatusIconToneClasses, syncStatusMeta } from "../chrome/AppChrome";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";
import type { PrimarySectionId, SectionId } from "../appModel";
import { isPrimarySection, navHref, navItems, sectionTitle } from "../appModel";
import { engineSectionView } from "../sections/engine/engineModel";

const RAIL_FOOTER_ICON_ROW_CLASS = "flex h-8 w-full items-center rounded-md p-2 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!";
const RAIL_FOOTER_ICON_SLOT_CLASS = "grid size-4 shrink-0 place-items-center";

export function DesktopRail({
  expanded,
  section,
  appVersionState,
  otaRefreshing,
  otaState,
  pendingCount,
  versionError,
  versionRefreshing,
  syncStatus,
  onSettings,
  onEngine,
  onArchive,
  onLogout,
}: {
  expanded: boolean;
  section: SectionId;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BrightOtaState | null;
  pendingCount: number;
  versionError: boolean;
  versionRefreshing: boolean;
  syncStatus: SyncStatus;
  onSettings: () => void;
  onEngine: () => void;
  onArchive: () => void;
  onLogout: () => Promise<void>;
}) {
  return (
    <Sidebar
      collapsible="icon"
      className={cx("desktop-rail max-[860px]:hidden", expanded && "expanded")}
      aria-label="Основная навигация"
    >
      <SidebarHeader>
        <ProfileMenu />
        <RailCollapseButton />
      </SidebarHeader>
      <SidebarContent>
        <PageMenu
          expanded={expanded}
          showEngineItem={false}
          section={section}
          appVersionState={appVersionState}
          otaRefreshing={otaRefreshing}
          otaState={otaState}
          versionError={versionError}
          versionRefreshing={versionRefreshing}
          onSettings={onSettings}
          onEngine={onEngine}
          onArchive={onArchive}
          onLogout={onLogout}
        />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu className="gap-4">
          <EnvironmentBadgeMenuItem />
          <ConnectionStatusMenuItem status={syncStatus} pendingCount={pendingCount} />
          <EngineMenuItem
            active={section === "engine"}
            appVersionState={appVersionState}
            otaRefreshing={otaRefreshing}
            otaState={otaState}
            versionError={versionError}
            versionRefreshing={versionRefreshing}
            onClick={onEngine}
          />
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
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

export function MobileProfileDrawer({
  section,
  appVersionState,
  otaRefreshing,
  otaState,
  versionError,
  versionRefreshing,
  onClose,
  onSettings,
  onEngine,
  onArchive,
  onLogout,
}: {
  section: SectionId;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BrightOtaState | null;
  versionError: boolean;
  versionRefreshing: boolean;
  onClose: () => void;
  onSettings: () => void;
  onEngine: () => void;
  onArchive: () => void;
  onLogout: () => Promise<void>;
}) {
  const suppressPopRef = useRef(false);
  const afterCloseRef = useRef<(() => void) | null>(null);
  const finishClose = useCallback(() => {
    onClose();
    afterCloseRef.current?.();
    afterCloseRef.current = null;
  }, [onClose]);
  const { backdropRef, backdropStyle, closeWithAnimation, resetOpen, sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({
    axis: "x",
    excludeControls: true,
    onClose: finishClose,
  });

  const closeMenu = useCallback((afterClose?: () => void) => {
    afterCloseRef.current = afterClose ?? null;
    if (window.history.state?.brightMobileMenu) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
  }, [closeWithAnimation]);

  useEffect(() => {
    resetOpen();
    if (window.history.state?.brightMobileMenu) {
      window.history.replaceState({ ...window.history.state, brightMobileMenu: true }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, brightMobileMenu: true }, "", window.location.href);
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
  }, [closeWithAnimation, resetOpen]);

  useEffect(() => installAndroidBackHandler(() => {
    closeMenu();
    return true;
  }), [closeMenu]);

  function closeThen(callback: () => void) {
    closeMenu(callback);
  }

  function closeThenAsync(callback: () => Promise<void>) {
    closeMenu(() => void callback());
  }

  return (
    <div className="mobile-menu-backdrop fixed inset-0 z-[90]" data-nav-swipe-exclusion onClick={() => closeMenu()}>
      <div ref={backdropRef} className="absolute inset-0 bg-foreground/15 dark:bg-background/80" style={backdropStyle} aria-hidden="true" />
      <aside
        ref={sheetRef}
        className="mobile-profile-drawer flex h-full w-4/5 flex-col border-r border-border bg-card px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-[calc(12px+env(safe-area-inset-top))] shadow-xl animate-[mobile-drawer-in_180ms_ease-out] [touch-action:pan-y] will-change-transform"
        style={sheetStyle}
        aria-label="Профиль"
        {...sheetDragHandlers}
        onClick={(event) => event.stopPropagation()}
      >
        <ProfileMenu />
        <div className="flex min-h-0 flex-1 flex-col">
          <PageMenu
            forceActionMenu
            expanded
            section={section}
            appVersionState={appVersionState}
            otaRefreshing={otaRefreshing}
            otaState={otaState}
            versionError={versionError}
            versionRefreshing={versionRefreshing}
            onSettings={() => closeThen(onSettings)}
            onEngine={() => closeThen(onEngine)}
            onArchive={() => closeThen(onArchive)}
            onLogout={() => closeThenAsync(onLogout)}
          />
        </div>
      </aside>
    </div>
  );
}

function PageMenu({
  expanded,
  forceActionMenu = false,
  showEngineItem = true,
  section,
  appVersionState,
  otaRefreshing,
  otaState,
  versionError,
  versionRefreshing,
  onSettings,
  onEngine,
  onArchive,
  onLogout,
}: {
  expanded: boolean;
  forceActionMenu?: boolean;
  showEngineItem?: boolean;
  section: SectionId;
  appVersionState: AppVersionState | null;
  otaRefreshing: boolean;
  otaState: BrightOtaState | null;
  versionError: boolean;
  versionRefreshing: boolean;
  onSettings: () => void;
  onEngine: () => void;
  onArchive: () => void;
  onLogout: () => void | Promise<void>;
}) {
  const showActionMenu = forceActionMenu || section === "actions" || section === "settings" || section === "archive" || section === "engine";

  return (
    <>
      {expanded ? (
        <SidebarGroup>
          <SidebarGroupLabel>Меню страницы</SidebarGroupLabel>
          <SidebarGroupContent>
            <div className="px-2 py-1.5 text-sm font-medium text-sidebar-foreground" data-rail-page-title>{sectionTitle(section)}</div>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      {showActionMenu ? (
        <SidebarGroup>
          <SidebarGroupLabel>Действия</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <ActionMenuItem icon={Settings} label="Настройки" active={section === "settings"} onClick={onSettings} />
              <ActionMenuItem icon={Archive} label="Архив" active={section === "archive"} onClick={onArchive} />
              <ActionMenuItem icon={LogOut} label="Выйти" onClick={onLogout} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      {showActionMenu && showEngineItem ? (
        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              <EngineMenuItem
                active={section === "engine"}
                appVersionState={appVersionState}
                otaRefreshing={otaRefreshing}
                otaState={otaState}
                versionError={versionError}
                versionRefreshing={versionRefreshing}
                onClick={onEngine}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
    </>
  );
}

function EnvironmentBadgeMenuItem() {
  if (isProductionEnvironment() || !ENVIRONMENT_BADGE_LABEL) return null;

  return (
    <SidebarMenuItem>
      <span className={RAIL_FOOTER_ICON_ROW_CLASS} title={`Превью ${ENVIRONMENT_BADGE_LABEL}`} aria-label={`Превью ${ENVIRONMENT_BADGE_LABEL}`}>
        <span className="relative size-4 shrink-0">
          <EnvironmentBadge label={ENVIRONMENT_BADGE_LABEL} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
        </span>
      </span>
    </SidebarMenuItem>
  );
}

function ConnectionStatusMenuItem({ status, pendingCount }: { status: SyncStatus; pendingCount: number }) {
  const { label, tone, icon: Icon, spinning } = syncStatusMeta(status, pendingCount);

  return (
    <SidebarMenuItem>
      <span
        className={cx(
          RAIL_FOOTER_ICON_ROW_CLASS,
          syncStatusIconToneClasses[tone],
        )}
        title={label}
        aria-label={label}
        role="status"
      >
        <span className={RAIL_FOOTER_ICON_SLOT_CLASS}>
          <Icon className={cx("size-4", spinning && "animate-spin")} aria-hidden="true" />
        </span>
      </span>
    </SidebarMenuItem>
  );
}

function EngineMenuItem({
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
  otaState: BrightOtaState | null;
  versionError: boolean;
  versionRefreshing: boolean;
  onClick: () => void;
}) {
  const view = engineSectionView({
    appBuild: APP_VERSION,
    appVersionState,
    otaRefreshing,
    otaState,
    versionError,
    versionRefreshing,
  });
  const Icon = view.hasUpdate ? Download : Cpu;
  const label = view.latestVersion ? `Engine v${view.latestVersion}` : "Engine";

  return <ActionMenuItem icon={Icon} label={label} active={active} onClick={onClick} />;
}

function ActionMenuItem({
  icon: Icon,
  label,
  active = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton type="button" isActive={active} tooltip={label} onClick={() => void onClick()}>
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ProfileMenu() {
  const { isMobile, setOpen, state } = useSidebar();

  if (!isMobile && state === "collapsed") {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="lg"
            className="rail-profile"
            data-profile-trigger
            data-nav-swipe-exclusion
            type="button"
            aria-label="Развернуть меню"
            onClick={() => setOpen(true)}
          >
            <ProfileAvatar />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="rail-profile flex h-12 w-full items-center gap-2 rounded-md p-2 text-left text-sm">
          <ProfileAvatar />
          <ProfileText />
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function RailCollapseButton() {
  const { isMobile, setOpen, state } = useSidebar();
  if (isMobile || state === "collapsed") return null;

  return (
    <button
      type="button"
      className="ml-auto mr-1 grid size-7 place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Свернуть меню"
      title="Свернуть меню"
      onClick={() => setOpen(false)}
    >
      <PanelLeftClose className="size-4" aria-hidden="true" />
    </button>
  );
}

function ProfileAvatar() {
  return (
    <Avatar className="profile-avatar h-8 w-8 rounded-full">
      <AvatarFallback className="rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        BO
      </AvatarFallback>
    </Avatar>
  );
}

function ProfileText() {
  return (
    <div className="grid flex-1 text-left text-sm leading-tight">
      <span className="truncate font-semibold">Bright OS</span>
      <span className="truncate text-xs">Workspace</span>
    </div>
  );
}

export function MainDock({
  section,
  hidden,
  onSection,
  swipeHandlers,
  timer,
}: {
  section: SectionId;
  hidden: boolean;
  onSection: (section: SectionId) => void;
  timer: TimerState;
  swipeHandlers?: {
    onTouchStart: TouchEventHandler<HTMLElement>;
    onTouchMove: TouchEventHandler<HTMLElement>;
    onTouchEnd: TouchEventHandler<HTMLElement>;
    onTouchCancel: TouchEventHandler<HTMLElement>;
  };
}) {
  const dockItems = navItems.map((item) => {
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
        "main-dock pointer-events-auto fixed bottom-5 left-1/2 z-[70] -translate-x-1/2 max-[860px]:static max-[860px]:inset-auto max-[860px]:flex max-[860px]:translate-x-0 max-[860px]:justify-center max-[860px]:pb-[env(safe-area-inset-bottom)] max-[860px]:[touch-action:none]",
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
