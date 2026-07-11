-- brai:reapply-after-production-seed

INSERT INTO workflow_definitions (
  id, version, title, description, status, task_queue, steps_json, diagram_mermaid,
  input_schema_version, input_schema_json, output_schema_version, output_schema_json,
  created_at_utc, updated_at_utc
)
SELECT
  id,
  2,
  title,
  'Надёжно запускает Temporal и нормализует текст через изолированный schema-constrained local Codex CLI; image analysis остаётся отдельным условным шагом.',
  'active',
  task_queue,
  '["ingest","dispatch","prepare_raw","image_describer","raw_normalizer","apply_normalized_raw","terminal_reconcile"]',
  $mermaid$flowchart LR
  ingest["ingest"] --> dispatch["durable dispatch"]
  dispatch --> prepare["prepare_raw"]
  prepare --> image_check{"image required?"}
  image_check -->|yes| image["image_describer"]
  image_check -->|no| normalizer["raw_normalizer / local Codex CLI"]
  image --> normalizer
  normalizer -->|schema-valid JSON| apply["apply_normalized_raw"]
  normalizer -->|CLI/schema failure| failed["failed / needs_review"]
  apply --> terminal["Temporal close / terminal reconcile"]
  terminal -->|completed + persisted domain result| completed["completed"]
  terminal -->|failed / cancelled / timeout / missing| failed
  apply -->|business error / rollback| failed$mermaid$,
  input_schema_version,
  input_schema_json,
  'brai.inbox.normalized.v2',
  '{"type":"object","required":["title","description","class_key","class_title","class_description","normalization"],"properties":{"title":{"type":"string","minLength":1,"maxLength":80},"description":{"type":"string","minLength":1,"maxLength":8000},"class_key":{"type":"string","pattern":"^[a-z][a-z0-9_-]{1,62}$"},"class_title":{"type":"string","maxLength":8000},"class_description":{"type":"string","maxLength":8000},"normalization":{"type":"string","minLength":1,"maxLength":8000}},"additionalProperties":false}',
  now()::text,
  now()::text
FROM workflow_definitions
WHERE id = 'inbox.raw-normalization' AND version = 1
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
  updated_at_utc = excluded.updated_at_utc;

UPDATE workflow_definitions
SET status = 'retired', updated_at_utc = now()::text
WHERE id = 'inbox.raw-normalization' AND version = 1;

UPDATE role_contracts
SET
  workflow_definition_version = 2,
  output_schema_version = 'brai.inbox.normalized.v2',
  updated_at_utc = now()::text
WHERE id = 'inbox'
  AND workflow_definition_id = 'inbox.raw-normalization';

UPDATE agents
SET
  version = '3',
  summary = 'Формирует title, description, preliminary class и normalization через локальный Codex CLI с versioned output schema.',
  interactions_description = 'Вызывается Temporal Activity через изолированный local codex exec; применяющий скрипт остаётся единственным владельцем domain mutation.',
  llm_provider = 'codex-cli',
  llm_model = 'gpt-5.4-mini',
  llm_timeout_ms = 20000,
  fallback_description = 'Schema validation может повторить bounded Codex CLI invocation; прямой provider API не используется.',
  updated_at_utc = now()::text
WHERE id = 'inbox.normalizer';

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (52, now()::text, 'repair Inbox workflow dispatch, preview sequences, and local Codex normalization')
ON CONFLICT (version) DO NOTHING;
