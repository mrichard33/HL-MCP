-- 013_run_sql_full_resultset.sql
-- Fix run_sql so it returns the WHOLE result set instead of one scalar.
--
-- Run manually in the Supabase dashboard (DDL is dashboard-only in this stack).
-- See the "Applying this" note at the bottom — it cannot be applied through the
-- MCP admin tool, because that tool routes SQL through the very function this
-- replaces.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
-- 009_run_sql_rpc.sql defined the body as:
--
--     DECLARE result JSON;
--     BEGIN EXECUTE query_text INTO result; RETURN result; END;
--
-- `EXECUTE ... INTO result` captures only the FIRST COLUMN of the FIRST ROW and
-- coerces that scalar to JSON. Two consequences, both silent:
--
--   1. Data loss. Every other column and every other row is discarded. A
--      multi-column aggregate comes back as one number that looks perfectly
--      plausible, so nothing about the answer says it is wrong.
--   2. Type errors. A non-JSON scalar (text, uuid, timestamptz) raises
--      "invalid input syntax for type json". COUNT(*) only appeared to work
--      because a bare number is valid JSON.
--
-- Observed 2026-08-29 while probing the contacts mirror: a query asking for
-- json_build_object('probed', …, 'exactly_one', …, 'ambiguous_multi', …,
-- 'no_contact', …) returned the bare value `273`. It was caught only because
-- the number was implausible for the shape requested.
--
-- LP-MCP hit this same defect on its own instance, root-caused it, and fixed it
-- in LP-MCP/sql/run_sql.sql. This is that fix, ported. The two functions should
-- stay identical.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- SELECT / WITH are wrapped and aggregated with jsonb_agg(row_to_json(sub)), so
-- every column and row round-trips, JSON/JSONB columns included. Empty results
-- return '[]' rather than NULL. A single leading-whitespace run and a single
-- trailing semicolon are stripped so the query nests cleanly inside the
-- subselect wrapper. Non-SELECT statements (INSERT/UPDATE/DELETE/CREATE/ALTER)
-- run unchanged via the original text and return a status object, so the admin
-- tool keeps its full read/write capability.
--
-- ── BEHAVIOR CHANGE — READ BEFORE APPLYING ─────────────────────────────────
-- SELECT results now return an ARRAY OF ROW OBJECTS, e.g. `[{"count": 42}]`
-- instead of the old bare `42`. Any caller that parsed run_sql output as a bare
-- scalar must be updated.
--
-- The known caller is LP-MCP's src/admin/hl-client.js, which works around this
-- defect client-side: wrapSelectForJsonAgg() wraps every SELECT in json_agg
-- BEFORE sending it, and unwrapSingleValue() un-nests the reply. With this
-- migration applied, both sides would wrap. The double wrap mostly cancels, but
-- NOT for a single-row/single-column result, which collapses to a bare scalar
-- today and would come back as an array afterwards — and
-- src/tools/admin/hl-fallback.js documents relying on that collapse.
--
-- SO: apply this migration FIRST, then land the matching LP-MCP change that
-- removes the client-side wrap. In that order there is never a window where
-- neither side wraps. Applying this alone is safe for the MCP admin tool (it
-- starts returning correct full result sets) but changes shapes for those LP
-- callers, so do not leave the pair half-done.
--
-- ── APPLYING THIS ──────────────────────────────────────────────────────────
-- Supabase SQL editor or psql, NOT the MCP admin tool: that tool sends every
-- statement through run_sql itself, and the old INTO-based body handles a
-- CREATE OR REPLACE by executing it and then binding NULL, so the call can look
-- like it did nothing (or fail) even when it succeeded. Verify by hand
-- afterwards rather than trusting the tool's reply:
--
--   SELECT run_sql($$SELECT json_build_object('a',1,'b',2)$$);   -- both keys
--   SELECT run_sql($$SELECT 1 AS a, 2 AS b UNION ALL SELECT 3, 4$$); -- 2 rows
--   SELECT run_sql($$SELECT now()$$);                            -- no type error
--   SELECT run_sql($$SELECT 1 WHERE false$$);                    -- []
--
-- ── ROLLBACK ───────────────────────────────────────────────────────────────
-- Re-apply the body from 009_run_sql_rpc.sql. Only do that alongside reverting
-- the LP-MCP client change, for the same ordering reason as above.

CREATE OR REPLACE FUNCTION public.run_sql(query_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  result JSONB;
  cleaned TEXT := regexp_replace(query_text, '^\s+', '');
BEGIN
  -- strip a single trailing semicolon + whitespace so it nests cleanly
  cleaned := regexp_replace(cleaned, ';\s*$', '');

  IF cleaned ~* '^(SELECT|WITH)\s' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) FROM (%s) sub', cleaned)
      INTO result;
    RETURN result;
  ELSE
    -- non-SELECT: run original text unchanged (semicolons fine here)
    EXECUTE query_text;
    RETURN jsonb_build_object('status', 'ok', 'rows_affected', 'n/a');
  END IF;
END;
$function$;
