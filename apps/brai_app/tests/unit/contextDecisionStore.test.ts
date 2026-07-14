import { beforeEach, describe, expect, it } from "vitest";
import { loadContextDecisionsState, saveContextDecisionsState } from "@/shared/storage/contextDecisionStore";
import { ClientUserScopeChangedError, clientDb, setMeta } from "@/shared/storage/db";
import type { ContextDecisionsState } from "@/shared/types/contextDecisions";

describe("context decision store", () => {
  beforeEach(async () => {
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("caches decisions, audits, and policy notifications", async () => {
    expect(await saveContextDecisionsState(state(3))).toBe(true);

    const cached = await loadContextDecisionsState();

    expect(cached?.decisions).toMatchObject([{ id: "decision-1", decision_kind: "relation_add", status: "pending" }]);
    expect(cached?.audits).toMatchObject([{ id: "audit-1", decision_ids: ["decision-1"] }]);
    expect(cached?.notifications).toMatchObject([{ id: "notification-1", type: "policy_activated" }]);
    expect(await clientDb().context_decisions_cache.count()).toBe(3);
  });

  it("does not overwrite a newer cached review snapshot", async () => {
    expect(await saveContextDecisionsState(state(3))).toBe(true);
    expect(await saveContextDecisionsState({ ...state(2), decisions: [] })).toBe(false);

    expect((await loadContextDecisionsState())?.server_revision).toBe(3);
    expect((await loadContextDecisionsState())?.decisions).toHaveLength(1);
  });

  it("repairs an incomplete cached snapshot at the same validated revision", async () => {
    expect(await saveContextDecisionsState({ ...state(3), decisions: [] })).toBe(true);
    expect(await saveContextDecisionsState(state(3))).toBe(true);

    expect((await loadContextDecisionsState())?.server_revision).toBe(3);
    expect((await loadContextDecisionsState())?.decisions).toMatchObject([{ id: "decision-1" }]);
  });

  it("keeps the new owner's context snapshot untouched by a stale tab", async () => {
    await setMeta("currentUserId", "user-a");
    await setMeta("currentUserId", "user-b");
    await saveContextDecisionsState(state(3), "user-b");
    const beforeCache = await clientDb().context_decisions_cache.toArray();

    await expect(saveContextDecisionsState({ ...state(4), decisions: [] }, "user-a"))
      .rejects.toBeInstanceOf(ClientUserScopeChangedError);
    await expect(loadContextDecisionsState("user-a")).rejects.toBeInstanceOf(ClientUserScopeChangedError);

    expect(await clientDb().context_decisions_cache.toArray()).toEqual(beforeCache);
    expect(await loadContextDecisionsState("user-b")).toMatchObject({
      server_revision: 3,
      decisions: [{ id: "decision-1" }],
    });
  });
});

function state(serverRevision: number): ContextDecisionsState {
  const now = "2026-07-13T00:00:00.000Z";
  return {
    server_time_utc: now,
    server_revision: serverRevision,
    decisions: [{
      id: "decision-1",
      decision_kind: "relation_add",
      status: "pending",
      confidence: 0.96,
      subject_items_id: "action-1",
      proposal: { target_items_id: "goal-1" },
      rationale: "Подходит по смыслу",
      evidence: ["Общий результат"],
      created_at_utc: now,
      updated_at_utc: now,
    }],
    audits: [{
      id: "audit-1",
      status: "pending",
      policy_id: "policy-1",
      decision_ids: ["decision-1"],
      due_at_utc: "2026-07-27T00:00:00.000Z",
      created_at_utc: now,
      updated_at_utc: now,
    }],
    notifications: [{
      id: "notification-1",
      type: "policy_activated",
      policy_id: "policy-1",
      created_at_utc: now,
      read_at_utc: null,
    }],
  };
}
