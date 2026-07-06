import { act, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStartupSplash } from "@/features/app/AppStartupSplash";

describe("AppStartupSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders only the Brai logo immediately", () => {
    render(<AppStartupSplash ready={false} />);

    const splash = document.querySelector("[data-startup-splash]");
    expect(splash).toBeInTheDocument();
    expect(within(splash as HTMLElement).getByRole("img", { name: "Brai" })).toBeInTheDocument();
    expect(within(splash as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    expect(within(splash as HTMLElement).queryByText("Brai")).not.toBeInTheDocument();
  });

  it("stays visible for at least three seconds", () => {
    render(<AppStartupSplash ready />);

    act(() => vi.advanceTimersByTime(2999));

    expect(document.querySelector("[data-startup-splash]")).toBeInTheDocument();
  });

  it("hides after three seconds when the app is ready", () => {
    render(<AppStartupSplash ready />);

    act(() => vi.advanceTimersByTime(3000));

    expect(document.querySelector("[data-startup-splash]")).not.toBeInTheDocument();
  });

  it("waits past three seconds until the app becomes ready", () => {
    const view = render(<AppStartupSplash ready={false} />);

    act(() => vi.advanceTimersByTime(3000));

    expect(document.querySelector("[data-startup-splash]")).toBeInTheDocument();

    view.rerender(<AppStartupSplash ready />);

    expect(document.querySelector("[data-startup-splash]")).not.toBeInTheDocument();
  });

  it("does not stay forever when startup readiness stalls", () => {
    render(<AppStartupSplash ready={false} />);

    act(() => vi.advanceTimersByTime(4999));

    expect(document.querySelector("[data-startup-splash]")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));

    expect(document.querySelector("[data-startup-splash]")).not.toBeInTheDocument();
  });
});
