import Dexie, { type Table } from "dexie";
import type {
  GoalData,
  PendingTimerEvent,
  TimerSession,
  TimerState,
} from "@/shared/types/timer";
import type { ActivityItem, PendingActivityEvent } from "@/shared/types/activities";
import type { InboxItem, PendingInboxEvent } from "@/shared/types/inbox";
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
];

export interface MetaRow {
  key: string;
  value: unknown;
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
  canonical_state!: Table<CanonicalStateRow, string>;
  sessions_cache!: Table<TimerSession, string>;
  actions_cache!: Table<ActivityItem, string>;
  inbox_cache!: Table<InboxItem, string>;
  goal_cache!: Table<GoalCacheRow, string>;
  ignored_events!: Table<IgnoredEventRow, string>;

  constructor() {
    // Keep the physical IndexedDB name stable so existing offline/outbox data survives the Brai cutover.
    super("bright_os_client_sync");
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
  }
}

let dbInstance: BraiClientDb | null = null;

export function clientDb(): BraiClientDb {
  dbInstance ??= new BraiClientDb();
  return dbInstance;
}

export async function getMeta<T>(key: string): Promise<T | null> {
  const row = await clientDb().meta.get(key);
  return (row?.value as T | undefined) ?? null;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await clientDb().meta.put({ key, value });
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
    await setMeta("localSchemaVersion", 3);

    return { deviceId, platform, nextClientSequence };
  });
}

/**
 * Clears user-owned local data when the authenticated server user changes.
 */
export async function ensureClientUser(userId: string | null): Promise<void> {
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
      db.canonical_state,
      db.sessions_cache,
      db.actions_cache,
      db.inbox_cache,
      db.goal_cache,
      db.ignored_events,
    ],
    async () => {
      const [existingUser, existingRuntimeScope] = await Promise.all([
        db.meta.get("currentUserId"),
        db.meta.get("runtimeScope"),
      ]);
      const currentUserId = (existingUser?.value as string | null | undefined) ?? null;
      const userChanged = Boolean(existingUser) && currentUserId !== userId;
      const runtimeChanged = runtimeScope !== null && existingRuntimeScope?.value !== runtimeScope;
      if (!userChanged && !runtimeChanged) {
        await setMeta("currentUserId", userId);
        return;
      }

      const clearing = [
        db.canonical_state.clear(),
        db.sessions_cache.clear(),
        db.actions_cache.clear(),
        db.inbox_cache.clear(),
        db.goal_cache.clear(),
        db.ignored_events.clear(),
        db.meta.bulkDelete(SERVER_STATE_META_KEYS),
      ];
      if (userChanged) {
        clearing.push(
          db.outbox_events.clear(),
          db.action_outbox_events.clear(),
          db.inbox_outbox_events.clear(),
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
