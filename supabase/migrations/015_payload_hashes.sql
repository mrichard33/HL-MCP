-- 015_payload_hashes.sql
-- Universal payload-hash change detection (v2.2).
--
-- Run manually in the Supabase SQL editor — DDL is dashboard-only in this stack
-- (same note as 011_workflow_steps_composite_pk.sql). This file is the record of
-- what was applied.
--
-- ORDERING DOES NOT MATTER. The delta gate fails open: if these columns do not
-- exist yet, the prefetch errors, the gate logs "cycle runs ungated" and every
-- sync writes everything exactly as it does today. So the code can ship before
-- or after this migration with no coordination.
--
-- appointments.payload_hash already exists in production (added out-of-band when
-- the appointment gate shipped) and is included here with IF NOT EXISTS so this
-- file is a complete description of the schema rather than a partial one.

ALTER TABLE appointments    ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE contacts        ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE opportunities   ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE custom_fields   ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE custom_values   ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE tags            ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE trigger_links   ADD COLUMN IF NOT EXISTS payload_hash TEXT;
ALTER TABLE templates       ADD COLUMN IF NOT EXISTS payload_hash TEXT;

-- workflows uses detail_hash rather than payload_hash because it gates a
-- different thing: not the workflows row itself, but whether the ~26k
-- workflow_steps / connections / triggers / actions rows need rebuilding.
ALTER TABLE workflows       ADD COLUMN IF NOT EXISTS detail_hash TEXT;

-- No indexes. Every hash lookup is by primary/unique key (ghl_*_id) or a full
-- table scan of a 234-row table, so an index on the hash column would only add
-- write cost to the very writes this change exists to avoid.

-- All columns start NULL, which the gate treats as "changed". The first cycle
-- after this migration therefore writes every row once and populates the hashes;
-- savings begin from the second cycle.
