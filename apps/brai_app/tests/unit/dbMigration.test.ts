import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { BraiClientDb, LocalDatabaseUnavailableError, openClientDbWithRetry } from "@/shared/storage/db";

const databaseNames: string[] = [];

describe("BraiClientDb migrations", () => {
  afterEach(async () => {
    await Promise.all(databaseNames.splice(0).map((name) => Dexie.delete(name)));
  });

  it("upgrades version 3 without clearing existing caches or outboxes", async () => {
    const name = `brai-migration-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = legacyDatabase(name);
    await legacy.open();
    await legacy.table("outbox_events").put(pendingTimerEvent());
    await legacy.table("action_outbox_events").put({
      eventId: "activity-event-1",
      deviceId: "device-1",
      clientSequence: 4,
      type: "create",
      occurredAtUtc: "2026-07-13T00:00:00.000Z",
      actionId: "action-1",
      payload: { title: "Сохранить" },
      baseServerRevision: 3,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      enqueuedAtUtc: "2026-07-13T00:00:00.000Z",
    });
    await legacy.table("inbox_outbox_events").put({
      eventId: "inbox-event-1",
      deviceId: "device-1",
      clientSequence: 6,
      type: "create",
      occurredAtUtc: "2026-07-13T00:00:00.000Z",
      inboxId: "inbox-1",
      payload: { title: "Сохранить входящее" },
      baseServerRevision: 3,
      payloadVersion: 1,
      status: "pending",
      attemptCount: 0,
      enqueuedAtUtc: "2026-07-13T00:00:00.000Z",
    });
    await legacy.table("actions_cache").put({
      id: "action-1",
      title: "Сохранить",
      description_md: "",
      status: "New",
      created_at_utc: "2026-07-13T00:00:00.000Z",
      updated_at_utc: "2026-07-13T00:00:00.000Z",
      completed_at_utc: null,
      sort_order: null,
      deleted_at_utc: null,
      restored_at_utc: null,
    });
    legacy.close();

    const upgraded = new BraiClientDb(name);
    await upgraded.open();

    expect(upgraded.verno).toBe(4);
    expect(await upgraded.outbox_events.get("timer-event-1")).toMatchObject({ status: "pending", localTimerId: "timer-1" });
    expect(await upgraded.action_outbox_events.get("activity-event-1")).toMatchObject({ status: "pending", actionId: "action-1" });
    expect(await upgraded.inbox_outbox_events.get("inbox-event-1")).toMatchObject({ status: "pending", inboxId: "inbox-1" });
    expect(await upgraded.actions_cache.get("action-1")).toMatchObject({ title: "Сохранить" });
    expect(upgraded.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      "relation_outbox_events",
      "relations_cache",
      "context_decisions_cache",
    ]));
    upgraded.close();
  });

  it("retries a failed first migration against the same legacy database without deletion", async () => {
    const name = `brai-migration-retry-${crypto.randomUUID()}`;
    databaseNames.push(name);
    const legacy = legacyDatabase(name);
    await legacy.open();
    await legacy.table("outbox_events").put(pendingTimerEvent());
    legacy.close();

    let migrationAttempts = 0;
    const upgraded = new BraiClientDb(name);
    upgraded.version(4).upgrade(() => {
      migrationAttempts += 1;
      if (migrationAttempts === 1) throw new Error("upgrade_failed_once");
    });

    await openClientDbWithRetry(upgraded, { attempts: 2, delayMs: 0 });

    expect(migrationAttempts).toBe(2);
    expect(upgraded.verno).toBe(4);
    expect(await upgraded.outbox_events.get("timer-event-1")).toMatchObject({
      status: "pending",
      localTimerId: "timer-1",
    });
    upgraded.close();
  });

  it("retries a failed migration without deleting the existing database", async () => {
    let attempts = 0;
    let closes = 0;
    const migrationFailure = new Error("upgrade_failed");
    const database = {
      open: async () => {
        attempts += 1;
        throw migrationFailure;
      },
      close: () => { closes += 1; },
    };

    await expect(openClientDbWithRetry(database as Pick<BraiClientDb, "open" | "close">, {
      attempts: 2,
      delayMs: 0,
    })).rejects.toBeInstanceOf(LocalDatabaseUnavailableError);
    expect(attempts).toBe(2);
    expect(closes).toBe(2);
  });
});

function legacyDatabase(name: string): Dexie {
  const database = new Dexie(name);
  database.version(3).stores({
    meta: "&key",
    outbox_events: "&eventId, deviceId, clientSequence, status, enqueuedAtUtc",
    action_outbox_events: "&eventId, deviceId, clientSequence, actionId, status, enqueuedAtUtc",
    inbox_outbox_events: "&eventId, deviceId, clientSequence, inboxId, status, enqueuedAtUtc",
    canonical_state: "&key, serverRevision",
    sessions_cache: "&id, started_at_utc, ended_at_utc",
    actions_cache: "&id, status, created_at_utc, updated_at_utc, completed_at_utc",
    inbox_cache: "&id, created_at_utc, updated_at_utc, deleted_at_utc",
    goal_cache: "&key, serverRevision",
    ignored_events: "&eventId, acknowledgedAtUtc",
  });
  return database;
}

function pendingTimerEvent() {
  return {
    eventId: "timer-event-1",
    deviceId: "device-1",
    clientSequence: 2,
    type: "start",
    occurredAtUtc: "2026-07-13T00:00:00.000Z",
    localTimerId: "timer-1",
    baseServerRevision: 3,
    payloadVersion: 1,
    status: "pending",
    attemptCount: 0,
    enqueuedAtUtc: "2026-07-13T00:00:00.000Z",
  };
}
