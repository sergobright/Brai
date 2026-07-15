export type BraiChatThread = {
  version: 1;
  id: string;
  title: string;
  model: string | null;
  reasoning_effort: string | null;
  archived_at_utc: string | null;
  active_turn_id: string | null;
  created_at_utc: string;
  updated_at_utc: string;
};

export type BraiChatAttachment = {
  version: 1;
  id: string;
  thread_id: string;
  message_id?: string | null;
  filename: string;
  media_type: "image/jpeg" | "image/png" | "image/webp";
  byte_size: number;
  checksum_sha256: string;
  created_at_utc: string;
};

export type BraiChatMessage = {
  version: 1;
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  status: "streaming" | "completed" | "interrupted" | "failed";
  model?: string | null;
  reasoning_effort?: string | null;
  sequence: number;
  attachments?: BraiChatAttachment[];
  created_at_utc: string;
};

export type BraiChatEvent = {
  version: 1;
  id: string;
  thread_id: string;
  message_id: string | null;
  turn_id: string | null;
  sequence: number;
  type: string;
  safe_payload: Record<string, unknown>;
  truncated: boolean;
  created_at_utc: string;
};

export type BraiChatSearchHit = {
  version: 1;
  id: string;
  thread_id: string;
  thread_title: string;
  snippet: string;
  source_message_id?: string | null;
  source_event_id?: string | null;
  archived_at_utc?: string | null;
};

export type BraiChatModel = {
  id: string;
  display_name: string;
  reasoning_efforts: string[];
  default_reasoning_effort?: string | null;
};
