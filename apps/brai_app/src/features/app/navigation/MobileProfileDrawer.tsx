"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { cx } from "../appUtils";
import { useMobileSheetDrag } from "../hooks/useMobileSheetDrag";

export function MobileProfileDrawer({ children, onClose }: { children?: ReactNode; onClose: () => void }) {
  const suppressPopRef = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const finishClose = useCallback(() => {
    onCloseRef.current();
    const opener = openerRef.current;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (opener.isConnected) opener.focus();
      }));
    }
  }, []);
  const { backdropRef, backdropStyle, closeWithAnimation, gestureRef, resetOpen, sheetDragHandlers, sheetRef, sheetStyle } = useMobileSheetDrag({
    axis: "x",
    excludeControls: true,
    onClose: finishClose,
  });
  const setBackdropGestureRef = useCallback((element: HTMLDivElement | null) => {
    gestureRef(element);
    backdropRef(element);
  }, [backdropRef, gestureRef]);
  const setSheetDialogRef = useCallback((element: HTMLElement | null) => {
    dialogRef.current = element;
    sheetRef(element);
  }, [sheetRef]);
  const closeMenu = useCallback((restoreHistory = true) => {
    if (restoreHistory && window.history.state?.braiMobileMenu) {
      suppressPopRef.current = true;
      window.history.back();
    }
    closeWithAnimation();
  }, [closeWithAnimation]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    resetOpen();
    if (window.history.state?.braiMobileMenu) window.history.replaceState({ ...window.history.state, braiMobileMenu: true }, "", window.location.href);
    else window.history.pushState({ ...window.history.state, braiMobileMenu: true }, "", window.location.href);
    function onPopState() {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      closeMenu(false);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeMenu, resetOpen]);

  useEffect(() => installAndroidBackHandler(() => { closeMenu(); return true; }), [closeMenu]);
  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    });
    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMenu]);
  useEffect(() => {
    const close = () => closeMenu();
    window.addEventListener("brai:close-mobile-profile-drawer", close);
    return () => window.removeEventListener("brai:close-mobile-profile-drawer", close);
  }, [closeMenu]);

  return (
    <div
      ref={setBackdropGestureRef}
      className="mobile-menu-backdrop fixed inset-0 z-[90] bg-foreground/15 dark:bg-background/80"
      style={backdropStyle}
      data-nav-swipe-exclusion
      onClick={() => closeMenu()}
      {...sheetDragHandlers}
    >
      <aside
        ref={setSheetDialogRef}
        className={cx(
          "mobile-profile-drawer relative z-[1] flex h-full flex-col overflow-hidden border-r border-border bg-card pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl [touch-action:pan-y] will-change-transform",
          children ? "w-[min(86vw,22rem)] sm:max-w-[22rem]" : "w-16 sm:max-w-16",
        )}
        style={sheetStyle}
        aria-label={children ? "Списки действий" : "Меню"}
        aria-modal="true"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div aria-label="Левый рейл" className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className={children ? "px-3 pb-3" : "px-2 pb-3"}>{children}</div>
          </ScrollArea>
        </div>
      </aside>
    </div>
  );
}

const FOCUSABLE_SELECTOR = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export function requestMobileProfileDrawerClose() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("brai:close-mobile-profile-drawer"));
}
