-- PUIMS database bootstrap. Run ONCE per environment by a PostgreSQL superuser:
--
--   psql -v owner_password='...' -v app_password='...' -v db_name=puims -f db/bootstrap.sql
--
-- Creates two roles:
--   puims_owner  owns the schema and runs migrations/seeds. Not used by the running app.
--   puims_app    used by the running app. NOT the owner, NO BYPASSRLS, no DELETE/TRUNCATE
--                anywhere — so row-level security and append-only rules apply to it.
-- Passwords come from psql variables; never commit them.

\set ON_ERROR_STOP on

SELECT 'CREATE ROLE puims_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'puims_owner') \gexec
SELECT 'CREATE ROLE puims_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'puims_app') \gexec

ALTER ROLE puims_owner PASSWORD :'owner_password';
ALTER ROLE puims_app PASSWORD :'app_password';

SELECT format('CREATE DATABASE %I OWNER puims_owner ENCODING ''UTF8'' TEMPLATE template0', :'db_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name') \gexec

\connect :db_name
ALTER SCHEMA public OWNER TO puims_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO puims_app;
-- btree_gist is a trusted extension but creating it here keeps migrations superuser-free.
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE CONNECT ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO puims_owner, puims_app;
