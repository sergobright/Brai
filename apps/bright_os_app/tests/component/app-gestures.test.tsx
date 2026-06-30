import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupBrightOsAppTest, swipe } from "./app-test-support";
import { BrightOsApp } from "@/features/app/BrightOsApp";
import { installAndroidBackHandler } from "@/shared/platform/platform";

describe("BrightOsApp gestures", () => {
  setupBrightOsAppTest();

  it("tries Android back handlers from the top layer down", () => {
    const calls: string[] = [];
    const cleanupBase = installAndroidBackHandler(() => {
      calls.push("base");
      return true;
    });
    const cleanupTop = installAndroidBackHandler(() => {
      calls.push("top");
      return false;
    });

    expect(window.BrightOsAndroidBack?.()).toBe(true);
    expect(calls).toEqual(["top", "base"]);

    cleanupTop();
    cleanupBase();
  });

  it("does not move screens from horizontal page-body drags", () => {
    render(<BrightOsApp />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, {
      changedTouches: [{ identifier: 1, clientX: 320, clientY: 220 }],
    });
    fireEvent.touchMove(main, {
      changedTouches: [{ identifier: 1, clientX: 240, clientY: 224 }],
    });

    const current = document.querySelector('[data-section-page="actions"]');

    expect(current).toBeInstanceOf(HTMLElement);
    expect((current as HTMLElement).style.transform).toBe("");
    expect(document.querySelector('[data-section-page="focus"]')).not.toBeInTheDocument();
  });

  it("opens the mobile profile drawer from a left-edge page swipe", async () => {
    render(<BrightOsApp />);
    const main = screen.getByRole("main");

    fireEvent.touchStart(main, {
      changedTouches: [{ identifier: 1, clientX: 2, clientY: 220 }],
    });
    fireEvent.touchMove(main, {
      changedTouches: [{ identifier: 1, clientX: 88, clientY: 224 }],
    });
    fireEvent.touchEnd(main, {
      changedTouches: [{ identifier: 1, clientX: 116, clientY: 224 }],
    });

    const drawer = await waitFor(() => {
      const current = document.querySelector(".mobile-profile-drawer");
      expect(current).toBeInstanceOf(HTMLElement);
      return current as HTMLElement;
    });
    expect(drawer).toHaveClass("w-4/5");
  });

  it("switches adjacent mobile tabs by swiping anywhere across the bottom menu zone", async () => {
    render(<BrightOsApp />);
    const dock = document.querySelector(".main-dock");
    expect(dock).toBeInstanceOf(HTMLElement);

    fireEvent.touchStart(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 340, clientY: 720 }],
    });
    fireEvent.touchMove(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 260, clientY: 724 }],
    });
    const current = document.querySelector('[data-section-page="actions"]');
    const adjacent = document.querySelector('[data-section-page="inbox"]');
    expect((current as HTMLElement).style.transform).toBe("translate3d(-80px, 0, 0)");
    expect((adjacent as HTMLElement).style.transform).toBe("translate3d(280px, 0, 0)");
    fireEvent.touchEnd(dock as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 180, clientY: 724 }],
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Входящие" })).toBeInTheDocument());

    swipe(dock as HTMLElement, { fromX: 20, toX: 160 });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument());
  });

  it("does not switch mobile tabs while the profile drawer is open", () => {
    render(<BrightOsApp />);
    const dock = document.querySelector(".main-dock");
    expect(dock).toBeInstanceOf(HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    swipe(dock as HTMLElement, { fromX: 320, toX: 180 });

    expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument();
  });

  it("closes the mobile profile drawer through the Android back bridge", async () => {
    render(<BrightOsApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    await waitFor(() => expect(window.BrightOsAndroidBack).toBeTypeOf("function"));
    expect(window.BrightOsAndroidBack?.()).toBe(true);

    await waitFor(() => expect(document.querySelector(".mobile-menu-backdrop")).not.toBeInTheDocument());
  });

  it("drags the mobile profile drawer back to the screen edge", async () => {
    render(<BrightOsApp />);

    fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
    const drawer = document.querySelector(".mobile-profile-drawer") as HTMLElement | null;
    const backdrop = document.querySelector(".mobile-menu-backdrop > div") as HTMLElement | null;
    expect(drawer).toBeInstanceOf(HTMLElement);
    expect(backdrop).toBeInstanceOf(HTMLElement);
    Object.defineProperty(drawer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 640, height: 640, left: 0, right: 300, top: 0, width: 300, x: 0, y: 0 }),
    });

    fireEvent.touchStart(drawer as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 280, clientY: 120 }],
    });
    fireEvent.touchMove(drawer as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 80, clientY: 124 }],
    });

    await waitFor(() => expect((drawer as HTMLElement).style.getPropertyValue("--mobile-sheet-offset")).toBe("190px"));
    expect(Number((backdrop as HTMLElement).style.getPropertyValue("--mobile-sheet-backdrop-opacity"))).toBeLessThan(1);

    fireEvent.touchEnd(drawer as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 80, clientY: 124 }],
    });

    await waitFor(() => expect(document.querySelector(".mobile-menu-backdrop")).not.toBeInTheDocument());
  });

  it("keeps vertical gestures as page scroll instead of tab navigation", () => {
    render(<BrightOsApp />);
    const main = screen.getByRole("main");

    swipe(main, { fromX: 320, toX: 240, fromY: 120, toY: 260 });

    expect(screen.getByRole("heading", { name: "Действия" })).toBeInTheDocument();
  });

  it("does not switch tabs from excluded horizontal gesture areas", async () => {
    render(<BrightOsApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    const excluded = document.querySelector(".focus-history-backdrop");
    expect(excluded).toBeInstanceOf(HTMLElement);
    swipe(excluded as HTMLElement, { fromX: 320, toX: 180 });

    expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument();
    expect(document.querySelector(".mobile-context-sheet")).toBeInTheDocument();
  });

  it("fades the mobile sheet backdrop after the drag passes the sheet midpoint", async () => {
    render(<BrightOsApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    const sheet = document.querySelector(".mobile-context-sheet") as HTMLElement | null;
    const backdrop = document.querySelector(".mobile-context-backdrop > div") as HTMLElement | null;
    expect(sheet).toBeInstanceOf(HTMLElement);
    expect(backdrop).toBeInstanceOf(HTMLElement);
    Object.defineProperty(sheet, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ bottom: 500, height: 400, left: 0, right: 360, top: 100, width: 360, x: 0, y: 100 }),
    });

    fireEvent.touchStart(sheet as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 100 }],
    });
    fireEvent.touchMove(sheet as HTMLElement, {
      changedTouches: [{ identifier: 1, clientX: 200, clientY: 350 }],
    });

    await waitFor(() => expect(Number((backdrop as HTMLElement).style.getPropertyValue("--mobile-sheet-backdrop-opacity"))).toBeLessThan(1));
    expect((sheet as HTMLElement).style.getPropertyValue("--mobile-sheet-offset")).toBe("240px");
  });

  it("closes an open mobile sheet through the Android back bridge", async () => {
    render(<BrightOsApp initialSection="focus" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Фокус" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "История фокуса" }));

    await waitFor(() => expect(window.BrightOsAndroidBack).toBeTypeOf("function"));
    expect(window.BrightOsAndroidBack?.()).toBe(true);

    await waitFor(() => expect(document.querySelector(".mobile-context-sheet")).not.toBeInTheDocument());
  });
});
