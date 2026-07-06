-- Supabase Advisor expects an empty function search_path and qualified names.
DO $$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format($function$
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
