import { act, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStartupSplash } from "@/features/app/AppStartupSplash";

describe("AppStartupSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: false,
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as Window & { __braiStartupStartedAt?: number }).__braiStartupStartedAt;
  });

  it("renders one centered Brai logo with the CSS timeline immediately", () => {
    render(<AppStartupSplash ready={false} />);

    const splash = document.querySelector("[data-startup-splash]");
    const logo = splash?.querySelector("[data-startup-logo]");
    expect(splash).toBeInTheDocument();
    expect(within(splash as HTMLElement).getByRole("img", { name: "Brai" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-startup-logo]")).toHaveLength(1);
    expect(logo).toHaveStyle({ animation: "brai-startup-logo-fade 1000ms linear both" });
    expect(document.querySelector("style")?.textContent).toContain("brai-startup-logo-glare 1000ms linear 1000ms both");
    expect(within(splash as HTMLElement).queryByRole("button")).not.toBeInTheDocument();
    expect(within(splash as HTMLElement).queryByText("Brai")).not.toBeInTheDocument();
  });

  it("completes the fade, shimmer, and static phases after three seconds", () => {
    const onIntroComplete = vi.fn();
    render(<AppStartupSplash ready={false} onIntroComplete={onIntroComplete} />);

    const logo = document.querySelector("[data-startup-logo]");
    expect(logo).toHaveStyle({ animation: "brai-startup-logo-fade 1000ms linear both" });
    act(() => vi.advanceTimersByTime(2999));
    expect(onIntroComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onIntroComplete).toHaveBeenCalledTimes(1);
  });

  it("measures the three-second timeline from early document startup", () => {
    (window as Window & { __braiStartupStartedAt?: number }).__braiStartupStartedAt = 1000;
    vi.spyOn(window.performance, "now").mockReturnValue(1800);
    const onIntroComplete = vi.fn();

    render(<AppStartupSplash ready={false} onIntroComplete={onIntroComplete} />);
    act(() => vi.advanceTimersByTime(2199));
    expect(onIntroComplete).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onIntroComplete).toHaveBeenCalledTimes(1);
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

  it("keeps the same logo mounted for a fresh onboarding start", () => {
    const view = render(<AppStartupSplash ready persist />);
    const logo = document.querySelector("[data-startup-logo]");

    act(() => vi.advanceTimersByTime(5000));

    expect(document.querySelector("[data-startup-logo]")).toBe(logo);
    view.rerender(<AppStartupSplash ready persist={false} />);
    expect(document.querySelector("[data-startup-logo]")).not.toBeInTheDocument();
  });
});
