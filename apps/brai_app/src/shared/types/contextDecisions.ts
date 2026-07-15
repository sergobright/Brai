export type ContextDecisionKind = "activity_type_change" | "relation_add" | "goal_discovery" | "goal_plan";
export type ContextDecisionStatus = "pending" | "accepted" | "rejected" | "auto_accepted" | "undone" | "audit_confirmed" | "audit_rejected";
export type ContextResolution = "accept" | "reject";

export interface ContextDecision {
  id: string;
  decision_kind: ContextDecisionKind;
  status: ContextDecisionStatus;
  confidence: number;
  subject_items_id: string | null;
  proposal: Record<string, unknown>;
  rationale: string;
  evidence: unknown[];
  policy?: {
    id?: string;
    state?: "shadow" | "active" | "suspended";
    threshold?: number | null;
  } | null;
  audit_id?: string | null;
  operation_id?: string | null;
  relation_ids?: string[];
  agent_id?: string;
  agent_version?: string;
  prompt_version?: string;
  model?: string;
  schema_version?: string;
  workflow_id?: string | null;
  run_id?: string | null;
  created_at_utc: string;
  resolved_at_utc?: string | null;
  updated_at_utc: string;
}

export interface ContextAudit {
  id: string;
  status: "pending" | "completed" | "overdue";
  policy_id: string;
  decision_ids: string[];
  items?: ContextAuditItem[];
  due_at_utc: string;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface ContextAuditItem {
  id: string | number;
  decisions_id: string;
  position: number;
  status: "pending" | "confirmed" | "rejected";
  decision_kind: ContextDecisionKind;
  confidence: number;
  rationale: string;
  evidence: unknown[];
  proposal: Record<string, unknown>;
  trigger_items_id?: string | null;
}

export interface ContextNotification {
  id: string;
  type: "policy_activated";
  policy_id: string;
  title?: string;
  body?: string;
  created_at_utc: string;
  read_at_utc?: string | null;
}

export interface ContextDecisionsState {
  server_time_utc: string;
  server_revision: number;
  decisions: ContextDecision[];
  audits: ContextAudit[];
  notifications: ContextNotification[];
  next_cursor?: string | null;
}

export type ContextDecisionsWireState = Omit<ContextDecisionsState, "decisions" | "audits" | "notifications"> & {
  decisions?: ContextDecision[];
  audits?: ContextAudit[];
  notifications?: ContextNotification[];
};

export function normalizeContextDecisionsState(state: ContextDecisionsWireState): ContextDecisionsState {
  return {
    ...state,
    decisions: state.decisions ?? [],
    audits: state.audits ?? [],
    notifications: state.notifications ?? [],
  };
}

export interface ContextDecisionCacheRow {
  id: string;
  cache_kind: "decision" | "audit" | "notification";
  status: string;
  payloadJson: ContextDecision | ContextAudit | ContextNotification;
  updated_at_utc: string;
}

export interface ContextResolutionRequest {
  resolution: ContextResolution;
  idempotency_key: string;
  edited_payload?: Record<string, unknown>;
}

export interface ContextResolutionResponse {
  decision?: ContextDecision;
  audit?: ContextAudit;
  operation_id?: string | null;
}

export interface GoalPlanResponse {
  status: "queued" | "running" | "completed" | "failed" | "needs_review";
  execution_id: number | string;
  workflow_id: string;
  decision?: ContextDecision;
}

export function emptyContextDecisionsState(now = new Date()): ContextDecisionsState {
  return {
    server_time_utc: now.toISOString(),
    server_revision: 0,
    decisions: [],
    audits: [],
    notifications: [],
  };
}
