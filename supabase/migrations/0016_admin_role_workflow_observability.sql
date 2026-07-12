-- brai:reapply-after-production-seed

ALTER TABLE workflow_definitions
  ADD COLUMN IF NOT EXISTS process_json jsonb;

UPDATE workflow_definitions
SET process_json = CASE version
  WHEN 1 THEN
    jsonb_build_object(
      'lanes', jsonb_build_array(
        jsonb_build_object('id', 'api', 'label', 'Brai API'),
        jsonb_build_object('id', 'worker', 'label', 'Workflow worker'),
        jsonb_build_object('id', 'codex', 'label', 'Local Codex CLI'),
        jsonb_build_object('id', 'domain', 'label', 'Domain apply')
      ),
      'steps', jsonb_build_array(
        jsonb_build_object('id', 'ingest', 'label', 'Raw Inbox принят', 'lane', 'api', 'kind', 'api', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox request'), 'writes', jsonb_build_array('inbox', 'events', 'workflow_executions'), 'transaction', 'ingest'),
        jsonb_build_object('id', 'raw_normalizer', 'label', 'Нормализация текста', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'inbox.normalizer', 'reads', jsonb_build_array('inbox', 'inbox_classes'), 'writes', jsonb_build_array('ai_logs'), 'transaction', null),
        jsonb_build_object('id', 'apply_normalized_raw', 'label', 'Apply результата', 'lane', 'domain', 'kind', 'mutation', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox', 'role_contracts'), 'writes', jsonb_build_array('items', 'item_roles', 'inbox', 'events', 'workflow_executions'), 'transaction', 'domain_apply')
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'ingest', 'to', 'raw_normalizer', 'kind', 'success', 'condition', 'raw role queued'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'raw_normalizer', 'kind', 'retry', 'condition', 'schema validation failed and attempts remain'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'apply_normalized_raw', 'kind', 'success', 'condition', 'schema-valid JSON'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'needs_review', 'kind', 'failure', 'condition', 'maximum attempts exhausted'),
        jsonb_build_object('from', 'apply_normalized_raw', 'to', 'completed', 'kind', 'success', 'condition', 'domain transaction committed')
      ),
      'terminals', jsonb_build_array(
        jsonb_build_object('id', 'completed', 'status', 'completed'),
        jsonb_build_object('id', 'needs_review', 'status', 'needs_review')
      )
    )
  WHEN 2 THEN
    jsonb_build_object(
      'lanes', jsonb_build_array(
        jsonb_build_object('id', 'api', 'label', 'Brai API'),
        jsonb_build_object('id', 'postgres', 'label', 'Postgres'),
        jsonb_build_object('id', 'temporal', 'label', 'Temporal'),
        jsonb_build_object('id', 'worker', 'label', 'Workflow worker'),
        jsonb_build_object('id', 'codex', 'label', 'Local Codex CLI'),
        jsonb_build_object('id', 'domain', 'label', 'Domain apply')
      ),
      'steps', jsonb_build_array(
        jsonb_build_object('id', 'ingest', 'label', 'HTTP request, auth, validation, idempotency', 'lane', 'api', 'kind', 'api', 'owner', 'brai-api', 'reads', jsonb_build_array('request', 'app_settings'), 'writes', jsonb_build_array('inbox', 'events', 'workflow_executions', 'logs'), 'transaction', 'ingest'),
        jsonb_build_object('id', 'dispatch', 'label', 'Immediate Temporal dispatch', 'lane', 'temporal', 'kind', 'orchestration', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions'), 'writes', jsonb_build_array('workflow_executions'), 'transaction', null),
        jsonb_build_object('id', 'prepare_raw', 'label', 'Prepare raw input', 'lane', 'worker', 'kind', 'activity', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox'), 'writes', jsonb_build_array('workflow_executions'), 'transaction', null),
        jsonb_build_object('id', 'image_describer', 'label', 'Optional image describer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'inbox.image_describer', 'reads', jsonb_build_array('inbox attachments'), 'writes', jsonb_build_array('ai_logs'), 'transaction', null),
        jsonb_build_object('id', 'raw_normalizer', 'label', 'Local Codex CLI normalizer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'inbox.normalizer', 'reads', jsonb_build_array('inbox', 'inbox_classes', 'workflow_definitions'), 'writes', jsonb_build_array('ai_logs'), 'transaction', null),
        jsonb_build_object('id', 'apply_normalized_raw', 'label', 'Apply normalized raw', 'lane', 'domain', 'kind', 'mutation', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox', 'role_contracts', 'events'), 'writes', jsonb_build_array('items', 'item_roles', 'inbox', 'events', 'workflow_executions'), 'transaction', 'domain_apply'),
        jsonb_build_object('id', 'terminal_reconcile', 'label', 'Temporal close and reconcile', 'lane', 'worker', 'kind', 'recovery', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions', 'inbox'), 'writes', jsonb_build_array('workflow_executions', 'logs'), 'transaction', null)
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'ingest', 'to', 'dispatch', 'kind', 'success', 'condition', 'queued execution created'),
        jsonb_build_object('from', 'dispatch', 'to', 'prepare_raw', 'kind', 'success', 'condition', 'Temporal accepted run'),
        jsonb_build_object('from', 'dispatch', 'to', 'dispatch', 'kind', 'recovery', 'condition', 'dispatch unavailable; queued recovery retries'),
        jsonb_build_object('from', 'prepare_raw', 'to', 'image_describer', 'kind', 'success', 'condition', 'image exists'),
        jsonb_build_object('from', 'prepare_raw', 'to', 'raw_normalizer', 'kind', 'skip', 'condition', 'no image'),
        jsonb_build_object('from', 'image_describer', 'to', 'raw_normalizer', 'kind', 'success', 'condition', 'image description saved'),
        jsonb_build_object('from', 'image_describer', 'to', 'failed', 'kind', 'failure', 'condition', 'image description failed'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'raw_normalizer', 'kind', 'retry', 'condition', 'strict schema invalid and attempts remain'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'apply_normalized_raw', 'kind', 'success', 'condition', 'strict schema valid'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'needs_review', 'kind', 'failure', 'condition', 'maximum attempts exhausted'),
        jsonb_build_object('from', 'apply_normalized_raw', 'to', 'terminal_reconcile', 'kind', 'success', 'condition', 'domain transaction committed'),
        jsonb_build_object('from', 'apply_normalized_raw', 'to', 'failed', 'kind', 'failure', 'condition', 'apply rollback'),
        jsonb_build_object('from', 'terminal_reconcile', 'to', 'completed', 'kind', 'success', 'condition', 'Temporal completed and domain result exists'),
        jsonb_build_object('from', 'terminal_reconcile', 'to', 'failed', 'kind', 'failure', 'condition', 'Temporal closed without domain result')
      ),
      'terminals', jsonb_build_array(
        jsonb_build_object('id', 'completed', 'status', 'completed'),
        jsonb_build_object('id', 'failed', 'status', 'failed'),
        jsonb_build_object('id', 'needs_review', 'status', 'needs_review')
      )
    )
  ELSE
    jsonb_build_object(
      'lanes', jsonb_build_array(
        jsonb_build_object('id', 'api', 'label', 'Brai API'),
        jsonb_build_object('id', 'postgres', 'label', 'Postgres'),
        jsonb_build_object('id', 'temporal', 'label', 'Temporal'),
        jsonb_build_object('id', 'worker', 'label', 'Workflow worker'),
        jsonb_build_object('id', 'codex', 'label', 'Local Codex CLI'),
        jsonb_build_object('id', 'domain', 'label', 'Domain apply')
      ),
      'steps', jsonb_build_array(
        jsonb_build_object('id', 'ingest', 'label', 'HTTP request, auth, target/payload validation, idempotency, attachment persistence', 'lane', 'api', 'kind', 'api', 'owner', 'brai-api', 'reads', jsonb_build_array('request', 'app_settings'), 'writes', jsonb_build_array('inbox', 'events', 'workflow_executions', 'logs'), 'transaction', 'ingest'),
        jsonb_build_object('id', 'dispatch', 'label', 'Immediate Temporal dispatch; queued recovery when unavailable', 'lane', 'temporal', 'kind', 'orchestration', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions'), 'writes', jsonb_build_array('workflow_executions', 'logs'), 'transaction', null),
        jsonb_build_object('id', 'prepare_raw', 'label', 'Prepare raw input and branch by image presence', 'lane', 'worker', 'kind', 'activity', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox', 'attachments'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps'), 'transaction', null),
        jsonb_build_object('id', 'image_describer', 'label', 'Optional image describer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'inbox.image_describer', 'reads', jsonb_build_array('inbox attachments'), 'writes', jsonb_build_array('ai_logs', 'workflow_execution_steps'), 'transaction', null),
        jsonb_build_object('id', 'raw_normalizer', 'label', 'Local Codex CLI strict-schema text normalizer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'inbox.normalizer', 'reads', jsonb_build_array('inbox.explanation_text', 'inbox.description_text', 'inbox_classes', 'workflow_definitions.output_schema_json'), 'writes', jsonb_build_array('ai_logs', 'workflow_execution_steps'), 'transaction', null),
        jsonb_build_object('id', 'apply_normalized_raw', 'label', 'Apply transaction: items, item_roles, Inbox link, event link, normalized event', 'lane', 'domain', 'kind', 'mutation', 'owner', 'brai-api', 'reads', jsonb_build_array('inbox', 'role_contracts', 'events'), 'writes', jsonb_build_array('items', 'item_roles', 'inbox', 'events', 'workflow_executions', 'logs'), 'transaction', 'domain_apply'),
        jsonb_build_object('id', 'terminal_reconcile', 'label', 'Temporal close and terminal reconciliation', 'lane', 'worker', 'kind', 'recovery', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions', 'inbox', 'workflow_execution_steps'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps', 'logs'), 'transaction', null)
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'ingest', 'to', 'dispatch', 'kind', 'success', 'condition', 'raw inbox, initial event and queued execution committed'),
        jsonb_build_object('from', 'ingest', 'to', 'failed', 'kind', 'failure', 'condition', 'invalid request, idempotency conflict or attachment failure'),
        jsonb_build_object('from', 'dispatch', 'to', 'prepare_raw', 'kind', 'success', 'condition', 'Temporal accepted run'),
        jsonb_build_object('from', 'dispatch', 'to', 'dispatch', 'kind', 'recovery', 'condition', 'Temporal dispatch unavailable or lost queued execution'),
        jsonb_build_object('from', 'prepare_raw', 'to', 'image_describer', 'kind', 'success', 'condition', 'image exists'),
        jsonb_build_object('from', 'prepare_raw', 'to', 'raw_normalizer', 'kind', 'skip', 'condition', 'no image'),
        jsonb_build_object('from', 'prepare_raw', 'to', 'needs_review', 'kind', 'failure', 'condition', 'raw input empty'),
        jsonb_build_object('from', 'image_describer', 'to', 'raw_normalizer', 'kind', 'success', 'condition', 'image description saved to ai_logs'),
        jsonb_build_object('from', 'image_describer', 'to', 'failed', 'kind', 'failure', 'condition', 'Codex CLI timeout, non-zero exit or model refusal'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'raw_normalizer', 'kind', 'retry', 'condition', 'invalid strict-schema result and attempts remain'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'apply_normalized_raw', 'kind', 'success', 'condition', 'strict schema valid'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'needs_review', 'kind', 'failure', 'condition', 'maximum attempts exhausted'),
        jsonb_build_object('from', 'raw_normalizer', 'to', 'failed', 'kind', 'failure', 'condition', 'Codex CLI timeout, non-zero exit or model refusal'),
        jsonb_build_object('from', 'apply_normalized_raw', 'to', 'terminal_reconcile', 'kind', 'success', 'condition', 'apply transaction committed'),
        jsonb_build_object('from', 'apply_normalized_raw', 'to', 'failed', 'kind', 'failure', 'condition', 'apply rollback'),
        jsonb_build_object('from', 'terminal_reconcile', 'to', 'completed', 'kind', 'success', 'condition', 'Temporal completed and domain result exists'),
        jsonb_build_object('from', 'terminal_reconcile', 'to', 'failed', 'kind', 'failure', 'condition', 'Temporal timeout, missing run or terminal mismatch'),
        jsonb_build_object('from', 'terminal_reconcile', 'to', 'partial', 'kind', 'recovery', 'condition', 'observer transport or telemetry loss')
      ),
      'terminals', jsonb_build_array(
        jsonb_build_object('id', 'completed', 'status', 'completed'),
        jsonb_build_object('id', 'failed', 'status', 'failed'),
        jsonb_build_object('id', 'needs_review', 'status', 'needs_review'),
        jsonb_build_object('id', 'partial', 'status', 'partial')
      )
    )
END
WHERE id = 'inbox.raw-normalization';

UPDATE workflow_definitions
SET process_json = jsonb_build_object(
  'lanes', jsonb_build_array(jsonb_build_object('id', 'workflow', 'label', 'Workflow')),
  'steps', (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', value,
      'label', value,
      'lane', 'workflow',
      'kind', 'activity',
      'owner', 'brai-api',
      'reads', jsonb_build_array(),
      'writes', jsonb_build_array(),
      'transaction', null
    )), '[]'::jsonb)
    FROM jsonb_array_elements_text(COALESCE(steps_json::jsonb, '[]'::jsonb)) AS step(value)
  ),
  'edges', '[]'::jsonb,
  'terminals', '[]'::jsonb
)
WHERE process_json IS NULL;

ALTER TABLE workflow_definitions
  ALTER COLUMN process_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN process_json SET NOT NULL;

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS trace_status text;

UPDATE workflow_executions
SET trace_status = 'unavailable'
WHERE trace_status IS NULL;

ALTER TABLE workflow_executions
  ALTER COLUMN trace_status SET DEFAULT 'unavailable',
  ALTER COLUMN trace_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workflow_executions_trace_status_check'
      AND conrelid = 'workflow_executions'::regclass
  ) THEN
    ALTER TABLE workflow_executions
      ADD CONSTRAINT workflow_executions_trace_status_check
      CHECK (trace_status IN ('unavailable', 'recording', 'complete', 'partial'));
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  workflow_execution_id integer NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  step_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'timed_out')),
  started_at_utc text,
  completed_at_utc text,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  activity_type text,
  agent_id text,
  ai_log_id integer REFERENCES ai_logs(id),
  error_code text,
  error_summary text CHECK (error_summary IS NULL OR length(error_summary) <= 1000),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at_utc text NOT NULL DEFAULT (now()::text),
  updated_at_utc text NOT NULL DEFAULT (now()::text),
  UNIQUE (workflow_execution_id, step_key, attempt)
);

CREATE TABLE IF NOT EXISTS workflow_worker_heartbeats (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  task_queue text NOT NULL,
  worker_identity text NOT NULL,
  build_ref text NOT NULL DEFAULT '',
  started_at_utc text NOT NULL,
  last_seen_at_utc text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (task_queue, worker_identity)
);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_definition_status_updated
  ON workflow_executions (workflow_definition_id, status, updated_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_execution_started
  ON workflow_execution_steps (workflow_execution_id, started_at_utc, attempt);
CREATE INDEX IF NOT EXISTS idx_workflow_execution_steps_status_started
  ON workflow_execution_steps (status, started_at_utc);
CREATE INDEX IF NOT EXISTS idx_ai_logs_workflow_run_attempt
  ON ai_logs (workflow_id, run_id, attempt_number, dt);
CREATE INDEX IF NOT EXISTS idx_workflow_worker_heartbeats_queue_seen
  ON workflow_worker_heartbeats (task_queue, last_seen_at_utc DESC);

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  ('workflow_definitions', 'Workflow definitions', 'Версионированный source of truth product workflows.', 'Хранит task queue, versioned JSON schemas и structured process_json. Admin генерирует orchestration/data/error diagrams из process_json; legacy Mermaid остается compatibility source.', now()::text),
  ('workflow_executions', 'Workflow executions', 'Компактный read model выполнения product workflows.', 'Хранит workflow/run ids, version pin, текущий шаг, status, attempt count, bounded last error и trace_status. Admin не читает Temporal напрямую.', now()::text),
  ('workflow_execution_steps', 'Workflow execution steps', 'Step telemetry workflow execution.', 'Одна строка на step/attempt: status, start/end/duration, technical metadata, ai_log link и bounded error. Пользовательские тексты, prompts, model output и stdout/stderr здесь не хранятся.', now()::text),
  ('workflow_worker_heartbeats', 'Workflow worker heartbeats', 'Heartbeat runtime workers по task queue.', 'Worker делает upsert heartbeat; Admin вычисляет online/stale/offline из last_seen_at_utc без прямого подключения к Temporal.', now()::text),
  ('ai_logs', 'AI logs', 'Отдельный журнал фактических AI-срабатываний.', 'AI calls пишут workflow_id, run_id и attempt_number; Admin показывает только технические ссылки и bounded metadata, не raw пользовательский payload.', now()::text)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

ALTER TABLE workflow_execution_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_worker_heartbeats ENABLE ROW LEVEL SECURITY;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (57, now()::text, 'add admin role/workflow observability telemetry')
ON CONFLICT (version) DO NOTHING;
