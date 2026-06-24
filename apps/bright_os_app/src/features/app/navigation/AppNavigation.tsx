"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent, type TouchEvent, type TouchEventHandler } from "react";
import { Archive, ChevronsUpDown, LogOut, Menu, PanelLeftClose, Settings } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { Avatar, AvatarFallback } from "@/shared/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { FloatingDock } from "@/shared/ui/floating-dock";
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from "@/shared/ui/sidebar";
import { cx } from "../appUtils";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";
import type { PrimarySectionId, SectionId } from "../appModel";
import { isPrimarySection, navHref, navItems, sectionTitle } from "../appModel";

export function DesktopRail({
  expanded,
  section,
  onSettings,
  onArchive,
  onLogout,
}: {
  expanded: boolean;
  section: SectionId;
  onSettings: () => void;
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
        <ProfileMenu onSettings={onSettings} onArchive={onArchive} onLogout={onLogout} />
        <RailCollapseButton />
      </SidebarHeader>
      <SidebarContent>
        <PageMenu expanded={expanded} section={section} />
      </SidebarContent>
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
  onClose,
  onSettings,
  onArchive,
  onLogout,
}: {
  section: SectionId;
  onClose: () => void;
  onSettings: () => void;
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
    excludeControls: false,
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
        className="mobile-profile-drawer grid h-full w-4/5 content-start border-r border-border bg-card px-2 pb-4 pt-[calc(12px+env(safe-area-inset-top))] shadow-xl animate-[mobile-drawer-in_180ms_ease-out] [touch-action:pan-y] will-change-transform"
        style={sheetStyle}
        aria-label="Профиль"
        {...sheetDragHandlers}
        onClick={(event) => event.stopPropagation()}
      >
        <ProfileMenu
          onSettings={() => closeThen(onSettings)}
          onArchive={() => closeThen(onArchive)}
          onLogout={() => closeThenAsync(onLogout)}
        />
        <PageMenu expanded section={section} />
      </aside>
    </div>
  );
}

function PageMenu({ expanded, section }: { expanded: boolean; section: SectionId }) {
  if (!expanded) return null;

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Меню страницы</SidebarGroupLabel>
      <SidebarGroupContent>
        <div className="px-2 py-1.5 text-sm font-medium text-sidebar-foreground">{sectionTitle(section)}</div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function ProfileMenu({
  onSettings,
  onArchive,
  onLogout,
}: {
  onSettings: () => void;
  onArchive: () => void;
  onLogout: () => void | Promise<void>;
}) {
  const { isMobile, setOpen, state } = useSidebar();
  function actionProps(action: () => void | Promise<void>) {
    if (!isMobile) return { onSelect: () => void action() };
    return {
      onPointerDown: (event: PointerEvent) => {
        if (event.pointerType === "mouse" || event.pointerType === "touch" || event.pointerType === "pen") void action();
      },
      onSelect: () => void action(),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") void action();
      },
      onTouchEnd: (event: TouchEvent) => {
        event.preventDefault();
        void action();
      },
    };
  }

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="rail-profile data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
              data-profile-trigger
              data-nav-swipe-exclusion
              type="button"
              aria-label="Открыть меню профиля"
            >
              <ProfileAvatar />
              <ProfileText />
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="profile-menu z-[100] w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem className="text-base" {...actionProps(onSettings)}>
                <Settings />
                <span>Настройки</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="text-base" {...actionProps(onArchive)}>
                <Archive />
                <span>Архив</span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-base" {...actionProps(onLogout)}>
              <LogOut />
              <span>Выйти</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
}: {
  section: SectionId;
  hidden: boolean;
  onSection: (section: SectionId) => void;
  swipeHandlers?: {
    onTouchStart: TouchEventHandler<HTMLElement>;
    onTouchMove: TouchEventHandler<HTMLElement>;
    onTouchEnd: TouchEventHandler<HTMLElement>;
    onTouchCancel: TouchEventHandler<HTMLElement>;
  };
}) {
  const dockItems = navItems.map((item) => {
    const Icon = item.icon;
    return {
      title: item.label,
      href: navHref(item.id),
      active: isActiveNavItem(item.id, section),
      onClick: () => onSection(item.id),
      icon: <Icon className="h-full w-full" aria-hidden="true" />,
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

function isActiveNavItem(itemId: PrimarySectionId, section: SectionId): boolean {
  return isPrimarySection(section) && itemId === section;
}
