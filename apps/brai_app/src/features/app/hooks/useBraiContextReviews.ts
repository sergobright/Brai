"use client";

import { useEffect, useRef, useState } from "react";
import type { BraiApi } from "@/shared/api/braiApi";
import type { ClientOwnerScope } from "@/shared/storage/db";
import { defaultApiBase } from "@/shared/config/runtime";
import { loadContextDecisionsState, saveContextDecisionsState } from "@/shared/storage/contextDecisionStore";
import { emptyContextDecisionsState, type ContextDecision, type ContextDecisionsState, type ContextResolution } from "@/shared/types/contextDecisions";

const MAX_CONTEXT_REVIEW_SNAPSHOT_ATTEMPTS = 3;

/** Caches compact pending decisions/audits and refreshes them through poll/live state. */
export function useBraiContextReviews(
  api: BraiApi,
  beforeSync?: (sourceApi?: BraiApi, requestedScope?: ClientOwnerScope) => Promise<ClientOwnerScope | null>,
  isScopeCurrent?: (scope: ClientOwnerScope) => boolean,
) {
  const apiRef = useRef(api);
  useEffect(() => { apiRef.current = api; }, [api]);
  const revisionRef = useRef(0);
  const [contextReviews, setContextReviews] = useState<ContextDecisionsState>(emptyContextDecisionsState());

  async function loadLocalContextReviews(expectedUserId?: string) {
    const cached = await loadContextDecisionsState(expectedUserId);
    if (!cached) return;
    revisionRef.current = cached.server_revision;
    setContextReviews(cached);
  }

  async function applyContextReviewsState(next: ContextDecisionsState, scope?: ClientOwnerScope) {
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    if (next.server_revision < revisionRef.current) return;
    const accepted = await saveContextDecisionsState(next, scope?.userId);
    if (!accepted) return;
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    revisionRef.current = next.server_revision;
    setContextReviews(next);
  }

  async function refreshContextReviews(sourceApi = apiRef.current, requestedScope?: ClientOwnerScope) {
    const scope = beforeSync ? (await beforeSync(sourceApi, requestedScope)) ?? undefined : requestedScope;
    if (beforeSync && !scope) return;
    if (scope) sourceApi.setExpectedUserId(scope.userId);
    for (let attempt = 1; attempt <= MAX_CONTEXT_REVIEW_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const [next, autoAccepted, auditConfirmed] = await Promise.all([
        sourceApi.contextDecisions("pending"),
        sourceApi.contextDecisions("auto_accepted"),
        sourceApi.contextDecisions("audit_confirmed"),
      ]);
      if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
      if (autoAccepted.server_revision !== next.server_revision || auditConfirmed.server_revision !== next.server_revision) {
        if (attempt === MAX_CONTEXT_REVIEW_SNAPSHOT_ATTEMPTS) throw new Error("context_reviews_revision_drift");
        continue;
      }
      await applyContextReviewsState({
        ...next,
        decisions: [...next.decisions, ...autoAccepted.decisions, ...auditConfirmed.decisions]
          .sort((left, right) => right.created_at_utc.localeCompare(left.created_at_utc)),
      }, scope);
      return;
    }
  }

  async function onUndoContextDecision(decision: ContextDecision) {
    const scope = beforeSync ? (await beforeSync(apiRef.current)) ?? undefined : undefined;
    if (beforeSync && !scope) throw new Error("session_revalidation_required");
    if (scope) apiRef.current.setExpectedUserId(scope.userId);
    await apiRef.current.undoContextDecision(decision.id, `product:undo:${decision.id}`);
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    await refreshContextReviews(apiRef.current, scope);
  }

  async function onResolveContextDecision(decision: ContextDecision, resolution: ContextResolution, editedPayload?: Record<string, unknown>) {
    const scope = beforeSync ? (await beforeSync(apiRef.current)) ?? undefined : undefined;
    if (beforeSync && !scope) throw new Error("session_revalidation_required");
    if (scope) apiRef.current.setExpectedUserId(scope.userId);
    if (decision.audit_id) {
      await apiRef.current.resolveContextAudit(decision.id, {
        resolution,
        idempotency_key: `product:audit:${decision.audit_id}:${decision.id}:${resolution}`,
      });
    } else {
      await apiRef.current.resolveContextDecision(decision.id, {
        resolution,
        idempotency_key: `product:${decision.id}:${resolution}`,
        ...(editedPayload ? { edited_payload: editedPayload } : {}),
      });
    }
    if (scope && isScopeCurrent && !isScopeCurrent(scope)) return;
    await refreshContextReviews(apiRef.current, scope);
  }

  function resetContextReviews() {
    revisionRef.current = 0;
    setContextReviews(emptyContextDecisionsState());
  }

  return { applyContextReviewsState, contextReviews, loadLocalContextReviews, onResolveContextDecision, onUndoContextDecision, refreshContextReviews, resetContextReviews };
}

/** Marks a one-time policy notification read through the environment-specific API. */
export async function markContextNotificationRead(notificationId: string): Promise<void> {
  const path = `/v1/context-notifications/${encodeURIComponent(notificationId)}/read`;
  const base = defaultApiBase();
  const response = await fetch(!base || base === "/" ? path : `${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok && response.status !== 404) throw new Error(`brai_api_${response.status}`);
}
