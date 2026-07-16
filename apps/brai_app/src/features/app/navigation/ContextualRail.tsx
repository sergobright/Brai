"use client";

import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BraiApi } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import type { SectionId } from "../appModel";
import { hasDesktopPageRail } from "../appModel";

const DEFAULT_WIDTH = 256;
const MIN_WIDTH = 192;
const MAX_WIDTH = 512;

export function isContextualRailSection(section: SectionId): boolean {
  return hasDesktopPageRail(section);
}

export function useContextualRail(section: SectionId, userId?: string | null) {
  const api = useMemo(() => new BraiApi(defaultApiBase()), []);
  const accountKey = userId ?? "anonymous";
  const currentOpenKey = openKey(accountKey, section);
  const currentWidthKey = widthKey(accountKey);
  const [openState, setOpenState] = useState(() => ({ key: currentOpenKey, value: readBoolean(currentOpenKey, true) }));
  const [widthState, setWidthState] = useState(() => ({ key: currentWidthKey, value: readWidth(currentWidthKey) }));
  const saveTimer = useRef<number | null>(null);
  const open = openState.key === currentOpenKey ? openState.value : readBoolean(currentOpenKey, true);
  const width = widthState.key === currentWidthKey ? widthState.value : readWidth(currentWidthKey);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    void api.preferences().then((preferences) => {
      if (cancelled) return;
      const next = clampWidth(preferences.context_rail_width_px);
      setWidthState({ key: currentWidthKey, value: next });
      writeStorage(currentWidthKey, String(next));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, currentWidthKey, userId]);

  const setOpen = useCallback((next: boolean) => {
    setOpenState({ key: currentOpenKey, value: next });
    if (isContextualRailSection(section)) writeStorage(currentOpenKey, String(next));
  }, [currentOpenKey, section]);

  const setWidth = useCallback((next: number) => {
    const value = clampWidth(next);
    setWidthState({ key: currentWidthKey, value });
    writeStorage(currentWidthKey, String(value));
    if (!userId) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.updatePreferences({ context_rail_width_px: value }).catch(() => undefined);
    }, 300);
  }, [api, currentWidthKey, userId]);

  useEffect(() => () => {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
  }, [currentWidthKey]);

  return { open, setOpen, width, setWidth, supported: isContextualRailSection(section) };
}

export function ContextualRail({ children, open, width, onWidth }: {
  children?: ReactNode;
  open: boolean;
  width: number;
  onWidth: (width: number) => void;
}) {
  const railRef = useRef<HTMLElement | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  function startResize(event: PointerEvent<HTMLButtonElement>) {
    if (!railRef.current) return;
    event.preventDefault();
    dragStart.current = { x: event.clientX, width: railRef.current.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onWidth(dragStart.current.width + event.clientX - dragStart.current.x);
  }

  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") onWidth(width - 8);
    else if (event.key === "ArrowRight") onWidth(width + 8);
    else if (event.key === "Home") onWidth(MIN_WIDTH);
    else if (event.key === "End") onWidth(MAX_WIDTH);
    else return;
    event.preventDefault();
  }

  if (!open) return null;
  return (
    <aside
      ref={railRef}
      className="contextual-rail relative hidden h-full min-h-0 shrink-0 overflow-hidden border-r border-border bg-card min-[861px]:block"
      style={{ width }}
      aria-label="Левый рейл"
    >
      <div className="h-full min-h-0 overflow-hidden">{children ?? <PageRailPlaceholder />}</div>
      <button
        type="button"
        className="absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-ew-resize border-0 bg-transparent outline-none focus-visible:bg-primary/25"
        role="slider"
        aria-label="Изменить ширину контекстной панели"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={Math.round(width)}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={resizeWithKeyboard}
      />
    </aside>
  );
}

export function PageRailPlaceholder() {
  return (
    <div className="grid h-full min-h-0 place-items-center p-4 text-center text-sm text-muted-foreground">
      В разработке
    </div>
  );
}

function clampWidth(value: number): number {
  return Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value || DEFAULT_WIDTH)));
}

function readWidth(key: string): number {
  const cached = Number(readStorage(key));
  return Number.isFinite(cached) ? clampWidth(cached) : DEFAULT_WIDTH;
}

function openKey(account: string, section: SectionId): string {
  return `brai_context_rail_open:${account}:${section}`;
}

function widthKey(account: string): string {
  return `brai_context_rail_width:${account}`;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const value = readStorage(key);
  return value === null ? fallback : value !== "false";
}

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return getBraiLocalStorageItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try { setBraiLocalStorageItem(key, value); } catch { /* constrained WebView */ }
}
