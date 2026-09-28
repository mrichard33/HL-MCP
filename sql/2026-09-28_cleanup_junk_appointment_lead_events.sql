-- =====================================================================
-- 2026-09-28 — Clean up junk appointment lead_events (HL Supabase)
-- =====================================================================
--
-- WHAT THESE ROWS ARE
-- Until HL-MCP#179 (merged and deployed 2026-09-28 ~21:05Z), the appointment
-- webhook read the top level of GHL's payload, while GHL nests the record
-- under `appointment`. The appointments upsert failed, but createLeadEvent
-- still wrote a row for every webhook with:
--   contact_id  = NULL
--   event_type  = 'appointment_booked'  (even for updates and deletes)
--   event_time  = when the webhook arrived, not the appointment time
--   raw_json    = the whole webhook envelope ({ type, appointment: {...} })
--
-- WHY THEY ARE SAFE TO REMOVE (measured 2026-09-28)
--   * 16,679 rows, 2026-07-12 → 2026-09-28 21:01Z
--       AppointmentCreate 8,399 · AppointmentUpdate 8,234 · AppointmentDelete 46
--   * None since the fix went live; new webhook events carry a contact.
--   * No foreign keys or triggers reference lead_events.
--   * Every reader filters by contact_id (funnel progression, dashboard
--     journey / leads / workflow queries, LP-MCP hl-read.js), so none of
--     them ever saw these rows. The 15-minute sync already records the real
--     event for each appointment, with its contact.
--   * The one other NULL-contact row (contact_updated, 2026-05-20) does not
--     match the filter and is left alone.
--
-- PERFORMANCE
-- Always lead with `contact_id IS NULL` — it uses idx_lead_events_contact and
-- narrows 2.2M rows to ~16.7k. Filtering on created_at alone times out
-- (no index on that column).
--
-- HOW TO RUN
-- One statement at a time, in order, through the HL Supabase query tool.
-- Step 4 is repeated until it reports 0. Nothing here has been run yet.
-- =====================================================================


-- ---------------------------------------------------------------------
-- STEP 1 — Preview (read-only). Expect ~16,679 total and nothing after
-- the fix went live.
-- ---------------------------------------------------------------------
SELECT json_agg(row_to_json(s)) FROM (
  SELECT raw_json->>'type' AS webhook_type,
         count(*)          AS n,
         min(created_at)   AS first_created,
         max(created_at)   AS last_created
  FROM lead_events
  WHERE contact_id IS NULL
    AND event_type = 'appointment_booked'
    AND raw_json ? 'appointment'
    AND raw_json->>'type' IN ('AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete')
    AND created_at < '2026-09-28T21:05:00Z'
  GROUP BY 1 ORDER BY 2 DESC
) s;


-- ---------------------------------------------------------------------
-- STEP 2 — Archive first, so the cleanup can be undone.
-- ---------------------------------------------------------------------
CREATE TABLE lead_events_junk_appt_20260928 AS
  SELECT *
  FROM lead_events
  WHERE contact_id IS NULL
    AND event_type = 'appointment_booked'
    AND raw_json ? 'appointment'
    AND raw_json->>'type' IN ('AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete')
    AND created_at < '2026-09-28T21:05:00Z';


-- ---------------------------------------------------------------------
-- STEP 3 — Check the archive. archived must equal the Step 1 total.
-- ---------------------------------------------------------------------
SELECT json_agg(row_to_json(s)) FROM (
  SELECT count(*) AS archived, min(created_at) AS first_created, max(created_at) AS last_created
  FROM lead_events_junk_appt_20260928
) s;


-- ---------------------------------------------------------------------
-- STEP 4 — Delete in batches of 2,000. REPEAT until deleted = 0
-- (about 9 runs). Only rows already in the archive can be deleted.
-- ---------------------------------------------------------------------
WITH d AS (
  DELETE FROM lead_events
  WHERE id IN (
    SELECT e.id
    FROM lead_events e
    WHERE e.contact_id IS NULL
      AND e.event_type = 'appointment_booked'
      AND e.raw_json ? 'appointment'
      AND e.id IN (SELECT a.id FROM lead_events_junk_appt_20260928 a)
    LIMIT 2000
  )
  RETURNING 1
)
SELECT count(*) AS deleted FROM d;


-- ---------------------------------------------------------------------
-- STEP 5 — Verify. remaining_junk must be 0; archived unchanged.
-- ---------------------------------------------------------------------
SELECT json_agg(row_to_json(s)) FROM (
  SELECT
    (SELECT count(*) FROM lead_events
      WHERE contact_id IS NULL
        AND event_type = 'appointment_booked'
        AND raw_json ? 'appointment') AS remaining_junk,
    (SELECT count(*) FROM lead_events_junk_appt_20260928) AS archived
) s;


-- ---------------------------------------------------------------------
-- STEP 6 — UNDO (only if ever needed). Puts the archived rows back;
-- event_hash is unique, so anything already present is skipped.
-- ---------------------------------------------------------------------
-- WITH r AS (
--   INSERT INTO lead_events
--   SELECT * FROM lead_events_junk_appt_20260928
--   ON CONFLICT (event_hash) DO NOTHING
--   RETURNING 1
-- )
-- SELECT count(*) AS restored FROM r;


-- ---------------------------------------------------------------------
-- STEP 7 — LATER (separate, reviewed step, no sooner than 2026-10-28):
-- DROP TABLE lead_events_junk_appt_20260928;
-- ---------------------------------------------------------------------
