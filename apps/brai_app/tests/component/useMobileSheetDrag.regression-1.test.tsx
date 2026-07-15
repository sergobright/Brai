import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMobileSheetDrag } from "@/features/app/hooks/useMobileSheetDrag";

const originalMatchMedia = window.matchMedia;

// Regression: ISSUE-001 — vertical mobile sheets captured pointer events from buttons.
// Found by /qa on 2026-07-12.
// Report: /tmp/activity-normalization-qa/report.md
describe("useMobileSheetDrag", () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("does not capture a mouse pointer that starts on a button", () => {
    render(<TestSheet />);
    const sheet = screen.getByTestId("sheet");
    const setPointerCapture = vi.fn();
    sheet.setPointerCapture = setPointerCapture;

    fireEvent.pointerDown(screen.getByRole("button", { name: "AI" }), {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it("closes immediately and omits settle transitions when reduced motion is requested", () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const onClose = vi.fn();
    render(<ClosableTestSheet onClose={onClose} />);

    expect(screen.getByTestId("closable-sheet")).toHaveStyle({ transition: "none" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

function TestSheet() {
  const { sheetDragHandlers, sheetRef } = useMobileSheetDrag({ onClose: vi.fn() });

  return (
    <aside data-testid="sheet" ref={sheetRef} {...sheetDragHandlers}>
      <button type="button">AI</button>
    </aside>
  );
}

function ClosableTestSheet({ onClose }: { onClose: () => void }) {
  const { closeWithAnimation, sheetRef, sheetStyle } = useMobileSheetDrag({ onClose });

  return (
    <aside data-testid="closable-sheet" ref={sheetRef} style={sheetStyle}>
      <button type="button" onClick={closeWithAnimation}>Закрыть</button>
    </aside>
  );
}
