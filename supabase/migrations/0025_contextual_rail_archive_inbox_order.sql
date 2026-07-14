CREATE TABLE IF NOT EXISTS user_ui_preferences (
  user_id text PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  context_rail_width_px integer NOT NULL DEFAULT 256 CHECK (context_rail_width_px BETWEEN 192 AND 512),
  updated_at_utc text NOT NULL
);

ALTER TABLE user_ui_preferences ENABLE ROW LEVEL SECURITY;

ALTER TABLE inbox ADD COLUMN IF NOT EXISTS sort_order integer;
ALTER TABLE inbox ADD COLUMN IF NOT EXISTS restored_at_utc text;

CREATE INDEX IF NOT EXISTS idx_inbox_new_sort_order
  ON inbox (status, sort_order)
  WHERE deleted_at_utc IS NULL AND sort_order IS NOT NULL;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  (
    'user_ui_preferences',
    'User UI preferences',
    'Синхронизируемые настройки интерфейса пользователя.',
    'Хранит общую для web-аккаунта ширину contextual rail; локальные open/closed состояния страниц остаются на устройстве.',
    now()::text
  ),
  (
    'inbox',
    'Inbox',
    'Role table входящих записей с raw и normalized состояниями.',
    'Inbox поддерживает offline-first ручной порядок, архивирование и восстановление наверх списка со статусом New.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (25, now()::text, 'contextual rail preferences, role archive, and inbox ordering')
ON CONFLICT (version) DO NOTHING;
