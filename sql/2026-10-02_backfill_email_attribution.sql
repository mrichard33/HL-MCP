-- 2026-10-02_backfill_email_attribution.sql
-- Re-attribute email_events rows written before the lc-operations fix.
--
-- Run ONCE in the HL MCP Supabase SQL editor, AFTER the fix is deployed.
-- Safe to re-run: it only touches rows still on the old guess whose payload
-- carries GHL's email id.
--
-- Why: the first live events (2026-10-02 ~5:50 PM ET) were attributed by
-- "last email sent to this contact", which gave two test emails sent a minute
-- apart the same message id. GHL's own id was in every payload all along.

WITH u AS (
  UPDATE public.email_events
     SET attributed_message_id = raw_json->'webhookPayload'->'lc-operations'->>'email_message_id',
         attribution_method    = 'lc_operations'
   WHERE attribution_method IN ('last_email_to_contact', 'none')
     AND raw_json->'webhookPayload'->'lc-operations'->>'email_message_id' IS NOT NULL
  RETURNING 1
)
SELECT count(*) AS rows_updated FROM u;
