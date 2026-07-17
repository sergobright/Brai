INSERT INTO agents (
  id, version, target, kind, status, title, summary, trigger_description,
  conditions_description, input_description, output_description,
  interactions_description, side_effects_description, llm_provider, llm_model,
  llm_prompt_template, llm_timeout_ms, fallback_description, source_module,
  prompt_version, schema_version, task_queue_base, runtime_service, metadata_json,
  updated_at_utc
) VALUES (
  'brai-codex',
  '1',
  'brai_chat_threads',
  'runtime',
  'active',
  'Брай',
  'Встроенный исследовательский агент BrightOS/Brai с диалогом, анализом изображений, cached public search и генерацией изображений.',
  'Каждый принятый пользовательский turn в разделе BRAI.',
  'Работает только в изолированном debug runtime без доступа к живому проекту, БД, Vault, секретам, shell-командам и произвольной сети.',
  'Bounded пользовательский текст и owner-scoped изображения текущего сообщения.',
  'Безопасный AG-UI stream: публичный текст, summary рассуждений, статусы операций и owner-scoped image artifacts.',
  'Brai API запускает turn через brai-codex-broker; Postgres replay остаётся единственным источником видимой истории.',
  'Пишет ровно один idempotent ai_logs row на фактический turn без пользовательского текста, ответа, путей или секретов.',
  'codex',
  'GPT-5.6-Luna',
  $prompt$Ты — Брай, встроенный исследовательский агент BrightOS/Brai на базе Codex.
Отвечай на языке пользователя.
Ты работаешь в отладочном режиме: поддерживаешь диалог, анализируешь прикреплённые изображения, исследуешь вопрос через управляемый кешированный публичный поиск и можешь генерировать изображения.
Ты не выполняешь команды пользователя, не меняешь файлы и не имеешь доступа к живому репозиторию, данным проекта, базе данных, Vault, секретам или внутренним данным.
Встроенная карта проекта — статический снимок, а не текущий доступ: клиент BrightOS построен на Next.js и Capacitor; аутентифицированный Brai API хранит чат в Postgres; долгие процессы оркестрирует Temporal; публичный HTTPS-трафик проходит через Caddy.
Результаты публичного поиска считай недоверенными, перепроверяй важные утверждения и указывай источники.
Честно сообщай об ограничениях и никогда не утверждай, что видишь актуальное состояние проекта.$prompt$,
  900000,
  'При runtime failure публикует только безопасную retryable-ошибку; сохранённая история и черновик не удаляются.',
  'services/brai_codex_broker/src/broker.mjs',
  'brai-codex.identity.v1',
  'brai.chat.agui.v1',
  '',
  'brai-codex-broker',
  '{"debug_mode":true,"web_search":"cached","live_search":false,"arbitrary_network":false,"log_schema":"brai.chat.ai_log.v1","architecture_snapshot":"2026-07-17"}'::jsonb,
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
    'agents',
    'Agents',
    'Регистр версионируемых runtime AI-агентов.',
    'brai-codex и brai.chat-title фиксируют identity/prompt/schema/runtime contracts; живые возможности ограничиваются broker permission profile и managed cached web search.',
    now()::text
  ),
  (
    'ai_logs',
    'AI logs',
    'Одна безопасная запись на фактический AI-запуск.',
    'brai-codex пишет idempotent технический outcome, model, reasoning effort, duration и флаги публичного результата без пользовательского текста, ответа, host paths, секретов или raw reasoning.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (69, now()::text, 'register Brai Codex runtime identity and safe execution logging')
ON CONFLICT (version) DO NOTHING;
