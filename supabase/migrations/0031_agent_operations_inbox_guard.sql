-- Agent operations belong to Inbox. Legacy Activity rows remain mutable for cleanup.
CREATE OR REPLACE FUNCTION brai_reject_new_agent_activity_operations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('brai.allow_legacy_operation_import', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.activity_type_id = 'operation'
     AND (NEW.author = 'Codex' OR NEW.id LIKE 'operation:agent-task:%') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'agent_operations_belong_to_inbox';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brai_reject_new_agent_activity_operations ON activities;
CREATE TRIGGER brai_reject_new_agent_activity_operations
  BEFORE INSERT ON activities
  FOR EACH ROW
  EXECUTE FUNCTION brai_reject_new_agent_activity_operations();

INSERT INTO table_descriptions (table_name, title, short_description, long_description, updated_at_utc)
VALUES (
  'activities',
  'Activities',
  'Пользовательские action, goal и product-owned записи.',
  'Agent operations создаются только во внешнем Inbox; legacy activities.operation доступны лишь для чтения, завершения и мягкого удаления.',
  now()::text
)
ON CONFLICT (table_name) DO UPDATE SET
  title = excluded.title,
  short_description = excluded.short_description,
  long_description = excluded.long_description,
  updated_at_utc = excluded.updated_at_utc;

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (67, now()::text, 'enforce Inbox-only agent operations')
ON CONFLICT (version) DO NOTHING;
