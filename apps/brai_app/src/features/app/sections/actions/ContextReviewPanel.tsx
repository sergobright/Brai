"use client";

import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Check, Sparkles, Undo2, X } from "lucide-react";
import { markContextNotificationRead } from "@/features/app/hooks/useBraiContextReviews";
import { getBraiLocalStorageItem, setBraiLocalStorageItem } from "@/shared/storage/localStorageKeys";
import type {
  ContextAudit,
  ContextAuditItem,
  ContextDecision,
  ContextDecisionsState,
  ContextNotification,
  ContextResolution,
} from "@/shared/types/contextDecisions";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export function ContextReviewPanel({ state, onResolve, onUndo = async () => undefined, compact = false }: {
  state: ContextDecisionsState;
  onResolve: (decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) => Promise<void>;
  onUndo?: (decision: ContextDecision) => Promise<void>;
  compact?: boolean;
}) {
  const titleId = useId();
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = state.decisions.filter((decision) => decision.status === "pending");
  const automatic = state.decisions.filter((decision) => decision.status === "auto_accepted" || decision.status === "audit_confirmed");
  if (pending.length === 0 && automatic.length === 0 && state.audits.length === 0 && state.notifications.length === 0) return null;

  async function resolve(decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) {
    setBusyId(reviewKey(decision));
    try {
      await onResolve(decision, resolution, editedPayload);
    } finally {
      setBusyId(null);
    }
  }

  async function undo(decision: ContextDecision) {
    setBusyId(reviewKey(decision));
    try { await onUndo(decision); } finally { setBusyId(null); }
  }

  return (
    <section className={compact
      ? "my-2 grid gap-2 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11"
      : "mt-4 grid gap-3 border-t border-border pt-4 max-[860px]:[&_button]:min-h-11 max-[860px]:[&_button]:min-w-11 max-[860px]:[&_[data-slot=input]]:min-h-11"
    } aria-labelledby={titleId}>
      <header className={compact ? "sr-only" : "flex items-center gap-2 px-2"}>
        <Sparkles className="size-4 text-primary" aria-hidden="true" />
        <h2 id={titleId} className="m-0 text-sm font-semibold">Предложения</h2>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{pending.length}</span>
      </header>
      {state.notifications.map((notification) => <PolicyNotification key={notification.id} notification={notification} />)}
      {pending.map((decision) => {
        if (decision.decision_kind === "goal_plan") {
          return <PlanDraftReview key={decision.id} decision={decision} busy={busyId === reviewKey(decision)} onResolve={resolve} />;
        }
        if (decision.decision_kind === "goal_discovery") {
          return <GoalDiscoveryDraftReview key={decision.id} decision={decision} busy={busyId === reviewKey(decision)} onResolve={resolve} />;
        }
        return <SimpleDecisionReview key={decision.id} decision={decision} busy={busyId === reviewKey(decision)} onResolve={resolve} />;
      })}
      {state.audits.map((audit) => <AuditReview key={audit.id} audit={audit} busyId={busyId} onResolve={resolve} />)}
      {automatic.length > 0 ? (
        <section className="grid gap-2 rounded-xl bg-muted p-3" aria-label="Недавние автоматические изменения">
          <strong className="text-sm">Недавние автоматические изменения</strong>
          {automatic.map((decision) => (
            <article key={decision.id} className="grid gap-2 rounded-lg bg-background p-2">
              <p className="m-0 text-sm">{proposalSummary(decision)}</p>
              <Button type="button" variant="ghost" size="sm" className="justify-self-end" disabled={busyId === reviewKey(decision)} onClick={() => void undo(decision)}>
                <Undo2 aria-hidden="true" />Отменить
              </Button>
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}

function SimpleDecisionReview({ decision, busy, onResolve, audit = false }: ReviewProps & { audit?: boolean }) {
  return (
    <article className="grid gap-2 rounded-xl border border-border p-3">
      <strong className="text-sm">{audit ? `Проверка: ${decisionTitle(decision)}` : decisionTitle(decision)}</strong>
      <p className="m-0 text-sm text-foreground">{proposalSummary(decision)}</p>
      {decision.rationale ? <p className="m-0 line-clamp-3 text-sm text-muted-foreground">{decision.rationale}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onResolve(decision, "reject")}><X aria-hidden="true" />Отклонить</Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => void onResolve(decision, "accept")}><Check aria-hidden="true" />{audit ? "Подтвердить" : "Принять"}</Button>
      </div>
    </article>
  );
}

function GoalDiscoveryDraftReview({ decision, busy, onResolve }: ReviewProps) {
  const proposal = decision.proposal;
  const [title, setTitle] = useState(() => stringValue(proposal.title));
  const [description, setDescription] = useState(() => stringValue(proposal.description_md));
  const [members, setMembers] = useState(() => uniqueStrings(proposal.member_items_ids).slice(0, 50));

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= members.length) return;
    setMembers((current) => {
      const copy = [...current];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  }

  const valid = title.trim().length > 0 && members.length >= 2 && members.length <= 50;
  return (
    <article className="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
      <div>
        <strong className="text-sm">Новая цель</strong>
        {decision.rationale ? <p className="m-0 mt-1 text-sm text-muted-foreground">{decision.rationale}</p> : null}
      </div>
      <Input name="goal-discovery-title" value={title} maxLength={80} aria-label="Название предложенной цели" onChange={(event) => setTitle(event.target.value)} />
      <Textarea name="goal-discovery-description" value={description} maxLength={8000} aria-label="Описание предложенной цели" className="min-h-20" onChange={(event) => setDescription(event.target.value)} />
      <div className="grid gap-1" aria-label="Пункты предложенной цели">
        {members.map((memberId, index) => (
          <div key={memberId} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-background px-2 py-1">
            <span className="min-w-0 truncate text-sm">{evidenceExcerpt(decision.evidence, memberId) ?? `Пункт ${index + 1}`}</span>
            <span className="flex gap-1">
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Поднять пункт ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Опустить пункт ${index + 1}`} disabled={index === members.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Удалить пункт ${index + 1}`} disabled={members.length <= 2} onClick={() => setMembers((current) => current.filter((id) => id !== memberId))}><X aria-hidden="true" /></Button>
            </span>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onResolve(decision, "reject")}><X aria-hidden="true" />Отклонить</Button>
        <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void onResolve(decision, "accept", { ...proposal, title: title.trim(), description_md: description, member_items_ids: members })}><Check aria-hidden="true" />Создать цель</Button>
      </div>
    </article>
  );
}

function PlanDraftReview({ decision, busy, onResolve }: ReviewProps) {
  const proposal = decision.proposal;
  const initial = Array.isArray(proposal.steps) ? proposal.steps : Array.isArray(proposal.actions) ? proposal.actions : [];
  const [steps, setSteps] = useState(() => initial.map((step) => ({
    title: typeof step === "object" && step && "title" in step ? String(step.title) : "",
    description_md: typeof step === "object" && step && "description_md" in step ? String(step.description_md) : "",
  })));

  function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= steps.length) return;
    setSteps((current) => {
      const copy = [...current];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      return copy;
    });
  }

  const valid = steps.length >= 2 && steps.length <= 20 && steps.every((step) => step.title.trim());
  return (
    <article className="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3">
      <div><strong className="text-sm">План цели</strong>{decision.rationale ? <p className="m-0 mt-1 text-sm text-muted-foreground">{decision.rationale}</p> : null}</div>
      <div className="grid gap-2">
        {steps.map((step, index) => (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_auto] gap-1 rounded-lg bg-background p-2">
            <div className="grid gap-1">
              <Input name={`goal-plan-step-${index + 1}-title`} value={step.title} maxLength={80} aria-label={`Шаг ${index + 1}`} onChange={(event) => setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} />
              <Textarea name={`goal-plan-step-${index + 1}-description`} value={step.description_md} maxLength={8000} aria-label={`Описание шага ${index + 1}`} className="min-h-16" onChange={(event) => setSteps((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, description_md: event.target.value } : item))} />
            </div>
            <div className="grid content-start gap-1">
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Поднять шаг ${index + 1}`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Опустить шаг ${index + 1}`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-xs" aria-label={`Удалить шаг ${index + 1}`} disabled={steps.length <= 2} onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X aria-hidden="true" /></Button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void onResolve(decision, "reject")}><X aria-hidden="true" />Отклонить</Button>
        <Button type="button" size="sm" disabled={busy || !valid} onClick={() => void onResolve(decision, "accept", { ...proposal, steps: steps.map((step, position) => ({ ...step, position })) })}><Check aria-hidden="true" />Принять план</Button>
      </div>
    </article>
  );
}

function AuditReview({ audit, busyId, onResolve }: { audit: ContextAudit; busyId: string | null; onResolve: ReviewProps["onResolve"] }) {
  const items = (audit.items ?? []).filter((item) => item.status === "pending");
  return (
    <section className="grid gap-2 rounded-xl bg-muted p-3" aria-label="Проверка автоматических решений">
      <div className="flex items-center gap-2">
        <strong className="text-sm">Проверка решений</strong>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      {items.length === 0 ? <p className="m-0 text-sm text-muted-foreground">Решения для проверки загружаются.</p> : items.map((item) => {
        const decision = auditItemDecision(audit, item);
        return <SimpleDecisionReview key={String(item.id)} decision={decision} audit busy={busyId === reviewKey(decision)} onResolve={onResolve} />;
      })}
    </section>
  );
}

function PolicyNotification({ notification }: { notification: ContextNotification }) {
  const storageKey = `brai_context_notification:${notification.id}`;
  const [visible, setVisible] = useState(() => notificationIsUnseen(storageKey));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (visible) return;
    void markContextNotificationRead(notification.id).catch(() => undefined);
  }, [notification.id, visible]);

  if (!visible) return null;
  async function dismiss() {
    setBusy(true);
    setFailed(false);
    try {
      await markContextNotificationRead(notification.id);
      try { setBraiLocalStorageItem(storageKey, "seen"); } catch { /* WebView storage may be unavailable. */ }
      setVisible(false);
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-1 rounded-lg bg-primary/10 px-3 py-2 text-sm" role="status">
      <p className="m-0 flex items-center gap-2">
        {notification.body || "Автоматические предложения включены."}
        <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" disabled={busy} aria-label="Скрыть уведомление" onClick={() => void dismiss()}><X aria-hidden="true" /></Button>
      </p>
      {failed ? <p className="m-0 text-xs text-destructive" role="alert">Не удалось скрыть уведомление. Попробуйте ещё раз.</p> : null}
    </div>
  );
}

type ReviewProps = {
  decision: ContextDecision;
  busy: boolean;
  onResolve: (decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) => Promise<void>;
};

function auditItemDecision(audit: ContextAudit, item: ContextAuditItem): ContextDecision {
  return {
    id: item.decisions_id,
    audit_id: audit.id,
    decision_kind: item.decision_kind,
    status: "pending",
    confidence: item.confidence,
    subject_items_id: item.trigger_items_id ?? null,
    proposal: item.proposal,
    rationale: item.rationale,
    evidence: item.evidence,
    created_at_utc: audit.created_at_utc,
    updated_at_utc: audit.updated_at_utc,
  };
}

function reviewKey(decision: ContextDecision): string {
  return decision.audit_id ? `audit:${decision.audit_id}:${decision.id}` : decision.id;
}

function decisionTitle(decision: ContextDecision): string {
  if (decision.decision_kind === "relation_add") return "Добавить в цель";
  if (decision.decision_kind === "activity_type_change") return "Считать целью";
  if (decision.decision_kind === "goal_plan") return "План цели";
  return "Новая цель";
}

function proposalSummary(decision: ContextDecision): string {
  if (decision.decision_kind === "activity_type_change") return "Превратить этот пункт в цель, сохранив его историю.";
  if (decision.decision_kind === "relation_add") {
    const goal = evidenceExcerpt(decision.evidence, stringValue(decision.proposal.target_items_id));
    return goal ? `Добавить пункт в цель «${goal}».` : "Добавить пункт в предложенную цель.";
  }
  return "Проверить предложенное изменение.";
}

function evidenceExcerpt(evidence: unknown[], itemsId: string): string | null {
  if (!itemsId) return null;
  for (const entry of evidence) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.items_id === itemsId && typeof value.excerpt === "string" && value.excerpt.trim()) return value.excerpt.trim();
  }
  return null;
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter(Boolean))];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function notificationIsUnseen(storageKey: string): boolean {
  if (typeof window === "undefined") return true;
  try { return getBraiLocalStorageItem(storageKey) !== "seen"; } catch { return true; }
}
