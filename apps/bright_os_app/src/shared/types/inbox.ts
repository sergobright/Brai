export type InboxEventType = "create" | "update_title" | "update_description" | "delete";

export interface InboxItem {
  id: string;
  title: string;
  description_md: string;
  source: string;
  source_key: string;
  response_required: boolean;
  related_inbox_id: string | null;
  record_type_id: number;
  item_date: string | null;
  author: string;
  preliminary_section: string;
  urgency: string;
  attachment_links: string[];
  explanation_text: string;
  normalization_text: string;
  is_normalized: boolean;
  created_at_utc: string;
  updated_at_utc: string;
  deleted_at_utc: string | null;
  pending?: boolean;
}

export interface InboxEventPayload {
  title?: string;
  description_md?: string;
}

export interface PendingInboxEvent {
  eventId: string;
  deviceId: string;
  clientSequence: number;
  type: InboxEventType;
  occurredAtUtc: string;
  inboxId: string;
  payload: InboxEventPayload;
  baseServerRevision: number;
  payloadVersion: 1;
  status: "pending" | "syncing" | "failed";
  attemptCount: number;
  lastError?: string | null;
  enqueuedAtUtc: string;
  lastSyncAttemptAtUtc?: string | null;
}

export interface InboxState {
  server_time_utc: string;
  server_revision: number;
  inbox: InboxItem[];
}

export interface InboxSyncResponse {
  acknowledged_event_ids: string[];
  ignored_events: Array<{ event_id: string; reason: string }>;
  server_revision: number;
  server_time_utc: string;
  state: InboxState;
}

export function emptyInboxState(now = new Date()): InboxState {
  return {
    server_time_utc: now.toISOString(),
    server_revision: 0,
    inbox: [],
  };
}
