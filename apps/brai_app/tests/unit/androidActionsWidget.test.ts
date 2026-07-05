import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitiesState } from "@/shared/types/activities";

const plugin = vi.hoisted(() => ({
  acknowledgeStatusChanges: vi.fn(),
  addListener: vi.fn(),
  clear: vi.fn(),
  pendingStatusChanges: vi.fn(),
  saveSnapshot: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => plugin),
}));

describe("Android Actions widget bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    plugin.acknowledgeStatusChanges.mockReset();
    plugin.addListener.mockReset();
    plugin.clear.mockReset();
    plugin.pendingStatusChanges.mockReset();
    plugin.saveSnapshot.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing outside Android native shell", async () => {
    vi.stubGlobal("Capacitor", undefined);
    const { saveAndroidActionsWidgetSnapshot } = await import("@/shared/platform/androidActionsWidget");

    await saveAndroidActionsWidgetSnapshot(state());

    expect(plugin.saveSnapshot).not.toHaveBeenCalled();
  });

  it("sends the selected widget view snapshot, not necessarily every action", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const { saveAndroidActionsWidgetSnapshot } = await import("@/shared/platform/androidActionsWidget");
    const fullState = state();

    await saveAndroidActionsWidgetSnapshot(fullState, {
      viewId: "today",
      actions: [fullState.actions[1]],
    });

    expect(plugin.saveSnapshot).toHaveBeenCalledWith({
      viewId: "today",
      serverRevision: 7,
      snapshotVersion: expect.any(Number),
      actions: [{ id: "a2", title: "Второе", status: "Done" }],
    });
  });

  it("versions snapshots from action freshness so older state cannot overwrite newer widget data", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const { saveAndroidActionsWidgetSnapshot } = await import("@/shared/platform/androidActionsWidget");

    await saveAndroidActionsWidgetSnapshot(state());
    await saveAndroidActionsWidgetSnapshot({
      ...state(),
      actions: [action("a1", "Первое", "Done", "2026-07-04T12:01:00.000Z")],
    });

    const first = plugin.saveSnapshot.mock.calls[0][0].snapshotVersion;
    const second = plugin.saveSnapshot.mock.calls[1][0].snapshotVersion;
    expect(second).toBeGreaterThan(first);
  });

  it("uses an explicit snapshot version from the app state owner", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const { saveAndroidActionsWidgetSnapshot } = await import("@/shared/platform/androidActionsWidget");

    await saveAndroidActionsWidgetSnapshot(state(), { snapshotVersion: 42 });

    expect(plugin.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      snapshotVersion: 42,
    }));
  });

  it("reads and acknowledges widget status changes", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    plugin.pendingStatusChanges.mockResolvedValue({
      changes: [
        { id: "change-1", actionId: "a1", status: "Done", baseServerRevision: 7, occurredAtUtc: "2026-07-04T12:00:00.000Z" },
        { id: "change-2", actionId: "a2", status: "New", baseServerRevision: 7, occurredAtUtc: "2026-07-04T12:01:00.000Z" },
        { id: "bad", actionId: "a2", status: "Broken", baseServerRevision: 7, occurredAtUtc: "2026-07-04T12:00:00.000Z" },
      ],
    });
    const { acknowledgeAndroidActionsWidgetStatusChanges, pendingAndroidActionsWidgetStatusChanges } = await import(
      "@/shared/platform/androidActionsWidget"
    );

    await expect(pendingAndroidActionsWidgetStatusChanges()).resolves.toEqual([
      { id: "change-1", actionId: "a1", status: "Done", baseServerRevision: 7, occurredAtUtc: "2026-07-04T12:00:00.000Z" },
      { id: "change-2", actionId: "a2", status: "New", baseServerRevision: 7, occurredAtUtc: "2026-07-04T12:01:00.000Z" },
    ]);
    await acknowledgeAndroidActionsWidgetStatusChanges(["change-1", "change-2"]);

    expect(plugin.acknowledgeStatusChanges).toHaveBeenCalledWith({ ids: ["change-1", "change-2"] });
  });

  it("subscribes to native pending status notifications on Android", async () => {
    vi.stubGlobal("Capacitor", {
      isNativePlatform: () => true,
      getPlatform: () => "android",
    });
    const handle = { remove: vi.fn() };
    plugin.addListener.mockResolvedValue(handle);
    const { listenAndroidActionsWidgetStatusChangesPending } = await import("@/shared/platform/androidActionsWidget");
    const listener = vi.fn();

    await expect(listenAndroidActionsWidgetStatusChangesPending(listener)).resolves.toBe(handle);

    expect(plugin.addListener).toHaveBeenCalledWith("statusChangesPending", listener);
  });
});

function state(): ActivitiesState {
  return {
    server_time_utc: "2026-07-04T12:00:00.000Z",
    server_revision: 7,
    actions: [
      action("a1", "Первое", "New"),
      action("a2", "Второе", "Done"),
    ],
    archived_actions: [],
  };
}

function action(id: string, title: string, status: "New" | "Done", updatedAtUtc = "2026-07-04T10:00:00.000Z") {
  return {
    id,
    activity_type_id: "action" as const,
    title,
    description_md: "",
    status,
    created_at_utc: "2026-07-04T10:00:00.000Z",
    updated_at_utc: updatedAtUtc,
    completed_at_utc: status === "Done" ? updatedAtUtc : null,
    sort_order: null,
    deleted_at_utc: null,
    restored_at_utc: null,
  };
}
