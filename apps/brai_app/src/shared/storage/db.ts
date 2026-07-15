import Dexie, { type Table } from "dexie";
import type {
  GoalData,
  PendingTimerEvent,
  TimerSession,
  TimerState,
} from "@/shared/types/timer";
import type { ActivityItem, PendingActivityEvent } from "@/shared/types/activities";
import type { ContextDecisionCacheRow } from "@/shared/types/contextDecisions";
import type { InboxItem, PendingInboxEvent } from "@/shared/types/inbox";
import type { PendingRelationEvent, RelationItem } from "@/shared/types/relations";
import { appCommit, appEnvironment } from "@/shared/config/runtime";
import { platformName } from "@/shared/platform/platform";

const SERVER_STATE_META_KEYS = [
  "lastServerRevision",
  "lastSuccessfulSyncAtUtc",
  "lastActionServerRevision",
  "lastActionServerTimeUtc",
  "lastSuccessfulActionsSyncAtUtc",
  "lastInboxServerRevision",
  "lastInboxServerTimeUtc",
  "lastSuccessfulInboxSyncAtUtc",
  "lastRelationServerRevision",
  "lastRelationServerTimeUtc",
  "lastSuccessfulRelationsSyncAtUtc",
  "relationSyncIssues",
  "relationIdAliases",
  "relationTypesCache",
  "relationsSnapshotComplete",
  "lastContextDecisionServerRevision",
  "lastContextDecisionServerTimeUtc",
  "lastSuccessfulContextDecisionsSyncAtUtc",
];

export interface MetaRow {
  key: string;
  value: unknown;
}

export type ClientOwnerScope = {
  userId: string;
  epoch: number;
};

export class ClientUserScopeChangedError extends Error {
  constructor() {
    super("client_user_scope_changed");
    this.name = "ClientUserScopeChangedError";
  }
}

export interface CanonicalStateRow {
  key: "current";
  serverRevision: number;
  serverTimeUtc: string;
  activeSessionJson: TimerState["active_session"];
  elapsedSeconds: number;
  activeIntervalJson?: TimerState["active_interval"];
  activeIntervalElapsedSeconds?: number;
  activeActivityId?: string | null;
  activeSessionStartOrigin?: TimerState["active_session_start_origin"];
  activeSessionStartedByActivityId?: string | null;
  updatedAtUtc: string;
}

export interface GoalCacheRow {
  key: "challenge";
  payloadJson: GoalData;
  serverRevision: number;
  updatedAtUtc: string;
}

export interface IgnoredEventRow {
  eventId: string;
  reason: string;
  acknowledgedAtUtc: string;
}

/**
 * Defines the IndexedDB schema used by the Brai offline-first client.
 */
export class BraiClientDb extends Dexie {
  meta!: Table<MetaRow, string>;
  outbox_events!: Table<PendingTimerEvent, string>;
  action_outbox_events!: Table<PendingActivityEvent, string>;
  inbox_outbox_events!: Table<PendingInboxEvent, string>;
  relation_outbox_events!: Table<PendingRelationEvent, string>;
  canonical_state!: Table<CanonicalStateRow, string>;
  sessions_cache!: Table<TimerSession, string>;
  actions_cache!: Table<ActivityItem, string>;
  inbox_cache!: Table<InboxItem, string>;
  relations_cache!: Table<RelationItem, string>;
  context_decisions_cache!: Table<ContextDecisionCacheRow, string>;
  goal_cache!: Table<GoalCacheRow, string>;
  ignored_events!: Table<IgnoredEventRow, string>;

  constructor(databaseName = "bright_os_client_sync") {
    // Keep the physical IndexedDB name stable so existing offline/outbox data survives the Brai cutover.
    super(databaseName);
    this.version(1).stores({
      meta: "&key",
      outbox_events: "&eventId, deviceId, clientSequence, status, enqueuedAtUtc",
      canonical_state: "&key, serverRevision",
      sessions_cache: "&id, started_at_utc, ended_at_utc",
      goal_cache: "&key, serverRevision",
      ignored_events: "&eventId, acknowledgedAtUtc",
    });
    this.version(2).stores({
      meta: "&key",
      outbox_events: "&eventId, deviceId, clientSequence, status, enqueuedAtUtc",
      action_outbox_events: "&eventId, deviceId, clientSequence, actionId, status, enqueuedAtUtc",
      canonical_state: "&key, serverRevision",
      sessions_cache: "&id, started_at_utc, ended_at_utc",
      actions_cache: "&id, status, created_at_utc, updated_at_utc, completed_at_utc",
      goal_cache: "&key, serverRevision",
      ignored_events: "&eventId, acknowledgedAtUtc",
    });
    this.version(3).stores({
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
    this.version(4).stores({
      meta: "&key",
      outbox_events: "&eventId, deviceId, clientSequence, status, enqueuedAtUtc",
      action_outbox_events: "&eventId, deviceId, clientSequence, actionId, status, enqueuedAtUtc",
      inbox_outbox_events: "&eventId, deviceId, clientSequence, inboxId, status, enqueuedAtUtc",
      relation_outbox_events: "&eventId, deviceId, clientSequence, relationId, status, enqueuedAtUtc",
      canonical_state: "&key, serverRevision",
      sessions_cache: "&id, started_at_utc, ended_at_utc",
      actions_cache: "&id, activity_type_id, status, created_at_utc, updated_at_utc, completed_at_utc",
      inbox_cache: "&id, items_id, record_type_id, preliminary_section, status, created_at_utc, updated_at_utc, deleted_at_utc",
      relations_cache: "&id, relation_types_id, source_items_id, target_items_id, status, [target_items_id+position], updated_at_utc",
      context_decisions_cache: "&id, cache_kind, status, updated_at_utc",
      goal_cache: "&key, serverRevision",
      ignored_events: "&eventId, acknowledgedAtUtc",
    });
  }
}

let dbInstance: BraiClientDb | null = null;

export function clientDb(): BraiClientDb {
  dbInstance ??= new BraiClientDb();
  return dbInstance;
}

export class LocalDatabaseUnavailableError extends Error {
  override name = "LocalDatabaseUnavailableError";
}

/** Opens/migrates IndexedDB with one bounded retry and never deletes old data. */
export async function openClientDbWithRetry(
  database: Pick<BraiClientDb, "open" | "close"> = clientDb(),
  { attempts = 2, delayMs = 150 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const total = Math.max(1, Math.min(attempts, 3));
  let lastError: unknown;
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      await database.open();
      return;
    } catch (error) {
      lastError = error;
      database.close();
      if (attempt < total && delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  const blocked = new LocalDatabaseUnavailableError("local_database_migration_blocked");
  blocked.cause = lastError;
  throw blocked;
}

export async function getMeta<T>(key: string): Promise<T | null> {
  const row = await clientDb().meta.get(key);
  return (row?.value as T | undefined) ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await clientDb().meta.put({ key, value });
}

/** Verifies an expected owner from inside the caller's Dexie transaction. */
export async function assertClientUserInCurrentTransaction(expectedUserId: string): Promise<void> {
  const currentUserId = (await clientDb().meta.get("currentUserId"))?.value;
  if (currentUserId !== expectedUserId) throw new ClientUserScopeChangedError();
}

/**
 * Ensures every local outbox write has a stable device id and sequence.
 */
export async function ensureClientMeta(): Promise<{
  deviceId: string;
  platform: "android" | "web";
  nextClientSequence: number;
}> {
  const db = clientDb();
  return db.transaction("rw", db.meta, async () => {
    let deviceId = await getMeta<string>("deviceId");
    if (!deviceId) {
      deviceId = `brai-${randomId()}`;
      await setMeta("deviceId", deviceId);
    }

    const sequenceValue = await getMeta<number>("nextClientSequence");
    let nextClientSequence = Number.isInteger(sequenceValue) ? Number(sequenceValue) : 1;
    if (nextClientSequence < 1) {
      nextClientSequence = 1;
    }
    await setMeta("nextClientSequence", nextClientSequence);

    const platform = platformName();
    await setMeta("platform", platform);
    await setMeta("localSchemaVersion", 4);

    return { deviceId, platform, nextClientSequence };
  });
}

/**
 * Clears user-owned local data when the authenticated server user changes.
 */
export async function ensureClientUser(
  userId: string | null,
  expectedCurrentUserId?: string | null,
): Promise<void> {
  const db = clientDb();
  const environment = appEnvironment();
  const runtimeScope = environment === "prod" ? null : `${environment}:${appCommit() || "unknown"}`;
  await db.transaction(
    "rw",
    [
      db.meta,
      db.outbox_events,
      db.action_outbox_events,
      db.inbox_outbox_events,
      db.relation_outbox_events,
      db.canonical_state,
      db.sessions_cache,
      db.actions_cache,
      db.inbox_cache,
      db.relations_cache,
      db.context_decisions_cache,
      db.goal_cache,
      db.ignored_events,
    ],
    async () => {
      const [existingUser, existingRuntimeScope] = await Promise.all([
        db.meta.get("currentUserId"),
        db.meta.get("runtimeScope"),
      ]);
      const currentUserId = (existingUser?.value as string | null | undefined) ?? null;
      if (expectedCurrentUserId !== undefined && currentUserId !== expectedCurrentUserId) {
        throw new ClientUserScopeChangedError();
      }
      // Ownerless local data must never be adopted when the first authenticated user is bound.
      const ownerChanged = existingUser ? currentUserId !== userId : userId !== null;
      const runtimeChanged = runtimeScope !== null && existingRuntimeScope?.value !== runtimeScope;
      if (!ownerChanged && !runtimeChanged) {
        await setMeta("currentUserId", userId);
        return;
      }

      const clearing = [
        db.canonical_state.clear(),
        db.sessions_cache.clear(),
        db.actions_cache.clear(),
        db.inbox_cache.clear(),
        db.relations_cache.clear(),
        db.context_decisions_cache.clear(),
        db.goal_cache.clear(),
        db.ignored_events.clear(),
        db.meta.bulkDelete(SERVER_STATE_META_KEYS),
      ];
      if (ownerChanged) {
        clearing.push(
          db.outbox_events.clear(),
          db.action_outbox_events.clear(),
          db.inbox_outbox_events.clear(),
          db.relation_outbox_events.clear(),
        );
      }
      await Promise.all(clearing);
      await setMeta("currentUserId", userId);
      if (runtimeScope !== null) await setMeta("runtimeScope", runtimeScope);
    },
  );
}

export function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
