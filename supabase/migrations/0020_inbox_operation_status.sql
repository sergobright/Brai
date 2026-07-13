ALTER TABLE inbox ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'New';
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS completed_at_utc text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inbox_status_check'
      AND conrelid = 'inbox'::regclass
  ) THEN
    ALTER TABLE inbox ADD CONSTRAINT inbox_status_check CHECK (status IN ('New', 'Done'));
  END IF;
END;
$$;

INSERT INTO inbox_classes (key, title, description, status, created_by_agent_id, created_at_utc, updated_at_utc)
VALUES (
  'operation',
  'Операция агента',
  'Служебная операция, созданная агентом и обрабатываемая через Inbox.',
  'active',
  NULL,
  now()::text,
  now()::text
)
ON CONFLICT (key) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  status = 'active',
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'inbox',
  'Inbox',
  'Role table входящих записей с immutable raw input, normalized состоянием и служебным статусом.',
  'explanation_text сохраняет исходный пользовательский ввод и не перезаписывается нормализацией; source/source_key фиксируют provenance. Workflow создаёт entity/role только после schema-valid local Codex CLI результата. status хранит служебное New/Done состояние для agent operation-записей без UI controls.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (60, now()::text, 'move agent operations to Inbox with status')
ON CONFLICT (version) DO NOTHING;
