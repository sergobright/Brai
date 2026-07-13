import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useMobileSheetDrag } from "@/features/app/hooks/useMobileSheetDrag";

// Regression: ISSUE-001 — vertical mobile sheets captured pointer events from buttons.
// Found by /qa on 2026-07-12.
// Report: /tmp/activity-normalization-qa/report.md
describe("useMobileSheetDrag", () => {
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
});

function TestSheet() {
  const { sheetDragHandlers, sheetRef } = useMobileSheetDrag({ onClose: vi.fn() });

  return (
    <aside data-testid="sheet" ref={sheetRef} {...sheetDragHandlers}>
      <button type="button">AI</button>
    </aside>
  );
}
