"use client";

import type { CSSProperties, ReactNode } from "react";
import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ActivityItem, ActivityStatus } from "@/shared/types/activities";
import type { RelationItem } from "@/shared/types/relations";
import { useMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { ActionRow, type DetailTitleFocus } from "./ActionRow";
import { GoalBadges, GoalMembershipPicker, RemoveGoalMembershipButton } from "./GoalMembershipControls";
import { OperationWorkspaceRow } from "./OperationWorkspaceItem";
import type { WorkspaceFilterId, WorkspaceWorkItem } from "./actionsWorkspaceModel";

type WorkspaceWorkListProps = {
  items: WorkspaceWorkItem[];
  goals: ActivityItem[];
  filter: WorkspaceFilterId;
  selectedId: string | null;
  titleDrafts: Record<string, string>;
  openDeleteActionId: string | null;
  activeActivityId: string | null;
  activeActivityElapsedSeconds: number;
  sortable?: boolean;
  onSelect: (item: WorkspaceWorkItem, focus?: DetailTitleFocus) => void;
  onEditMobile: (action: ActivityItem) => void;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onTitleDraftChange: (actionId: string, title: string | null) => void;
  onSetStatus: (action: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (action: ActivityItem) => Promise<void>;
  onOpenDelete: (actionId: string) => void;
  onCloseDelete: () => void;
  onStartFocus: (action: ActivityItem) => Promise<void>;
  onStopFocus: (action: ActivityItem) => Promise<void>;
  onSelectFilter: (filter: WorkspaceFilterId) => void;
  onAddToGoals: (itemsId: string, goalIds: string[]) => Promise<void>;
  onCreateGoalForItem: (itemsId: string, title: string) => Promise<void>;
  onRemoveFromGoal: (relation: RelationItem) => Promise<void>;
  onReorder?: (orderedIds: string[]) => Promise<void>;
  renderAfter?: (item: WorkspaceWorkItem) => ReactNode;
};

export function WorkspaceWorkList(props: WorkspaceWorkListProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = props.items.map((item) => item.id);
  const sortable = props.sortable === true && props.items.every((item) => !item.goalMembershipReadOnly);

  function onDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over?.id == null ? null : String(event.over.id);
    if (!overId || activeId === overId || !props.onReorder) return;
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    void props.onReorder(arrayMove(ids, from, to));
  }

  const content = props.items.map((item) => sortable
    ? <SortableWorkspaceItem key={item.id} item={item} props={props} />
    : <WorkspaceItem key={item.id} item={item} props={props} />);

  if (!sortable) return content;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>{content}</SortableContext>
    </DndContext>
  );
}

function SortableWorkspaceItem({ item, props }: { item: WorkspaceWorkItem; props: WorkspaceWorkListProps }) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id: item.id });
  const isMobile = useMobileNavigationViewport();
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 2 : undefined };
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className="grid size-8 shrink-0 cursor-grab place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing max-[860px]:size-11"
      aria-label={`Переместить: ${item.title}`}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
  );
  return (
    <div ref={setNodeRef} style={style} className="min-w-0 motion-reduce:!transition-none" data-dragging={isDragging || undefined} data-sortable-workspace-item>
      <WorkspaceItem
        item={item}
        props={props}
        dragHandle={isMobile ? undefined : handle}
        mobileDragHandle={isMobile ? handle : undefined}
      />
    </div>
  );
}

function WorkspaceItem({ item, props, dragHandle, mobileDragHandle }: { item: WorkspaceWorkItem; props: WorkspaceWorkListProps; dragHandle?: ReactNode; mobileDragHandle?: ReactNode }) {
  const membershipControl = item.goalMembershipReadOnly ? null : (
    <>
      {props.filter.startsWith("goal:") ? <RemoveGoalMembershipButton item={item} onRemove={props.onRemoveFromGoal} /> : null}
      {!props.filter.startsWith("goal:") ? <GoalMembershipPicker item={item} goals={props.goals} onAdd={props.onAddToGoals} onCreateGoal={props.onCreateGoalForItem} /> : null}
    </>
  );
  return (
    <div className="min-w-0">
      {item.kind === "action" && item.activity ? (
        <ActionRow
          action={item.activity}
          titleDraft={props.titleDrafts[item.activity.id]}
          selected={props.selectedId === item.id}
          onSelect={(focus?: DetailTitleFocus) => props.onSelect(item, focus)}
          onEditMobile={props.onEditMobile}
          onUpdateTitle={props.onUpdateTitle}
          onTitleDraftChange={props.onTitleDraftChange}
          onSetStatus={props.onSetStatus}
          onDelete={props.onDelete}
          activeFocus={props.activeActivityId === item.activity.id}
          activeFocusElapsedSeconds={props.activeActivityId === item.activity.id ? props.activeActivityElapsedSeconds : 0}
          onStartFocus={props.onStartFocus}
          onStopFocus={props.onStopFocus}
          deleteOpen={props.openDeleteActionId === item.activity.id}
          onOpenDelete={() => props.onOpenDelete(item.activity!.id)}
          onCloseDelete={props.onCloseDelete}
          dragHandle={dragHandle}
          membershipControl={membershipControl}
        />
      ) : (
        <OperationWorkspaceRow item={item} selected={props.selectedId === item.id} onSelect={() => props.onSelect(item)} controls={<>{membershipControl}{dragHandle ?? mobileDragHandle}</>} />
      )}
      {item.kind === "action" ? (
        mobileDragHandle ?? (!props.filter.startsWith("goal:") ? <GoalBadges item={item} onSelect={props.onSelectFilter} /> : null)
      ) : !props.filter.startsWith("goal:") ? <GoalBadges item={item} onSelect={props.onSelectFilter} /> : null}
      {props.renderAfter?.(item)}
    </div>
  );
}
