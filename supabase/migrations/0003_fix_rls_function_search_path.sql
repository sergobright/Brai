-- Supabase Advisor: keep this event trigger function from using caller search_path.
ALTER FUNCTION IF EXISTS public.brai_enable_rls_for_new_public_tables()
  SET search_path = pg_catalog;
