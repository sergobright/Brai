"use client";

import { useEffect, useRef, useState } from "react";

const KEYBOARD_OPENING_DELTA_PX = 24;
const KEYBOARD_CLOSED_TOLERANCE_PX = 8;

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
  return baselineHeight - currentHeight >= KEYBOARD_OPENING_DELTA_PX;
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
        commit(false);
        return;
      }

      if (!openRef.current) baselineHeight = Math.max(baselineHeight, currentHeight);
      if (openRef.current) {
        // Android's VisualViewport often rebounds by a few pixels while the
        // keyboard is still open. Only a real return to the pre-keyboard
        // height may restore the Dock.
        if (currentHeight >= baselineHeight - KEYBOARD_CLOSED_TOLERANCE_PX) {
          baselineHeight = Math.max(baselineHeight, currentHeight);
          commit(false);
        }
      } else {
        commit(isSoftwareKeyboardViewport({ baselineHeight, currentHeight, editableFocused }));
      }
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
