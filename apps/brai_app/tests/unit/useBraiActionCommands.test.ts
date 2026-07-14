import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBraiActionCommands } from "@/features/app/hooks/useBraiActionCommands";
import { pendingActivityEvents } from "@/shared/storage/activityStore";
import { clientDb } from "@/shared/storage/db";
import { pendingRelationEvents } from "@/shared/storage/relationStore";
import { emptyActivitiesState, type ActivityItem } from "@/shared/types/activities";

describe("createBraiActionCommands", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("checks the local mutation boundary before every durable Action and Goal path", async () => {
    const blocked = new Error("local_snapshot_not_ready");
    const beforeLocalMutation = vi.fn(() => { throw blocked; });
    const beforeGoalStatusChange = vi.fn(async () => undefined);
    const first = activity("action-1", "action", "Первое");
    const second = activity("action-2", "action", "Второе");
    const goal = activity("goal-1", "goal", "Цель");
    const actions = emptyActivitiesState();
    actions.actions = [first, second];
    actions.goals = [goal];
    const commands = createBraiActionCommands({
      actions,
      beforeGoalStatusChange,
      beforeLocalMutation,
      flushActionPending: vi.fn(async () => undefined),
      getActions: () => actions,
      setActionPendingCount: vi.fn(),
      setActions: vi.fn(),
      setSyncStatus: vi.fn(),
    });

    const attempts: Array<() => Promise<void>> = [
      () => commands.onCreateAction("Новое действие"),
      () => commands.onCreateGoal("Новая цель"),
      () => commands.onUpdateActionTitle(first, "Новое название"),
      () => commands.onAutosaveActionDetails(first, "Первое", "Новое описание"),
      () => commands.onSetActionStatus(first, "Done"),
      () => commands.onDeleteAction(first),
      () => commands.onRestoreAction(first),
      () => commands.onReorderActions([second.id, first.id], first),
      () => commands.onSetGoalStatus(goal, "Done"),
    ];

    for (const attempt of attempts) await expect(attempt()).rejects.toBe(blocked);

    expect(beforeLocalMutation).toHaveBeenCalledTimes(attempts.length);
    expect(beforeGoalStatusChange).not.toHaveBeenCalled();
    expect(await pendingActivityEvents()).toEqual([]);
    expect(await pendingRelationEvents()).toEqual([]);
  });

  it("keeps the boundary callback optional for existing callers", async () => {
    const actions = emptyActivitiesState();
    const commands = createBraiActionCommands({
      actions,
      flushActionPending: vi.fn(async () => undefined),
      setActionPendingCount: vi.fn(),
      setActions: vi.fn(),
      setSyncStatus: vi.fn(),
    });

    await commands.onCreateAction("Локальное действие");

    expect(await pendingActivityEvents()).toHaveLength(1);
  });

  it("rechecks the owner after the awaited Goal status precondition", async () => {
    const blocked = new Error("local_user_scope_not_ready");
    let owner = "user-a";
    const beforeLocalMutation = vi.fn((expectedOwnerId?: string) => {
      if (owner !== "user-a" || (expectedOwnerId && expectedOwnerId !== owner)) throw blocked;
      return owner;
    });
    const beforeGoalStatusChange = vi.fn(async () => {
      owner = "user-b";
    });
    const goal = activity("goal-1", "goal", "Цель");
    const actions = emptyActivitiesState();
    actions.goals = [goal];
    const commands = createBraiActionCommands({
      actions,
      beforeGoalStatusChange,
      beforeLocalMutation,
      flushActionPending: vi.fn(async () => undefined),
      getActions: () => actions,
      setActionPendingCount: vi.fn(),
      setActions: vi.fn(),
      setSyncStatus: vi.fn(),
    });

    await expect(commands.onSetGoalStatus(goal, "Done")).rejects.toBe(blocked);

    expect(beforeGoalStatusChange).toHaveBeenCalledOnce();
    expect(beforeLocalMutation).toHaveBeenCalledTimes(2);
    expect(await pendingActivityEvents()).toEqual([]);
  });
});

function activity(id: string, type: "action" | "goal", title: string): ActivityItem {
  return {
    id,
    activity_type_id: type,
    title,
    description_md: "",
    status: "New",
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
    completed_at_utc: null,
    sort_order: null,
    deleted_at_utc: null,
    restored_at_utc: null,
  };
}
