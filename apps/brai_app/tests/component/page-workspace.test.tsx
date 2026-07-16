import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PAGE_WORKSPACE_REGISTRY, hasDesktopPageRail, hasMobilePageRail } from "@/features/app/appModel";
import { PageWorkspace } from "@/features/app/chrome/PageWorkspace";
import { ScrollArea } from "@/shared/ui/scroll-area";

describe("PageWorkspace", () => {
  it("centers a panel-free main column and gives an open panel a fixed half", () => {
    const view = render(<PageWorkspace main={<div>Главная</div>} />);

    const pageMain = document.querySelector(".page-main");
    expect(pageMain).toHaveClass("max-w-3xl");
    expect(pageMain).toHaveAttribute("data-slot", "scroll-area");
    expect(pageMain).not.toHaveClass("overflow-auto");
    expect(document.querySelector(".page-main > [data-slot='scroll-area-viewport']")).toBeInTheDocument();
    expect(document.querySelector(".page-main > [data-slot='scroll-area-scrollbar']")).toBeInTheDocument();
    expect(document.querySelector(".page-panel")).not.toBeInTheDocument();

    view.rerender(<PageWorkspace main={<div>Главная</div>} persistentPanel={<div>Постоянная</div>} />);
    expect(document.querySelector(".page-workspace")).toHaveClass("grid-cols-2", "has-panel");
    expect(document.querySelector(".page-panel")).toHaveAttribute("data-slot", "scroll-area");
    expect(document.querySelector(".page-panel")).not.toHaveClass("overflow-auto");
    expect(screen.getByText("Постоянная")).toBeInTheDocument();
  });

  it("removes the centered maximum for an explicit full-bleed page", () => {
    render(<PageWorkspace fullBleed main={<div>Полный экран</div>} />);

    expect(document.querySelector(".page-main")).toHaveClass("w-full", "max-w-none");
    expect(document.querySelector(".page-main")).not.toHaveClass("max-w-3xl", "mx-auto");
  });

  it("does not add a nested scroll owner when the page content owns scrolling", () => {
    render(<PageWorkspace mainScroll={false} main={<ScrollArea className="inner-scroll">Содержимое</ScrollArea>} />);

    expect(document.querySelector(".page-main")).not.toHaveAttribute("data-slot", "scroll-area");
    expect(document.querySelector(".page-main")).toHaveClass("overflow-hidden");
    expect(document.querySelector(".page-main > .inner-scroll")).toHaveAttribute("data-slot", "scroll-area");
  });

  it("temporarily replaces and then restores the persistent panel", () => {
    const view = render(
      <PageWorkspace
        main={<div>Главная</div>}
        persistentPanel={<div>Постоянная</div>}
        temporaryPanel={<div>Временная</div>}
      />,
    );

    expect(screen.getByText("Временная")).toBeInTheDocument();
    expect(screen.queryByText("Постоянная")).not.toBeInTheDocument();

    view.rerender(<PageWorkspace main={<div>Главная</div>} persistentPanel={<div>Постоянная</div>} />);
    expect(screen.getByText("Постоянная")).toBeInTheDocument();
  });
});

describe("page workspace registry", () => {
  it("keeps rail modes platform-specific", () => {
    expect(hasDesktopPageRail("actions")).toBe(true);
    expect(hasMobilePageRail("actions")).toBe(true);
    expect(hasDesktopPageRail("focus")).toBe(false);
    expect(hasMobilePageRail("focus", true)).toBe(false);
    expect(hasDesktopPageRail("brai-cmd")).toBe(false);
    expect(hasMobilePageRail("brai-cmd", false)).toBe(false);
    expect(hasMobilePageRail("brai-cmd", true)).toBe(true);
    expect(PAGE_WORKSPACE_REGISTRY.draws.fullscreenOverride).toBe(true);
    expect(PAGE_WORKSPACE_REGISTRY.focus.persistentPanels).toEqual(["goal", "history"]);
    expect(PAGE_WORKSPACE_REGISTRY.engine.persistentPanels).toEqual(["history"]);
  });
});
