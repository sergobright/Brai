-- Supabase Advisor: keep this event trigger function from using caller search_path.
DO $$
BEGIN
  IF to_regprocedure('brai_enable_rls_for_new_public_tables()') IS NOT NULL THEN
    EXECUTE format(
      'ALTER FUNCTION %I.brai_enable_rls_for_new_public_tables() SET search_path = pg_catalog',
      current_schema()
    );
  END IF;
END;
$$;
