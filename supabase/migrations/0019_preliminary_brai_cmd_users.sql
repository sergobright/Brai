CREATE TABLE IF NOT EXISTS preliminary_users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  device_fingerprint_hash text NOT NULL UNIQUE,
  device_fingerprint_kind text NOT NULL DEFAULT 'android_id',
  install_id_hash text NOT NULL DEFAULT '',
  claim_token_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active', 'converted')),
  user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  last_seen_at_utc text NOT NULL,
  converted_at_utc text,
  client_version text NOT NULL DEFAULT '',
  app_package text NOT NULL DEFAULT ''
);

ALTER TABLE brai_cmd_access_tokens
  ADD COLUMN IF NOT EXISTS preliminary_users_id text REFERENCES preliminary_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_preliminary_users_status_created
  ON preliminary_users (status, created_at_utc);

CREATE INDEX IF NOT EXISTS idx_preliminary_users_user
  ON preliminary_users (user_id);

CREATE INDEX IF NOT EXISTS idx_brai_cmd_access_tokens_preliminary_users
  ON brai_cmd_access_tokens (preliminary_users_id);

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  (
    'preliminary_users',
    'Preliminary users',
    'Предварительные пользователи Android onboarding.',
    'Хранит имя, статус и хэши device fingerprint/claim token для Brai Cmd до полной регистрации; raw fingerprint и токены не сохраняются.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (59, now()::text, 'add preliminary Brai Cmd users')
ON CONFLICT (version) DO NOTHING;
