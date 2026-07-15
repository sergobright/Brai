"use client";

import { useMemo, useState } from "react";
import { ListPlus, X } from "lucide-react";
import type { ActivityItem } from "@/shared/types/activities";
import type { RelationItem } from "@/shared/types/relations";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/shared/ui/popover";
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
  onRemove,
}: {
  item: WorkspaceWorkItem;
  goals: ActivityItem[];
  onAdd: (itemsId: string, goalIds: string[]) => Promise<void>;
  onRemove: (relation: RelationItem) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const activeByGoal = useMemo(() => new Map(item.memberships.map((membership) => [membership.goal.id, membership.relation])), [item.memberships]);
  const visibleGoals = goals.filter((goal) => goal.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  function onOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) setSelected(new Set(activeByGoal.keys()));
    else setQuery("");
  }

  async function apply() {
    const added = [...selected].filter((goalId) => !activeByGoal.has(goalId));
    const removed = [...activeByGoal].filter(([goalId]) => !selected.has(goalId)).map(([, relation]) => relation);
    if (added.length > 0) await onAdd(item.id, added);
    for (const relation of removed) await onRemove(relation);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground max-[860px]:min-h-11 max-[860px]:min-w-11" aria-label={`Добавить в список: ${item.title}`}>
          <ListPlus aria-hidden="true" />
          <span className="max-[520px]:sr-only">Добавить в список…</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-[min(22rem,calc(100vw-2rem))] gap-3 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11 max-[860px]:[&_label]:min-h-11" data-nav-swipe-exclusion>
        <PopoverTitle>Цели для «{item.title}»</PopoverTitle>
        <Input value={query} placeholder="Найти цель" aria-label="Найти цель" onChange={(event) => setQuery(event.target.value)} />
        <div className="grid max-h-64 gap-1 overflow-y-auto" role="group" aria-label="Выбор целей">
          {visibleGoals.length === 0 ? <p className="m-0 py-3 text-sm text-muted-foreground">Цели не найдены</p> : null}
          {visibleGoals.map((goal) => {
            const checked = selected.has(goal.id);
            const disabled = goal.status === "Done" && item.status !== "Done" && !activeByGoal.has(goal.id);
            return (
              <label key={goal.id} className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent has-data-disabled:opacity-60">
                <Checkbox
                  checked={checked}
                  disabled={disabled}
                  aria-label={goal.title}
                  onCheckedChange={(next) => setSelected((current) => {
                    const copy = new Set(current);
                    if (next) copy.add(goal.id); else copy.delete(goal.id);
                    return copy;
                  })}
                />
                <span className="min-w-0 flex-1 truncate">{goal.title}</span>
                {disabled ? <span className="text-xs text-muted-foreground">сначала завершите пункт</span> : null}
              </label>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Отмена</Button>
          <Button type="button" size="sm" onClick={() => void apply()}>Применить</Button>
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
