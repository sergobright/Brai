"use client";

import { useId, useMemo, useRef, useState } from "react";
import { ListPlus, X } from "lucide-react";
import { cleanTitle, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import type { ActivityItem } from "@/shared/types/activities";
import type { RelationItem } from "@/shared/types/relations";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/shared/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/select";
import { visibleGoalBadges, type WorkspaceWorkItem, type WorkspaceFilterId } from "./actionsWorkspaceModel";

export function GoalBadges({ item, onSelect }: { item: WorkspaceWorkItem; onSelect: (filter: WorkspaceFilterId) => void }) {
  const badges = visibleGoalBadges(item);
  if (badges.named.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 px-3 pb-2 max-[860px]:flex-nowrap max-[860px]:overflow-hidden" aria-label="Цели элемента">
      {badges.named.map(({ goal }) => (
        <button key={goal.id} type="button" className="max-w-36 truncate rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring max-[860px]:min-h-11 max-[860px]:max-w-28" onClick={() => onSelect(`goal:${goal.id}`)}>
          {goal.title}
        </button>
      ))}
      {badges.remaining > 0 ? <span className="shrink-0 text-xs text-muted-foreground">+{badges.remaining}</span> : null}
    </div>
  );
}

export function GoalMembershipPicker({
  item,
  goals,
  onAdd,
  onCreateGoal,
}: {
  item: WorkspaceWorkItem;
  goals: ActivityItem[];
  onAdd: (itemsId: string, goalIds: string[]) => Promise<void>;
  onCreateGoal: (itemsId: string, title: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newGoalTitle, setNewGoalTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const createFieldsId = useId();
  const linkedGoalIds = useMemo(() => new Set(item.memberships.map((membership) => membership.goal.id)), [item.memberships]);
  const availableGoals = useMemo(() => goals.filter((goal) =>
    goal.status === "New" && goal.deleted_at_utc === null && !linkedGoalIds.has(goal.id),
  ), [goals, linkedGoalIds]);

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setSelectedGoalId("");
      setCreateOpen(false);
      setNewGoalTitle("");
    }
  }

  async function add() {
    if (!selectedGoalId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onAdd(item.id, [selectedGoalId]);
      onOpenChange(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function createGoal() {
    const title = cleanTitle(newGoalTitle);
    if (!title || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onCreateGoal(item.id, title);
      onOpenChange(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground max-[860px]:min-h-11 max-[860px]:min-w-11" aria-label={`Добавить в цель: ${item.title}`}>
          <ListPlus aria-hidden="true" />
          <span className="max-[520px]:sr-only">Добавить в цель</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-[min(22rem,calc(100vw-2rem))] gap-3 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11 max-[860px]:[&_label]:min-h-11" data-nav-swipe-exclusion>
        <PopoverTitle>Добавить в цель</PopoverTitle>
        {availableGoals.length > 0 ? (
          <Select value={selectedGoalId} onValueChange={setSelectedGoalId}>
            <SelectTrigger className="w-full" aria-label="Активная цель"><SelectValue placeholder="Выберите цель" /></SelectTrigger>
            <SelectContent>{availableGoals.map((goal) => <SelectItem key={goal.id} value={goal.id}>{goal.title}</SelectItem>)}</SelectContent>
          </Select>
        ) : <p className="m-0 text-sm text-muted-foreground">Нет доступных целей</p>}
        <Button type="button" variant="ghost" size="sm" className="justify-self-start" aria-expanded={createOpen} aria-controls={createFieldsId} onClick={() => setCreateOpen((current) => !current)}>Создать цель</Button>
        {createOpen ? (
          <div id={createFieldsId} className="grid gap-2">
            <Input id={`${createFieldsId}-title`} name="new-goal-title" value={newGoalTitle} maxLength={TITLE_MAX_LENGTH} placeholder="Название новой цели" aria-label="Название новой цели" autoFocus onChange={(event) => setNewGoalTitle(event.target.value)} />
            <Button type="button" size="sm" disabled={busy || !cleanTitle(newGoalTitle)} onClick={() => void createGoal()}>Создать и добавить</Button>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button type="button" size="sm" disabled={busy || !selectedGoalId} onClick={() => void add()}>Добавить</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function RemoveGoalMembershipButton({ item, onRemove }: { item: WorkspaceWorkItem; onRemove: (relation: RelationItem) => Promise<void> }) {
  if (!item.selectedRelation) return null;
  return (
    <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground max-[860px]:size-11" aria-label={`Убрать из цели: ${item.title}`} title="Убрать из цели" onClick={() => void onRemove(item.selectedRelation!)}>
      <X aria-hidden="true" />
    </Button>
  );
}
