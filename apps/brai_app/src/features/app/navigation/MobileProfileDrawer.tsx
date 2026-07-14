"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { Button } from "@/shared/ui/button";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/shared/ui/sheet";
import { cx } from "../appUtils";

export function MobileProfileDrawer({ children, onClose }: { children?: ReactNode; onClose: () => void }) {
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const label = children ? "Списки действий" : "Меню";
  const closeMenu = useCallback((restoreHistory = true) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (restoreHistory && window.history.state?.braiMobileMenu) window.history.back();
    onCloseRef.current();
    const opener = openerRef.current;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (opener.isConnected) opener.focus();
      }));
    }
  }, []);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closedRef.current = false;
    if (window.history.state?.braiMobileMenu) window.history.replaceState({ ...window.history.state, braiMobileMenu: true }, "", window.location.href);
    else window.history.pushState({ ...window.history.state, braiMobileMenu: true }, "", window.location.href);
    function onPopState() { closeMenu(false); }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closeMenu]);

  useEffect(() => installAndroidBackHandler(() => { closeMenu(); return true; }), [closeMenu]);
  useEffect(() => {
    const close = () => closeMenu();
    window.addEventListener("brai:close-mobile-profile-drawer", close);
    return () => window.removeEventListener("brai:close-mobile-profile-drawer", close);
  }, [closeMenu]);

  return (
    <Sheet open onOpenChange={(open) => { if (!open) closeMenu(); }}>
      <SheetContent
        side="left"
        showCloseButton={false}
        overlayClassName="mobile-menu-backdrop z-[90] bg-foreground/15 dark:bg-background/80"
        className={cx(
          "mobile-profile-drawer z-[90] gap-0 overflow-hidden border-r border-border bg-card px-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl",
          children ? "w-[min(86vw,22rem)] sm:max-w-[22rem]" : "w-16 sm:max-w-16",
        )}
        data-nav-swipe-exclusion
        aria-modal="true"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription>Навигация по разделу</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-11 shrink-0 justify-end px-2">
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon-sm" className="size-11" aria-label="Закрыть меню">
              <X aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className={children ? "px-3 pb-3" : "px-2 pb-3"}>{children}</div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function requestMobileProfileDrawerClose() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("brai:close-mobile-profile-drawer"));
}
