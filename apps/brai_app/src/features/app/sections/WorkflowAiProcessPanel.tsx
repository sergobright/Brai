"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, LoaderCircle, XCircle } from "lucide-react";
import { BraiApi } from "@/shared/api/braiApi";
import { defaultApiBase } from "@/shared/config/runtime";
import type { InboxWorkflowDetails } from "@/shared/types/inbox";
import { cn } from "@/shared/ui/cn";
import { ScrollArea } from "@/shared/ui/scroll-area";

type WorkflowPanelItem = {
  id: string;
  workflow_execution_id?: number | null;
  workflow_status?: string | null;
  workflow_attempt_count?: number;
  temporal_workflow_id?: string | null;
  temporal_run_id?: string | null;
};

export function WorkflowAiProcessPanel({
  item,
  emptyText,
  loadDetails,
}: {
  item: WorkflowPanelItem;
  emptyText: string;
  loadDetails: (api: BraiApi, id: string) => Promise<InboxWorkflowDetails>;
}) {
  const [result, setResult] = useState<{ itemId: string; details: InboxWorkflowDetails | null; error: string } | null>(null);
  const hasWorkflow = item.workflow_execution_id != null || Boolean(item.temporal_workflow_id);
  const loadDetailsRef = useRef(loadDetails);

  useEffect(() => {
    loadDetailsRef.current = loadDetails;
  }, [loadDetails]);

  useEffect(() => {
    if (!hasWorkflow) return undefined;
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const api = new BraiApi(defaultApiBase());
    const load = async () => {
      if (loading) return;
      loading = true;
      timer = null;
      try {
        const value = await loadDetailsRef.current(api, item.id);
        if (!active) return;
        setResult({ itemId: item.id, details: value, error: "" });
        if (["queued", "running"].includes(value.execution.status) && document.visibilityState !== "hidden") {
          timer = setTimeout(load, 1500);
        }
      } catch (reason) {
        if (active) {
          setResult({ itemId: item.id, details: null, error: reason instanceof Error ? reason.message : "Не удалось загрузить workflow" });
          if (["queued", "running"].includes(item.workflow_status ?? "") && document.visibilityState !== "hidden") {
            timer = setTimeout(load, 1500);
          }
        }
      } finally {
        loading = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !timer) void load();
      if (document.visibilityState === "hidden" && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasWorkflow, item.id, item.temporal_run_id, item.workflow_attempt_count, item.workflow_status]);

  if (!hasWorkflow) return <p className="m-0 py-4 text-sm text-muted-foreground">{emptyText}</p>;
  const currentResult = result?.itemId === item.id ? result : null;
  if (currentResult?.error) return <p className="m-0 py-4 text-sm text-destructive" role="alert">{currentResult.error}</p>;
  const details = currentResult?.details;
  if (!details) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Загружаю AI process
      </div>
    );
  }

  const failed = details.execution.status === "failed" || details.execution.status === "needs_review";
  const stepStates = details.step_states;
  return (
    <ScrollArea className="min-h-0" role="tabpanel">
      <div className="grid gap-4 py-4">
        <div className="grid gap-2 rounded-lg border border-border p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            {failed ? <XCircle className="size-4 text-destructive" aria-hidden="true" /> : details.execution.status === "completed" ? <CheckCircle2 className="size-4 text-primary" aria-hidden="true" /> : <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden="true" />}
            {details.execution.status}
          </div>
          {details.execution.status === "running" || details.execution.status === "queued" ? (
            <div className="text-muted-foreground">Шаг: {details.execution.current_step}</div>
          ) : failed ? (
            <div className="text-muted-foreground">Последний runtime-шаг: {details.execution.current_step}</div>
          ) : null}
          <div className="text-muted-foreground">Попытки: {details.execution.attempt_count}</div>
          {details.execution.last_error ? <div className="text-destructive">{details.execution.last_error}</div> : null}
        </div>

        <div className="grid gap-2">
          <h3 className="m-0 text-sm font-semibold">Шаги workflow</h3>
          {!stepStates ? <p className="m-0 text-sm text-muted-foreground">Состояния шагов недоступны.</p> : stepStates.map((step) => (
            <div
              className={cn("flex items-center gap-2 text-sm", step.state === "failed" ? "text-destructive" : "text-muted-foreground")}
              data-workflow-step-state={step.state}
              key={step.id}
            >
              {step.state === "completed" ? <CheckCircle2 className="size-3.5 text-primary" aria-hidden="true" /> : null}
              {step.state === "running" ? <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden="true" /> : null}
              {step.state === "failed" ? <XCircle className="size-3.5" aria-hidden="true" /> : null}
              {step.state === "pending" || step.state === "skipped" ? <Circle className="size-3.5" aria-hidden="true" /> : null}
              {step.id}{step.state === "skipped" ? " · пропущен" : ""}
            </div>
          ))}
        </div>

        <div className="grid gap-2">
          <h3 className="m-0 text-sm font-semibold">AI executions</h3>
          {details.attempts.length ? details.attempts.map((attempt) => (
            <div className="grid gap-1 rounded-lg border border-border p-3 text-sm" key={attempt.id}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{attempt.agent_id}</span>
                <span className="text-xs text-muted-foreground">#{attempt.attempt_number ?? 1}</span>
              </div>
              <div className={attempt.status === "failed" ? "text-destructive" : "text-muted-foreground"}>{attempt.ai_title}</div>
              {typeof attempt.json_data.metadata?.error === "string" ? <div className="text-xs text-destructive">{attempt.json_data.metadata.error}</div> : null}
            </div>
          )) : <p className="m-0 text-sm text-muted-foreground">AI ещё не запускался.</p>}
        </div>

        <dl className="m-0 grid gap-1 text-xs text-muted-foreground">
          <div><dt className="inline font-medium text-foreground">Workflow ID: </dt><dd className="inline break-all">{details.execution.workflow_id}</dd></div>
          <div><dt className="inline font-medium text-foreground">Run ID: </dt><dd className="inline break-all">{details.execution.run_id || "-"}</dd></div>
        </dl>
      </div>
    </ScrollArea>
  );
}
