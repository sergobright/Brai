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
      activeBundleVersion: "0.0.10.1",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      lastCheckStatus: "up_to_date",
    });
    otaPlugin.markReady.mockResolvedValue({
      activeBundleVersion: "0.0.10.1",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      lastCheckStatus: "ready",
    });
    otaPlugin.checkForUpdates.mockResolvedValue({
      activeBundleVersion: "0.0.10.1",
      nativeVersionName: "0.0.10.1",
      nativeBuild: "1",
      nativeVersionCode: 1,
      candidateBundleVersion: "0.0.11.1",
      lastCheckStatus: "candidate_ready_for_next_start",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/v1/version")) {
        return new Response(JSON.stringify(testVersionState("0.0.10.1")), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return Promise.reject(new Error("offline"));
    }));
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
  fireEvent.click(screen.getByRole("button", { name: "Открыть левое меню" }));
  return await waitFor(() => {
    const current = document.querySelector(".mobile-profile-drawer");
    expect(current).toBeInstanceOf(HTMLElement);
    return current as HTMLElement;
  });
}

export async function openProfileMenuItem(name: string | RegExp) {
  const drawer = await openProfileMenu();
  fireEvent.click(within(drawer).getByRole("button", { name }));
}

export async function openSettingsFromProfile() {
  await openProfileMenuItem("Настройки");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Настройки" })).toBeInTheDocument());
}

export async function openEngineFromProfile() {
  await openProfileMenuItem(/^Engine(?: v.+)?$/);
  await waitFor(() => expect(screen.getByRole("heading", { name: "Engine" })).toBeInTheDocument());
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

export function cachedActivitiesState(id: string, title: string, descriptionMd = "") {
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

export function testVersionState(version: string) {
  const [canon, release, build, apk] = version.split(".").map(Number);
  return {
    server_time_utc: "2026-06-29T12:00:00.000Z",
    version,
    parts: { canon, release, build, apk },
    latest: {
      canon: null,
      release: release > 0 ? versionRow("release", release, "Release changes.") : null,
      build: versionRow("build", build, "Build changes."),
      apk: versionRow("apk", apk, "APK changes."),
    },
  };
}

function versionRow(type: "release" | "build" | "apk", version: number, shortChanges: string) {
  return {
    id: version,
    version_type_id: type,
    version,
    included_in_version_id: null,
    short_changes: shortChanges,
    detailed_changes: shortChanges,
    reason: shortChanges,
    released_at_utc: "2026-06-29T12:00:00.000Z",
    created_at_utc: "2026-06-29T12:00:00.000Z",
  };
}
