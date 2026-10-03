-- 020_revoke_run_sql_public.sql
--
-- 2026-10-03 (security review) — APPLIED LIVE on 2026-10-03 to this project
-- (jtlngmcrtqncimtjjzlz). This file is the record, so a rebuilt database gets
-- the same grants.
--
-- run_sql (009/014) is SECURITY DEFINER and executes any text it is given.
-- Postgres grants EXECUTE to PUBLIC by default and Supabase adds anon and
-- authenticated, so the Security Advisor flagged it as callable at
-- /rest/v1/rpc/run_sql with the public anon key: full control of this database
-- for anyone holding that key. HL-MCP and LP-MCP call it with the service-role
-- key only, so service_role keeps EXECUTE and nothing else does.
--
-- Verified after applying: anon=false, authenticated=false, service_role=true,
-- and supabase_run_query "select 1" still answered through HL-MCP.

GRANT EXECUTE ON FUNCTION public.run_sql(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.run_sql(text) FROM PUBLIC, anon, authenticated;
