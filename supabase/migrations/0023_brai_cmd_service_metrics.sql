ALTER TABLE brai_cmd_usage_events
  ADD COLUMN IF NOT EXISTS post_processing_input_chars integer NOT NULL DEFAULT 0;

ALTER TABLE brai_cmd_usage_events
  ADD COLUMN IF NOT EXISTS post_processing_output_chars integer NOT NULL DEFAULT 0;

DELETE FROM ai_logs
WHERE agent_id = 'brai-cmd.dictate.transcription';

DELETE FROM agents
WHERE id = 'brai-cmd.dictate.transcription';

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'brai_cmd_usage_events',
  'Brai Cmd usage events',
  'Метрики выполнения Brai Cmd диктовки.',
  'Фиксирует counts, timings, provider/model metadata, ошибки и char usage постобработки без хранения исходного аудио, промптов или текста расшифровки.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (58, now()::text, 'treat Brai Cmd transcription as service metrics')
ON CONFLICT (version) DO NOTHING;
