DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 48) THEN
    DELETE FROM ai_logs;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS inbox_classes (
  key text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active', 'candidate', 'archived')),
  created_by_agent_id text,
  created_at_utc text NOT NULL,
  updated_at_utc text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_classes_status ON inbox_classes (status, title);

ALTER TABLE inbox_events DROP CONSTRAINT IF EXISTS inbox_events_type_check;
ALTER TABLE inbox_events
  ADD CONSTRAINT inbox_events_type_check
  CHECK (type IN ('create', 'update_title', 'update_description', 'normalize', 'delete', 'invalid'));

UPDATE inbox_record_types
SET key = 'api_human_inbox',
    title = 'Входящее от человека по API',
    description = 'Внешний API запрос, инициированный человеком.'
WHERE id = 1;

UPDATE inbox_record_types
SET key = 'api_agent_inbox',
    title = 'Входящее от агента по API',
    description = 'Внешний API запрос, инициированный агентом.'
WHERE id = 2;

UPDATE inbox_record_types
SET key = 'internal_agent_inbox',
    title = 'Внутреннее входящее от агента',
    description = 'Внутренний агент Brai создал входящую запись.'
WHERE id = 3;

INSERT INTO inbox_classes (key, title, description, status, created_by_agent_id, created_at_utc, updated_at_utc) VALUES
  ('idea', 'Идея', 'Мысль или концепция, которую стоит развить.', 'active', NULL, now()::text, now()::text),
  ('wish', 'Желание', 'Пользователь выразил желание, намерение или будущую покупку.', 'active', NULL, now()::text, now()::text),
  ('library', 'Сохранить в библиотеку', 'Материал, ссылку, изображение или фрагмент нужно сохранить для дальнейшего чтения.', 'active', NULL, now()::text, now()::text),
  ('task', 'Задача', 'Нужно выполнить действие, проверить, подготовить или кому-то ответить.', 'active', NULL, now()::text, now()::text),
  ('note', 'Заметка', 'Наблюдение, факт или короткая запись без явного действия.', 'active', NULL, now()::text, now()::text),
  ('other', 'Другое', 'Входящее не подходит под остальные классы.', 'active', NULL, now()::text, now()::text)
ON CONFLICT (key) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  status = excluded.status,
  updated_at_utc = excluded.updated_at_utc;

DELETE FROM agent_schedules WHERE agent_id = 'in' || 'bound.inbox.title_generator';
DELETE FROM agents WHERE id = 'in' || 'bound.inbox.title_generator';

INSERT INTO agents (
  id,
  version,
  target,
  kind,
  status,
  title,
  summary,
  trigger_description,
  conditions_description,
  input_description,
  output_description,
  interactions_description,
  side_effects_description,
  llm_provider,
  llm_model,
  llm_prompt_template,
  llm_timeout_ms,
  fallback_description,
  source_module,
  updated_at_utc
) VALUES
(
  'inbox.image_describer',
  '1',
  'inbox',
  'runtime',
  'active',
  'Inbox image describer',
  'Описывает картинки, приложенные к Inbox-записи, и сохраняет описание в normalization_text.',
  'Срабатывает после создания Inbox-записи, если у нее есть image attachments.',
  'Пропускается, если картинок нет, запись удалена или уже обработана.',
  'Inbox id и локальные пути к сохраненным image attachments.',
  'Фактическое русскоязычное описание изображения для последующей нормализации.',
  'Вызывается из services/brai_api/src/inbox.js через Codex CLI или тестовый runtime hook.',
  'Пишет normalize event и ai_logs; не меняет explanation_text.',
  '',
  '',
  'Опиши изображение для Inbox на русском языке.
Нужно детальное, фактическое описание: что видно, какой интерфейс/экран, важные тексты, объекты, состояния, числа и возможный пользовательский контекст.
Не выдумывай невидимые детали. Верни только описание.',
  60000,
  'Если описание картинки не удалось получить, обработка Inbox-записи останавливается и пишет failed ai_log для этого шага.',
  'services/brai_api/src/inbox.js',
  now()::text
),
(
  'inbox.normalizer',
  '1',
  'inbox',
  'runtime',
  'active',
  'Inbox normalizer',
  'Сопоставляет транскрипт, текстовый контекст и описание картинки, затем заполняет title, description_text, preliminary_section и normalization_text.',
  'Срабатывает после создания Inbox-записи и после optional описания картинок.',
  'Пропускается, если запись удалена или уже обработана.',
  'Inbox explanation_text, description_text, normalization_text image block и список inbox_classes.',
  'Короткий заголовок, понятное описание намерения пользователя, class key и технический разбор.',
  'Вызывается из services/brai_api/src/inbox.js через Codex CLI или тестовый runtime hook.',
  'Пишет normalize event, ai_logs и при необходимости candidate row в inbox_classes; не меняет explanation_text.',
  '',
  '',
  'Разбери Inbox-запись на русском языке.
Нужно сопоставить голосовой транскрипт, текстовый контекст и описание картинки.
Верни только JSON без Markdown с полями:
{"title":"короткий заголовок до 80 символов","description":"понятное описание чего хотел пользователь","class_key":"ключ класса","class_title":"русское название класса если ключ новый","class_description":"краткое описание класса если ключ новый","normalization":"технический разбор"}

Доступные классы:
{{classes}}

Транскрипт:
{{text}}

Текстовый контекст:
{{description}}

Описание картинки:
{{image_description}}',
  60000,
  'При ошибке пишет failed ai_log и оставляет Inbox-запись необработанной; допускается только retry другой моделью через runtime config.',
  'services/brai_api/src/inbox.js',
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
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc) VALUES
  (
    'inbox_classes',
    'Inbox classes',
    'Справочник предварительных классов Inbox-записей.',
    'Используется Inbox normalizer для preliminary_section. Если подходящего класса нет, агент добавляет candidate row для последующего ручного утверждения.',
    now()::text
  )
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (48, now()::text, 'add Inbox AI processing')
ON CONFLICT (version) DO NOTHING;
