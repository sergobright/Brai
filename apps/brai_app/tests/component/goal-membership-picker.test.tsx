import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoalMembershipPicker } from "@/features/app/sections/actions/GoalMembershipControls";
import type { WorkspaceWorkItem } from "@/features/app/sections/actions/actionsWorkspaceModel";
import type { ActivityItem } from "@/shared/types/activities";
import type { RelationItem } from "@/shared/types/relations";

Element.prototype.scrollIntoView = vi.fn();

describe("GoalMembershipPicker", () => {
  it("offers one active unlinked Goal and preserves existing memberships", async () => {
    const onAdd = vi.fn(async () => undefined);
    render(
      <GoalMembershipPicker
        item={workItem([membership(goal("linked", "Уже привязана"), "linked")])}
        goals={[
          goal("active", "Активная цель"),
          goal("linked", "Уже привязана"),
          goal("done", "Завершённая", "Done"),
          { ...goal("deleted", "Удалённая"), deleted_at_utc: "2026-07-15T00:00:00.000Z" },
        ]}
        onAdd={onAdd}
        onCreateGoal={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Добавить в цель: Пункт" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Активная цель" }));
    fireEvent.click(await screen.findByRole("option", { name: "Активная цель" }));
    expect(screen.queryByRole("option", { name: "Уже привязана" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Завершённая" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Удалённая" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledWith("item-1", ["active"]));
  });

  it("creates a Goal and membership through one callback", async () => {
    const onCreateGoal = vi.fn(async () => undefined);
    render(
      <GoalMembershipPicker
        item={workItem()}
        goals={[]}
        onAdd={vi.fn(async () => undefined)}
        onCreateGoal={onCreateGoal}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Добавить в цель: Пункт" }));
    expect(screen.getByText("Нет доступных целей")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Создать цель" }));
    expect(screen.getByRole("button", { name: "Создать цель" })).toHaveAttribute("aria-expanded", "true");
    const title = screen.getByRole("textbox", { name: "Название новой цели" });
    expect(title).toHaveAttribute("name", "new-goal-title");
    expect(title).toHaveAttribute("id");
    fireEvent.change(title, { target: { value: "  Новая цель  " } });
    const create = screen.getByRole("button", { name: "Создать и добавить" });
    fireEvent.click(create);
    fireEvent.click(create);

    await waitFor(() => expect(onCreateGoal).toHaveBeenCalledWith("item-1", "Новая цель"));
    expect(onCreateGoal).toHaveBeenCalledTimes(1);
  });
});

function workItem(memberships: WorkspaceWorkItem["memberships"] = []): WorkspaceWorkItem {
  const activity = action();
  return {
    id: "item-1",
    rowId: "item-1",
    kind: "action",
    relationSourceRole: "activity",
    goalMembershipReadOnly: false,
    title: "Пункт",
    descriptionMd: "",
    status: "New",
    updatedAtUtc: activity.updated_at_utc,
    activity,
    memberships,
  };
}

function action(): ActivityItem {
  return { ...goal("item-1", "Пункт"), activity_type_id: "action" };
}

function goal(id: string, title: string, status: ActivityItem["status"] = "New"): ActivityItem {
  return {
    id,
    activity_type_id: "goal",
    title,
    description_md: "",
    status,
    created_at_utc: "2026-07-15T00:00:00.000Z",
    updated_at_utc: "2026-07-15T00:00:00.000Z",
    completed_at_utc: status === "Done" ? "2026-07-15T00:00:00.000Z" : null,
    sort_order: null,
    deleted_at_utc: null,
    restored_at_utc: null,
  };
}

function membership(goalItem: ActivityItem, relationId: string): WorkspaceWorkItem["memberships"][number] {
  return { goal: goalItem, relation: relation(relationId, goalItem.id) };
}

function relation(id: string, targetId: string): RelationItem {
  return {
    id,
    user_id: "user-1",
    relation_types_id: "part_of",
    source_items_id: "item-1",
    target_items_id: targetId,
    status: "active",
    position: 0,
    active_from_utc: "2026-07-15T00:00:00.000Z",
    active_to_utc: null,
    operation_id: `operation-${id}`,
    ended_operation_id: null,
    origin_decision_id: null,
    created_by_actor_type: "user",
    created_by_actor_id: "user-1",
    ended_by_actor_type: null,
    ended_by_actor_id: null,
    end_reason: null,
    metadata_json: {},
    created_at_utc: "2026-07-15T00:00:00.000Z",
    updated_at_utc: "2026-07-15T00:00:00.000Z",
  };
}
