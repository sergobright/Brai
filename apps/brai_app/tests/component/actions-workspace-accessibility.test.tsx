import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActionsWorkspaceNavigation } from "@/features/app/sections/actions/ActionsWorkspaceNavigation";
import { ContextReviewPanel } from "@/features/app/sections/actions/ContextReviewPanel";
import { GoalBadges } from "@/features/app/sections/actions/GoalMembershipControls";
import { GoalWorkspaceHeader } from "@/features/app/sections/actions/GoalWorkspaceHeader";
import { WorkspaceWorkList } from "@/features/app/sections/actions/WorkspaceWorkList";
import { buildActionsWorkspace, type WorkspaceWorkItem } from "@/features/app/sections/actions/actionsWorkspaceModel";
import { emptyActivitiesState, type ActivityItem } from "@/shared/types/activities";
import { emptyContextDecisionsState } from "@/shared/types/contextDecisions";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyRelationsState, type RelationItem } from "@/shared/types/relations";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

const originalMatchMedia = window.matchMedia;

describe("Actions workspace accessibility", () => {
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({
      matches: true,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("keeps the mobile reorder activator keyboard-focusable", () => {
    const item = workItem();
    render(
      <WorkspaceWorkList
        items={[item]}
        goals={[goal()]}
        filter="goal:goal-1"
        selectedId={null}
        titleDrafts={{}}
        openDeleteActionId={null}
        activeActivityId={null}
        activeActivityElapsedSeconds={0}
        sortable
        onSelect={vi.fn()}
        onEditMobile={vi.fn()}
        onUpdateTitle={vi.fn()}
        onTitleDraftChange={vi.fn()}
        onSetStatus={vi.fn()}
        onDelete={vi.fn()}
        onOpenDelete={vi.fn()}
        onCloseDelete={vi.fn()}
        onStartFocus={vi.fn()}
        onStopFocus={vi.fn()}
        onSelectFilter={vi.fn()}
        onAddToGoals={vi.fn()}
        onRemoveFromGoal={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    const handle = screen.getByRole("button", { name: "Переместить: Первый шаг" });
    handle.focus();
    expect(handle).toHaveFocus();
    expect(handle).toHaveClass("max-[860px]:size-11");
    expect(handle.closest("[data-sortable-workspace-item]")).toHaveClass("motion-reduce:!transition-none");
  });

  it("gives compact Goal badges a mobile touch target", () => {
    render(<GoalBadges item={workItem()} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Луна" })).toHaveClass("max-[860px]:min-h-11");
  });

  it("applies 44px mobile touch targets without changing desktop control sizes", () => {
    const activities = emptyActivitiesState();
    activities.goals = [goal()];
    const workspace = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations: emptyRelationsState(), filter: "all" });
    const { unmount } = render(<ActionsWorkspaceNavigation workspace={workspace} onSelect={vi.fn()} onCreateGoal={vi.fn()} onRestoreGoal={vi.fn()} />);

    expect(screen.getByRole("navigation", { name: "Списки действий" })).toHaveClass(
      "max-[860px]:[&_button]:min-h-11",
      "max-[860px]:[&_button]:min-w-11",
      "max-[860px]:[&_[data-slot=input]]:min-h-11",
    );
    unmount();

    render(
      <GoalWorkspaceHeader
        goal={goal()}
        progress={{ total: 2, done: 1, eligible: false, reason: "Завершите все пункты." }}
        onSave={vi.fn()}
        onSetStatus={vi.fn()}
        onDelete={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Луна" }).closest("section")).toHaveClass(
      "max-[860px]:[&_button]:min-h-11",
      "max-[860px]:[&_button]:min-w-11",
      "max-[860px]:[&_[data-slot=input]]:min-h-11",
    );
  });

  it("keeps every review action in a mobile touch-target scope", () => {
    const state = emptyContextDecisionsState();
    state.decisions = [{
      id: "decision-1",
      decision_kind: "relation_add",
      status: "pending",
      confidence: 0.9,
      subject_items_id: "action-1",
      proposal: { target_items_id: "goal-1" },
      rationale: "Связать действие с целью",
      evidence: [],
      created_at_utc: "2026-07-13T00:00:00.000Z",
      updated_at_utc: "2026-07-13T00:00:00.000Z",
    }];
    render(<ContextReviewPanel state={state} onResolve={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Предложения" }).closest("section")).toHaveClass(
      "max-[860px]:[&_button]:min-h-11",
      "max-[860px]:[&_button]:min-w-11",
      "max-[860px]:[&_[data-slot=input]]:min-h-11",
    );
  });

  it("disables picker animation when reduced motion is requested", () => {
    render(
      <Popover open>
        <PopoverTrigger>Открыть выбор цели</PopoverTrigger>
        <PopoverContent>Выбор цели</PopoverContent>
      </Popover>,
    );

    expect(screen.getByText("Выбор цели")).toHaveClass(
      "motion-reduce:animate-none",
      "motion-reduce:transition-none",
    );
  });
});

function workItem(): WorkspaceWorkItem {
  const activity = action();
  return {
    id: activity.id,
    rowId: activity.id,
    kind: "action",
    relationSourceRole: "activity",
    goalMembershipReadOnly: false,
    title: activity.title,
    descriptionMd: "",
    status: "New",
    updatedAtUtc: activity.updated_at_utc,
    activity,
    memberships: [{ goal: goal(), relation: relation() }],
    selectedRelation: relation(),
  };
}

function action(): ActivityItem {
  return activity("action-1", "action", "Первый шаг");
}

function goal(): ActivityItem {
  return activity("goal-1", "goal", "Луна");
}

function activity(id: string, activityType: "action" | "goal", title: string): ActivityItem {
  return { id, activity_type_id: activityType, title, description_md: "", status: "New", created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z", completed_at_utc: null, sort_order: null, deleted_at_utc: null, restored_at_utc: null };
}

function relation(): RelationItem {
  return { id: "relation-1", user_id: "user-1", relation_types_id: "part_of", source_items_id: "action-1", target_items_id: "goal-1", status: "active", position: 0, active_from_utc: "2026-07-13T00:00:00.000Z", active_to_utc: null, operation_id: "operation-1", ended_operation_id: null, origin_decision_id: null, created_by_actor_type: "user", created_by_actor_id: "user-1", ended_by_actor_type: null, ended_by_actor_id: null, end_reason: null, metadata_json: {}, created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z" };
}
