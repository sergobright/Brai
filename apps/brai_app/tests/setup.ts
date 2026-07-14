import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { configure } from "@testing-library/dom";
import { vi } from "vitest";

configure({ asyncUtilTimeout: 12_000 });

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("geist/font/sans", () => ({
  GeistSans: {
    variable: "__geistSans_mock",
  },
}));

vi.mock("geist/font/mono", () => ({
  GeistMono: {
    variable: "__geistMono_mock",
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    push: (href: string) => window.history.pushState(window.history.state, "", href),
    refresh: vi.fn(),
    replace: (href: string) => window.history.replaceState(window.history.state, "", href),
  }),
}));
