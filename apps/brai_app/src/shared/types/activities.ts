export type ActivityStatus = "New" | "Done";
export type ActivityType = "action" | "operation";
export type ActivityEventType = "create" | "update_title" | "update_description" | "set_status" | "reorder" | "delete" | "restore";

export interface ActivityItem {
  id: string;
  activity_type_id?: ActivityType;
  title: string;
  description_md: string;
  author?: string;
  reason?: string;
  status: ActivityStatus;
  created_at_utc: string;
  updated_at_utc: string;
  completed_at_utc: string | null;
  sort_order: number | null;
  deleted_at_utc: string | null;
  restored_at_utc: string | null;
  pending?: boolean;
}

export interface ActivityEventPayload {
  title?: string;
  description_md?: string;
  status?: ActivityStatus;
  ordered_ids?: string[];
}

export interface PendingActivityEvent {
  eventId: string;
  deviceId: string;
  clientSequence: number;
  type: ActivityEventType;
  occurredAtUtc: string;
  // Persisted IndexedDB field from the old Actions naming; treat as an opaque activity id.
  actionId: string;
  payload: ActivityEventPayload;
  baseServerRevision: number;
  payloadVersion: 1;
  status: "pending" | "syncing" | "failed";
  attemptCount: number;
  lastError?: string | null;
  enqueuedAtUtc: string;
  lastSyncAttemptAtUtc?: string | null;
}

export interface ActivitiesState {
  server_time_utc: string;
  server_revision: number;
  actions: ActivityItem[];
  archived_actions: ActivityItem[];
}

export interface ActivitiesSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  server_time_utc: string;
  state: ActivitiesState;
}

export function emptyActivitiesState(now = new Date()): ActivitiesState {
  return {
    server_time_utc: now.toISOString(),
    server_revision: 0,
    actions: [],
    archived_actions: [],
  };
}

export type ActionStatus = ActivityStatus;
export type ActionEventType = ActivityEventType;
export type ActionItem = ActivityItem;
export type ActionEventPayload = ActivityEventPayload;
export type PendingActionEvent = PendingActivityEvent;
export type ActionsState = ActivitiesState;
export type ActionsSyncResponse = ActivitiesSyncResponse;
export const emptyActionsState = emptyActivitiesState;
