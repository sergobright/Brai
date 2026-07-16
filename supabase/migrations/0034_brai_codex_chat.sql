CREATE TABLE IF NOT EXISTS brai_chat_threads (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  codex_thread_id text,
  title text NOT NULL DEFAULT 'Новый чат' CHECK (char_length(title) BETWEEN 1 AND 80),
  title_source text NOT NULL DEFAULT 'default' CHECK (title_source IN ('default', 'auto', 'manual')),
  model text,
  reasoning_effort text,
  active_turn_id text,
  active_codex_turn_id text,
  active_user_message_id text,
  active_turn_started_at_utc text,
  active_turn_deadline_at_utc text,
  active_turn_model text,
  active_turn_reasoning_effort text,
  archived_at_utc text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, codex_thread_id)
);

CREATE TABLE IF NOT EXISTS brai_chat_messages (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  brai_chat_threads_id text NOT NULL,
  turn_id text,
  idempotency_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'interrupted')),
  dispatch_status text CHECK (dispatch_status IS NULL OR dispatch_status IN ('pending', 'delivered', 'failed')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  model text,
  reasoning_effort text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, brai_chat_threads_id, id),
  UNIQUE (user_id, brai_chat_threads_id, idempotency_key),
  UNIQUE (user_id, brai_chat_threads_id, sequence),
  FOREIGN KEY (user_id, brai_chat_threads_id)
    REFERENCES brai_chat_threads(user_id, id) ON DELETE CASCADE
);

ALTER TABLE brai_chat_threads
  ADD COLUMN IF NOT EXISTS active_turn_started_at_utc text,
  ADD COLUMN IF NOT EXISTS active_turn_deadline_at_utc text,
  ADD COLUMN IF NOT EXISTS active_turn_model text,
  ADD COLUMN IF NOT EXISTS active_turn_reasoning_effort text;
ALTER TABLE brai_chat_messages
  ADD COLUMN IF NOT EXISTS dispatch_status text
    CHECK (dispatch_status IS NULL OR dispatch_status IN ('pending', 'delivered', 'failed'));

CREATE TABLE IF NOT EXISTS brai_chat_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  brai_chat_threads_id text NOT NULL,
  brai_chat_messages_id text,
  turn_id text,
  source_event_id text,
  idempotency_key text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  safe_payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  searchable_text text NOT NULL DEFAULT '',
  truncated boolean NOT NULL DEFAULT false,
  created_at_utc text NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, brai_chat_threads_id, idempotency_key),
  UNIQUE (user_id, brai_chat_threads_id, sequence),
  FOREIGN KEY (user_id, brai_chat_threads_id)
    REFERENCES brai_chat_threads(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, brai_chat_threads_id, brai_chat_messages_id)
    REFERENCES brai_chat_messages(user_id, brai_chat_threads_id, id)
    ON DELETE SET NULL (brai_chat_messages_id)
);

CREATE TABLE IF NOT EXISTS brai_chat_attachments (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  brai_chat_threads_id text NOT NULL,
  brai_chat_messages_id text,
  original_name text NOT NULL,
  relative_path text NOT NULL,
  verified_media_type text NOT NULL CHECK (verified_media_type IN ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 52428800),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  created_at_utc text NOT NULL,
  UNIQUE (user_id, id),
  UNIQUE (user_id, relative_path),
  FOREIGN KEY (user_id, brai_chat_threads_id)
    REFERENCES brai_chat_threads(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, brai_chat_threads_id, brai_chat_messages_id)
    REFERENCES brai_chat_messages(user_id, brai_chat_threads_id, id)
    ON DELETE SET NULL (brai_chat_messages_id)
);

CREATE INDEX IF NOT EXISTS idx_brai_chat_threads_owner_lifecycle
  ON brai_chat_threads (user_id, archived_at_utc, updated_at_utc DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_brai_chat_messages_thread_sequence
  ON brai_chat_messages (user_id, brai_chat_threads_id, sequence);
CREATE INDEX IF NOT EXISTS idx_brai_chat_events_thread_sequence
  ON brai_chat_events (user_id, brai_chat_threads_id, sequence);
CREATE INDEX IF NOT EXISTS idx_brai_chat_attachments_thread
  ON brai_chat_attachments (user_id, brai_chat_threads_id, created_at_utc, id);
CREATE INDEX IF NOT EXISTS idx_brai_chat_threads_search
  ON brai_chat_threads USING gin (to_tsvector('simple', coalesce(title, '')));
CREATE INDEX IF NOT EXISTS idx_brai_chat_messages_search
  ON brai_chat_messages USING gin (to_tsvector('simple', coalesce(content, '')));
CREATE INDEX IF NOT EXISTS idx_brai_chat_events_search
  ON brai_chat_events USING gin (to_tsvector('simple', coalesce(searchable_text, '')));

ALTER TABLE brai_chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE brai_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE brai_chat_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE brai_chat_attachments ENABLE ROW LEVEL SECURITY;

INSERT INTO table_descriptions (
  table_name, title, short_description, long_description, updated_at_utc
) VALUES
  (
    'brai_chat_threads',
    'Brai chat threads',
    'Владелец-изолированные треды чата Брай.',
    'Хранит public id, внутреннее Codex thread mapping, заголовок, model/reasoning, durable active-turn deadline/effective settings и обратимый archive state. Все API reads фильтруются по server-side user_id.',
    now()::text
  ),
  (
    'brai_chat_messages',
    'Brai chat messages',
    'Нормализованная user/assistant история чата.',
    'Монотонная thread-local sequence и owner-scoped idempotency key исключают дубли при retry/reconciliation; execution model metadata и durable steer dispatch status фиксируются на самом message.',
    now()::text
  ),
  (
    'brai_chat_events',
    'Brai chat events',
    'Безопасные нормализованные replay-события чата.',
    'Хранит monotonic sequence, safe bounded payload и только уже sanitized searchable_text. Raw reasoning, credentials и unbounded tool output в таблицу не попадают.',
    now()::text
  ),
  (
    'brai_chat_attachments',
    'Brai chat attachments',
    'Метаданные приватных изображений чата.',
    'Хранит verified JPEG/PNG/WebP media type, size, checksum и только relative opaque Vault path; host paths и client-supplied filesystem paths отсутствуют.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (67, now()::text, 'add user-owned Brai Codex chat history and search')
ON CONFLICT (version) DO NOTHING;
