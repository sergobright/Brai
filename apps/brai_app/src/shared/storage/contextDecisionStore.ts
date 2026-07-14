import type {
  ContextAudit,
  ContextDecision,
  ContextDecisionCacheRow,
  ContextDecisionsState,
  ContextNotification,
} from "@/shared/types/contextDecisions";
import { assertClientUserInCurrentTransaction, clientDb } from "./db";

/** Persists the compact product review snapshot without touching domain outboxes. */
export async function saveContextDecisionsState(state: ContextDecisionsState, expectedUserId?: string): Promise<boolean> {
  const db = clientDb();
  const rows: ContextDecisionCacheRow[] = [
    ...state.decisions.map(decisionRow),
    ...state.audits.map(auditRow),
    ...state.notifications.map(notificationRow),
  ];
  return db.transaction("rw", db.context_decisions_cache, db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const currentRevision = Number((await db.meta.get("lastContextDecisionServerRevision"))?.value ?? 0);
    if (state.server_revision < currentRevision) return false;
    await db.context_decisions_cache.clear();
    if (rows.length > 0) await db.context_decisions_cache.bulkPut(rows);
    await db.meta.bulkPut([
      { key: "lastContextDecisionServerRevision", value: state.server_revision },
      { key: "lastContextDecisionServerTimeUtc", value: state.server_time_utc },
      { key: "lastSuccessfulContextDecisionsSyncAtUtc", value: new Date().toISOString() },
    ]);
    return true;
  });
}

/** Loads pending decisions, audits, and one-time notifications from IndexedDB. */
export async function loadContextDecisionsState(expectedUserId?: string): Promise<ContextDecisionsState | null> {
  const db = clientDb();
  const result = await db.transaction("r", db.context_decisions_cache, db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    const [rows, revision, serverTime] = await Promise.all([
      db.context_decisions_cache.toArray(),
      db.meta.get("lastContextDecisionServerRevision"),
      db.meta.get("lastContextDecisionServerTimeUtc"),
    ]);
    return {
      rows,
      revision: (revision?.value as number | undefined) ?? null,
      serverTime: (serverTime?.value as string | undefined) ?? null,
    };
  });
  if (result.rows.length === 0 && result.revision == null) return null;
  return {
    server_time_utc: result.serverTime ?? new Date().toISOString(),
    server_revision: result.revision ?? 0,
    decisions: payloads<ContextDecision>(result.rows, "decision"),
    audits: payloads<ContextAudit>(result.rows, "audit"),
    notifications: payloads<ContextNotification>(result.rows, "notification"),
  };
}

export async function lastContextDecisionServerRevision(expectedUserId?: string): Promise<number> {
  const db = clientDb();
  return db.transaction("r", db.meta, async () => {
    if (expectedUserId !== undefined) await assertClientUserInCurrentTransaction(expectedUserId);
    return Number((await db.meta.get("lastContextDecisionServerRevision"))?.value ?? 0);
  });
}

function decisionRow(item: ContextDecision): ContextDecisionCacheRow {
  return {
    id: `decision:${item.id}`,
    cache_kind: "decision",
    status: item.status,
    payloadJson: item,
    updated_at_utc: item.updated_at_utc,
  };
}

function auditRow(item: ContextAudit): ContextDecisionCacheRow {
  return {
    id: `audit:${item.id}`,
    cache_kind: "audit",
    status: item.status,
    payloadJson: item,
    updated_at_utc: item.updated_at_utc,
  };
}

function notificationRow(item: ContextNotification): ContextDecisionCacheRow {
  return {
    id: `notification:${item.id}`,
    cache_kind: "notification",
    status: item.read_at_utc ? "read" : "unread",
    payloadJson: item,
    updated_at_utc: item.read_at_utc ?? item.created_at_utc,
  };
}

function payloads<T>(rows: ContextDecisionCacheRow[], kind: ContextDecisionCacheRow["cache_kind"]): T[] {
  return rows
    .filter((row) => row.cache_kind === kind)
    .sort((left, right) => right.updated_at_utc.localeCompare(left.updated_at_utc))
    .map((row) => row.payloadJson as T);
}
