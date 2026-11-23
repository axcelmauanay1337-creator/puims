-- Security hardening (2026-11-23), from the Supabase security advisor.
--
-- 1. schema_migrations had no row-level security. Enable it (no policies): only the
--    owner, which runs migrations, can use it; the app role and any API role see nothing.
-- 2. Every function in public was executable by PUBLIC, which on Supabase includes the
--    `anon` and `authenticated` API roles (reachable through /rest/v1/rpc without
--    signing in). Revoke EXECUTE from PUBLIC and grant it only to the app role, now and
--    for functions created by later migrations.
-- 3. Pin search_path on every function that does not set one, so a caller cannot
--    shadow tables or operators by creating objects in another schema.
--
-- Runs as the schema owner (puims_owner). Safe to run on a plain PostgreSQL server
-- without the Supabase roles.

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO puims_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO puims_app;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.prokind = 'f'
       AND pg_get_userbyid(p.proowner) = current_user
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f);
  END LOOP;
END
$$;
