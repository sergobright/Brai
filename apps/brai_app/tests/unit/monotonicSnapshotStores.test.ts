import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadActivitiesState, saveActivitiesState } from "@/shared/storage/activityStore";
import { loadContextDecisionsState, saveContextDecisionsState } from "@/shared/storage/contextDecisionStore";
import { clientDb } from "@/shared/storage/db";
import { loadInboxState, saveInboxState } from "@/shared/storage/inboxStore";
import { loadRelationsState, saveRelationsState } from "@/shared/storage/relationStore";
import type { ActivitiesState } from "@/shared/types/activities";
import type { ContextDecisionsState } from "@/shared/types/contextDecisions";
import type { InboxState } from "@/shared/types/inbox";
import type { RelationsState } from "@/shared/types/relations";

describe("monotonic IndexedDB snapshots", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(clientDb().tables.map((table) => table.clear()));
  });

  it("cannot let an older Relations response win a delayed write race", async () => {
    const older = { ...relationsState(1), relations: [] };
    const outcome = await saveWithFirstTransactionDelayed(
      () => saveRelationsState(older),
      () => saveRelationsState(relationsState(2)),
    );

    expect(outcome).toEqual({ older: false, newer: true });
    expect(await loadRelationsState()).toMatchObject({
      server_revision: 2,
      relations: [{ id: "relation-2" }],
    });
  });

  it("cannot let an older Activity response win a delayed write race", async () => {
    const outcome = await saveWithFirstTransactionDelayed(
      () => saveActivitiesState(activitiesState(1)),
      () => saveActivitiesState(activitiesState(2)),
    );

    expect(outcome).toEqual({ older: false, newer: true });
    expect(await loadActivitiesState()).toMatchObject({
      server_revision: 2,
      actions: [{ id: "action-2" }],
    });
  });

  it("cannot let an older Inbox response win a delayed write race", async () => {
    const outcome = await saveWithFirstTransactionDelayed(
      () => saveInboxState(inboxState(1)),
      () => saveInboxState(inboxState(2)),
    );

    expect(outcome).toEqual({ older: false, newer: true });
    expect(await loadInboxState()).toMatchObject({
      server_revision: 2,
      inbox: [{ id: "inbox-2" }],
    });
  });

  it("cannot let an older Context Decisions response win a delayed write race", async () => {
    const outcome = await saveWithFirstTransactionDelayed(
      () => saveContextDecisionsState(contextState(1, [])),
      () => saveContextDecisionsState(contextState(2, ["decision-2"])),
    );

    expect(outcome).toEqual({ older: false, newer: true });
    expect(await loadContextDecisionsState()).toMatchObject({
      server_revision: 2,
      decisions: [{ id: "decision-2" }],
    });
  });
});

async function saveWithFirstTransactionDelayed(
  olderSave: () => Promise<boolean>,
  newerSave: () => Promise<boolean>,
): Promise<{ older: boolean; newer: boolean }> {
  const db = clientDb();
  const transaction = db.transaction.bind(db) as unknown as (...args: unknown[]) => Promise<unknown>;
  let signalBlocked!: () => void;
  let releaseBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => { signalBlocked = resolve; });
  const released = new Promise<void>((resolve) => { releaseBlocked = resolve; });
  let delayNext = true;
  const spy = vi.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
    if (!delayNext) return transaction(...args);
    delayNext = false;
    signalBlocked();
    return released.then(() => transaction(...args));
  }) as never);

  try {
    const older = olderSave();
    await blocked;
    const newer = await newerSave();
    releaseBlocked();
    return { older: await older, newer };
  } finally {
    releaseBlocked();
    spy.mockRestore();
  }
}

function relationsState(revision: number): RelationsState {
  const timestamp = `2026-07-13T00:00:0${revision}.000Z`;
  return {
    server_time_utc: timestamp,
    server_revision: revision,
    relation_types: [],
    relations: [{
      id: `relation-${revision}`,
      user_id: "user-1",
      relation_types_id: "part_of",
      source_items_id: "action-1",
      target_items_id: "goal-1",
      status: "active",
      position: 0,
      active_from_utc: timestamp,
      active_to_utc: null,
      operation_id: `operation-${revision}`,
      ended_operation_id: null,
      origin_decision_id: null,
      created_by_actor_type: "system",
      created_by_actor_id: null,
      ended_by_actor_type: null,
      ended_by_actor_id: null,
      end_reason: null,
      metadata_json: {},
      created_at_utc: timestamp,
      updated_at_utc: timestamp,
    }],
    ended_relations: [],
    next_cursor: null,
  };
}

function activitiesState(revision: number): ActivitiesState {
  const timestamp = `2026-07-13T00:00:0${revision}.000Z`;
  return {
    server_time_utc: timestamp,
    server_revision: revision,
    actions: [{
      id: `action-${revision}`,
      activity_type_id: "action",
      title: `Действие ${revision}`,
      description_md: "",
      status: "New",
      created_at_utc: timestamp,
      updated_at_utc: timestamp,
      completed_at_utc: null,
      sort_order: null,
      deleted_at_utc: null,
      restored_at_utc: null,
    }],
    archived_actions: [],
    legacy_operations: [],
    goals: [],
    archived_goals: [],
  };
}

function inboxState(revision: number): InboxState {
  const timestamp = `2026-07-13T00:00:0${revision}.000Z`;
  return {
    server_time_utc: timestamp,
    server_revision: revision,
    inbox: [{
      id: `inbox-${revision}`,
      title: `Входящее ${revision}`,
      description_md: "",
      source: "",
      item_date: null,
      author: "",
      preliminary_section: "",
      urgency: "",
      status: "New",
      completed_at_utc: null,
      attachment_links: [],
      explanation_text: "",
      normalization_text: "",
      is_normalized: false,
      created_at_utc: timestamp,
      updated_at_utc: timestamp,
      deleted_at_utc: null,
    }],
  };
}

function contextState(revision: number, ids: string[]): ContextDecisionsState {
  const timestamp = `2026-07-13T00:00:0${revision}.000Z`;
  return {
    server_time_utc: timestamp,
    server_revision: revision,
    decisions: ids.map((id) => ({
      id,
      decision_kind: "relation_add",
      status: "pending",
      confidence: 0.9,
      subject_items_id: "action-1",
      proposal: { target_items_id: "goal-1" },
      rationale: "Общий результат",
      evidence: [],
      created_at_utc: timestamp,
      updated_at_utc: timestamp,
    })),
    audits: [],
    notifications: [],
  };
}
