-- Keep the database-global event trigger independent from disposable runtime schemas.
CREATE OR REPLACE FUNCTION public.brai_enable_rls_for_new_public_tables()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  table_name pg_catalog.regclass;
BEGIN
  FOR table_name IN
    SELECT c.oid::pg_catalog.regclass
    FROM pg_catalog.pg_event_trigger_ddl_commands() AS ddl
    JOIN pg_catalog.pg_class AS c ON c.oid = ddl.objid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE (
        n.nspname = 'public'
        OR n.nspname = 'brai_dev'
        OR n.nspname LIKE 'brai_preview_%'
        OR n.nspname LIKE 'brai_test_%'
      )
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name pg_catalog.regclass;
BEGIN
  FOR table_name IN
    SELECT c.oid::pg_catalog.regclass
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE (
        n.nspname = 'public'
        OR n.nspname = 'brai_dev'
        OR n.nspname LIKE 'brai_preview_%'
        OR n.nspname LIKE 'brai_test_%'
      )
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END;
$$;

DROP EVENT TRIGGER IF EXISTS brai_enable_rls_for_new_public_tables;

CREATE EVENT TRIGGER brai_enable_rls_for_new_public_tables
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.brai_enable_rls_for_new_public_tables();

INSERT INTO schema_migrations (version, applied_at_utc, description)
VALUES (55, now()::text, 'stabilize database-global runtime RLS trigger')
ON CONFLICT (version) DO NOTHING;
