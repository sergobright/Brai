import type { ActivityItem, ActivitiesState } from "@/shared/types/activities";
import type { InboxItem, InboxState } from "@/shared/types/inbox";
import type { RelationItem, RelationsState } from "@/shared/types/relations";

export const SYSTEM_WORKSPACE_FILTERS = [
  { id: "all", label: "Все" },
  { id: "actions", label: "Действия" },
  { id: "operations", label: "Операции" },
  { id: "without-goal", label: "Без цели" },
] as const;

export type SystemWorkspaceFilterId = typeof SYSTEM_WORKSPACE_FILTERS[number]["id"];
export type WorkspaceFilterId = SystemWorkspaceFilterId | `goal:${string}`;
export type WorkspaceWorkKind = "action" | "operation";
export type WorkspaceRelationSourceRole = "activity" | "inbox";

export type GoalMembership = {
  goal: ActivityItem;
  relation: RelationItem;
};

export type WorkspaceWorkItem = {
  id: string;
  rowId: string;
  kind: WorkspaceWorkKind;
  relationSourceRole: WorkspaceRelationSourceRole;
  goalMembershipReadOnly: boolean;
  title: string;
  descriptionMd: string;
  status: "New" | "Done";
  updatedAtUtc: string;
  activity?: ActivityItem;
  operation?: InboxItem;
  memberships: GoalMembership[];
  selectedRelation?: RelationItem;
};

export type GoalProgress = {
  total: number;
  done: number;
  eligible: boolean;
  reason: string | null;
};

export type ActionsWorkspaceView = {
  filter: WorkspaceFilterId;
  systemCounts: Record<SystemWorkspaceFilterId, number>;
  activeGoals: ActivityItem[];
  completedGoals: ActivityItem[];
  archivedGoals: ActivityItem[];
  selectedGoal: ActivityItem | null;
  selectedGoalProgress: GoalProgress | null;
  newItems: WorkspaceWorkItem[];
  doneItems: WorkspaceWorkItem[];
  allItems: WorkspaceWorkItem[];
};

export function goalFilterId(goalId: string): WorkspaceFilterId {
  return `goal:${goalId}`;
}

export function goalIdFromFilter(filter: WorkspaceFilterId): string | null {
  return filter.startsWith("goal:") ? filter.slice(5) || null : null;
}

/** Builds the deterministic Actions/Operations/Goal-list read model used by desktop and mobile. */
export function buildActionsWorkspace({
  activities,
  inbox,
  relations,
  filter,
}: {
  activities: ActivitiesState;
  inbox: InboxState;
  relations: RelationsState;
  filter: WorkspaceFilterId;
}): ActionsWorkspaceView {
  const goals = activities.goals ?? [];
  const activeGoals = goals.filter((goal) => goal.status === "New");
  const completedGoals = goals
    .filter((goal) => goal.status === "Done")
    .sort((left, right) => goalCompletedAt(right).localeCompare(goalCompletedAt(left)) || left.title.localeCompare(right.title));
  const archivedGoals = [...(activities.archived_goals ?? [])]
    .sort((left, right) => (right.deleted_at_utc ?? "").localeCompare(left.deleted_at_utc ?? ""));
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const activeMemberships = relations.relations.filter((relation) =>
    relation.status === "active" && relation.relation_types_id === "part_of" && goalsById.has(relation.target_items_id),
  );
  const membershipsBySource = groupMemberships(activeMemberships, goalsById);
  const work = currentWorkItems(activities, inbox, membershipsBySource);
  const selectedGoalId = goalIdFromFilter(filter);
  const selectedGoal = selectedGoalId ? goalsById.get(selectedGoalId) ?? null : null;
  const resolvedFilter: WorkspaceFilterId = selectedGoalId && !selectedGoal ? "all" : filter;
  const selectedRelations = selectedGoal
    ? new Map(activeMemberships.filter((relation) => relation.target_items_id === selectedGoal.id).map((relation) => [relation.source_items_id, relation]))
    : new Map<string, RelationItem>();
  const allItems = filteredWork(work, resolvedFilter, selectedRelations);

  return {
    filter: resolvedFilter,
    systemCounts: {
      all: work.length,
      actions: work.filter((item) => item.kind === "action").length,
      operations: work.filter((item) => item.kind === "operation").length,
      "without-goal": work.filter((item) => item.memberships.length === 0).length,
    },
    activeGoals,
    completedGoals,
    archivedGoals,
    selectedGoal,
    selectedGoalProgress: selectedGoal ? goalProgress(allItems) : null,
    newItems: allItems.filter((item) => item.status === "New"),
    doneItems: allItems.filter((item) => item.status === "Done"),
    allItems,
  };
}

export function visibleGoalBadges(item: WorkspaceWorkItem): { named: GoalMembership[]; remaining: number } {
  return { named: item.memberships.slice(0, 2), remaining: Math.max(0, item.memberships.length - 2) };
}

function currentWorkItems(
  activities: ActivitiesState,
  inbox: InboxState,
  membershipsBySource: Map<string, GoalMembership[]>,
): WorkspaceWorkItem[] {
  const actions = activities.actions.map((activity) => activityWorkItem(activity, "action", membershipsBySource));
  const normalizedOperations = inbox.inbox
    .filter((item) => item.preliminary_section === "operation" && item.deleted_at_utc == null && item.item_roles_id != null)
    .map((operation) => inboxOperationWorkItem(operation, membershipsBySource));
  const operationIds = new Set(normalizedOperations.map((item) => item.id));
  const legacyOperations = (activities.legacy_operations ?? [])
    .filter((activity) => activity.deleted_at_utc == null && !operationIds.has(activity.id))
    .map((activity) => activityWorkItem(activity, "operation", membershipsBySource));
  return [...actions, ...normalizedOperations, ...legacyOperations];
}

function activityWorkItem(
  activity: ActivityItem,
  kind: WorkspaceWorkKind,
  membershipsBySource: Map<string, GoalMembership[]>,
): WorkspaceWorkItem {
  return {
    id: activity.id,
    rowId: activity.id,
    kind,
    relationSourceRole: "activity",
    goalMembershipReadOnly: kind === "operation",
    title: activity.title,
    descriptionMd: activity.description_md,
    status: activity.status,
    updatedAtUtc: activity.completed_at_utc ?? activity.updated_at_utc,
    activity,
    memberships: membershipsBySource.get(activity.id) ?? [],
  };
}

function inboxOperationWorkItem(
  operation: InboxItem,
  membershipsBySource: Map<string, GoalMembership[]>,
): WorkspaceWorkItem {
  const itemsId = operation.items_id || operation.id;
  return {
    id: itemsId,
    rowId: operation.id,
    kind: "operation",
    relationSourceRole: "inbox",
    goalMembershipReadOnly: false,
    title: operation.title,
    descriptionMd: operation.description_md,
    status: operation.status,
    updatedAtUtc: operation.completed_at_utc ?? operation.updated_at_utc,
    operation,
    memberships: membershipsBySource.get(itemsId) ?? [],
  };
}

function groupMemberships(relations: RelationItem[], goalsById: Map<string, ActivityItem>) {
  const grouped = new Map<string, GoalMembership[]>();
  for (const relation of relations) {
    const goal = goalsById.get(relation.target_items_id);
    if (!goal) continue;
    const memberships = grouped.get(relation.source_items_id) ?? [];
    memberships.push({ goal, relation });
    grouped.set(relation.source_items_id, memberships);
  }
  for (const memberships of grouped.values()) memberships.sort((left, right) => left.goal.title.localeCompare(right.goal.title));
  return grouped;
}

function filteredWork(
  work: WorkspaceWorkItem[],
  filter: WorkspaceFilterId,
  selectedRelations: Map<string, RelationItem>,
): WorkspaceWorkItem[] {
  if (filter === "actions") return work.filter((item) => item.kind === "action");
  const selected = filter.startsWith("goal:")
    ? work.filter((item) => selectedRelations.has(item.id)).map((item) => ({ ...item, selectedRelation: selectedRelations.get(item.id) }))
    : filter === "operations"
      ? work.filter((item) => item.kind === "operation")
      : filter === "without-goal"
        ? work.filter((item) => item.memberships.length === 0)
        : work;
  return [...selected].sort((left, right) => {
    const byStatus = Number(left.status === "Done") - Number(right.status === "Done");
    if (byStatus) return byStatus;
    if (filter.startsWith("goal:")) {
      const byPosition = Number(left.selectedRelation?.position ?? Number.MAX_SAFE_INTEGER) - Number(right.selectedRelation?.position ?? Number.MAX_SAFE_INTEGER);
      if (byPosition) return byPosition;
    }
    return right.updatedAtUtc.localeCompare(left.updatedAtUtc) || left.title.localeCompare(right.title);
  });
}

function goalProgress(items: WorkspaceWorkItem[]): GoalProgress {
  const total = items.length;
  const done = items.filter((item) => item.status === "Done").length;
  const reason = total < 2 ? "Для завершения цели нужно минимум два выполненных пункта." : done < total ? "Сначала завершите все пункты цели." : null;
  return { total, done, eligible: reason == null, reason };
}

function goalCompletedAt(goal: ActivityItem): string {
  return goal.completed_at_utc ?? goal.updated_at_utc;
}
