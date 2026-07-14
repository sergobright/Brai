export type RelationDirectionality = "directed" | "symmetric";
export type RelationLifecycleStatus = "active" | "ended";
export type RelationTypeStatus = "active" | "candidate" | "retired";
export type RelationEventType = "create" | "end" | "reorder";
export type RelationActorType = "user" | "agent" | "system";

export interface RelationEndpointRule {
  id: number;
  relation_types_id: string;
  source_role_key: string;
  source_type_key: string;
  target_role_key: string;
  target_type_key: string;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface RelationTypeItem {
  id: string;
  user_id: string | null;
  key: string;
  title: string;
  description: string;
  directionality: RelationDirectionality;
  source_label: string;
  target_label: string;
  is_ordered: 0 | 1;
  status: RelationTypeStatus;
  is_system: 0 | 1;
  created_by_actor_type: RelationActorType;
  created_by_actor_id: string | null;
  endpoint_rules: RelationEndpointRule[];
  created_at_utc: string;
  updated_at_utc: string;
  retired_at_utc: string | null;
}

export interface RelationItem {
  id: string;
  user_id: string;
  relation_types_id: string;
  source_items_id: string;
  target_items_id: string;
  status: RelationLifecycleStatus;
  position: number | null;
  active_from_utc: string;
  active_to_utc: string | null;
  operation_id: string;
  ended_operation_id: string | null;
  origin_decision_id: string | null;
  created_by_actor_type: RelationActorType;
  created_by_actor_id: string | null;
  ended_by_actor_type: RelationActorType | null;
  ended_by_actor_id: string | null;
  end_reason: string | null;
  metadata_json: Record<string, unknown>;
  created_at_utc: string;
  updated_at_utc: string;
  pending?: boolean;
}

export interface RelationEventPayload {
  relation_type_id?: string;
  source_items_id?: string;
  target_items_id?: string;
  position?: number | null;
  dependency_event_ids?: string[];
  reason?: string;
  ordered_relation_ids?: string[];
}

export interface PendingRelationEvent {
  eventId: string;
  deviceId: string;
  clientSequence: number;
  type: RelationEventType;
  occurredAtUtc: string;
  relationId: string;
  payload: RelationEventPayload;
  baseServerRevision: number;
  payloadVersion: 1;
  status: "pending" | "syncing" | "failed" | "blocked";
  attemptCount: number;
  lastError?: string | null;
  enqueuedAtUtc: string;
  lastSyncAttemptAtUtc?: string | null;
}

export interface RelationSyncIssue {
  event_id: string;
  reason: string;
  occurred_at_utc: string;
  relation_id?: string;
  change_type?: RelationEventType;
  payload?: RelationEventPayload;
}

export interface RelationsState {
  server_time_utc: string;
  server_revision: number;
  relation_types: RelationTypeItem[];
  relations: RelationItem[];
  ended_relations: RelationItem[];
  next_cursor?: string | null;
}

export interface RelationsSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  deferred_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  server_time_utc: string;
  state: RelationsState;
}

export type RelationsWireState = Omit<RelationsState, "relation_types" | "relations" | "ended_relations"> & {
  relation_types?: RelationTypeItem[];
  relations?: RelationItem[];
  ended_relations?: RelationItem[];
};

export type RelationsWireSyncResponse = Omit<RelationsSyncResponse, "state" | "deferred_events"> & {
  deferred_events?: RelationsSyncResponse["deferred_events"];
  state: RelationsWireState;
};

export function normalizeRelationsState(state: RelationsWireState): RelationsState {
  return {
    ...state,
    relation_types: state.relation_types ?? [],
    relations: state.relations ?? [],
    ended_relations: state.ended_relations ?? [],
  };
}

export function emptyRelationsState(now = new Date()): RelationsState {
  return {
    server_time_utc: now.toISOString(),
    server_revision: 0,
    relation_types: [],
    relations: [],
    ended_relations: [],
    next_cursor: null,
  };
}
