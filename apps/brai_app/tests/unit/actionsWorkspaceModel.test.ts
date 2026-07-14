import { describe, expect, it } from "vitest";
import { buildActionsWorkspace, goalFilterId, visibleGoalBadges } from "@/features/app/sections/actions/actionsWorkspaceModel";
import { emptyActivitiesState, type ActivityItem } from "@/shared/types/activities";
import { emptyInboxState, type InboxItem } from "@/shared/types/inbox";
import { emptyRelationsState, type RelationItem } from "@/shared/types/relations";

describe("actionsWorkspaceModel", () => {
  it("keeps Goals out of All and interleaves normalized Operations", () => {
    const activities = emptyActivitiesState();
    activities.actions = [activity("action-1", "action", "New", "2026-07-13T01:00:00.000Z")];
    activities.goals = [activity("goal-1", "goal", "New", "2026-07-13T00:00:00.000Z")];
    const inbox = emptyInboxState();
    inbox.inbox = [operation("operation-1", "Done", "2026-07-13T02:00:00.000Z")];

    const view = buildActionsWorkspace({ activities, inbox, relations: emptyRelationsState(), filter: "all" });

    expect(view.allItems.map((item) => [item.kind, item.rowId])).toEqual([
      ["action", "action-1"],
      ["operation", "operation-1"],
    ]);
    expect(view.systemCounts).toEqual({ all: 2, actions: 1, operations: 1, "without-goal": 2 });
  });

  it("marks legacy Activity Operations as read-only relation sources", () => {
    const activities = emptyActivitiesState();
    activities.legacy_operations = [activity("legacy-operation", "operation")];
    const inbox = emptyInboxState();
    inbox.inbox = [operation("normalized-operation", "New", "2026-07-13T02:00:00.000Z")];

    const items = buildActionsWorkspace({ activities, inbox, relations: emptyRelationsState(), filter: "all" }).allItems;

    expect(items.find((item) => item.id === "legacy-operation")).toMatchObject({
      kind: "operation", relationSourceRole: "activity", goalMembershipReadOnly: true,
    });
    expect(items.find((item) => item.id === "normalized-operation")).toMatchObject({
      kind: "operation", relationSourceRole: "inbox", goalMembershipReadOnly: false,
    });
  });

  it("filters zero-membership work and exposes only two named Goal badges", () => {
    const activities = emptyActivitiesState();
    activities.actions = [activity("a1"), activity("a2")];
    activities.goals = [activity("g1", "goal"), activity("g2", "goal"), activity("g3", "goal")];
    const relations = emptyRelationsState();
    relations.relations = [relation("r1", "a1", "g1", 0), relation("r2", "a1", "g2", 0), relation("r3", "a1", "g3", 0)];

    const view = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations, filter: "without-goal" });
    const all = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations, filter: "all" });

    expect(view.allItems.map((item) => item.id)).toEqual(["a2"]);
    expect(visibleGoalBadges(all.allItems.find((item) => item.id === "a1")!)).toMatchObject({ remaining: 1 });
  });

  it("sorts a selected Goal by status then Relation position and computes eligibility", () => {
    const activities = emptyActivitiesState();
    activities.actions = [
      activity("new-later", "action", "New", "2026-07-13T03:00:00.000Z"),
      activity("done-first", "action", "Done", "2026-07-13T04:00:00.000Z"),
      activity("new-first", "action", "New", "2026-07-13T01:00:00.000Z"),
    ];
    activities.goals = [activity("goal-1", "goal")];
    const relations = emptyRelationsState();
    relations.relations = [
      relation("r1", "new-later", "goal-1", 2),
      relation("r2", "done-first", "goal-1", 0),
      relation("r3", "new-first", "goal-1", 1),
    ];

    const view = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations, filter: goalFilterId("goal-1") });

    expect(view.allItems.map((item) => item.id)).toEqual(["new-first", "new-later", "done-first"]);
    expect(view.selectedGoalProgress).toEqual({ total: 3, done: 1, eligible: false, reason: "Сначала завершите все пункты цели." });
  });

  it("falls back to All when a persisted Goal is unavailable", () => {
    const activities = emptyActivitiesState();
    activities.actions = [activity("a1")];
    const view = buildActionsWorkspace({ activities, inbox: emptyInboxState(), relations: emptyRelationsState(), filter: goalFilterId("missing") });
    expect(view.filter).toBe("all");
    expect(view.allItems.map((item) => item.id)).toEqual(["a1"]);
  });
});

function activity(id: string, type: "action" | "goal" | "operation" = "action", status: "New" | "Done" = "New", updatedAt = "2026-07-13T00:00:00.000Z"): ActivityItem {
  return { id, activity_type_id: type, title: id, description_md: "", status, created_at_utc: updatedAt, updated_at_utc: updatedAt, completed_at_utc: status === "Done" ? updatedAt : null, sort_order: null, deleted_at_utc: null, restored_at_utc: null };
}

function operation(id: string, status: "New" | "Done", updatedAt: string): InboxItem {
  return { id, items_id: id, title: id, description_md: "", source: "agent", source_key: "agent", response_required: false, related_inbox_id: null, record_type_id: 2, item_date: null, author: "agent", preliminary_section: "operation", urgency: "", attachment_links: [], explanation_text: "", normalization_text: "", is_normalized: true, status, completed_at_utc: status === "Done" ? updatedAt : null, item_roles_id: 1, created_at_utc: updatedAt, updated_at_utc: updatedAt, deleted_at_utc: null };
}

function relation(id: string, source: string, target: string, position: number): RelationItem {
  return { id, user_id: "u1", relation_types_id: "part_of", source_items_id: source, target_items_id: target, status: "active", position, active_from_utc: "2026-07-13T00:00:00.000Z", active_to_utc: null, operation_id: id, ended_operation_id: null, origin_decision_id: null, created_by_actor_type: "user", created_by_actor_id: "u1", ended_by_actor_type: null, ended_by_actor_id: null, end_reason: null, metadata_json: {}, created_at_utc: "2026-07-13T00:00:00.000Z", updated_at_utc: "2026-07-13T00:00:00.000Z" };
}
