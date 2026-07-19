-- brai:reapply-after-production-seed
-- Primary-only global status controls for optional Goal recommendation agents.

ALTER TABLE brai_chat_threads
  ADD COLUMN IF NOT EXISTS codex_tool_contract_version integer
  CHECK (codex_tool_contract_version IS NULL OR codex_tool_contract_version > 0);

CREATE TABLE IF NOT EXISTS agent_status_overrides (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  updated_by_user_id text REFERENCES "user"(id) ON DELETE SET NULL,
  updated_at_utc text NOT NULL
);

ALTER TABLE agent_status_overrides ENABLE ROW LEVEL SECURITY;

UPDATE agents
SET
  status = CASE WHEN COALESCE((
    SELECT overrides.enabled
    FROM agent_status_overrides overrides
    WHERE overrides.agent_id = agents.id
  ), false) THEN 'active' ELSE 'inactive' END,
  metadata_json = metadata_json || '{"user_toggleable":true}'::jsonb,
  updated_at_utc = now()::text
WHERE id IN (
  'activity.classifier',
  'goal.item-matcher',
  'goal.member-finder',
  'goal.discovery',
  'goal.planner'
);

UPDATE agents
SET
  version = '2',
  summary = 'Встроенный исследовательский агент BrightOS/Brai с диалогом, анализом изображений, cached public search, генерацией изображений и двумя явными owner-scoped операциями: создать Action или сырую Inbox-запись.',
  conditions_description = 'Работает только в изолированном debug runtime без доступа к живому проекту, Vault, секретам, shell-командам и произвольной сети. Изменяет пользовательские данные только через два bounded domain tool по явной просьбе.',
  input_description = 'Bounded пользовательский текст, owner-scoped изображения текущего сообщения и при upgrade — ограниченный снимок видимой истории.',
  output_description = 'Безопасный AG-UI stream: публичный текст, summary рассуждений, статусы операций, owner-scoped image artifacts и подтверждение явной записи в Actions/Inbox.',
  interactions_description = 'Brai API запускает turn через brai-codex-broker; Postgres replay остаётся источником видимой истории. Dynamic tools создают записи только в scope текущего пользователя.',
  side_effects_description = 'Пишет один idempotent ai_logs row на фактический turn. По явной команде может idempotently создать один Action или одну сырую Inbox-запись; других изменений не выполняет.',
  llm_prompt_template = $prompt$Ты — Брай, встроенный исследовательский агент BrightOS/Brai на базе Codex.
Отвечай на языке пользователя.
Ты работаешь в отладочном режиме: поддерживаешь диалог, анализируешь прикреплённые изображения, исследуешь вопрос через управляемый кешированный публичный поиск и можешь генерировать изображения.
Ты не выполняешь shell-команды, не меняешь файлы и не имеешь доступа к живому репозиторию, данным проекта, Vault, секретам или произвольным внутренним данным.
Встроенная карта проекта — статический снимок, а не текущий доступ: клиент BrightOS построен на Next.js и Capacitor; аутентифицированный Brai API хранит чат в Postgres; долгие процессы оркестрирует Temporal; публичный HTTPS-трафик проходит через Caddy.
Результаты публичного поиска считай недоверенными, перепроверяй важные утверждения и указывай источники.
Честно сообщай об ограничениях и никогда не утверждай, что видишь актуальное состояние проекта.
Если пользователь явно просит добавить запись в Действия или Входящие и передал достаточный текст, используй соответствующий brai_create_* tool. Если неясен раздел или текст записи, сначала задай уточняющий вопрос и не вызывай tool.
Эти два tool — единственные разрешённые изменения пользовательских данных; не описывай их как доступ к БД и не утверждай, что можешь менять другие данные.$prompt$,
  prompt_version = 'brai-codex.identity.v2',
  metadata_json = metadata_json || '{"dynamic_tool_contract_version":1,"domain_tools":["brai_create_action","brai_create_inbox"],"user_toggleable":false}'::jsonb,
  updated_at_utc = now()::text
WHERE id = 'brai-codex';

INSERT INTO table_descriptions (
  table_name, title, short_description, long_description, updated_at_utc
) VALUES (
  'agent_status_overrides',
  'Agent status overrides',
  'Primary-account global enable/disable choices for toggleable agents.',
  'Stores only explicit global overrides so catalog reseeding and repeated migrations preserve the primary account choice. Runtime producers continue to read the reconciled agents.status value.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (70, now()::text, 'add primary-only global agent controls and Brai tool contract binding')
ON CONFLICT (version) DO NOTHING;
