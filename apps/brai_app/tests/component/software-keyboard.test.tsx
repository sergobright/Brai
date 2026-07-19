import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isSoftwareKeyboardViewport, useSoftwareKeyboardOpen } from "@/features/app/hooks/useSoftwareKeyboardOpen";

describe("global software keyboard state", () => {
  afterEach(() => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
    document.body.replaceChildren();
  });

  it("requires editable focus and reacts at the start of the keyboard animation", () => {
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 500, editableFocused: true })).toBe(true);
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 770, editableFocused: true })).toBe(true);
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 780, editableFocused: true })).toBe(false);
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 500, editableFocused: false })).toBe(false);
  });

  it("ignores Android viewport rebound while the keyboard remains open", () => {
    const viewport = fakeVisualViewport(800);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 800 });
    const input = document.createElement("input");
    document.body.append(input);
    const { result } = renderHook(() => useSoftwareKeyboardOpen(true));

    act(() => input.focus());
    act(() => {
      viewport.setHeight(520);
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);

    act(() => {
      viewport.setHeight(540);
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(true);

    act(() => {
      viewport.setHeight(793);
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);
  });
});

function fakeVisualViewport(initialHeight: number): VisualViewport & { setHeight: (height: number) => void } {
  let height = initialHeight;
  const viewport = Object.assign(new EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    onresize: null,
    onscroll: null,
    pageLeft: 0,
    pageTop: 0,
    scale: 1,
    setHeight: (nextHeight: number) => { height = nextHeight; },
    width: 393,
  });
  Object.defineProperty(viewport, "height", { configurable: true, get: () => height });
  return viewport as VisualViewport & { setHeight: (height: number) => void };
}
