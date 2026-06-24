import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { clientDb } from "@/shared/storage/db";

const otaPlugin = vi.hoisted(() => ({
  getState: vi.fn(),
  checkForUpdates: vi.fn(),
  markReady: vi.fn(),
}));

export { otaPlugin };

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => otaPlugin),
}));

function matchesMediaQuery(query: string): boolean {
  const maxWidth = query.match(/max-width:\s*(\d+)px/);
  if (maxWidth) return window.innerWidth <= Number(maxWidth[1]);
  const minWidth = query.match(/min-width:\s*(\d+)px/);
  if (minWidth) return window.innerWidth >= Number(minWidth[1]);
  return false;
}

export function setupBrightOsAppTest() {
  beforeEach(async () => {
    const db = clientDb();
    await Promise.all(db.tables.map((table) => table.clear()));
    otaPlugin.getState.mockReset();
    otaPlugin.checkForUpdates.mockReset();
    otaPlugin.markReady.mockReset();
    otaPlugin.getState.mockResolvedValue({
      activeBundleVersion: "0.0.6.1",
      nativeVersionName: "0.0.6.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      lastCheckStatus: "up_to_date",
    });
    otaPlugin.markReady.mockResolvedValue({
      activeBundleVersion: "0.0.6.1",
      nativeVersionName: "0.0.6.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      lastCheckStatus: "ready",
    });
    otaPlugin.checkForUpdates.mockResolvedValue({
      activeBundleVersion: "0.0.6.1",
      nativeVersionName: "0.0.6.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      candidateBundleVersion: "0.0.7.1",
      lastCheckStatus: "candidate_ready_for_next_start",
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: matchesMediaQuery(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 360 });
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    document.cookie = "sidebar_state=; path=/; max-age=0";
    delete document.documentElement.dataset.sidebarState;
  });

  afterEach(() => {
    delete window.Capacitor;
    delete window.BrightOsAndroidBack;
    delete document.documentElement.dataset.sidebarState;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export function stubAndroidCapacitor() {
  const capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };
  vi.stubGlobal("Capacitor", capacitor);
  window.Capacitor = capacitor;
}

export async function openProfileMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
  const drawer = await waitFor(() => {
    const current = document.querySelector(".mobile-profile-drawer");
    expect(current).toBeInstanceOf(HTMLElement);
    return current as HTMLElement;
  });
  const profileButton = within(drawer).getByRole("button", { name: "Открыть меню профиля" });
  fireEvent.pointerDown(profileButton, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(profileButton);
}

export async function openProfileMenuItem(name: string) {
  await openProfileMenu();
  fireEvent.touchEnd(await screen.findByRole("menuitem", { name }));
}

export async function openSettingsFromProfile() {
  await openProfileMenuItem("Настройки");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument());
}

export function swipe(
  element: HTMLElement,
  {
    fromX,
    toX,
    fromY = 220,
    toY = 224,
  }: {
    fromX: number;
    toX: number;
    fromY?: number;
    toY?: number;
  },
) {
  const identifier = 1;
  fireEvent.touchStart(element, {
    changedTouches: [{ identifier, clientX: fromX, clientY: fromY }],
  });
  fireEvent.touchEnd(element, {
    changedTouches: [{ identifier, clientX: toX, clientY: toY }],
  });
}

export function cachedActionsState(id: string, title: string, descriptionMd = "") {
  return {
    server_time_utc: "2026-06-16T12:00:00.000Z",
    server_revision: 8,
    actions: [
      {
        id,
        title,
        description_md: descriptionMd,
        status: "New" as const,
        created_at_utc: "2026-06-16T10:00:00.000Z",
        updated_at_utc: "2026-06-16T10:00:00.000Z",
        completed_at_utc: null,
        sort_order: null,
        deleted_at_utc: null,
        restored_at_utc: null,
      },
    ],
    archived_actions: [],
  };
}
