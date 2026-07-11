-- brai:reapply-after-production-seed

WITH empty_input_executions AS (
  SELECT DISTINCT w.id
  FROM workflow_executions w
  JOIN ai_logs l
    ON l.workflow_id = w.workflow_id
   AND l.run_id IS NOT DISTINCT FROM w.run_id
  WHERE w.role_contract_id = 'inbox'
    AND w.status = 'completed'
    AND l.agent_id = 'inbox.normalizer'
    AND l.status = 'done'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(l.json_data::jsonb -> 'inputs', '[]'::jsonb)) input
      WHERE input ->> 'ref' IN (
        'inbox.explanation_text',
        'inbox.description_text',
        'inbox.normalization_text.image_description'
      )
        AND NULLIF(btrim(input ->> 'value'), '') IS NOT NULL
    )
)
UPDATE workflow_executions w
SET status = 'needs_review',
    current_step = 'raw_normalizer',
    last_error = 'normalized_without_raw_input',
    updated_at_utc = now()::text
FROM empty_input_executions bad
WHERE w.id = bad.id;

WITH raw_create AS (
  SELECT DISTINCT ON (e.subject_id)
    e.subject_id AS inbox_id,
    e.device_id,
    e.payload_json::jsonb AS payload
  FROM events e
  WHERE e.event_domain = 'inbox'
    AND e.event_type = 'create'
    AND e.status = 'accepted'
    AND e.subject_id IS NOT NULL
  ORDER BY e.subject_id, e.occurred_at_utc, e.domain_sequence
)
UPDATE inbox i
SET explanation_text = CASE
      WHEN NULLIF(btrim(i.explanation_text), '') IS NULL
        THEN COALESCE(NULLIF(btrim(raw.payload ->> 'explanation_text'), ''), NULLIF(btrim(raw.payload ->> 'title'), ''), '')
      ELSE i.explanation_text
    END,
    source = CASE
      WHEN NULLIF(btrim(i.source), '') IS NULL AND raw.device_id <> 'inbox-api' THEN 'brai-app'
      ELSE i.source
    END,
    source_key = CASE
      WHEN NULLIF(btrim(i.source_key), '') IS NULL AND raw.device_id <> 'inbox-api' THEN raw.device_id
      ELSE i.source_key
    END
FROM raw_create raw
WHERE raw.inbox_id = i.id
  AND (
    NULLIF(btrim(i.explanation_text), '') IS NULL
    OR (raw.device_id <> 'inbox-api' AND NULLIF(btrim(i.source), '') IS NULL)
    OR (raw.device_id <> 'inbox-api' AND NULLIF(btrim(i.source_key), '') IS NULL)
  );

INSERT INTO workflow_definitions (
  id, version, title, description, status, task_queue, steps_json, diagram_mermaid,
  input_schema_version, input_schema_json, output_schema_version, output_schema_json,
  created_at_utc, updated_at_utc
)
SELECT
  id,
  3,
  title,
  'Сохраняет immutable raw input, отклоняет пустой semantic input до AI и показывает фактические состояния условных шагов.',
  'active',
  task_queue,
  steps_json,
  diagram_mermaid,
  'brai.inbox.raw.v2',
  input_schema_json,
  'brai.inbox.normalized.v3',
  output_schema_json,
  now()::text,
  now()::text
FROM workflow_definitions
WHERE id = 'inbox.raw-normalization' AND version = 2
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
WHERE id = 'inbox.raw-normalization' AND version IN (1, 2);

UPDATE role_contracts
SET workflow_definition_version = 3,
    input_schema_version = 'brai.inbox.raw.v2',
    output_schema_version = 'brai.inbox.normalized.v3',
    updated_at_utc = now()::text
WHERE id = 'inbox'
  AND workflow_definition_id = 'inbox.raw-normalization';

UPDATE agents
SET version = '4',
    summary = 'Сохраняет намерение и именованные сущности, исправляет очевидные опечатки и формирует strict JSON через локальный Codex CLI.',
    input_description = 'Immutable Inbox explanation_text с fallback на provisional title, description_text, optional image description и список inbox_classes.',
    interactions_description = 'Вызывается только Temporal Activity через локальный /srv/opt/codex-cli/bin/codex; прямой provider API и Groq не используются.',
    llm_provider = 'codex-cli',
    llm_model = 'gpt-5.4-mini',
    llm_prompt_template = $prompt$Разбери Inbox-запись на русском языке.
Нужно сопоставить голосовой транскрипт, текстовый контекст и описание картинки.
Сохраняй исходное намерение пользователя и все названные им сущности, имена и названия.
Исправляй очевидные опечатки, но не меняй смысл.
Если хотя бы один вход непустой, не называй запись пустой и не утверждай, что контекст отсутствует.
Верни только JSON без Markdown с полями:
{"title":"короткий заголовок до 80 символов","description":"понятное описание чего хотел пользователь","class_key":"ключ класса","class_title":"русское название класса если ключ новый","class_description":"краткое описание класса если ключ новый","normalization":"технический разбор"}

Доступные классы:
{{classes}}

Транскрипт:
{{text}}

Текстовый контекст:
{{description}}

Описание картинки:
{{image_description}}$prompt$,
    llm_timeout_ms = 20000,
    fallback_description = 'Schema validation допускает не более трёх локальных Codex CLI attempts; raw_input_empty завершается needs_review без AI call.',
    source_module = 'services/brai_api/src/inbox-workflow-runtime.js',
    updated_at_utc = now()::text
WHERE id = 'inbox.normalizer';

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'inbox',
  'Inbox',
  'Role table входящих записей с immutable raw input и normalized состоянием.',
  'explanation_text сохраняет исходный пользовательский ввод и не перезаписывается нормализацией; source/source_key фиксируют provenance. Workflow v3 создаёт entity/role только после schema-valid local Codex CLI результата.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (53, now()::text, 'preserve Inbox raw input and add workflow v3')
ON CONFLICT (version) DO NOTHING;
