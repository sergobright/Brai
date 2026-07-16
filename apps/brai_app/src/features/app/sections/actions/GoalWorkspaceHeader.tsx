"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Archive, CheckCircle2, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { cleanTitle, normalizeDescription, TITLE_MAX_LENGTH } from "@/shared/activities/text";
import type { ActivityItem, ActivityStatus } from "@/shared/types/activities";
import type { GoalPlanResponse } from "@/shared/types/contextDecisions";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Progress } from "@/shared/ui/progress";
import { Textarea } from "@/shared/ui/textarea";
import type { GoalProgress } from "./actionsWorkspaceModel";

export function GoalWorkspaceHeader({
  goal,
  progress,
  onSave,
  onSetStatus,
  onDelete,
  onPlan,
  planPending = false,
  children,
}: {
  goal: ActivityItem;
  progress: GoalProgress;
  onSave: (goal: ActivityItem, title: string, descriptionMd: string) => Promise<void>;
  onSetStatus: (goal: ActivityItem, status: ActivityStatus) => Promise<void>;
  onDelete: (goal: ActivityItem) => Promise<void>;
  onPlan: (goal: ActivityItem) => Promise<GoalPlanResponse>;
  planPending?: boolean;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [description, setDescription] = useState(goal.description_md);
  const [message, setMessage] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planRequested, setPlanRequested] = useState(false);
  const planAvailable = planPending || planRequested;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = cleanTitle(title);
    if (!nextTitle) return;
    await onSave(goal, nextTitle, normalizeDescription(description));
    setEditing(false);
  }

  async function requestPlan() {
    if (planBusy) return;
    setPlanRequested(false);
    setPlanBusy(true);
    try {
      const response = await onPlan(goal);
      if (response.decision || response.status === "completed") {
        setPlanRequested(true);
        setMessage("Предложение плана готово к проверке.");
      } else if (response.status === "running") {
        setPlanRequested(true);
        setMessage("План уже формируется. Предложение появится здесь после обработки.");
      } else if (response.status === "failed") {
        setPlanRequested(false);
        setMessage("Не удалось подготовить план. Попробуйте ещё раз.");
      } else if (response.status === "needs_review") {
        setPlanRequested(false);
        setMessage("Не удалось подготовить корректный план. Запросите его повторно.");
      } else {
        setPlanRequested(true);
        setMessage("План поставлен в очередь. Предложение появится здесь после обработки.");
      }
    } catch {
      setMessage("Не удалось запросить план. Попробуйте ещё раз.");
    } finally {
      setPlanBusy(false);
    }
  }

  async function complete() {
    if (!progress.eligible) {
      setMessage(progress.reason);
      return;
    }
    try {
      await onSetStatus(goal, "Done");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const message = error instanceof Error ? error.message : "";
      setMessage(code === "goal_membership_pending" || message.includes("goal_membership_pending")
        ? "Сначала синхронизируем состав цели. Попробуйте ещё раз после синхронизации."
        : "Не удалось завершить цель. Попробуйте ещё раз.");
    }
  }

  return (
    <section className="mb-4 grid gap-3 rounded-xl border border-border bg-card p-4 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11" aria-labelledby="selected-goal-title">
      {editing ? (
        <form className="grid gap-3" onSubmit={save}>
          <Input name="goal-title" value={title} maxLength={TITLE_MAX_LENGTH} aria-label="Название цели" onChange={(event) => setTitle(event.target.value)} />
          <Textarea name="goal-description" value={description} aria-label="Описание цели в Markdown" placeholder="Описание цели" onChange={(event) => setDescription(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Отмена</Button>
            <Button type="submit" size="sm" disabled={!title.trim()}>Сохранить</Button>
          </div>
        </form>
      ) : (
        <>
          <header className="flex min-w-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="selected-goal-title" className="m-0 break-words text-lg font-semibold">{goal.title}</h2>
              {goal.description_md ? <p className="m-0 mt-1 line-clamp-2 text-sm text-muted-foreground">{goal.description_md}</p> : null}
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Изменить цель" onClick={() => setEditing(true)}><Pencil aria-hidden="true" /></Button>
          </header>
          {children}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <Progress value={progress.total === 0 ? 0 : progress.done / progress.total * 100} aria-label={`Прогресс цели: ${progress.done} из ${progress.total}`} />
            <strong className="text-sm tabular-nums">{progress.done}/{progress.total}</strong>
          </div>
          <div className="flex flex-wrap gap-2">
            {goal.status !== "Done" ? (
              <Button type="button" variant="outline" size="sm" disabled={planBusy || planAvailable} onClick={() => void requestPlan()}><Sparkles aria-hidden="true" />{planBusy ? "Формируем…" : planAvailable ? "План предложен" : "Предложить план"}</Button>
            ) : null}
            {goal.status === "Done" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void onSetStatus(goal, "New")}><RotateCcw aria-hidden="true" />Вернуть в работу</Button>
            ) : (
              <Button type="button" variant="outline" size="sm" aria-disabled={!progress.eligible} onClick={() => void complete()}><CheckCircle2 aria-hidden="true" />Завершить цель</Button>
            )}
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => void onDelete(goal)}><Archive aria-hidden="true" />В архив</Button>
          </div>
        </>
      )}
      {progress.reason && !message ? <p className="m-0 text-sm text-muted-foreground">{progress.reason}</p> : null}
      {message ? <p className="m-0 rounded-lg bg-muted px-3 py-2 text-sm" role="status">{message}</p> : null}
    </section>
  );
}
