-- brai:reapply-after-production-seed

ALTER TABLE activities ADD COLUMN IF NOT EXISTS initial_event_id text REFERENCES events(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS workflow_execution_id integer REFERENCES workflow_executions(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_initial_event
  ON activities (initial_event_id)
  WHERE initial_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activities_workflow_execution
  ON activities (workflow_execution_id);
CREATE INDEX IF NOT EXISTS idx_activities_raw_queue
  ON activities (created_at_utc, id)
  WHERE item_roles_id IS NULL
    AND activity_type_id IN ('action', 'operation');

UPDATE activities a
SET initial_event_id = e.id
FROM events e
WHERE a.initial_event_id IS NULL
  AND e.event_domain = 'activity'
  AND e.subject_id = a.id
  AND e.event_type = 'create'
  AND e.id = (
    SELECT first_event.id
    FROM events first_event
    WHERE first_event.event_domain = 'activity'
      AND first_event.subject_id = a.id
      AND first_event.event_type = 'create'
    ORDER BY first_event.occurred_at_utc, first_event.domain_sequence
    LIMIT 1
  );

INSERT INTO workflow_definitions (
  id, version, title, description, status, task_queue, steps_json, diagram_mermaid,
  input_schema_version, input_schema_json, output_schema_version, output_schema_json,
  process_json, created_at_utc, updated_at_utc
) VALUES (
  'activity.raw-normalization',
  1,
  'Activity raw normalization',
  'Создает entity и Activity role только после schema-valid результата агента.',
  'active',
  'brai-inbox-normalization',
  '["ingest","dispatch","prepare_raw","raw_normalizer","apply_normalized_raw","terminal_reconcile"]',
  $mermaid$flowchart LR
  ingest["ingest"] --> dispatch["dispatch"]
  dispatch --> prepare["prepare_raw"]
  prepare --> normalizer["raw_normalizer"]
  normalizer -->|valid JSON| apply["apply_normalized_raw"]
  normalizer -->|validation error, max 3| normalizer
  normalizer -->|3 failures| review["needs_review"]
  apply --> terminal["terminal_reconcile"]
  terminal --> done["completed"]$mermaid$,
  'brai.activity.raw.v1',
  '{"type":"object","required":["activity_id"],"properties":{"activity_id":{"type":"string","minLength":1}},"additionalProperties":false}',
  'brai.activity.normalized.v1',
  '{"type":"object","required":["title","description","reason","normalization"],"properties":{"title":{"type":"string","minLength":1,"maxLength":80},"description":{"type":"string","minLength":1,"maxLength":8000},"reason":{"type":"string","maxLength":8000},"normalization":{"type":"string","minLength":1,"maxLength":8000}},"additionalProperties":false}',
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
      jsonb_build_object('id', 'ingest', 'label', 'Raw Activity принят', 'lane', 'api', 'kind', 'api', 'owner', 'brai-api', 'reads', jsonb_build_array('activity sync event'), 'writes', jsonb_build_array('activities', 'events', 'workflow_executions', 'logs'), 'transaction', 'ingest'),
      jsonb_build_object('id', 'dispatch', 'label', 'Immediate Temporal dispatch; queued recovery when unavailable', 'lane', 'temporal', 'kind', 'orchestration', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions'), 'writes', jsonb_build_array('workflow_executions', 'logs'), 'transaction', null),
      jsonb_build_object('id', 'prepare_raw', 'label', 'Prepare raw Activity input', 'lane', 'worker', 'kind', 'activity', 'owner', 'brai-api', 'reads', jsonb_build_array('activities'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps'), 'transaction', null),
      jsonb_build_object('id', 'raw_normalizer', 'label', 'Local Codex CLI strict-schema Activity normalizer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'activity.normalizer', 'reads', jsonb_build_array('activities.title', 'activities.description_md', 'activities.author', 'activities.reason', 'workflow_definitions.output_schema_json'), 'writes', jsonb_build_array('ai_logs', 'workflow_execution_steps'), 'transaction', null),
      jsonb_build_object('id', 'apply_normalized_raw', 'label', 'Apply transaction: items, item_roles, Activity link, event link, normalized event', 'lane', 'domain', 'kind', 'mutation', 'owner', 'brai-api', 'reads', jsonb_build_array('activities', 'role_contracts', 'events'), 'writes', jsonb_build_array('items', 'item_roles', 'activities', 'events', 'workflow_executions', 'logs'), 'transaction', 'domain_apply'),
      jsonb_build_object('id', 'terminal_reconcile', 'label', 'Temporal close and terminal reconciliation', 'lane', 'worker', 'kind', 'recovery', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions', 'activities', 'workflow_execution_steps'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps', 'logs'), 'transaction', null)
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('from', 'ingest', 'to', 'dispatch', 'kind', 'success', 'condition', 'raw activity, initial event and queued execution committed'),
      jsonb_build_object('from', 'dispatch', 'to', 'prepare_raw', 'kind', 'success', 'condition', 'Temporal accepted run'),
      jsonb_build_object('from', 'dispatch', 'to', 'dispatch', 'kind', 'recovery', 'condition', 'Temporal dispatch unavailable or lost queued execution'),
      jsonb_build_object('from', 'prepare_raw', 'to', 'raw_normalizer', 'kind', 'success', 'condition', 'raw input present'),
      jsonb_build_object('from', 'prepare_raw', 'to', 'needs_review', 'kind', 'failure', 'condition', 'raw input empty'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'raw_normalizer', 'kind', 'retry', 'condition', 'invalid strict-schema result and attempts remain'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'apply_normalized_raw', 'kind', 'success', 'condition', 'strict schema valid'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'needs_review', 'kind', 'failure', 'condition', 'maximum attempts exhausted'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'failed', 'kind', 'failure', 'condition', 'Codex CLI timeout, non-zero exit or model refusal'),
      jsonb_build_object('from', 'apply_normalized_raw', 'to', 'terminal_reconcile', 'kind', 'success', 'condition', 'apply transaction committed'),
      jsonb_build_object('from', 'apply_normalized_raw', 'to', 'failed', 'kind', 'failure', 'condition', 'apply rollback'),
      jsonb_build_object('from', 'terminal_reconcile', 'to', 'completed', 'kind', 'success', 'condition', 'Temporal completed and domain result exists'),
      jsonb_build_object('from', 'terminal_reconcile', 'to', 'failed', 'kind', 'failure', 'condition', 'Temporal timeout, missing run or terminal mismatch')
    ),
    'terminals', jsonb_build_array(
      jsonb_build_object('id', 'completed', 'status', 'completed'),
      jsonb_build_object('id', 'failed', 'status', 'failed'),
      jsonb_build_object('id', 'needs_review', 'status', 'needs_review')
    )
  ),
  now()::text,
  now()::text
)
ON CONFLICT (id, version) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  task_queue = excluded.task_queue,
  steps_json = excluded.steps_json,
  diagram_mermaid = excluded.diagram_mermaid,
  input_schema_version = excluded.input_schema_version,
  input_schema_json = excluded.input_schema_json,
  output_schema_version = excluded.output_schema_version,
  output_schema_json = excluded.output_schema_json,
  process_json = excluded.process_json,
  updated_at_utc = excluded.updated_at_utc;

UPDATE role_contracts
SET lifecycle_json = '{"statuses":["active","ended","deleted"],"raw_when":"activity_type_id in (''action'',''operation'') and item_roles_id is null"}',
  workflow_definition_id = 'activity.raw-normalization',
  workflow_definition_version = 1,
  input_schema_version = 'brai.activity.raw.v1',
  output_schema_version = 'brai.activity.normalized.v1',
  owner = 'brai-activities',
  event_rules_json = '{"link":"item_roles_id","initial_event_column":"initial_event_id"}',
  updated_at_utc = now()::text
WHERE id = 'activity';

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
  'activity.normalizer',
  '1',
  'activity',
  'runtime',
  'active',
  'Activity normalizer',
  'Нормализует raw Activity action/operation в краткий title, description_md, reason и технический разбор.',
  'Срабатывает после создания raw Activity через синхронизацию клиента.',
  'Пропускается, если Activity отсутствует или уже имеет item_roles_id.',
  'activities.activity_type_id, title, description_md, author, reason и status.',
  'Schema-valid JSON: title, description, reason и normalization.',
  'Вызывается из services/brai_api/src/activity-normalization.js через общий JSON normalizer, Codex CLI или тестовый runtime hook.',
  'Пишет ровно один ai_logs на реальное выполнение; domain mutation выполняет apply_normalized_raw.',
  '',
  '',
  'Разбери Activity-запись на русском языке.
Activity может быть пользовательским действием action или будущей пользовательской операцией operation.
Сохраняй исходное намерение, имена, названия и все важные ограничения.
Исправляй очевидные опечатки, но не меняй смысл.
Верни только JSON без Markdown с полями:
{"title":"короткий заголовок до 80 символов","description":"понятное описание задачи или операции","reason":"почему эта activity существует, если причина понятна, иначе пустая строка","normalization":"технический разбор"}

Тип Activity:
{{activity_type}}

Заголовок:
{{title}}

Описание:
{{description}}

Автор:
{{author}}

Причина:
{{reason}}

Статус:
{{status}}',
  60000,
  'При ошибке пишет failed ai_log и оставляет Activity raw; после трех schema validation failures workflow становится needs_review.',
  'services/brai_api/src/activity-normalization.js',
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

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  ('activities', 'Activities', 'Role table действий и пользовательских операций.', 'Raw Activity action/operation не имеет item_roles_id; workflow activity.raw-normalization создает entity/role, связывает initial_event_id и сохраняет compact execution state. Исторические already-linked записи не перегоняются.', now()::text),
  ('events', 'Global events', 'Единый canonical event log для бизнес-событий Brai.', 'Role-linked события используют item_roles_id. Принятые raw Inbox и Activity events создаются без ссылки и получают item_roles_id после успешной нормализации без изменения исходного payload, timestamp или type.', now()::text),
  ('workflow_definitions', 'Workflow definitions', 'Версионированный source of truth product workflows.', 'Хранит task queue, versioned JSON schemas и structured process_json для Inbox и Activity raw normalization workflows.', now()::text),
  ('agents', 'Agents', 'Регистр runtime AI-агентов.', 'Каждый runtime AI-агент имеет stable id, prompt/source metadata и пишет фактические AI executions в ai_logs.', now()::text)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (60, now()::text, 'add Activity raw normalization workflow')
ON CONFLICT (version) DO NOTHING;
