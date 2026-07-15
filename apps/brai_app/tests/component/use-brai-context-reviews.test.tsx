import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BraiApi } from "@/shared/api/braiApi";
import { useBraiContextReviews } from "@/features/app/hooks/useBraiContextReviews";
import { emptyContextDecisionsState, type ContextDecision, type ContextDecisionsState, type ContextDecisionStatus } from "@/shared/types/contextDecisions";

vi.mock("@/shared/storage/contextDecisionStore", () => ({
  loadContextDecisionsState: vi.fn(async () => null),
  saveContextDecisionsState: vi.fn(async () => true),
}));

describe("useBraiContextReviews", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes audit items to the audit endpoint with a stable resolution key", async () => {
    const api = {
      resolveContextAudit: vi.fn(async () => ({})),
      resolveContextDecision: vi.fn(async () => ({})),
      contextDecisions: vi.fn(async () => emptyContextDecisionsState()),
    } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiContextReviews(api));
    const decision = auditDecision();

    await act(() => result.current.onResolveContextDecision(decision, "reject"));

    expect(api.resolveContextAudit).toHaveBeenCalledWith("decision-1", {
      resolution: "reject",
      idempotency_key: "product:audit:audit-1:decision-1:reject",
    });
    expect(api.resolveContextDecision).not.toHaveBeenCalled();
  });

  it("undoes an automatic decision through a stable compensation command", async () => {
    const api = {
      undoContextDecision: vi.fn(async () => ({})),
      contextDecisions: vi.fn(async () => emptyContextDecisionsState()),
    } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiContextReviews(api));
    const decision = { ...auditDecision(), audit_id: null, status: "auto_accepted" as const };

    await act(() => result.current.onUndoContextDecision(decision));

    expect(api.undoContextDecision).toHaveBeenCalledWith("decision-1", "product:undo:decision-1");
    expect(api.contextDecisions).toHaveBeenCalledTimes(3);
  });

  it("aborts a stale context mutation when session revalidation changes identity", async () => {
    const api = {
      resolveContextDecision: vi.fn(async () => ({})),
      contextDecisions: vi.fn(async () => emptyContextDecisionsState()),
    } as unknown as BraiApi;
    const beforeMutation = vi.fn(async () => null);
    const { result } = renderHook(() => useBraiContextReviews(api, beforeMutation));
    const decision = { ...auditDecision(), audit_id: null };

    await expect(result.current.onResolveContextDecision(decision, "accept")).rejects.toThrow("session_revalidation_required");

    expect(beforeMutation).toHaveBeenCalledWith(api);
    expect(api.resolveContextDecision).not.toHaveBeenCalled();
  });

  it("retries every status and applies only one revision-consistent snapshot", async () => {
    const contextDecisions = vi.fn()
      .mockResolvedValueOnce(reviewState(2, "pending-2", "pending"))
      .mockResolvedValueOnce(reviewState(1, "auto-stale", "auto_accepted"))
      .mockResolvedValueOnce(reviewState(2, "confirmed-2", "audit_confirmed"))
      .mockResolvedValueOnce(reviewState(2, "pending-2", "pending"))
      .mockResolvedValueOnce(reviewState(2, "auto-2", "auto_accepted"))
      .mockResolvedValueOnce(reviewState(2, "confirmed-2", "audit_confirmed"));
    const api = { contextDecisions } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiContextReviews(api));

    await act(async () => result.current.refreshContextReviews());

    expect(contextDecisions).toHaveBeenCalledTimes(6);
    expect(result.current.contextReviews.server_revision).toBe(2);
    expect(result.current.contextReviews.decisions.map((decision) => decision.id)).toEqual([
      "pending-2", "auto-2", "confirmed-2",
    ]);
  });

  it("stops after three inconsistent whole-snapshot attempts", async () => {
    const contextDecisions = vi.fn(async (status: "pending" | "auto_accepted" | "audit_confirmed") =>
      reviewState(status === "pending" ? 2 : 1, `${status}-decision`, status));
    const api = { contextDecisions } as unknown as BraiApi;
    const { result } = renderHook(() => useBraiContextReviews(api));

    await expect(result.current.refreshContextReviews()).rejects.toThrow("context_reviews_revision_drift");
    expect(contextDecisions).toHaveBeenCalledTimes(9);
  });
});

function reviewState(revision: number, id: string, status: ContextDecisionStatus): ContextDecisionsState {
  return {
    server_time_utc: "2026-07-13T00:00:00.000Z",
    server_revision: revision,
    decisions: [{ ...auditDecision(), id, audit_id: null, status }],
    audits: [],
    notifications: [],
    next_cursor: null,
  };
}

function auditDecision(): ContextDecision {
  return {
    id: "decision-1",
    audit_id: "audit-1",
    decision_kind: "relation_add",
    status: "pending",
    confidence: 0.96,
    subject_items_id: "action-1",
    proposal: { target_items_id: "goal-1" },
    rationale: "Проверка",
    evidence: [],
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
  };
}
