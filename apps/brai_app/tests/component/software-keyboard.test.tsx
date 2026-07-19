import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isSoftwareKeyboardViewport, useSoftwareKeyboardOpen } from "@/features/app/hooks/useSoftwareKeyboardOpen";

describe("global software keyboard state", () => {
  afterEach(() => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
    document.body.replaceChildren();
  });

  it("requires both an editable focus and a meaningful viewport contraction", () => {
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 500, editableFocused: true })).toBe(true);
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 740, editableFocused: true })).toBe(false);
    expect(isSoftwareKeyboardViewport({ baselineHeight: 800, currentHeight: 500, editableFocused: false })).toBe(false);
  });

  it("opens on the first contracted viewport frame and closes while it expands", () => {
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
