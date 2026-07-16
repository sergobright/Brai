ALTER TABLE brai_chat_threads
  DROP CONSTRAINT IF EXISTS brai_chat_threads_title_source_check;

ALTER TABLE brai_chat_threads
  ADD CONSTRAINT brai_chat_threads_title_source_check
  CHECK (title_source IN ('default', 'auto', 'generated', 'manual'));

INSERT INTO agents (
  id, version, target, kind, status, title, summary, trigger_description,
  conditions_description, input_description, output_description,
  interactions_description, side_effects_description, llm_provider, llm_model,
  llm_prompt_template, llm_timeout_ms, fallback_description, source_module,
  prompt_version, schema_version, task_queue_base, runtime_service, metadata_json,
  updated_at_utc
) VALUES (
  'brai.chat-title',
  '1',
  'brai_chat_threads',
  'runtime',
  'active',
  'Brai chat semantic title generator',
  'Создаёт короткий смысловой заголовок треда на языке диалога после успешного ответа Брай.',
  'После успешного assistant turn, пока title_source остаётся default.',
  'Не запускается без assistant output; ручной или уже generated title не перезаписывается.',
  'Bounded user message и assistant text текущего turn, выбранные model и reasoning effort.',
  'Только заголовок до 7 слов и 80 символов на языке диалога.',
  'Brai API вызывает broker generateTitle; broker использует отдельный ephemeral Codex thread и не публикует его события в пользовательский AG-UI stream.',
  'При успехе условно обновляет brai_chat_threads.title и всегда пишет ровно один idempotent ai_logs row на фактический вызов.',
  'codex',
  '',
  $prompt$Придумай краткий смысловой заголовок для диалога.
Верни только заголовок без кавычек, Markdown и пояснений.
Заголовок должен быть на основном языке диалога пользователя.
Не копируй запрос дословно. Не более 7 слов и 80 символов.

Запрос пользователя: {{user_message}}
Ответ ассистента: {{assistant_text}}$prompt$,
  30000,
  'При ошибке, timeout или пустом результате оставляет «Новый чат»; не строит заголовок из пользовательского запроса локально.',
  'services/brai_codex_broker/src/broker.mjs',
  'brai-chat-title.v1',
  'brai.chat-title.result.v1',
  '',
  'brai-codex-broker',
  '{"isolated_runtime":true,"log_schema":"brai.chat_title.ai_log.v1","max_words":7,"max_chars":80,"title_source":"generated"}'::jsonb,
  now()::text
)
ON CONFLICT (id) DO UPDATE SET
  version = excluded.version,
  target = excluded.target,
  kind = excluded.kind,
  status = excluded.status,
  title = excluded.title,
  summary = excluded.summary,
  trigger_description = excluded.trigger_description,
  conditions_description = excluded.conditions_description,
  input_description = excluded.input_description,
  output_description = excluded.output_description,
  interactions_description = excluded.interactions_description,
  side_effects_description = excluded.side_effects_description,
  llm_provider = excluded.llm_provider,
  llm_model = excluded.llm_model,
  llm_prompt_template = excluded.llm_prompt_template,
  llm_timeout_ms = excluded.llm_timeout_ms,
  fallback_description = excluded.fallback_description,
  source_module = excluded.source_module,
  prompt_version = excluded.prompt_version,
  schema_version = excluded.schema_version,
  task_queue_base = excluded.task_queue_base,
  runtime_service = excluded.runtime_service,
  metadata_json = excluded.metadata_json,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO table_descriptions (
  table_name, title, short_description, long_description, updated_at_utc
) VALUES
  (
    'brai_chat_threads',
    'Brai chat threads',
    'Владелец-изолированные треды чата Брай.',
    'Хранит public id, внутреннее Codex thread mapping, semantic generated/manual title provenance, model/reasoning, durable active-turn state и обратимый archive state. Все API reads фильтруются по server-side user_id.',
    now()::text
  ),
  (
    'agents',
    'Agents',
    'Регистр runtime AI-агентов.',
    'Каждый runtime AI-агент, включая brai.chat-title, имеет stable id, prompt/source/timeout/fallback metadata и пишет фактические AI executions в ai_logs.',
    now()::text
  ),
  (
    'ai_logs',
    'AI logs',
    'Отдельный журнал фактических AI-срабатываний.',
    'brai.chat-title пишет ровно один idempotent row на фактический model call: только bounded technical outcome, model, duration и title application flags без пользовательского текста или generated title.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (68, now()::text, 'add semantic generated title provenance for Brai chat')
ON CONFLICT (version) DO NOTHING;
