"use client";

import type { CSSProperties, HTMLAttributes, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Square, Timer, Trash2, Undo2 } from "lucide-react";
import { useSwipeable } from "react-swipeable";
import { cleanTitle, limitTitle, visibleDescriptionPreview } from "@/shared/activities/text";
import type { ActivityItem, ActivityStatus } from "@/shared/types/activities";
import { formatHourMinute } from "@/shared/time/format";
import { Checkbox } from "@/shared/ui/checkbox";
import { cx } from "../../appUtils";
import { isMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { ACTION_DELETE_REVEAL_WIDTH, ACTION_ROW_SERVICE_SELECTOR } from "./constants";

export type DetailTitleFocus = "end" | null;

export function ActionRow({
  action,
  selected,
  readonly = false,
  control = "delete",
  onEditMobile,
  onUpdateTitle,
  onSetStatus,
  onDelete,
  onStartFocus,
  onStopFocus,
  activeFocus = false,
  activeFocusElapsedSeconds = 0,
  onRestore,
  onSelect,
  titleDraft,
  onTitleDraftChange = () => undefined,
  deleteOpen,
  onOpenDelete,
  onCloseDelete,
  dragHandle,
  mobileDragProps,
  sortableRef,
  sortableStyle,
  sortableDragging = false,
}: {
  action: ActivityItem;
  selected: boolean;
  readonly?: boolean;
  control?: "delete" | "restore";
  onSelect: (detailTitleFocus?: DetailTitleFocus) => void;
  onEditMobile: (action: ActivityItem) => void;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onSetStatus: (action: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (action: ActivityItem) => Promise<void>;
  onStartFocus?: (action: ActivityItem) => Promise<void>;
  onStopFocus?: (action: ActivityItem) => Promise<void>;
  activeFocus?: boolean;
  activeFocusElapsedSeconds?: number;
  onRestore?: (action: ActivityItem) => Promise<void>;
  titleDraft?: string;
  onTitleDraftChange?: (actionId: string, title: string | null) => void;
  deleteOpen: boolean;
  onOpenDelete: () => void;
  onCloseDelete: () => void;
  dragHandle?: ReactNode;
  mobileDragProps?: HTMLAttributes<HTMLDivElement>;
  sortableRef?: (node: HTMLDivElement | null) => void;
  sortableStyle?: CSSProperties;
  sortableDragging?: boolean;
}) {
  const done = action.status === "Done";
  const title = titleDraft ?? action.title;
  const hasDragHandle = Boolean(dragHandle);
  const preview = visibleDescriptionPreview(action.description_md);
  const restoreControl = control === "restore";
  const focusControlAvailable = !restoreControl && (activeFocus || Boolean(onStartFocus) || Boolean(onStopFocus));
  const checkboxId = useId();
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [focusStopArmedActionId, setFocusStopArmedActionId] = useState<string | null>(null);
  const focusStopArmed = activeFocus && focusStopArmedActionId === action.id;
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);
  const actionControlOpen = deleteOpen || dragging || sortableDragging;
  const swipeHandlers = useSwipeable({
    onSwiping: (data) => {
      if (!isMobileNavigationViewport()) return;
      if (data.dir !== "Left" && data.dir !== "Right") return;
      setDragging(true);
      setDragX(Math.max(-ACTION_DELETE_REVEAL_WIDTH, Math.min(0, data.deltaX)));
    },
    onSwipedLeft: (data) => {
      if (!isMobileNavigationViewport()) return;
      if (data.absX >= 28) onOpenDelete();
    },
    onSwipedRight: () => {
      if (!isMobileNavigationViewport()) return;
      onCloseDelete();
    },
    onSwiped: () => {
      setDragging(false);
      setDragX(0);
    },
    delta: 8,
    preventScrollOnSwipe: false,
    trackMouse: false,
    touchEventOptions: { passive: false },
  });
  const { ref: swipeRef, ...rowSwipeHandlers } = swipeHandlers;

  useEffect(() => {
    if (focusStopArmedActionId === null) return undefined;
    const timeout = window.setTimeout(() => setFocusStopArmedActionId(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [focusStopArmedActionId]);

  async function requestRowAction() {
    if (removing) return;
    onCloseDelete();
    if (restoreControl) {
      await onRestore?.(action);
    } else {
      await onDelete(action);
    }
    setRemoving(true);
  }

  async function requestFocusAction(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (readonly) return;
    if (activeFocus) {
      if (isMobileNavigationViewport() && !focusStopArmed) {
        setFocusStopArmedActionId(action.id);
        return;
      }
      await onStopFocus?.(action);
    } else {
      setFocusStopArmedActionId(null);
      await onStartFocus?.(action);
    }
  }

  function isActionRowServiceTarget(target: EventTarget | null, rowSurface: Element) {
    const service = target instanceof Element ? target.closest(ACTION_ROW_SERVICE_SELECTOR) : null;
    return service !== null && service !== rowSurface;
  }

  function openActionDetails() {
    if (readonly) return;
    if (isMobileNavigationViewport()) {
      onEditMobile(action);
      return;
    }
    onSelect("end");
  }

  function openDetailsFromRow(event: MouseEvent<HTMLDivElement>) {
    if (isActionRowServiceTarget(event.target, event.currentTarget)) return;
    openActionDetails();
  }

  function rememberMobileTap(event: PointerEvent<HTMLDivElement>) {
    if (!isMobileNavigationViewport()) return;
    tapStartRef.current = { x: event.clientX, y: event.clientY };
  }

  function openDetailsFromMobileTap(event: PointerEvent<HTMLDivElement>) {
    if (!isMobileNavigationViewport()) return;
    const tapStart = tapStartRef.current;
    tapStartRef.current = null;
    if (!tapStart || dragging || deleteOpen || sortableDragging) return;
    if (Math.abs(event.clientX - tapStart.x) > 8 || Math.abs(event.clientY - tapStart.y) > 8) return;
    if (isActionRowServiceTarget(event.target, event.currentTarget)) return;
    openActionDetails();
  }

  function setActionRowRef(node: HTMLDivElement | null) {
    sortableRef?.(node);
    swipeRef(node);
  }

  return (
    <div
      ref={setActionRowRef}
      className={cx(
        "action-row group relative grid min-h-[54px] max-h-[220px] grid-cols-[minmax(0,1fr)_44px] items-stretch overflow-hidden border-b border-border transition-[max-height,opacity,border-color,box-shadow] duration-150 [&:has(+_.action-row.selected)]:border-b-transparent max-[860px]:grid-cols-[minmax(0,1fr)_46px] max-[860px]:select-none max-[860px]:[touch-action:pan-y]",
        done && "done",
        action.pending && "pending opacity-80",
        deleteOpen && "delete-open",
        dragging && "dragging",
        removing && "removing pointer-events-none max-h-0 border-b-transparent opacity-0",
        selected && "selected rounded-lg border-b-transparent bg-primary/10",
        sortableDragging && "sorting overflow-visible shadow-lg",
      )}
      data-nav-swipe-exclusion
      data-action-row
      style={sortableStyle}
      {...rowSwipeHandlers}
    >
      <div
        className={cx(
          "action-row-surface grid min-h-[54px] w-full min-w-0 grid-cols-[20px_28px_minmax(0,1fr)] items-center gap-x-1.5 py-2.5 transition-transform duration-150 will-change-transform max-[860px]:min-h-[54px] max-[860px]:grid-cols-[38px_minmax(0,1fr)] max-[860px]:py-[9px]",
          hasDragHandle && "has-drag-handle",
          activeFocus && focusControlAvailable && "pr-[52px] max-[860px]:pr-[54px]",
        )}
        {...mobileDragProps}
        onClick={openDetailsFromRow}
        onPointerDownCapture={rememberMobileTap}
        onPointerUpCapture={openDetailsFromMobileTap}
        style={{
          transform: `translate3d(${dragX}px, 0, 0)`,
          transition: dragging ? "none" : undefined,
        }}
      >
        {dragHandle ?? <span className="action-drag-placeholder hidden h-8 w-5 min-[861px]:block" aria-hidden="true" />}
        <span className="action-checkbox-cell flex h-6 shrink-0 items-center justify-center" data-action-row-service>
          <Checkbox
            checked={done}
            className="action-checkbox-label"
            id={checkboxId}
            aria-label={title}
            disabled={readonly}
            onCheckedChange={(checked) => void onSetStatus(action, checked ? "Done" : "New")}
          />
        </span>
        <div className="action-main flex min-w-0 flex-1 flex-col gap-1">
          <ActionTitleEditor
            action={action}
            title={title}
            readonly={readonly}
            onSelect={onSelect}
            onEditMobile={onEditMobile}
            onUpdateTitle={onUpdateTitle}
            onTitleDraftChange={onTitleDraftChange}
          />
          {preview ? (
            <p
              className="action-description-preview block min-w-0 max-w-full overflow-hidden whitespace-nowrap text-xs/5 font-normal text-muted-foreground/70"
              style={{
                WebkitMaskImage: "linear-gradient(to right, #000 calc(100% - 44px), transparent)",
                maskImage: "linear-gradient(to right, #000 calc(100% - 44px), transparent)",
              }}
            >
              {preview}
            </p>
          ) : null}
        </div>
      </div>
      <div className="action-row-controls pointer-events-none absolute inset-y-0 right-0 z-[1] flex items-stretch justify-end">
        <button
          type="button"
          className={cx(
            "action-delete-button grid min-h-[54px] w-0 min-w-0 place-items-center overflow-hidden border-0 bg-transparent transition-[width,opacity,transform] duration-150 hover:opacity-70 focus-visible:opacity-70 focus-visible:outline-0",
            restoreControl ? "text-primary" : "text-destructive",
            actionControlOpen
              ? "visible pointer-events-auto w-9 scale-100 opacity-[0.42] max-[860px]:w-[46px]"
              : "invisible pointer-events-none scale-[0.96] opacity-0",
            "group-hover:visible group-hover:pointer-events-auto group-hover:w-9 group-hover:scale-100 group-hover:opacity-[0.42] max-[860px]:group-hover:w-[46px] min-[861px]:group-hover:w-9",
            !activeFocus && "group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:w-9 group-focus-within:scale-100 group-focus-within:opacity-[0.42] max-[860px]:group-focus-within:w-[46px] min-[861px]:group-focus-within:w-9",
          )}
          data-action-row-control
          data-action-delete
          data-action-restore={restoreControl ? true : undefined}
          aria-label={`${restoreControl ? "Восстановить" : "Удалить"}: ${title}`}
          title={restoreControl ? "Восстановить" : "Удалить"}
          disabled={removing}
          onClick={(event) => {
            event.stopPropagation();
            void requestRowAction();
          }}
        >
          {restoreControl ? <Undo2 className="size-5" aria-hidden="true" /> : <Trash2 className="size-5" aria-hidden="true" />}
        </button>
        {focusControlAvailable ? (
          <button
            type="button"
            className={cx(
              "action-focus-button group/focus-control grid min-h-[54px] w-0 min-w-0 place-items-center overflow-hidden border-0 bg-transparent text-primary transition-[width,opacity,transform] duration-150 hover:opacity-80 focus-visible:opacity-90 focus-visible:outline-0",
              activeFocus
                ? "visible pointer-events-auto w-[52px] scale-100 opacity-100 max-[860px]:w-[54px]"
                : actionControlOpen
                  ? "visible pointer-events-auto w-9 scale-100 opacity-[0.65] max-[860px]:w-[46px]"
                  : "invisible pointer-events-none scale-[0.96] opacity-0",
              !activeFocus && "group-hover:visible group-hover:pointer-events-auto group-hover:w-9 group-hover:scale-100 group-hover:opacity-[0.65] group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:w-9 group-focus-within:scale-100 group-focus-within:opacity-[0.65] max-[860px]:group-hover:w-[46px] max-[860px]:group-focus-within:w-[46px] min-[861px]:group-hover:w-9 min-[861px]:group-focus-within:w-9",
            )}
            data-action-row-control
            data-action-focus
            aria-label={activeFocus ? `Остановить фокус: ${title}` : `Фокусироваться: ${title}`}
            title={activeFocus ? "Стоп" : "Фокус"}
            onClick={(event) => void requestFocusAction(event)}
          >
            {activeFocus ? <ActionFocusTime armed={focusStopArmed} seconds={activeFocusElapsedSeconds} /> : <Timer className="size-5" aria-hidden="true" />}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ActionFocusTime({ armed, seconds }: { armed: boolean; seconds: number }) {
  const value = formatHourMinute(seconds);
  if (armed) {
    return (
      <span className="grid h-5 w-11 place-items-center">
        <Square className="size-5 fill-current" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="relative grid h-5 w-11 place-items-center text-sm font-semibold tabular-nums leading-none">
      <span className="transition-opacity min-[861px]:group-hover/focus-control:opacity-0 min-[861px]:group-focus-visible/focus-control:opacity-0">{value}</span>
      <Square className="pointer-events-none absolute left-1/2 top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 fill-current opacity-0 transition-opacity min-[861px]:group-hover/focus-control:opacity-100 min-[861px]:group-focus-visible/focus-control:opacity-100" aria-hidden="true" />
    </span>
  );
}

function ActionTitleEditor({
  action,
  title,
  readonly = false,
  onSelect,
  onEditMobile,
  onUpdateTitle,
  onTitleDraftChange,
}: {
  action: ActivityItem;
  title: string;
  readonly?: boolean;
  onSelect: (detailTitleFocus?: DetailTitleFocus) => void;
  onEditMobile: (action: ActivityItem) => void;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onTitleDraftChange: (actionId: string, title: string | null) => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);

  useLayoutEffect(() => {
    if (!titleRef.current || document.activeElement === titleRef.current) return;
    titleRef.current.textContent = title;
  }, [title]);

  function resetTitle() {
    onTitleDraftChange(action.id, null);
    if (titleRef.current) titleRef.current.textContent = action.title;
  }

  async function saveTitle() {
    const nextTitle = cleanTitle(titleRef.current?.textContent ?? "");
    if (!nextTitle) {
      resetTitle();
      return;
    }
    onTitleDraftChange(action.id, nextTitle === action.title ? null : nextTitle);
    if (nextTitle !== action.title) await onUpdateTitle(action, nextTitle);
  }

  function onClick(event: MouseEvent<HTMLSpanElement>) {
    event.stopPropagation();
    if (readonly) return;
    if (isMobileNavigationViewport()) {
      event.preventDefault();
      onEditMobile(action);
      return;
    }
    onSelect(null);
  }

  function onInput() {
    titleRef.current?.animate?.([{ opacity: 0.72 }, { opacity: 1 }], { duration: 140, easing: "ease-out" });
    const nextTitle = limitTitle(titleRef.current?.textContent ?? "");
    if (titleRef.current && titleRef.current.textContent !== nextTitle) titleRef.current.textContent = nextTitle;
    onTitleDraftChange(action.id, nextTitle);
  }

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      titleRef.current?.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetTitle();
      titleRef.current?.blur();
    }
  }

  if (readonly) {
    return (
      <span
        className="action-title block max-h-12 min-w-0 overflow-hidden text-base/6 no-underline [overflow-wrap:anywhere]"
        data-title-fade
        aria-label={`Название действия: ${title}`}
        style={{
          WebkitMaskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
          maskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
        }}
      >
        {title}
      </span>
    );
  }

  return (
    <span
      ref={titleRef}
      className="action-title block max-h-12 min-w-0 overflow-hidden text-base/6 no-underline [overflow-wrap:anywhere] focus:text-primary focus:outline-0"
      data-title-fade
      style={{
        WebkitMaskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
        maskImage: "linear-gradient(to bottom, #000 calc(100% - 12px), transparent)",
      }}
      contentEditable={!isMobileNavigationViewport()}
      suppressContentEditableWarning
      tabIndex={0}
      role="textbox"
      aria-label={`Название действия: ${title}`}
      onClick={onClick}
      onInput={onInput}
      onBlur={() => void saveTitle()}
      onKeyDown={onKeyDown}
    />
  );
}
