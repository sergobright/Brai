ALTER TABLE brai_cmd_access_tokens
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE brai_cmd_access_tokens
  DROP CONSTRAINT IF EXISTS brai_cmd_access_tokens_source_check;

ALTER TABLE brai_cmd_access_tokens
  ADD CONSTRAINT brai_cmd_access_tokens_source_check
  CHECK (source IN ('self_service', 'authenticated', 'admin'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_brai_cmd_access_tokens_active_user_device
  ON brai_cmd_access_tokens (user_id, device_id_hash)
  WHERE status = 'active' AND user_id IS NOT NULL AND device_id_hash IS NOT NULL;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'brai_cmd_access_tokens',
  'Brai Cmd access tokens',
  'Хэши access tokens и device binding для Android Brai Cmd.',
  'Хранит только хэши секретов и metadata клиента; authenticated tokens сохраняют owner user_id, а исходные токены и device ids не сохраняются в открытом виде.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (65, now()::text, 'preserve authenticated Brai Cmd tokens in production-derived Preview seeds')
ON CONFLICT (version) DO NOTHING;
