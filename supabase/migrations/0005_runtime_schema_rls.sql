-- Ensure RLS follows the active runtime schema selected by search_path.
DO $$
DECLARE
  table_name pg_catalog.regclass;
  target_schema text := pg_catalog.current_schema();
BEGIN
  FOR table_name IN
    SELECT c.oid::pg_catalog.regclass
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = target_schema
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;

  IF pg_catalog.to_regrole('anon') IS NOT NULL THEN
    EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA %I FROM anon', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM anon', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM anon', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM anon', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM anon', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM anon', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM anon', target_schema);
  END IF;

  IF pg_catalog.to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA %I FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM authenticated', target_schema);
    EXECUTE pg_catalog.format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM authenticated', target_schema);
  END IF;
END;
$$;

DO $$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format($function$
    CREATE OR REPLACE FUNCTION %I.brai_enable_rls_for_new_public_tables()
    RETURNS event_trigger
    LANGUAGE plpgsql
    SET search_path = ''
    AS $body$
    DECLARE
      table_name pg_catalog.regclass;
      runtime_schema text := %L;
    BEGIN
      FOR table_name IN
        SELECT c.oid::pg_catalog.regclass
        FROM pg_catalog.pg_event_trigger_ddl_commands() AS ddl
        JOIN pg_catalog.pg_class AS c ON c.oid = ddl.objid
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = runtime_schema
          AND c.relkind IN ('r', 'p')
      LOOP
        EXECUTE pg_catalog.format('ALTER TABLE %%s ENABLE ROW LEVEL SECURITY', table_name);
      END LOOP;
    END;
    $body$;
  $function$, target_schema, target_schema);
END;
$$;

DROP EVENT TRIGGER IF EXISTS brai_enable_rls_for_new_public_tables;

DO $$
DECLARE
  target_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'CREATE EVENT TRIGGER brai_enable_rls_for_new_public_tables ON ddl_command_end WHEN TAG IN (''CREATE TABLE'', ''CREATE TABLE AS'', ''SELECT INTO'') EXECUTE FUNCTION %I.brai_enable_rls_for_new_public_tables()',
    target_schema
  );
END;
$$;
