import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useActionsWorkspace } from "@/features/app/hooks/useActionsWorkspace";
import { emptyActivitiesState, type ActivityItem } from "@/shared/types/activities";
import { emptyInboxState } from "@/shared/types/inbox";
import { emptyRelationsState } from "@/shared/types/relations";

const STORAGE_KEY = "brai_actions_workspace_filter";

describe("useActionsWorkspace", () => {
  afterEach(() => window.localStorage.clear());

  it("persists the All fallback after a selected Goal disappears", async () => {
    window.localStorage.setItem(STORAGE_KEY, "goal:missing");
    const activities = emptyActivitiesState();
    activities.server_revision = 4;
    const { result } = renderHook(() => useActionsWorkspace(activities, emptyInboxState(), emptyRelationsState()));

    await waitFor(() => expect(result.current.workspace.filter).toBe("all"));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("all");
  });

  it("does not discard a persisted Goal before the local snapshot loads", async () => {
    window.localStorage.setItem(STORAGE_KEY, "goal:goal-1");
    const initial = emptyActivitiesState();
    const inbox = emptyInboxState();
    const relations = emptyRelationsState();
    const { result, rerender } = renderHook(
      ({ activities }) => useActionsWorkspace(activities, inbox, relations),
      { initialProps: { activities: initial } },
    );

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("goal:goal-1");
    const loaded = emptyActivitiesState();
    loaded.server_revision = 3;
    loaded.goals = [goal()];
    rerender({ activities: loaded });

    await waitFor(() => expect(result.current.workspace.selectedGoal?.id).toBe("goal-1"));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("goal:goal-1");
  });
});

function goal(): ActivityItem {
  return {
    id: "goal-1",
    activity_type_id: "goal",
    title: "Луна",
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
