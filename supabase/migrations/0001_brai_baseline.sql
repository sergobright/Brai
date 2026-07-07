-- Brai Postgres baseline for Supabase branches.
-- Runtime data lives only in Supabase/Postgres environments.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  applied_at_utc text NOT NULL,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE IF NOT EXISTS timer_devices (
  device_id text PRIMARY KEY,
  platform text NOT NULL,
  display_name text,
  created_at_utc text NOT NULL,
  last_seen_at_utc text NOT NULL,
  last_sync_at_utc text,
  last_server_clock_offset_ms integer
);

CREATE TABLE IF NOT EXISTS timer_events (
  event_id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES timer_devices(device_id),
  client_sequence integer NOT NULL,
  server_sequence integer NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('start', 'stop', 'edit_session', 'delete_session', 'start_activity_focus', 'switch_activity_focus', 'stop_activity_focus', 'edit_focus_interval', 'invalid')),
  occurred_at_utc text NOT NULL,
  received_at_utc text NOT NULL,
  local_timer_id text,
  base_server_revision integer,
  status text NOT NULL CHECK (status IN ('accepted', 'ignored')),
  ignore_reason text,
  payload_version integer NOT NULL,
  metadata_json text,
  user_id text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_timer_events_device_sequence ON timer_events (device_id, client_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timer_events_server_sequence ON timer_events (server_sequence);
CREATE INDEX IF NOT EXISTS idx_timer_events_occurred ON timer_events (occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_timer_events_device_occurred ON timer_events (device_id, occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_timer_events_received ON timer_events (received_at_utc);
CREATE INDEX IF NOT EXISTS idx_timer_events_user_sequence ON timer_events (user_id, server_sequence);

CREATE TABLE IF NOT EXISTS activity_types (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  created_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id text PRIMARY KEY,
  activity_type_id text NOT NULL DEFAULT 'action' REFERENCES activity_types(id),
  title text NOT NULL,
  description_md text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('New', 'Done')),
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  completed_at_utc text,
  sort_order integer,
  deleted_at_utc text,
  restored_at_utc text,
  last_event_id text,
  user_id text
);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES timer_devices(device_id),
  client_sequence integer NOT NULL,
  server_sequence integer NOT NULL UNIQUE,
  activity_id text,
  change_type text NOT NULL CHECK (change_type IN ('create', 'update_title', 'update_description', 'set_status', 'reorder', 'delete', 'restore', 'invalid')),
  occurred_at_utc text NOT NULL,
  received_at_utc text NOT NULL,
  payload_json text,
  status text NOT NULL CHECK (status IN ('accepted', 'ignored')),
  ignore_reason text,
  payload_version integer NOT NULL,
  user_id text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_device_sequence ON activity_events (device_id, client_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_server_sequence ON activity_events (server_sequence);
CREATE INDEX IF NOT EXISTS idx_activity_events_occurred ON activity_events (occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_activity_events_device_occurred ON activity_events (device_id, occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_activity_events_activity_occurred ON activity_events (activity_id, occurred_at_utc, server_sequence);
CREATE INDEX IF NOT EXISTS idx_activity_events_change_type_occurred ON activity_events (change_type, occurred_at_utc, server_sequence);
CREATE INDEX IF NOT EXISTS idx_activity_events_user_sequence ON activity_events (user_id, server_sequence);
CREATE INDEX IF NOT EXISTS idx_activities_status_created ON activities (status, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_activities_updated ON activities (updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_activities_type_status_updated ON activities (activity_type_id, status, updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_activities_user_status_created ON activities (user_id, status, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_activities_new_sort_order ON activities (status, sort_order) WHERE deleted_at_utc IS NULL AND sort_order IS NOT NULL;

CREATE TABLE IF NOT EXISTS focus_sessions (
  id text PRIMARY KEY,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  deleted_at_utc text,
  deleted_event_id text,
  start_origin text NOT NULL DEFAULT 'focus' CHECK (start_origin IN ('focus', 'activity')),
  started_by_activity_id text,
  user_id text
);

CREATE TABLE IF NOT EXISTS focus_session_intervals (
  id text PRIMARY KEY,
  focus_session_id text NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  activity_id text,
  started_at_utc text NOT NULL,
  ended_at_utc text,
  duration_seconds integer,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  created_event_id text,
  ended_event_id text,
  created_by_device_id text REFERENCES timer_devices(device_id),
  user_id text
);

CREATE TABLE IF NOT EXISTS focus_session_sources (
  session_id text NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  device_id text NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (session_id, event_id, role)
);

CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_session_started ON focus_session_intervals (focus_session_id, started_at_utc);
CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_activity_started ON focus_session_intervals (activity_id, started_at_utc);
CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_started ON focus_session_intervals (started_at_utc);
CREATE INDEX IF NOT EXISTS idx_focus_session_intervals_ended ON focus_session_intervals (ended_at_utc);
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_session_intervals_one_active ON focus_session_intervals (focus_session_id) WHERE ended_at_utc IS NULL;
CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_updated ON focus_sessions (user_id, updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_focus_intervals_user_started ON focus_session_intervals (user_id, started_at_utc);

CREATE TABLE IF NOT EXISTS inbox_record_types (
  id integer PRIMARY KEY,
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  created_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox_classes (
  key text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active', 'candidate', 'archived')),
  created_by_agent_id text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL
);

ALTER TABLE inbox_classes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS inbox (
  id text PRIMARY KEY,
  title text NOT NULL,
  description_text text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  source_key text NOT NULL DEFAULT '',
  response_required integer NOT NULL DEFAULT 0 CHECK (response_required IN (0, 1)),
  related_inbox_id text,
  record_type_id integer NOT NULL DEFAULT 4,
  item_date text,
  author text NOT NULL DEFAULT '',
  preliminary_section text NOT NULL DEFAULT '',
  urgency text NOT NULL DEFAULT '',
  attachment_links_json text NOT NULL DEFAULT '[]',
  explanation_text text NOT NULL DEFAULT '',
  normalization_text text NOT NULL DEFAULT '',
  is_normalized integer NOT NULL DEFAULT 0 CHECK (is_normalized IN (0, 1)),
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  deleted_at_utc text,
  last_event_id text,
  user_id text
);

CREATE TABLE IF NOT EXISTS inbox_events (
  event_id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES timer_devices(device_id),
  client_sequence integer NOT NULL,
  server_sequence integer NOT NULL UNIQUE,
  inbox_id text,
  type text NOT NULL CHECK (type IN ('create', 'update_title', 'update_description', 'normalize', 'delete', 'invalid')),
  occurred_at_utc text NOT NULL,
  received_at_utc text NOT NULL,
  payload_json text,
  status text NOT NULL CHECK (status IN ('accepted', 'ignored')),
  ignore_reason text,
  payload_version integer NOT NULL,
  user_id text
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_device_sequence ON inbox_events (device_id, client_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_events_server_sequence ON inbox_events (server_sequence);
CREATE INDEX IF NOT EXISTS idx_inbox_events_occurred ON inbox_events (occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_inbox_events_inbox_occurred ON inbox_events (inbox_id, occurred_at_utc, server_sequence);
CREATE INDEX IF NOT EXISTS idx_inbox_events_user_sequence ON inbox_events (user_id, server_sequence);
CREATE INDEX IF NOT EXISTS idx_inbox_classes_status ON inbox_classes (status, title);
CREATE INDEX IF NOT EXISTS idx_inbox_source_key_created ON inbox (source_key, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_inbox_record_type_created ON inbox (record_type_id, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_inbox_related ON inbox (related_inbox_id);
CREATE INDEX IF NOT EXISTS idx_inbox_item_date ON inbox (item_date);
CREATE INDEX IF NOT EXISTS idx_inbox_normalized_updated ON inbox (is_normalized, updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_inbox_user_created ON inbox (user_id, created_at_utc);

CREATE TABLE IF NOT EXISTS items (
  id text PRIMARY KEY,
  user_id text,
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  author text NOT NULL DEFAULT '',
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  deleted_at_utc text
);

CREATE TABLE IF NOT EXISTS item_role_types (
  id integer PRIMARY KEY,
  title_system text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  payload_table text NOT NULL DEFAULT '',
  is_system integer NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  created_at_utc text NOT NULL,
  deleted_at_utc text
);

CREATE TABLE IF NOT EXISTS item_roles (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  items_id text NOT NULL REFERENCES items(id),
  item_role_types_id integer NOT NULL REFERENCES item_role_types(id),
  active_from_utc text NOT NULL,
  active_to_utc text,
  status text NOT NULL CHECK (status IN ('active', 'ended', 'deleted')),
  metadata_json text NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_items_user_deleted_updated ON items (user_id, deleted_at_utc, updated_at_utc);
CREATE INDEX IF NOT EXISTS idx_item_roles_items_status ON item_roles (items_id, status);
CREATE INDEX IF NOT EXISTS idx_item_roles_type_status ON item_roles (item_role_types_id, status);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  event_domain text NOT NULL CHECK (event_domain IN ('timer', 'activity', 'inbox', 'system')),
  event_id text NOT NULL,
  event_type text NOT NULL,
  event_action text NOT NULL,
  title text NOT NULL,
  items_id text REFERENCES items(id),
  subject_type text NOT NULL,
  subject_id text,
  actor_type text NOT NULL DEFAULT 'user',
  actor_id text,
  device_id text REFERENCES timer_devices(device_id),
  client_sequence integer,
  server_sequence integer NOT NULL UNIQUE,
  domain_sequence integer NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'ignored')),
  ignore_reason text,
  occurred_at_utc text NOT NULL,
  received_at_utc text NOT NULL,
  base_server_revision integer,
  payload_version integer NOT NULL DEFAULT 1,
  payload_json text NOT NULL DEFAULT '{}',
  trace_id text,
  created_at_utc text NOT NULL,
  user_id text,
  UNIQUE (event_domain, event_id),
  UNIQUE (event_domain, device_id, client_sequence),
  UNIQUE (event_domain, domain_sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_domain_user_sequence ON events (event_domain, user_id, domain_sequence);
CREATE INDEX IF NOT EXISTS idx_events_items_occurred ON events (items_id, occurred_at_utc, server_sequence);
CREATE INDEX IF NOT EXISTS idx_events_trace ON events (trace_id);
CREATE INDEX IF NOT EXISTS idx_events_status_domain ON events (status, event_domain, occurred_at_utc);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  version text NOT NULL DEFAULT '1',
  target text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  trigger_description text NOT NULL,
  conditions_description text NOT NULL,
  input_description text NOT NULL,
  output_description text NOT NULL,
  interactions_description text NOT NULL,
  side_effects_description text NOT NULL,
  llm_provider text NOT NULL DEFAULT '',
  llm_model text NOT NULL DEFAULT '',
  llm_prompt_template text NOT NULL DEFAULT '',
  llm_timeout_ms integer,
  fallback_description text NOT NULL DEFAULT '',
  source_module text NOT NULL,
  updated_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_schedules (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  status text NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
  next_run_at_utc text,
  interval_seconds integer CHECK (interval_seconds IS NULL OR interval_seconds > 0),
  locked_until_utc text,
  last_started_at_utc text,
  last_finished_at_utc text,
  last_error text NOT NULL DEFAULT '',
  updated_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_logs (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agents(id),
  agent_version text NOT NULL,
  dt text NOT NULL,
  status text NOT NULL CHECK (status IN ('done', 'failed')),
  json_data text NOT NULL,
  ai_title text NOT NULL,
  flow_id text,
  flow_command text,
  trace_id text
);

CREATE INDEX IF NOT EXISTS idx_agents_target_status ON agents (target, status);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent ON agent_schedules (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules (status, next_run_at_utc, locked_until_utc);
CREATE INDEX IF NOT EXISTS idx_ai_logs_agent_dt ON ai_logs (agent_id, dt);
CREATE INDEX IF NOT EXISTS idx_ai_logs_trace_dt ON ai_logs (trace_id, dt);

CREATE TABLE IF NOT EXISTS logs (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  trace_id text,
  span_id text,
  parent_span_id text,
  dt text NOT NULL,
  observed_at_utc text NOT NULL,
  severity_text text NOT NULL,
  severity_number integer,
  service text NOT NULL,
  source text NOT NULL,
  operation text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'done', 'failed', 'skipped')),
  duration_ms integer,
  user_id text,
  items_id text REFERENCES items(id),
  event_domain text,
  event_id text,
  device_id text,
  client_sequence integer,
  reason text,
  message text NOT NULL DEFAULT '',
  json_data text NOT NULL DEFAULT '{}',
  expires_at_utc text NOT NULL,
  created_at_utc text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_dt ON logs (dt);
CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs (trace_id, dt);
CREATE INDEX IF NOT EXISTS idx_logs_source_status_dt ON logs (source, status, dt);
CREATE INDEX IF NOT EXISTS idx_logs_event_receipt ON logs (event_domain, event_id);
CREATE INDEX IF NOT EXISTS idx_logs_device_sequence ON logs (event_domain, device_id, client_sequence);
CREATE INDEX IF NOT EXISTS idx_logs_expires ON logs (expires_at_utc);

ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS brai_cmd_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS brai_cmd_access_tokens (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  device_id_hash text,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  source text NOT NULL CHECK (source IN ('self_service', 'admin')),
  created_at_utc text NOT NULL,
  activated_at_utc text,
  last_used_at_utc text,
  client_version text NOT NULL DEFAULT '',
  app_package text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS brai_cmd_usage_events (
  id text PRIMARY KEY,
  access_token_id text NOT NULL REFERENCES brai_cmd_access_tokens(id) ON DELETE CASCADE,
  created_at_utc text NOT NULL,
  success integer NOT NULL CHECK (success IN (0, 1)),
  error_code text NOT NULL DEFAULT '',
  audio_bytes integer NOT NULL DEFAULT 0,
  audio_duration_ms integer NOT NULL DEFAULT 0,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  fallback_used integer NOT NULL DEFAULT 0 CHECK (fallback_used IN (0, 1)),
  transcription_ms integer NOT NULL DEFAULT 0,
  post_processing_ms integer NOT NULL DEFAULT 0,
  total_ms integer NOT NULL DEFAULT 0,
  transcript_chars integer NOT NULL DEFAULT 0,
  client_version text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_brai_cmd_access_tokens_status_created ON brai_cmd_access_tokens (status, created_at_utc);
CREATE INDEX IF NOT EXISTS idx_brai_cmd_usage_events_created ON brai_cmd_usage_events (created_at_utc);
CREATE INDEX IF NOT EXISTS idx_brai_cmd_usage_events_token_created ON brai_cmd_usage_events (access_token_id, created_at_utc);

CREATE TABLE IF NOT EXISTS version_types (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  created_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS build_versions (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  version_type_id text NOT NULL REFERENCES version_types(id),
  version integer NOT NULL CHECK (version > 0),
  included_in_version_id integer REFERENCES build_versions(id) ON DELETE SET NULL,
  short_changes text NOT NULL,
  detailed_changes text NOT NULL,
  reason text NOT NULL,
  released_at_utc text NOT NULL,
  created_at_utc text NOT NULL,
  UNIQUE (version_type_id, version)
);

CREATE TABLE IF NOT EXISTS build_version_refs (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  version_type_id text NOT NULL,
  version integer NOT NULL,
  source_branch text,
  source_commit text,
  target_branch text NOT NULL,
  target_commit text NOT NULL,
  created_at_utc text NOT NULL,
  FOREIGN KEY (version_type_id, version) REFERENCES build_versions(version_type_id, version) ON DELETE CASCADE,
  UNIQUE (version_type_id, target_branch, target_commit)
);

CREATE TABLE IF NOT EXISTS deployment_records (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  environment text NOT NULL,
  slot text,
  branch text NOT NULL,
  commit_sha text NOT NULL,
  domain text NOT NULL,
  web_ota_version text,
  apk_version text,
  short_changes text NOT NULL,
  detailed_changes text NOT NULL,
  reason text NOT NULL,
  deployed_at_utc text NOT NULL,
  created_at_utc text NOT NULL
);

CREATE TABLE IF NOT EXISTS build_version_counters (
  version_type_id text PRIMARY KEY REFERENCES version_types(id),
  last_version integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sequence_counters (
  name text PRIMARY KEY,
  last_value integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_build_versions_type_released ON build_versions (version_type_id, released_at_utc);
CREATE INDEX IF NOT EXISTS idx_build_version_refs_version ON build_version_refs (version_type_id, version);
CREATE INDEX IF NOT EXISTS idx_deployment_records_branch_deployed ON deployment_records (branch, deployed_at_utc);
CREATE INDEX IF NOT EXISTS idx_deployment_records_env_deployed ON deployment_records (environment, deployed_at_utc);

CREATE TABLE IF NOT EXISTS table_descriptions (
  table_name text PRIMARY KEY,
  title text NOT NULL,
  short_description text NOT NULL,
  long_description text NOT NULL,
  updated_at_utc text NOT NULL
);

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (1, now()::text, 'Postgres baseline schema')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (47, now()::text, 'add Brai Cmd dictation runtime')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (48, now()::text, 'add Inbox AI processing')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (49, now()::text, 'enable RLS for Inbox classes')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (50, now()::text, 'add global events and technical logs')
ON CONFLICT (version) DO NOTHING;

INSERT INTO app_settings (key, value, updated_at_utc) VALUES
  ('goal_start_date', '2026-06-14', now()::text),
  ('goal_days', '15', now()::text),
  ('daily_goal_seconds', '7200', now()::text),
  ('goal_timezone', 'Europe/Moscow', now()::text)
ON CONFLICT (key) DO NOTHING;

INSERT INTO activity_types (id, title, description, created_at_utc) VALUES
  ('action', 'Действие', 'Пользовательская activity, созданная человеком в интерфейсе или синхронизированная с клиента.', now()::text),
  ('operation', 'Операция агента', 'Внутренняя задача агента с автором и причиной выполнения.', now()::text)
ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description;

INSERT INTO inbox_record_types (id, key, title, description, created_at_utc) VALUES
  (1, 'api_human_inbox', 'Входящее от человека по API', 'Внешний API запрос, инициированный человеком.', now()::text),
  (2, 'api_agent_inbox', 'Входящее от агента по API', 'Внешний API запрос, инициированный агентом.', now()::text),
  (3, 'internal_agent_inbox', 'Внутреннее входящее от агента', 'Внутренний агент Brai создал входящую запись.', now()::text),
  (4, 'interface_human_created', 'Человек добавил из интерфейса', 'Пользователь создал входящую запись в интерфейсе Brai.', now()::text)
ON CONFLICT (id) DO UPDATE SET key = excluded.key, title = excluded.title, description = excluded.description;

INSERT INTO inbox_classes (key, title, description, status, created_by_agent_id, created_at_utc, updated_at_utc) VALUES
  ('idea', 'Идея', 'Мысль или концепция, которую стоит развить.', 'active', NULL, now()::text, now()::text),
  ('wish', 'Желание', 'Пользователь выразил желание, намерение или будущую покупку.', 'active', NULL, now()::text, now()::text),
  ('library', 'Сохранить в библиотеку', 'Материал, ссылку, изображение или фрагмент нужно сохранить для дальнейшего чтения.', 'active', NULL, now()::text, now()::text),
  ('task', 'Задача', 'Нужно выполнить действие, проверить, подготовить или кому-то ответить.', 'active', NULL, now()::text, now()::text),
  ('note', 'Заметка', 'Наблюдение, факт или короткая запись без явного действия.', 'active', NULL, now()::text, now()::text),
  ('other', 'Другое', 'Входящее не подходит под остальные классы.', 'active', NULL, now()::text, now()::text)
ON CONFLICT (key) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO agents (
  id,
  version,
  target,
  kind,
  status,
  title,
  summary,
  trigger_description,
  conditions_description,
  input_description,
  output_description,
  interactions_description,
  side_effects_description,
  llm_provider,
  llm_model,
  llm_prompt_template,
  llm_timeout_ms,
  fallback_description,
  source_module,
  updated_at_utc
) VALUES (
  'brai-cmd.dictate.transcription',
  '1',
  'brai-cmd',
  'runtime',
  'active',
  'Brai Cmd диктовка',
  'Принимает аудио Brai Cmd, сохраняет usage metrics и пишет ai_logs без хранения исходного аудио.',
  'Срабатывает при POST /v1/dictate с валидным Brai Cmd access token.',
  'Пропускается при невалидном токене, неподдержанном media type или ошибке валидации.',
  'Multipart audio, device id, client metadata и optional post-processing/context fields.',
  'Текстовая расшифровка или ошибка с usage/ai_logs audit trail.',
  'Использует runtime deps braiCmd для transcription, post-processing и context reply.',
  'Пишет brai_cmd_usage_events и ai_logs; не сохраняет аудио или raw transcript в runtime таблицах.',
  '',
  '',
  '',
  NULL,
  'Возвращает structured API error и пишет failed ai_log/usage row при runtime failure.',
  'services/brai_api/src/brai-cmd-routes.js',
  now()::text
)
ON CONFLICT (id) DO UPDATE SET
  version = excluded.version,
  target = excluded.target,
  kind = excluded.kind,
  status = excluded.status,
  title = excluded.title,
  summary = excluded.summary,
  trigger_description = excluded.trigger_description,
  conditions_description = excluded.conditions_description,
  input_description = excluded.input_description,
  output_description = excluded.output_description,
  interactions_description = excluded.interactions_description,
  side_effects_description = excluded.side_effects_description,
  llm_provider = excluded.llm_provider,
  llm_model = excluded.llm_model,
  llm_prompt_template = excluded.llm_prompt_template,
  llm_timeout_ms = excluded.llm_timeout_ms,
  fallback_description = excluded.fallback_description,
  source_module = excluded.source_module,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO agents (
  id,
  version,
  target,
  kind,
  status,
  title,
  summary,
  trigger_description,
  conditions_description,
  input_description,
  output_description,
  interactions_description,
  side_effects_description,
  llm_provider,
  llm_model,
  llm_prompt_template,
  llm_timeout_ms,
  fallback_description,
  source_module,
  updated_at_utc
) VALUES (
  'inbox.image_describer',
  '1',
  'inbox',
  'runtime',
  'active',
  'Inbox image describer',
  'Описывает картинки, приложенные к Inbox-записи, и сохраняет описание в normalization_text.',
  'Срабатывает после создания Inbox-записи, если у нее есть image attachments.',
  'Пропускается, если картинок нет, запись удалена или уже обработана.',
  'Inbox id и локальные пути к сохраненным image attachments.',
  'Фактическое русскоязычное описание изображения для последующей нормализации.',
  'Вызывается из services/brai_api/src/inbox.js через Codex CLI или тестовый runtime hook.',
  'Пишет normalize event и ai_logs; не меняет explanation_text.',
  '',
  '',
  'Опиши изображение для Inbox на русском языке.
Нужно детальное, фактическое описание: что видно, какой интерфейс/экран, важные тексты, объекты, состояния, числа и возможный пользовательский контекст.
Не выдумывай невидимые детали. Верни только описание.',
  60000,
  'Если описание картинки не удалось получить, обработка Inbox-записи останавливается и пишет failed ai_log для этого шага.',
  'services/brai_api/src/inbox.js',
  now()::text
),
(
  'inbox.normalizer',
  '1',
  'inbox',
  'runtime',
  'active',
  'Inbox normalizer',
  'Сопоставляет транскрипт, текстовый контекст и описание картинки, затем заполняет title, description_text, preliminary_section и normalization_text.',
  'Срабатывает после создания Inbox-записи и после optional описания картинок.',
  'Пропускается, если запись удалена или уже обработана.',
  'Inbox explanation_text, description_text, normalization_text image block и список inbox_classes.',
  'Короткий заголовок, понятное описание намерения пользователя, class key и технический разбор.',
  'Вызывается из services/brai_api/src/inbox.js через Codex CLI или тестовый runtime hook.',
  'Пишет normalize event, ai_logs и при необходимости candidate row в inbox_classes; не меняет explanation_text.',
  '',
  '',
  'Разбери Inbox-запись на русском языке.
Нужно сопоставить голосовой транскрипт, текстовый контекст и описание картинки.
Верни только JSON без Markdown с полями:
{"title":"короткий заголовок до 80 символов","description":"понятное описание чего хотел пользователь","class_key":"ключ класса","class_title":"русское название класса если ключ новый","class_description":"краткое описание класса если ключ новый","normalization":"технический разбор"}

Доступные классы:
{{classes}}

Транскрипт:
{{text}}

Текстовый контекст:
{{description}}

Описание картинки:
{{image_description}}',
  60000,
  'При ошибке пишет failed ai_log и оставляет Inbox-запись необработанной; допускается только retry другой моделью через runtime config.',
  'services/brai_api/src/inbox.js',
  now()::text
)
ON CONFLICT (id) DO UPDATE SET
  version = excluded.version,
  target = excluded.target,
  kind = excluded.kind,
  status = excluded.status,
  title = excluded.title,
  summary = excluded.summary,
  trigger_description = excluded.trigger_description,
  conditions_description = excluded.conditions_description,
  input_description = excluded.input_description,
  output_description = excluded.output_description,
  interactions_description = excluded.interactions_description,
  side_effects_description = excluded.side_effects_description,
  llm_provider = excluded.llm_provider,
  llm_model = excluded.llm_model,
  llm_prompt_template = excluded.llm_prompt_template,
  llm_timeout_ms = excluded.llm_timeout_ms,
  fallback_description = excluded.fallback_description,
  source_module = excluded.source_module,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO item_role_types (id, title_system, title, description, payload_table, is_system, created_at_utc, deleted_at_utc) VALUES
  (1, 'activity', 'Activity', 'Роль activity для сущностей, чьи поля роли живут в activities.', 'activities', 1, now()::text, NULL),
  (2, 'inbox', 'Inbox', 'Роль inbox для сущностей, чьи поля роли живут в inbox.', 'inbox', 1, now()::text, NULL),
  (3, 'focus_session', 'Focus session', 'Роль focus_session для сущностей, чьи поля роли живут в focus_sessions.', 'focus_sessions', 1, now()::text, NULL)
ON CONFLICT (id) DO UPDATE SET
  title_system = excluded.title_system,
  title = excluded.title,
  description = excluded.description,
  payload_table = excluded.payload_table,
  is_system = 1,
  deleted_at_utc = NULL;

INSERT INTO version_types (id, title, description, created_at_utc) VALUES
  ('apk', 'APK', 'Публичная Android APK-линия. Увеличивается только при осознанном выпуске нового APK.', now()::text),
  ('build', 'Сборка', 'Принятая web/OTA сборка Brai. Обязательная запись production promotion.', now()::text)
ON CONFLICT (id) DO UPDATE SET title = excluded.title, description = excluded.description;

INSERT INTO build_version_counters (version_type_id, last_version) VALUES
  ('apk', 0),
  ('build', 0)
ON CONFLICT (version_type_id) DO NOTHING;

INSERT INTO build_versions (
  version_type_id,
  version,
  included_in_version_id,
  short_changes,
  detailed_changes,
  reason,
  released_at_utc,
  created_at_utc
) VALUES
  ('build', 1, NULL, 'Первичная публичная web/OTA-сборка.', 'Начальная запись web/OTA-сборки Brai.', 'Начальное состояние runtime базы Brai.', now()::text, now()::text),
  ('apk', 1, NULL, 'Первичная публичная APK-сборка.', 'Начальная запись APK-линии Brai.', 'Начальное состояние runtime базы Brai.', now()::text, now()::text),
  ('apk', 2, NULL, 'Актуальная публичная APK-сборка v2.', 'APK v2 использует Android versionName 2 и versionCode 2.', 'Ошибочные APK выше v2 удаляются, актуальная APK-линейка Brai продолжается с v2.', now()::text, now()::text)
ON CONFLICT (version_type_id, version) DO NOTHING;

INSERT INTO build_version_counters (version_type_id, last_version) VALUES
  ('apk', 2),
  ('build', 1)
ON CONFLICT (version_type_id) DO UPDATE
SET last_version = GREATEST(build_version_counters.last_version, excluded.last_version);

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  (
    'events',
    'Global events',
    'Единый canonical event log для бизнес-событий Brai.',
    'Заменяет runtime-чтение timer_events, activity_events и inbox_events: accepted rows участвуют в replay/read models, ignored rows сохраняют sync idempotency и revision history.',
    now()::text
  ),
  (
    'logs',
    'Technical logs',
    'Структурированные технические логи runtime-операций.',
    'Хранит request/sync/scheduler/agent-invocation/deploy summaries без секретов и без AI outputs; строки имеют expires_at_utc для retention.',
    now()::text
  ),
  (
    'ai_logs',
    'AI logs',
    'Отдельный журнал фактических AI-срабатываний.',
    'Хранит agent inputs/outputs в json_data и trace_id для связи с logs; technical logs не дублируют AI outputs.',
    now()::text
  ),
  (
    'brai_cmd_settings',
    'Brai Cmd настройки',
    'Настройки self-service доступа Brai Cmd.',
    'Хранит server-side feature settings для Brai Cmd, включая включение регистрации access tokens.',
    now()::text
  ),
  (
    'brai_cmd_access_tokens',
    'Brai Cmd access tokens',
    'Хэши access tokens и device binding для Android Brai Cmd.',
    'Хранит только хэши секретов и metadata клиента; исходные токены и device ids не сохраняются в открытом виде.',
    now()::text
  ),
  (
    'brai_cmd_usage_events',
    'Brai Cmd usage events',
    'Метрики выполнения Brai Cmd диктовки.',
    'Фиксирует counts, timings, provider/model metadata и ошибки без хранения исходного аудио или текста расшифровки.',
    now()::text
  ),
  (
    'inbox_classes',
    'Inbox classes',
    'Справочник предварительных классов Inbox-записей.',
    'Используется Inbox normalizer для preliminary_section. Если подходящего класса нет, агент добавляет candidate row для последующего ручного утверждения.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;
