-- ============================================================
-- 009: run_sql RPC function for admin tooling
-- Enables the MCP admin tools to execute arbitrary SQL via
-- supabase.rpc('run_sql', { query_text }). Only callable with
-- the service role key (SECURITY DEFINER).
-- ============================================================

CREATE OR REPLACE FUNCTION run_sql(query_text TEXT)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  EXECUTE query_text INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
