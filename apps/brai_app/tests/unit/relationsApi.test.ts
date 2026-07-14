import { afterEach, describe, expect, it, vi } from "vitest";
import { BraiApi } from "@/shared/api/braiApi";
import { drainRelations } from "@/shared/api/pagination";
import type { PendingRelationEvent } from "@/shared/types/relations";

describe("BraiApi Goal and Relation contracts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads filtered Relations with public semantic query names", async () => {
    const fetchMock = response({
      server_time_utc: "2026-07-13T00:00:00.000Z",
      server_revision: 1,
      relation_types: [],
      relations: [],
      ended_relations: [],
    });

    await new BraiApi("/api").relations({
      endpointItemsId: "action/1",
      relationTypeId: "part_of",
      status: "active",
      cursor: "next page",
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/v1/relations?endpoint_items_id=action%2F1&relation_type_id=part_of&status=active&cursor=next+page",
    );
  });

  it("normalizes omitted Relation and review arrays for defensive clients", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ server_time_utc: "2026-07-13T00:00:00.000Z", server_revision: 1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ server_time_utc: "2026-07-13T00:00:00.000Z", server_revision: 2 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ server_time_utc: "2026-07-13T00:00:00.000Z", server_revision: 2 })));
    const api = new BraiApi("/api");

    const relations = await api.relations();
    const decisions = await api.contextDecisions("pending");

    expect(relations).toMatchObject({ relation_types: [], relations: [], ended_relations: [] });
    expect(decisions).toMatchObject({ decisions: [], audits: [], notifications: [] });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/context-decisions?status=pending");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/v1/context-decisions?status=audit");
  });

  it("drains decision and audit cursors into one complete review state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({
        decisions: [{ id: "decision-1" }], next_cursor: "decision-cursor",
      }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ decisions: [{ id: "decision-2" }] }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({
        audits: [{ id: "audit-1" }], next_cursor: "audit-cursor",
      }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ audits: [{ id: "audit-2" }] }))));

    const state = await new BraiApi("/api").contextDecisions("pending");

    expect(state.decisions.map((decision) => decision.id)).toEqual(["decision-1", "decision-2"]);
    expect(state.audits.map((audit) => audit.id)).toEqual(["audit-1", "audit-2"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/context-decisions?status=pending",
      "/api/v1/context-decisions?status=pending&cursor=decision-cursor",
      "/api/v1/context-decisions?status=audit",
      "/api/v1/context-decisions?status=audit&cursor=audit-cursor",
    ]);
  });

  it("drains every auto-accepted and audit-confirmed review page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({
        decisions: [{ id: "auto-1" }], next_cursor: "auto-cursor",
      }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ decisions: [{ id: "auto-2" }] }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({
        decisions: [{ id: "confirmed-1" }], next_cursor: "confirmed-cursor",
      }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ decisions: [{ id: "confirmed-2" }] }))));
    const api = new BraiApi("/api");

    const autoAccepted = await api.contextDecisions("auto_accepted");
    const auditConfirmed = await api.contextDecisions("audit_confirmed");

    expect(autoAccepted.decisions.map((decision) => decision.id)).toEqual(["auto-1", "auto-2"]);
    expect(auditConfirmed.decisions.map((decision) => decision.id)).toEqual(["confirmed-1", "confirmed-2"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/context-decisions?status=auto_accepted",
      "/api/v1/context-decisions?status=auto_accepted&cursor=auto-cursor",
      "/api/v1/context-decisions?status=audit_confirmed",
      "/api/v1/context-decisions?status=audit_confirmed&cursor=confirmed-cursor",
    ]);
  });

  it("restarts a complete review status when a later page revision drifts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ server_revision: 1, decisions: [{ id: "old-1" }], next_cursor: "old-cursor" }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ server_revision: 2, decisions: [{ id: "mixed" }] }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ server_revision: 2, decisions: [{ id: "new-1" }], next_cursor: "new-cursor" }))))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewPage({ server_revision: 2, decisions: [{ id: "new-2" }] }))));

    const state = await new BraiApi("/api").contextDecisions("auto_accepted");

    expect(state.server_revision).toBe(2);
    expect(state.decisions.map((decision) => decision.id)).toEqual(["new-1", "new-2"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/context-decisions?status=auto_accepted",
      "/api/v1/context-decisions?status=auto_accepted&cursor=old-cursor",
      "/api/v1/context-decisions?status=auto_accepted",
      "/api/v1/context-decisions?status=auto_accepted&cursor=new-cursor",
    ]);
  });

  it("fails explicitly after bounded complete-review revision drift", async () => {
    const pages = [
      reviewPage({ server_revision: 1, next_cursor: "cursor-1" }),
      reviewPage({ server_revision: 2 }),
      reviewPage({ server_revision: 3, next_cursor: "cursor-3" }),
      reviewPage({ server_revision: 4 }),
      reviewPage({ server_revision: 5, next_cursor: "cursor-5" }),
      reviewPage({ server_revision: 6 }),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(pages.shift())));

    await expect(new BraiApi("/api").contextDecisions("audit_confirmed"))
      .rejects.toThrow("context_reviews_pagination_revision_drift");
    expect(pages).toEqual([]);
  });

  it("drains every active Relation page without duplicating bounded ended history", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        server_time_utc: "2026-07-13T00:00:00.000Z",
        server_revision: 3,
        relation_types: [],
        relations: [{ id: "relation-1" }],
        ended_relations: [{ id: "ended-1" }],
        next_cursor: "relation-1",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        server_time_utc: "2026-07-13T00:00:01.000Z",
        server_revision: 3,
        relation_types: [],
        relations: [{ id: "relation-2" }],
        ended_relations: [{ id: "ended-1" }],
        next_cursor: null,
      })));

    const state = await new BraiApi("/api").relations();

    expect(state.relations.map((relation) => relation.id)).toEqual(["relation-1", "relation-2"]);
    expect(state.ended_relations.map((relation) => relation.id)).toEqual(["ended-1"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/relations",
      "/api/v1/relations?cursor=relation-1",
    ]);
  });

  it("restarts Relation pagination from the first page when the revision drifts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(relationPage(3, ["relation-old-1"], "old-cursor"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(relationPage(4, ["relation-mixed"], null))))
      .mockResolvedValueOnce(new Response(JSON.stringify(relationPage(4, ["relation-new-1"], "new-cursor"))))
      .mockResolvedValueOnce(new Response(JSON.stringify(relationPage(4, ["relation-new-2"], null))));

    const state = await new BraiApi("/api").relations();

    expect(state.server_revision).toBe(4);
    expect(state.relations.map((relation) => relation.id)).toEqual(["relation-new-1", "relation-new-2"]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/relations",
      "/api/v1/relations?cursor=old-cursor",
      "/api/v1/relations",
      "/api/v1/relations?cursor=new-cursor",
    ]);
  });

  it("fails explicitly after bounded Relation pagination revision drift", async () => {
    const pages = [
      relationPage(1, ["relation-1"], "cursor-1"),
      relationPage(2, ["relation-2"], null),
      relationPage(3, ["relation-3"], "cursor-3"),
      relationPage(4, ["relation-4"], null),
      relationPage(5, ["relation-5"], "cursor-5"),
      relationPage(6, ["relation-6"], null),
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(pages.shift())));

    await expect(new BraiApi("/api").relations()).rejects.toThrow("relations_pagination_revision_drift");
    expect(pages).toEqual([]);
  });

  it("preserves Relation pagination cycle and page-limit guards", async () => {
    const cycle = relationPage(1, [], "same-cursor");
    await expect(drainRelations(cycle, async () => cycle)).rejects.toThrow("relations_pagination_cycle");

    let page = 0;
    await expect(drainRelations(relationPage(1, [], "cursor-0"), async () => {
      page += 1;
      return relationPage(1, [], `cursor-${page}`);
    })).rejects.toThrow("relations_pagination_limit");
    expect(page).toBe(200);
  });

  it("sends Relation outbox events through the canonical sync wire format", async () => {
    const fetchMock = response({
      acknowledged_event_ids: ["event-1"],
      ignored_events: [],
      deferred_events: [],
      server_revision: 2,
      server_time_utc: "2026-07-13T00:00:01.000Z",
      state: { server_time_utc: "2026-07-13T00:00:01.000Z", server_revision: 2, relation_types: [], relations: [], ended_relations: [] },
    });
    const event: PendingRelationEvent = {
      eventId: "event-1",
      deviceId: "device-1",
      clientSequence: 9,
      type: "create",
      occurredAtUtc: "2026-07-13T00:00:00.000Z",
      relationId: "relation-1",
      payload: {
        relation_type_id: "part_of",
        source_items_id: "action-1",
        target_items_id: "goal-1",
        dependency_event_ids: ["activity-event-1"],
      },
      baseServerRevision: 1,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      enqueuedAtUtc: "2026-07-13T00:00:00.000Z",
    };

    await new BraiApi("/api").syncRelationEvents({ deviceId: "device-1", platform: "web", events: [event] });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(url).toBe("/api/v1/relations/events/sync");
    expect(body.events[0]).toEqual(expect.objectContaining({
      event_id: "event-1",
      client_sequence: 9,
      change_type: "create",
      relation_id: "relation-1",
      payload: event.payload,
    }));
  });

  it("maps typed Goals and legacy Operations without polluting Actions", async () => {
    response({
      server_time_utc: "2026-07-13T00:00:00.000Z",
      server_revision: 3,
      activities: [activity("action-1", "action")],
      goals: [activity("goal-1", "goal")],
      legacy_operations: [activity("operation-1", "operation")],
      archived_activities: [],
      archived_goals: [],
    });

    const state = await new BraiApi("/api").activities();

    expect(state.actions.map((item) => item.id)).toEqual(["action-1"]);
    expect(state.goals?.map((item) => item.id)).toEqual(["goal-1"]);
    expect(state.legacy_operations?.map((item) => item.id)).toEqual(["operation-1"]);
  });

  it("uses idempotent decision, audit, and Goal plan endpoints", async () => {
    const fetchMock = response({ status: "queued", execution_id: 41, workflow_id: "goal-plan-1" });
    const api = new BraiApi("/api");

    await api.resolveContextDecision("decision/1", { resolution: "accept", idempotency_key: "resolve-1" });
    await api.resolveContextAudit("audit/1", { resolution: "reject", idempotency_key: "resolve-2" });
    await expect(api.requestGoalPlan("goal/1")).resolves.toEqual({ status: "queued", execution_id: 41, workflow_id: "goal-plan-1" });
    await api.activityWorkflow("action/1");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/context-decisions/decision%2F1/resolve",
      "/api/v1/context-audits/audit%2F1/resolve",
      "/api/v1/goals/goal%2F1/plan",
      "/api/v1/activities/action%2F1/workflow",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ resolution: "accept", idempotency_key: "resolve-1" });
  });
});

function response(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

function activity(id: string, type: "action" | "goal" | "operation") {
  return {
    id,
    activity_type_id: type,
    title: id,
    description_md: "",
    status: "New",
    created_at_utc: "2026-07-13T00:00:00.000Z",
    updated_at_utc: "2026-07-13T00:00:00.000Z",
    completed_at_utc: null,
    sort_order: null,
    deleted_at_utc: null,
    restored_at_utc: null,
  };
}

function reviewPage(overrides: Record<string, unknown>) {
  return {
    server_time_utc: "2026-07-13T00:00:00.000Z",
    server_revision: 1,
    decisions: [], audits: [], notifications: [], next_cursor: null,
    ...overrides,
  };
}

function relationPage(serverRevision: number, ids: string[], nextCursor: string | null) {
  return {
    server_time_utc: `2026-07-13T00:00:0${serverRevision}.000Z`,
    server_revision: serverRevision,
    relation_types: [],
    relations: ids.map((id) => ({ id })),
    ended_relations: [],
    next_cursor: nextCursor,
  };
}
