"use client";

import type { CSSProperties, HTMLAttributes } from "react";
import { closestCenter, DndContext, KeyboardSensor, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DraggableAttributes, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import type { ActivityItem, ActivityStatus } from "@/shared/types/activities";
import { useMobileNavigationViewport } from "../../navigation/useSectionSwipeNavigation";
import { ActionRow, type DetailTitleFocus } from "./ActionRow";

export function SortableActionList({
  actions,
  selectedActionId,
  openDeleteActionId,
  onSelect,
  onEditMobile,
  onUpdateTitle,
  onSetStatus,
  onDelete,
  onOpenDelete,
  onCloseDelete,
  onReorder,
  titleDrafts = {},
  onTitleDraftChange = () => undefined,
  activeActivityId = null,
  activeActivityElapsedSeconds = 0,
  onStartFocus,
  onStopFocus,
}: {
  actions: ActivityItem[];
  selectedActionId: string | null;
  openDeleteActionId: string | null;
  activeActivityId?: string | null;
  activeActivityElapsedSeconds?: number;
  onSelect: (actionId: string, focusDetailTitle?: DetailTitleFocus) => void;
  onEditMobile: (action: ActivityItem) => void;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onSetStatus: (action: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (action: ActivityItem) => Promise<void>;
  onOpenDelete: (actionId: string) => void;
  onCloseDelete: () => void;
  onReorder: (orderedIds: string[], movedAction: ActivityItem) => Promise<void>;
  onStartFocus?: (action: ActivityItem) => Promise<void>;
  onStopFocus?: (action: ActivityItem) => Promise<void>;
  titleDrafts?: Record<string, string>;
  onTitleDraftChange?: (actionId: string, title: string | null) => void;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 260, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = actions.map((action) => action.id);

  function onDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over?.id == null ? null : String(event.over.id);
    if (!overId || activeId === overId) return;

    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const nextActions = arrayMove(actions, oldIndex, newIndex);
    void onReorder(nextActions.map((action) => action.id), actions[oldIndex]);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {actions.map((action) => (
          <SortableActionRow
            key={action.id}
            action={action}
            titleDraft={titleDrafts[action.id]}
            selected={selectedActionId === action.id}
            onSelect={(focusDetailTitle) => onSelect(action.id, focusDetailTitle)}
            onEditMobile={onEditMobile}
            onUpdateTitle={onUpdateTitle}
            onTitleDraftChange={onTitleDraftChange}
            onSetStatus={onSetStatus}
            onDelete={onDelete}
            activeFocus={activeActivityId === action.id}
            activeFocusElapsedSeconds={activeActivityId === action.id ? activeActivityElapsedSeconds : 0}
            onStartFocus={onStartFocus}
            onStopFocus={onStopFocus}
            deleteOpen={openDeleteActionId === action.id}
            onOpenDelete={() => onOpenDelete(action.id)}
            onCloseDelete={onCloseDelete}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableActionRow(props: {
  action: ActivityItem;
  selected: boolean;
  onSelect: (focusDetailTitle?: DetailTitleFocus) => void;
  onEditMobile: (action: ActivityItem) => void;
  onUpdateTitle: (action: ActivityItem, title: string) => Promise<void>;
  onSetStatus: (action: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (action: ActivityItem) => Promise<void>;
  onStartFocus?: (action: ActivityItem) => Promise<void>;
  onStopFocus?: (action: ActivityItem) => Promise<void>;
  activeFocus?: boolean;
  activeFocusElapsedSeconds?: number;
  deleteOpen: boolean;
  onOpenDelete: () => void;
  onCloseDelete: () => void;
  titleDraft?: string;
  onTitleDraftChange: (actionId: string, title: string | null) => void;
}) {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.action.id,
  });
  const isMobile = useMobileNavigationViewport();
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 2 : undefined,
  };
  const mobileDragProps = isMobile
    ? ({ ...attributes, ...listeners } as HTMLAttributes<HTMLDivElement>)
    : undefined;

  return (
    <ActionRow
      {...props}
      sortableRef={setNodeRef}
      sortableStyle={style}
      sortableDragging={isDragging}
      mobileDragProps={mobileDragProps}
      dragHandle={
        isMobile ? undefined : (
          <ActionDragHandle
            action={props.action}
            attributes={attributes}
            listeners={listeners}
            setActivatorNodeRef={setActivatorNodeRef}
          />
        )
      }
    />
  );
}

function ActionDragHandle({
  action,
  attributes,
  listeners,
  setActivatorNodeRef,
}: {
  action: ActivityItem;
  attributes: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  setActivatorNodeRef: (node: HTMLElement | null) => void;
}) {
  return (
    <button
      type="button"
      className="action-drag-handle pointer-events-none grid h-8 w-5 cursor-grab place-items-center border-0 bg-transparent text-muted-foreground opacity-0 transition duration-150 active:cursor-grabbing hover:text-foreground hover:opacity-75 focus-visible:text-foreground focus-visible:opacity-75 focus-visible:outline-0 group-hover:pointer-events-auto group-hover:opacity-45 group-focus-within:pointer-events-auto group-focus-within:opacity-45"
      data-action-drag-handle
      aria-label={`Переместить: ${action.title}`}
      title="Переместить"
      ref={setActivatorNodeRef}
      onClick={(event) => event.stopPropagation()}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
  );
}
