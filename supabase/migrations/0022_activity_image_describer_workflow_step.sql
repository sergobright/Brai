-- brai:reapply-after-production-seed

UPDATE workflow_definitions
SET steps_json = '["ingest","dispatch","prepare_raw","image_describer","raw_normalizer","apply_normalized_raw","terminal_reconcile"]',
  diagram_mermaid = $mermaid$flowchart LR
  ingest["ingest"] --> dispatch["dispatch"]
  dispatch --> prepare["prepare_raw"]
  prepare --> image["image_describer"]
  image --> normalizer["raw_normalizer"]
  normalizer -->|valid JSON| apply["apply_normalized_raw"]
  normalizer -->|validation error, max 3| normalizer
  normalizer -->|3 failures| review["needs_review"]
  apply --> terminal["terminal_reconcile"]
  terminal --> done["completed"]$mermaid$,
  process_json = COALESCE(process_json, '{}'::jsonb) || jsonb_build_object(
    'steps', jsonb_build_array(
      jsonb_build_object('id', 'ingest', 'label', 'Raw Activity принят', 'lane', 'api', 'kind', 'api', 'owner', 'brai-api', 'reads', jsonb_build_array('activity sync event'), 'writes', jsonb_build_array('activities', 'events', 'workflow_executions', 'logs'), 'transaction', 'ingest'),
      jsonb_build_object('id', 'dispatch', 'label', 'Immediate Temporal dispatch; queued recovery when unavailable', 'lane', 'temporal', 'kind', 'orchestration', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions'), 'writes', jsonb_build_array('workflow_executions', 'logs'), 'transaction', null),
      jsonb_build_object('id', 'prepare_raw', 'label', 'Prepare raw Activity input', 'lane', 'worker', 'kind', 'activity', 'owner', 'brai-api', 'reads', jsonb_build_array('activities'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps'), 'transaction', null),
      jsonb_build_object('id', 'image_describer', 'label', 'Describe Activity image attachments when present', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'reads', jsonb_build_array('activities attachment metadata'), 'writes', jsonb_build_array('ai_logs', 'workflow_execution_steps'), 'transaction', null),
      jsonb_build_object('id', 'raw_normalizer', 'label', 'Local Codex CLI strict-schema Activity normalizer', 'lane', 'codex', 'kind', 'agent', 'owner', 'brai-api', 'agent_id', 'activity.normalizer', 'reads', jsonb_build_array('activities.title', 'activities.description_md', 'activity image description', 'activities.author', 'activities.reason', 'workflow_definitions.output_schema_json'), 'writes', jsonb_build_array('ai_logs', 'workflow_execution_steps'), 'transaction', null),
      jsonb_build_object('id', 'apply_normalized_raw', 'label', 'Apply transaction: items, item_roles, Activity link, event link, normalized event', 'lane', 'domain', 'kind', 'mutation', 'owner', 'brai-api', 'reads', jsonb_build_array('activities', 'role_contracts', 'events'), 'writes', jsonb_build_array('items', 'item_roles', 'activities', 'events', 'workflow_executions', 'logs'), 'transaction', 'domain_apply'),
      jsonb_build_object('id', 'terminal_reconcile', 'label', 'Temporal close and terminal reconciliation', 'lane', 'worker', 'kind', 'recovery', 'owner', 'brai-api', 'reads', jsonb_build_array('workflow_executions', 'activities', 'workflow_execution_steps'), 'writes', jsonb_build_array('workflow_executions', 'workflow_execution_steps', 'logs'), 'transaction', null)
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('from', 'ingest', 'to', 'dispatch', 'kind', 'success', 'condition', 'raw activity, initial event and queued execution committed'),
      jsonb_build_object('from', 'dispatch', 'to', 'prepare_raw', 'kind', 'success', 'condition', 'Temporal accepted run'),
      jsonb_build_object('from', 'dispatch', 'to', 'dispatch', 'kind', 'recovery', 'condition', 'Temporal dispatch unavailable or lost queued execution'),
      jsonb_build_object('from', 'prepare_raw', 'to', 'image_describer', 'kind', 'success', 'condition', 'raw input present'),
      jsonb_build_object('from', 'prepare_raw', 'to', 'needs_review', 'kind', 'failure', 'condition', 'raw input empty'),
      jsonb_build_object('from', 'image_describer', 'to', 'raw_normalizer', 'kind', 'success', 'condition', 'no images or image description ready'),
      jsonb_build_object('from', 'image_describer', 'to', 'failed', 'kind', 'failure', 'condition', 'image description fails for required image attachments'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'raw_normalizer', 'kind', 'retry', 'condition', 'invalid strict-schema result and attempts remain'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'apply_normalized_raw', 'kind', 'success', 'condition', 'strict schema valid'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'needs_review', 'kind', 'failure', 'condition', 'maximum attempts exhausted'),
      jsonb_build_object('from', 'raw_normalizer', 'to', 'failed', 'kind', 'failure', 'condition', 'Codex CLI timeout, non-zero exit or model refusal'),
      jsonb_build_object('from', 'apply_normalized_raw', 'to', 'terminal_reconcile', 'kind', 'success', 'condition', 'apply transaction committed'),
      jsonb_build_object('from', 'apply_normalized_raw', 'to', 'failed', 'kind', 'failure', 'condition', 'apply rollback'),
      jsonb_build_object('from', 'terminal_reconcile', 'to', 'completed', 'kind', 'success', 'condition', 'Temporal completed and domain result exists'),
      jsonb_build_object('from', 'terminal_reconcile', 'to', 'failed', 'kind', 'failure', 'condition', 'Temporal timeout, missing run or terminal mismatch')
    )
  ),
  updated_at_utc = now()::text
WHERE id = 'activity.raw-normalization'
  AND version = 1;

UPDATE agents
SET summary = 'Нормализует raw Activity action/operation в краткий title, description_md, reason и технический разбор с учетом будущих описаний вложений.',
  input_description = 'activities.activity_type_id, title, description_md, optional image description, author, reason и status.',
  llm_prompt_template = 'Разбери Activity-запись на русском языке.
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

Описание вложений/изображений, если есть:
{{image_description}}

Автор:
{{author}}

Причина:
{{reason}}

Статус:
{{status}}',
  updated_at_utc = now()::text
WHERE id = 'activity.normalizer';

UPDATE table_descriptions
SET long_description = 'Raw Activity action/operation не имеет item_roles_id; workflow activity.raw-normalization создает entity/role, связывает initial_event_id, имеет универсальный image_describer step для будущих вложений и сохраняет compact execution state. Исторические already-linked записи не перегоняются.',
  updated_at_utc = now()::text
WHERE table_name = 'activities';

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (61, now()::text, 'add Activity image describer workflow step')
ON CONFLICT (version) DO NOTHING;
