"use client";

import type { CSSProperties, PointerEvent, TouchEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type DragState = {
  id: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
  initialScrollTop: number;
  startedWithScrollableOffset: boolean;
  scrollViewport: HTMLElement | null;
};

type DragAxis = "x" | "y";

const DRAG_EXCLUSION_SELECTOR = "button, input, select, a, [role='button'], [role='switch'], [role='slider'], [contenteditable='true'], [data-mobile-sheet-no-drag]";
const SCROLL_VIEWPORT_SELECTOR = "[data-slot='scroll-area-viewport']";
const DRAG_ACTIVATION_PX = 10;
const SETTLE_MS = 180;
const BACKDROP_FADE_START_RATIO = 0.5;
const SHEET_OFFSET_VAR = "--mobile-sheet-offset";
const BACKDROP_OPACITY_VAR = "--mobile-sheet-backdrop-opacity";

/**
 * Provides touch and pointer drag behavior for dismissible mobile sheets.
 */
export function useMobileSheetDrag({
  axis = "y",
  excludeControls = true,
  enabled = true,
  onClose,
  onCloseStart,
}: {
  axis?: DragAxis;
  excludeControls?: boolean;
  enabled?: boolean;
  onClose: () => void;
  onCloseStart?: () => void;
}) {
  const onCloseRef = useRef(onClose);
  const onCloseStartRef = useRef(onCloseStart);
  const dragRef = useRef<DragState | null>(null);
  const sheetElementRef = useRef<HTMLElement | null>(null);
  const backdropElementRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef(0);
  const currentOffsetRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    onCloseRef.current = onClose;
    onCloseStartRef.current = onCloseStart;
  }, [onClose, onCloseStart]);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const applyOffset = useCallback((nextOffset: number) => {
    const offset = Math.max(0, nextOffset);
    currentOffsetRef.current = offset;
    if (sheetElementRef.current) {
      sheetElementRef.current.style.setProperty(SHEET_OFFSET_VAR, `${offset}px`);
    }
    if (backdropElementRef.current) {
      backdropElementRef.current.style.setProperty(BACKDROP_OPACITY_VAR, String(backdropOpacity(offset, panelSize(sheetElementRef.current, axis))));
    }
  }, [axis]);

  const scheduleOffset = useCallback((nextOffset: number) => {
    const offset = Math.max(0, nextOffset);
    currentOffsetRef.current = offset;
    pendingOffsetRef.current = offset;
    if (frameRef.current != null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      applyOffset(pendingOffsetRef.current);
    });
  }, [applyOffset]);

  const setSheetRef = useCallback((element: HTMLElement | null) => {
    sheetElementRef.current = element;
    if (element) applyOffset(currentOffsetRef.current);
  }, [applyOffset]);

  const setBackdropRef = useCallback((element: HTMLElement | null) => {
    backdropElementRef.current = element;
    if (element) applyOffset(currentOffsetRef.current);
  }, [applyOffset]);

  const finishClose = useCallback(() => {
    clearTimer();
    onCloseStartRef.current?.();
    setClosing(true);
    scheduleOffset(closeDistance(sheetElementRef.current, axis));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onCloseRef.current();
    }, SETTLE_MS);
  }, [axis, clearTimer, scheduleOffset]);

  const resetOpen = useCallback(() => {
    clearTimer();
    setClosing(false);
    setSettling(false);
    setDragging(false);
    scheduleOffset(0);
  }, [clearTimer, scheduleOffset]);

  const start = useCallback((id: number, clientX: number, clientY: number, target: EventTarget | null) => {
    if (!enabled || (excludeControls && isExcluded(target))) return false;
    clearTimer();
    const scrollViewport = closestScrollViewport(target);
    const initialScrollTop = scrollViewport?.scrollTop ?? 0;
    dragRef.current = {
      id,
      startX: clientX,
      startY: clientY,
      currentX: clientX,
      currentY: clientY,
      active: false,
      initialScrollTop,
      startedWithScrollableOffset: initialScrollTop > 0,
      scrollViewport,
    };
    setClosing(false);
    setSettling(false);
    return true;
  }, [clearTimer, enabled, excludeControls]);

  const move = useCallback((id: number, clientX: number, clientY: number, preventDefault: () => void) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    const deltaX = clientX - drag.startX;
    const deltaY = clientY - drag.startY;

    if (!drag.active) {
      if (axis === "x" && (deltaX > 8 || Math.abs(deltaY) > Math.max(12, -deltaX))) {
        dragRef.current = null;
        return;
      }
      if (axis === "y" && (deltaY < -8 || Math.abs(deltaX) > Math.max(12, deltaY))) {
        dragRef.current = null;
        return;
      }
      if (axis === "x" && deltaX > -DRAG_ACTIVATION_PX) return;
      if (axis === "y" && deltaY < DRAG_ACTIVATION_PX) return;
      if (axis === "y" && drag.scrollViewport && drag.scrollViewport.scrollTop > 0) return;
      if (axis === "x") drag.startX -= DRAG_ACTIVATION_PX;
      if (axis === "y") drag.startY += DRAG_ACTIVATION_PX;
      if (drag.startedWithScrollableOffset) {
        drag.startY += drag.initialScrollTop;
        drag.startedWithScrollableOffset = false;
      }
      drag.active = true;
      setDragging(true);
    }

    preventDefault();
    drag.currentX = clientX;
    drag.currentY = clientY;
    scheduleOffset(dragOffset(drag, axis));
  }, [axis, scheduleOffset]);

  const end = useCallback((id: number) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) return;
    dragRef.current = null;
    if (!drag.active) return;
    setDragging(false);

    if (dragOffset(drag, axis) > closeThreshold(sheetElementRef.current, axis)) {
      finishClose();
      return;
    }

    setSettling(true);
    scheduleOffset(0);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setSettling(false);
    }, SETTLE_MS);
  }, [axis, finishClose, scheduleOffset]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    const started = start(event.pointerId, event.clientX, event.clientY, event.target);
    if (started && typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }, [start]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    move(
      event.pointerId,
      event.clientX,
      event.clientY,
      () => {
        if (event.cancelable) event.preventDefault();
      },
    );
  }, [move]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    end(event.pointerId);
  }, [end]);

  const onTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    start(touch.identifier, touch.clientX, touch.clientY, event.target);
  }, [start]);

  const onTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === drag.id);
    if (!touch) return;
    move(touch.identifier, touch.clientX, touch.clientY, () => {
      if (event.cancelable) event.preventDefault();
    });
  }, [move]);

  const onTouchEnd = useCallback((event: TouchEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === drag.id);
    end(touch?.identifier ?? drag.id);
  }, [end]);

  const sheetStyle = {
    transform: sheetTransform(axis),
    transition: dragging ? "none" : closing ? `transform ${SETTLE_MS}ms ease-in` : settling ? `transform ${SETTLE_MS}ms ease-out` : undefined,
  } as CSSProperties;

  const backdropStyle = {
    opacity: `var(${BACKDROP_OPACITY_VAR}, 1)`,
    transition: dragging ? "none" : closing ? `opacity ${SETTLE_MS}ms ease-in` : settling ? `opacity ${SETTLE_MS}ms ease-out` : undefined,
  } as CSSProperties;

  return {
    backdropRef: setBackdropRef,
    backdropStyle,
    closeWithAnimation: finishClose,
    resetOpen,
    sheetDragHandlers: {
      onPointerDownCapture: onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onTouchStartCapture: onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
    },
    sheetRef: setSheetRef,
    sheetStyle,
  };
}

function isExcluded(target: EventTarget | null) {
  return target instanceof Element && target.closest(DRAG_EXCLUSION_SELECTOR) != null;
}

function closestScrollViewport(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest(SCROLL_VIEWPORT_SELECTOR) as HTMLElement | null;
}

function dragOffset(drag: DragState, axis: DragAxis) {
  return axis === "x" ? Math.max(0, drag.startX - drag.currentX) : Math.max(0, drag.currentY - drag.startY);
}

function sheetTransform(axis: DragAxis) {
  return axis === "x" ? `translate3d(calc(var(${SHEET_OFFSET_VAR}, 0px) * -1), 0, 0)` : `translate3d(0, var(${SHEET_OFFSET_VAR}, 0px), 0)`;
}

function closeDistance(element: HTMLElement | null, axis: DragAxis) {
  return panelSize(element, axis);
}

function closeThreshold(element: HTMLElement | null, axis: DragAxis) {
  return panelSize(element, axis) / 4;
}

function panelSize(element: HTMLElement | null, axis: DragAxis) {
  const rect = element?.getBoundingClientRect();
  return Math.max(1, axis === "x" ? rect?.width ?? window.innerWidth : rect?.height ?? window.innerHeight);
}

function backdropOpacity(offset: number, size = window.innerHeight) {
  const safeSize = Math.max(1, size);
  const fadeStart = safeSize * BACKDROP_FADE_START_RATIO;
  if (offset <= fadeStart) return 1;
  return Math.max(0, 1 - (offset - fadeStart) / (safeSize - fadeStart));
}
