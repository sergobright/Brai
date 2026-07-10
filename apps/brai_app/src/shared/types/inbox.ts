export type InboxEventType = "create" | "update_title" | "update_description" | "normalize" | "delete";

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
  item_roles_id?: number | null;
  initial_event_id?: string | null;
  workflow_execution_id?: number | null;
  workflow_status?: "queued" | "running" | "completed" | "failed" | "needs_review" | null;
  workflow_step?: string | null;
  workflow_attempt_count?: number;
  workflow_last_error?: string | null;
  temporal_workflow_id?: string | null;
  temporal_run_id?: string | null;
  ai_processing_status?: "running" | "failed" | "needs_review" | null;
  ai_processing_error?: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  deleted_at_utc: string | null;
  pending?: boolean;
}

export interface InboxWorkflowDetails {
  execution: {
    workflow_id: string;
    run_id: string | null;
    status: "queued" | "running" | "completed" | "failed" | "needs_review";
    current_step: string;
    attempt_count: number;
    last_error: string | null;
  };
  definition: {
    id: string;
    version: number;
    title: string;
    task_queue: string;
    steps: string[];
    input_schema_version: string;
    output_schema_version: string;
  } | null;
  attempts: Array<{
    id: number;
    agent_id: string;
    dt: string;
    status: "done" | "failed";
    ai_title: string;
    attempt_number: number | null;
    json_data: { metadata?: { error?: unknown } };
  }>;
}

export interface InboxEventPayload {
  title?: string;
  description_md?: string;
  preliminary_section?: string;
  normalization_text?: string;
  is_normalized?: boolean;
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
