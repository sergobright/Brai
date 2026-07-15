import type { ContextDecisionsState } from "@/shared/types/contextDecisions";
import type { RelationsState } from "@/shared/types/relations";

const MAX_PAGES = 200;
const MAX_SNAPSHOT_ATTEMPTS = 3;
const RELATION_REVISION_DRIFT = "relations_pagination_revision_drift";
const CONTEXT_REVISION_DRIFT = "context_reviews_pagination_revision_drift";

type ContextReviewStatus = "pending" | "audit" | "auto_accepted" | "audit_confirmed";

/** Drains every active Relation page while deduplicating bounded ended history. */
export async function drainRelations(
  first: RelationsState,
  load: (cursor?: string) => Promise<RelationsState>,
): Promise<RelationsState> {
  let start = first;
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await drainRelationSnapshot(start, load);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== RELATION_REVISION_DRIFT) throw error;
      if (attempt === MAX_SNAPSHOT_ATTEMPTS) throw error;
      start = await load();
    }
  }
  throw new Error(RELATION_REVISION_DRIFT);
}

async function drainRelationSnapshot(
  first: RelationsState,
  load: (cursor?: string) => Promise<RelationsState>,
): Promise<RelationsState> {
  if (!first.next_cursor) return first;
  const relations = new Map(first.relations.map((relation) => [relation.id, relation]));
  const ended = new Map(first.ended_relations.map((relation) => [relation.id, relation]));
  await drain(first.next_cursor, "relations", async (cursor) => {
    const page = await load(cursor);
    if (page.server_revision !== first.server_revision) throw new Error(RELATION_REVISION_DRIFT);
    for (const relation of page.relations) relations.set(relation.id, relation);
    for (const relation of page.ended_relations) ended.set(relation.id, relation);
    return page.next_cursor;
  });
  return { ...first, relations: [...relations.values()], ended_relations: [...ended.values()], next_cursor: null };
}

/** Drains one revision-consistent context-review status and its audit dependency. */
export async function drainContextReviews(
  first: ContextDecisionsState,
  load: (status: ContextReviewStatus, cursor?: string) => Promise<ContextDecisionsState>,
  status: ContextReviewStatus,
): Promise<ContextDecisionsState> {
  let start = first;
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await drainContextReviewSnapshot(start, load, status);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== CONTEXT_REVISION_DRIFT) throw error;
      if (attempt === MAX_SNAPSHOT_ATTEMPTS) throw error;
      start = await load(status);
    }
  }
  throw new Error(CONTEXT_REVISION_DRIFT);
}

async function drainContextReviewSnapshot(
  first: ContextDecisionsState,
  load: (status: ContextReviewStatus, cursor?: string) => Promise<ContextDecisionsState>,
  status: ContextReviewStatus,
): Promise<ContextDecisionsState> {
  const decisions = new Map(first.decisions.map((decision) => [decision.id, decision]));
  const audits = new Map(first.audits.map((audit) => [audit.id, audit]));
  const notifications = new Map(first.notifications.map((notification) => [notification.id, notification]));
  await drain(first.next_cursor, "context_decisions", async (cursor) => {
    const page = await load(status, cursor);
    assertContextRevision(page, first.server_revision);
    merge(page, decisions, audits, notifications);
    return page.next_cursor;
  });
  if (status === "pending") {
    const auditFirst = await load("audit");
    assertContextRevision(auditFirst, first.server_revision);
    merge(auditFirst, decisions, audits, notifications);
    await drain(auditFirst.next_cursor, "context_audits", async (cursor) => {
      const page = await load("audit", cursor);
      assertContextRevision(page, first.server_revision);
      merge(page, decisions, audits, notifications);
      return page.next_cursor;
    });
  }
  return {
    ...first,
    decisions: [...decisions.values()],
    audits: [...audits.values()],
    notifications: [...notifications.values()],
    next_cursor: null,
  };
}

function assertContextRevision(page: ContextDecisionsState, expected: number): void {
  if (page.server_revision !== expected) throw new Error(CONTEXT_REVISION_DRIFT);
}

async function drain(
  firstCursor: string | null | undefined,
  domain: string,
  load: (cursor: string) => Promise<string | null | undefined>,
): Promise<void> {
  const seen = new Set<string>();
  let cursor = firstCursor;
  for (let pageIndex = 0; cursor && pageIndex < MAX_PAGES; pageIndex += 1) {
    if (seen.has(cursor)) throw new Error(`${domain}_pagination_cycle`);
    seen.add(cursor);
    cursor = await load(cursor);
  }
  if (cursor) throw new Error(`${domain}_pagination_limit`);
}

function merge(
  page: ContextDecisionsState,
  decisions: Map<string, ContextDecisionsState["decisions"][number]>,
  audits: Map<string, ContextDecisionsState["audits"][number]>,
  notifications: Map<string, ContextDecisionsState["notifications"][number]>,
): void {
  for (const decision of page.decisions) decisions.set(decision.id, decision);
  for (const audit of page.audits) audits.set(audit.id, audit);
  for (const notification of page.notifications) notifications.set(notification.id, notification);
}
