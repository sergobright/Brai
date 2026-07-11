INSERT INTO app_settings (key, value, updated_at_utc) VALUES
  ('display_timezone', 'Europe/Moscow', now()::text),
  ('model_provider_mode', 'internal', now()::text),
  ('inbox_text_provider', 'groq', now()::text),
  ('inbox_text_model', 'openai/gpt-oss-120b', now()::text),
  ('inbox_image_provider', 'openai', now()::text),
  ('inbox_image_model', 'gpt-4.1-mini', now()::text)
ON CONFLICT (key) DO NOTHING;

UPDATE agents
SET
  version = '2',
  summary = 'Описывает картинки Inbox через внутренний Codex CLI или внешний OpenAI image-capable model по runtime settings.',
  interactions_description = 'Вызывается из services/brai_api/src/inbox.js или Temporal Activity; internal режим использует локальный Codex CLI, external режим использует OpenAI Responses API.',
  llm_provider = 'codex-cli/openai',
  llm_model = 'internal: agent/runtime Codex model; external: gpt-4.1-mini',
  fallback_description = 'При external режиме требуется OPENAI_API_KEY или BRAI_INBOX_OPENAI_API_KEY; без ключа workflow завершает шаг ошибкой и пишет ai_log.',
  updated_at_utc = now()::text
WHERE id = 'inbox.image_describer';

UPDATE agents
SET
  version = '5',
  summary = 'Нормализует Inbox-записи через внутренний Codex CLI или внешний Groq GPT OSS 120B по runtime settings.',
  interactions_description = 'Вызывается из services/brai_api/src/inbox.js или Temporal Activity; internal режим использует локальный Codex CLI, external режим использует Groq OpenAI-compatible chat completions.',
  llm_provider = 'codex-cli/groq',
  llm_model = 'internal: agent/runtime Codex model; external: openai/gpt-oss-120b',
  fallback_description = 'При external режиме требуется GROQ_API_KEY или BRAI_INBOX_GROQ_API_KEY; schema validation может повторить bounded invocation.',
  updated_at_utc = now()::text
WHERE id = 'inbox.normalizer';

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  (
    'app_settings',
    'App settings',
    'Глобальные runtime-настройки Brai.',
    'Хранит display_timezone для отрисовки и дневных read models, model_provider_mode для переключения internal/external AI runtime и non-secret provider/model ids; API keys остаются только в server env.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (56, now()::text, 'add runtime timezone and AI provider settings')
ON CONFLICT (version) DO NOTHING;
