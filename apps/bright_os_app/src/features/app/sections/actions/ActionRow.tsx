"use client";

import type { CSSProperties, HTMLAttributes, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Trash2, Undo2 } from "lucide-react";
import { useSwipeable } from "react-swipeable";
import { cleanTitle, visibleDescriptionPreview } from "@/shared/activities/text";
import type { ActivityItem, ActivityStatus } from "@/shared/types/activities";
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
  const checkboxId = useId();
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
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
        "action-row group relative grid min-h-[54px] max-h-[220px] grid-cols-[minmax(0,1fr)_44px] items-stretch overflow-hidden border-b border-border transition-[max-height,opacity,border-color,box-shadow] duration-150 max-[860px]:grid-cols-[minmax(0,1fr)_46px] max-[860px]:[touch-action:pan-y]",
        done && "done",
        action.pending && "pending opacity-80",
        deleteOpen && "delete-open",
        dragging && "dragging",
        removing && "removing pointer-events-none max-h-0 border-b-transparent opacity-0",
        selected && "selected bg-primary/10",
        sortableDragging && "sorting overflow-visible shadow-lg",
      )}
      data-nav-swipe-exclusion
      data-action-row
      style={sortableStyle}
      {...rowSwipeHandlers}
    >
      <div
        className={cx(
          "action-row-surface grid min-h-[54px] min-w-0 grid-cols-[20px_28px_minmax(0,1fr)] items-center gap-x-1.5 py-2.5 transition-transform duration-150 will-change-transform max-[860px]:min-h-[54px] max-[860px]:grid-cols-[38px_minmax(0,1fr)] max-[860px]:py-[9px]",
          hasDragHandle && "has-drag-handle",
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
      <button
        type="button"
        className={cx(
          "action-delete-button grid min-h-[54px] w-11 place-items-center border-0 bg-transparent transition duration-150 hover:opacity-70 focus-visible:opacity-70 focus-visible:outline-0 max-[860px]:w-[46px]",
          restoreControl ? "text-primary" : "text-destructive",
          actionControlOpen ? "visible pointer-events-auto scale-100 opacity-[0.42]" : "invisible pointer-events-none scale-[0.96] opacity-0",
          "group-hover:visible group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-[0.42] group-focus-within:visible group-focus-within:pointer-events-auto group-focus-within:scale-100 group-focus-within:opacity-[0.42]",
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
        {restoreControl ? <Undo2 aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
      </button>
    </div>
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
    onTitleDraftChange(action.id, titleRef.current?.textContent ?? "");
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
