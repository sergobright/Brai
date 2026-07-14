import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NavigationIndicator, UpdateNavigationDot } from "@/shared/ui/navigation-indicator";

describe("NavigationIndicator", () => {
  it("uses bottom-right by default and accepts arbitrary content", () => {
    const { getByText } = render(<div className="relative"><NavigationIndicator><span>новое</span></NavigationIndicator></div>);
    expect(getByText("новое").parentElement).toHaveClass("bottom-0.5", "right-0.5", "absolute");
  });

  it("supports the mobile overflow bottom-center exception", () => {
    const { container } = render(<div className="relative"><NavigationIndicator position="bottom-center"><UpdateNavigationDot /></NavigationIndicator></div>);
    expect(container.querySelector(".absolute")).toHaveClass("bottom-0.5", "left-1/2", "-translate-x-1/2");
  });
});
