"use client";

import { useEffect, useRef, useState } from "react";

const MIN_KEYBOARD_HEIGHT_PX = 80;
const KEYBOARD_HEIGHT_RATIO = 0.15;

/** Returns whether a focused editor and viewport contraction indicate a software keyboard. */
export function isSoftwareKeyboardViewport({
  baselineHeight,
  currentHeight,
  editableFocused,
}: {
  baselineHeight: number;
  currentHeight: number;
  editableFocused: boolean;
}): boolean {
  if (!editableFocused || baselineHeight <= 0 || currentHeight <= 0) return false;
  const threshold = Math.max(MIN_KEYBOARD_HEIGHT_PX, baselineHeight * KEYBOARD_HEIGHT_RATIO);
  return baselineHeight - currentHeight >= threshold;
}

/** Tracks the global mobile software keyboard from the first VisualViewport animation frame. */
export function useSoftwareKeyboardOpen(enabled: boolean): boolean {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      openRef.current = false;
      return undefined;
    }

    const viewport = window.visualViewport;
    let baselineHeight = viewportHeight(viewport);
    let previousHeight = baselineHeight;
    let focusFrame = 0;

    function commit(next: boolean) {
      if (openRef.current === next) return;
      openRef.current = next;
      setOpen(next);
    }

    function update() {
      const currentHeight = viewportHeight(viewport);
      const editableFocused = isEditableElement(document.activeElement);
      if (!editableFocused) {
        baselineHeight = Math.max(baselineHeight, currentHeight);
        previousHeight = currentHeight;
        commit(false);
        return;
      }

      if (!openRef.current) baselineHeight = Math.max(baselineHeight, currentHeight);
      const next = isSoftwareKeyboardViewport({ baselineHeight, currentHeight, editableFocused });
      // Start restoring the Dock on the first upward keyboard frame instead of
      // waiting for the viewport to reach its final full-height position.
      if (openRef.current && currentHeight > previousHeight + 2) {
        baselineHeight = currentHeight;
        commit(false);
      } else {
        commit(next);
      }
      previousHeight = currentHeight;
    }

    function onFocusIn() {
      baselineHeight = Math.max(baselineHeight, viewportHeight(viewport));
      window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(update);
    }

    function onFocusOut() {
      window.cancelAnimationFrame(focusFrame);
      focusFrame = window.requestAnimationFrame(() => {
        if (!isEditableElement(document.activeElement)) commit(false);
        update();
      });
    }

    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    update();

    return () => {
      window.cancelAnimationFrame(focusFrame);
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [enabled]);

  return enabled && open;
}

function viewportHeight(viewport: VisualViewport | null): number {
  return Math.round(viewport?.height ?? window.innerHeight);
}

function isEditableElement(value: Element | null): boolean {
  if (!(value instanceof HTMLElement)) return false;
  if (value.isContentEditable) return true;
  return value instanceof HTMLInputElement
    || value instanceof HTMLTextAreaElement
    || value instanceof HTMLSelectElement;
}
