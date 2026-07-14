CREATE TABLE IF NOT EXISTS user_provider_credentials (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id IN ('openai', 'groq', 'openrouter', 'gemini')),
  encrypted_api_key text NOT NULL,
  key_hint text NOT NULL CHECK (char_length(key_hint) BETWEEN 1 AND 4),
  verified_at_utc text NOT NULL,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  PRIMARY KEY (user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS user_ai_settings (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  model_provider_mode text NOT NULL DEFAULT 'internal'
    CHECK (model_provider_mode IN ('internal', 'external')),
  text_provider_id text,
  text_model text,
  vision_provider_id text,
  vision_model text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL,
  CHECK ((text_provider_id IS NULL) = (text_model IS NULL)),
  CHECK ((vision_provider_id IS NULL) = (vision_model IS NULL)),
  CHECK (
    model_provider_mode = 'internal'
    OR (
      text_provider_id IS NOT NULL AND text_model IS NOT NULL
      AND vision_provider_id IS NOT NULL AND vision_model IS NOT NULL
    )
  ),
  FOREIGN KEY (user_id, text_provider_id)
    REFERENCES user_provider_credentials(user_id, provider_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, vision_provider_id)
    REFERENCES user_provider_credentials(user_id, provider_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_user_provider_credentials_updated
  ON user_provider_credentials (user_id, updated_at_utc DESC);

CREATE TABLE IF NOT EXISTS brai_cmd_account_link_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  device_id_hash text NOT NULL,
  display_name text NOT NULL,
  client_version text NOT NULL DEFAULT '',
  app_package text NOT NULL DEFAULT '',
  created_at_utc text NOT NULL,
  expires_at_utc text NOT NULL,
  used_at_utc text
);

CREATE INDEX IF NOT EXISTS idx_brai_cmd_account_links_user_device
  ON brai_cmd_account_link_tokens (user_id, device_id_hash, created_at_utc DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_brai_cmd_account_links_pending_device
  ON brai_cmd_account_link_tokens (device_id_hash)
  WHERE used_at_utc IS NULL;

ALTER TABLE brai_cmd_access_tokens
  ADD COLUMN IF NOT EXISTS expires_at_utc text;

UPDATE brai_cmd_access_tokens
SET expires_at_utc = (created_at_utc::timestamptz + interval '30 days')::text
WHERE expires_at_utc IS NULL;

ALTER TABLE brai_cmd_access_tokens
  ALTER COLUMN expires_at_utc SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brai_cmd_access_tokens_expiry
  ON brai_cmd_access_tokens (status, expires_at_utc);

ALTER TABLE ai_logs
  ADD COLUMN IF NOT EXISTS user_id text REFERENCES "user"(id) ON DELETE CASCADE;

UPDATE ai_logs AS log
SET user_id = CASE
  WHEN log.agent_id LIKE 'inbox.%'
    THEN (SELECT inbox.user_id FROM inbox WHERE inbox.id = log.flow_id)
  WHEN log.agent_id LIKE 'activity.%'
    THEN (SELECT activities.user_id FROM activities WHERE activities.id = log.flow_id)
  ELSE NULL
END
WHERE log.user_id IS NULL
  AND (log.agent_id LIKE 'inbox.%' OR log.agent_id LIKE 'activity.%');

CREATE INDEX IF NOT EXISTS idx_ai_logs_user_dt
  ON ai_logs (user_id, dt DESC, id DESC);

INSERT INTO user_ai_settings (
  user_id, model_provider_mode, text_provider_id, text_model,
  vision_provider_id, vision_model, created_at_utc, updated_at_utc
)
SELECT id, 'internal', NULL, NULL, NULL, NULL, now()::text, now()::text
FROM "user"
ON CONFLICT (user_id) DO NOTHING;

UPDATE agents
SET
  version = '3',
  summary = 'Описывает картинки Inbox через установленный Codex CLI или user-scoped внешний vision-профиль.',
  interactions_description = 'Разрешает mode/provider/model по owner user scope; external key расшифровывается только перед provider call.',
  llm_provider = 'codex-cli/user-selected',
  llm_model = 'gpt-5.4-mini',
  fallback_description = 'При ошибке выбранного внешнего провайдера шаг завершается явно; project key и internal fallback не используются.',
  updated_at_utc = now()::text
WHERE id = 'inbox.image_describer';

UPDATE agents
SET
  version = '6',
  summary = 'Нормализует Inbox через установленный Codex CLI или user-scoped внешний text-профиль.',
  interactions_description = 'Разрешает mode/provider/model по owner user scope; external key расшифровывается только перед provider call.',
  llm_provider = 'codex-cli/user-selected',
  llm_model = 'gpt-5.4-mini',
  fallback_description = 'Schema validation может повторить тот же выбранный режим; project key и переключение на internal запрещены.',
  updated_at_utc = now()::text
WHERE id = 'inbox.normalizer';

UPDATE agents
SET
  version = '2',
  summary = 'Нормализует raw Activity через установленный Codex CLI или user-scoped внешний text-профиль.',
  interactions_description = 'Разрешает mode/provider/model по owner user scope и использует общий structured text adapter.',
  llm_provider = 'codex-cli/user-selected',
  llm_model = 'gpt-5.4-mini',
  fallback_description = 'Schema validation может повторить тот же выбранный режим; project key и переключение на internal запрещены.',
  updated_at_utc = now()::text
WHERE id = 'activity.normalizer';

INSERT INTO table_descriptions (
  table_name, title, short_description, long_description, updated_at_utc
) VALUES
  (
    'user_provider_credentials',
    'User provider credentials',
    'Зашифрованные аккаунтные API keys AI-провайдеров.',
    'Одна AES-256-GCM encrypted credential на user/provider; plaintext существует только на trust boundaries. key_hint хранит не более четырех последних символов для UI.',
    now()::text
  ),
  (
    'user_ai_settings',
    'User AI settings',
    'User-scoped режим и text/vision model profiles.',
    'Internal mode использует установленный Codex CLI. External mode требует text и vision provider/model, связанные с credential того же пользователя; delete активной credential ограничен FK.',
    now()::text
  ),
  (
    'brai_cmd_account_link_tokens',
    'Brai Cmd account link tokens',
    'Короткоживущие одноразовые ссылки между Web auth и native Brai CMD.',
    'Web получает только link-token, привязанный к user и device. Native активирует его с действующим device access token; link хранится только как hash, истекает и не допускает replay.',
    now()::text
  ),
  (
    'brai_cmd_access_tokens',
    'Brai Cmd access tokens',
    'Хешированные device-bound access tokens Brai CMD с ограниченным сроком жизни.',
    'Anonymous и account access tokens живут 30 дней, проверяются вместе с device id и отзываются при account activation, logout/self-revoke или admin revoke.',
    now()::text
  ),
  (
    'ai_logs',
    'AI logs',
    'User-scoped execution logs for AI agents.',
    'Each provider or Codex invocation records mode, provider, model, safe status and owning user_id. idx_ai_logs_user_dt supports account-isolated history without storing provider credentials.',
    now()::text
  ),
  (
    'app_settings',
    'App settings',
    'Глобальные runtime-настройки Brai.',
    'Хранит display_timezone и legacy AI rows для rollback. Активный user AI runtime читает user_ai_settings и user_provider_credentials.',
    now()::text
  ),
  (
    'agents',
    'Agents',
    'Регистр runtime AI-агентов.',
    'Три normalization-агента выбирают installed Codex CLI или user-scoped external capability profile и пишут ровно один ai_logs row на фактическое выполнение.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (62, now()::text, 'add account user AI provider credentials and profiles')
ON CONFLICT (version) DO NOTHING;
