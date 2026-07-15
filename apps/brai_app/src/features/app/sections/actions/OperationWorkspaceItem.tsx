"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Wrench, X } from "lucide-react";
import { installAndroidBackHandler } from "@/shared/platform/platform";
import { MarkdownContent } from "@/shared/ui/markdown-content";
import { ScrollArea } from "@/shared/ui/scroll-area";
import { Button } from "@/shared/ui/button";
import { cx } from "../../appUtils";
import type { WorkspaceWorkItem } from "./actionsWorkspaceModel";

export function OperationWorkspaceRow({ item, selected, onSelect, controls }: { item: WorkspaceWorkItem; selected: boolean; onSelect: () => void; controls?: ReactNode }) {
  return (
    <div className={cx("group grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-xl px-3 py-2 transition-colors", selected ? "bg-primary/10" : "hover:bg-accent/70")}>
      <Wrench className={cx("size-5", item.status === "Done" ? "text-primary" : "text-muted-foreground")} aria-label="Операция" />
      <button type="button" className="min-h-10 min-w-0 border-0 bg-transparent p-0 text-left focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect}>
        <span className={cx("block truncate text-sm font-medium", item.status === "Done" && "text-muted-foreground line-through")}>{item.title}</span>
        <span className="block truncate text-xs text-muted-foreground">Операция · статус управляется сервисом</span>
      </button>
      <div className="flex items-center gap-1">{controls}</div>
    </div>
  );
}

export function OperationDetailPanel({ item, mode, onClose }: { item: WorkspaceWorkItem; mode: "desktop" | "mobile"; onClose: () => void }) {
  const operation = item.operation;
  const closedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const closePanel = useCallback((restoreHistory = true) => {
    if (closedRef.current) return;
    closedRef.current = true;
    if (mode === "mobile" && restoreHistory && window.history.state?.braiOperationEditor === item.id) window.history.back();
    onCloseRef.current();
    const opener = openerRef.current;
    if (opener?.isConnected) {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (opener.isConnected) opener.focus();
      }));
    }
  }, [item.id, mode]);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    closedRef.current = false;
    if (window.history.state?.braiOperationEditor === item.id) {
      window.history.replaceState({ ...window.history.state, braiOperationEditor: item.id }, "", window.location.href);
    } else {
      window.history.pushState({ ...window.history.state, braiOperationEditor: item.id }, "", window.location.href);
    }
    function onPopState() { closePanel(false); }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [closePanel, item.id, mode]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    return installAndroidBackHandler(() => { closePanel(); return true; });
  }, [closePanel, mode]);

  useEffect(() => {
    if (mode !== "mobile") return undefined;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePanel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closePanel, mode]);

  function trapMobileFocus(event: KeyboardEvent<HTMLElement>) {
    if (mode !== "mobile" || event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !event.currentTarget.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  const panel = (
    <aside
      className={cx(
        "operation-detail-panel min-h-0 min-w-0 overflow-hidden bg-background",
        mode === "desktop" ? "h-full border-l border-border pl-7 max-[860px]:hidden" : "fixed inset-x-0 bottom-0 z-[85] hidden max-h-[82dvh] grid-rows-[auto_minmax(0,1fr)] rounded-t-2xl border-t border-border p-4 shadow-xl max-[860px]:grid",
      )}
      aria-label={`Операция: ${item.title}`}
      aria-modal={mode === "mobile" ? "true" : undefined}
      data-nav-swipe-exclusion
      role={mode === "mobile" ? "dialog" : "complementary"}
      tabIndex={mode === "mobile" ? -1 : undefined}
      onKeyDown={trapMobileFocus}
      onClick={(event) => event.stopPropagation()}
    >
      <header className="flex items-start gap-3 border-b border-border pb-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Операция</p>
          <h2 className="m-0 mt-1 break-words text-lg font-semibold">{item.title}</h2>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Закрыть операцию" autoFocus={mode === "mobile"} onClick={() => closePanel()}><X aria-hidden="true" /></Button>
      </header>
      <ScrollArea className="min-h-0 py-4">
        <div className="grid gap-4 pr-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Статус</dt><dd className="m-0">{item.status === "Done" ? "Выполнено" : "В работе"}</dd>
            {operation?.source ? <><dt className="text-muted-foreground">Источник</dt><dd className="m-0 break-words">{operation.source}</dd></> : null}
            {operation?.workflow_status ? <><dt className="text-muted-foreground">Обработка</dt><dd className="m-0">{operation.workflow_status}</dd></> : null}
          </dl>
          {item.descriptionMd ? <MarkdownContent source={item.descriptionMd} /> : <p className="m-0 text-sm text-muted-foreground">Описание отсутствует</p>}
          {operation?.ai_processing_error ? <p className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{operation.ai_processing_error}</p> : null}
        </div>
      </ScrollArea>
    </aside>
  );
  if (mode === "desktop") return panel;
  return (
    <div
      className="fixed inset-0 z-[84] hidden bg-foreground/20 max-[860px]:block"
      data-nav-swipe-exclusion
      onClick={() => closePanel()}
    >
      {panel}
    </div>
  );
}
