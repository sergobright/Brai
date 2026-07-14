"use client";

import { useState, type FormEvent } from "react";
import { ArchiveRestore, CheckCircle2, ChevronDown, Circle, List, Plus, Target, type LucideIcon } from "lucide-react";
import { cleanTitle, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import type { ActivityItem } from "@/shared/types/activities";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { cx } from "../../appUtils";
import { goalFilterId, SYSTEM_WORKSPACE_FILTERS, type ActionsWorkspaceView, type WorkspaceFilterId } from "./actionsWorkspaceModel";

export function ActionsWorkspaceNavigation({
  workspace,
  onSelect,
  onCreateGoal,
  onRestoreGoal,
}: {
  workspace: ActionsWorkspaceView;
  onSelect: (filter: WorkspaceFilterId) => void;
  onCreateGoal: (title: string) => Promise<void>;
  onRestoreGoal: (goal: ActivityItem) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [completedOpen, setCompletedOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  async function submitGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = cleanTitle(draft);
    if (!title) return;
    setDraft("");
    setCreateOpen(false);
    await onCreateGoal(title);
  }

  return (
    <nav className="grid min-w-0 content-start gap-5 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11" aria-label="Списки действий">
      <div className="grid gap-1">
        {SYSTEM_WORKSPACE_FILTERS.map((entry) => (
          <NavigationButton
            key={entry.id}
            active={workspace.filter === entry.id}
            icon={entry.id === "all" ? List : entry.id === "operations" ? Circle : Target}
            label={entry.label}
            count={workspace.systemCounts[entry.id]}
            onClick={() => onSelect(entry.id)}
          />
        ))}
      </div>

      <section className="grid gap-2" aria-labelledby="actions-goals-heading">
        <header className="flex min-h-9 items-center justify-between gap-2 px-2">
          <h2 id="actions-goals-heading" className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Цели</h2>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Создать цель" title="Создать цель" onClick={() => setCreateOpen((current) => !current)}>
            <Plus aria-hidden="true" />
          </Button>
        </header>
        {createOpen ? (
          <form className="flex gap-2 px-2" onSubmit={submitGoal}>
            <Input value={draft} maxLength={TITLE_MAX_LENGTH} placeholder="Новая цель" aria-label="Название новой цели" autoFocus onChange={(event) => setDraft(event.target.value)} />
            <Button type="submit" size="sm" disabled={!draft.trim()}>Создать</Button>
          </form>
        ) : null}
        <div className="grid gap-1">
          {workspace.activeGoals.length === 0 ? <p className="m-0 px-3 py-2 text-sm text-muted-foreground">Активных целей пока нет</p> : null}
          {workspace.activeGoals.map((goal) => (
            <NavigationButton key={goal.id} active={workspace.filter === goalFilterId(goal.id)} icon={Target} label={goal.title} onClick={() => onSelect(goalFilterId(goal.id))} />
          ))}
        </div>

        <GoalGroupToggle label="Завершённые" count={workspace.completedGoals.length} open={completedOpen} onToggle={() => setCompletedOpen((current) => !current)} />
        {completedOpen ? (
          <div className="grid gap-1 pl-2">
            {workspace.completedGoals.map((goal) => (
              <NavigationButton key={goal.id} active={workspace.filter === goalFilterId(goal.id)} icon={CheckCircle2} label={goal.title} onClick={() => onSelect(goalFilterId(goal.id))} />
            ))}
          </div>
        ) : null}

        {workspace.archivedGoals.length > 0 ? (
          <>
            <GoalGroupToggle label="Архив целей" count={workspace.archivedGoals.length} open={archiveOpen} onToggle={() => setArchiveOpen((current) => !current)} />
            {archiveOpen ? (
              <div className="grid gap-1 pl-2">
                {workspace.archivedGoals.map((goal) => (
                  <div key={goal.id} className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{goal.title}</span>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Восстановить цель: ${goal.title}`} onClick={() => void onRestoreGoal(goal)}>
                      <ArchiveRestore aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </nav>
  );
}

function NavigationButton({
  active,
  icon: Icon,
  label,
  count,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx(
        "flex min-h-11 min-w-0 items-center gap-2 rounded-lg border-0 px-3 py-2 text-left text-sm transition-colors focus-visible:outline-0 focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-primary/10 font-medium text-primary" : "bg-transparent text-foreground hover:bg-accent",
      )}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  );
}

function GoalGroupToggle({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="flex min-h-10 items-center gap-2 rounded-lg border-0 bg-transparent px-3 text-sm text-muted-foreground hover:bg-accent" aria-expanded={open} onClick={onToggle}>
      <ChevronDown className={cx("size-4 transition-transform motion-reduce:transition-none", !open && "-rotate-90")} aria-hidden="true" />
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs tabular-nums">{count}</span>
    </button>
  );
}
