-- 015_payload_hashes.sql
-- Universal payload-hash change detection (v2.2).
--
-- Adds the column each sync stores its content hash in, so a cycle can skip
-- rows that are byte-for-byte identical to what is already stored.
--
-- WHY THE TABLE-EXISTS GUARD
--
-- This repo has TWO migration directories and they describe different sets of
-- tables:
--   supabase/migrations/  (this one) — contacts, opportunities, appointments,
--                          custom_fields, custom_values, tags, trigger_links,
--                          workflows, …
--   migrations/          (top level) — templates, mcp_oauth_*
--
-- Supabase Branching builds a preview database from THIS directory only, so
-- `templates` does not exist there and a bare `ALTER TABLE templates` aborts the
-- whole migration (SQLSTATE 42P01 — this exact failure was caught by the preview
-- branch on PR #165 before it ever reached production).
--
-- Guarding on to_regclass makes the file correct in every lineage: it adds the
-- column where the table exists and quietly skips where it does not, instead of
-- failing the run. It is also fully idempotent, which matters because DDL in
-- this stack is applied by hand in the Supabase SQL editor (see the note in
-- 011_workflow_steps_composite_pk.sql) and may be run more than once.
--
-- ORDERING AGAINST THE CODE DOES NOT MATTER. The delta gate fails open: with no
-- hash column the prefetch errors, the gate logs "cycle runs ungated", and every
-- sync writes everything exactly as it does today.

DO $$
DECLARE
  spec  RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('appointments',  'payload_hash'),
      ('contacts',      'payload_hash'),
      ('opportunities', 'payload_hash'),
      ('custom_fields', 'payload_hash'),
      ('custom_values', 'payload_hash'),
      ('tags',          'payload_hash'),
      ('trigger_links', 'payload_hash'),
      -- Lives in the top-level migrations/ directory; absent from preview branches.
      ('templates',     'payload_hash'),
      -- workflows gates a different thing: not its own row, but whether the
      -- ~26k workflow_steps / connections / triggers / actions rows need
      -- rebuilding. Hence detail_hash rather than payload_hash.
      ('workflows',     'detail_hash')
    ) AS t(table_name, column_name)
  LOOP
    IF to_regclass('public.' || spec.table_name) IS NULL THEN
      RAISE NOTICE 'skipping %.% — table not present in this database', spec.table_name, spec.column_name;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I TEXT',
      spec.table_name, spec.column_name
    );
  END LOOP;
END $$;

-- No indexes. Every hash lookup is by primary/unique key (ghl_*_id) or a full
-- scan of a 234-row table, so an index on the hash column would only add write
-- cost to the very writes this change exists to avoid.

-- All columns start NULL, which the gate treats as "changed". The first cycle
-- after this migration therefore writes every row once to populate the hashes;
-- savings begin from the second cycle.
