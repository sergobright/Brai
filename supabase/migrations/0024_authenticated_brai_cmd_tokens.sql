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

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (60, now()::text, 'add authenticated Brai Cmd device tokens')
ON CONFLICT (version) DO NOTHING;
