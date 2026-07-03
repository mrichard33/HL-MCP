-- 011_workflow_steps_composite_pk.sql
-- Fix recurring 23505 duplicate-key errors on workflow_steps_pkey.
--
-- Cloned/duplicated GHL workflows retain their SOURCE workflow's step
-- (template) IDs. The old primary key was PRIMARY KEY (step_id) alone, so the
-- first workflow synced "owned" the shared step IDs and every clone's inserts
-- failed with 23505 — ~24,000 Postgres errors/day and, worse, silent data loss
-- (colliding workflows had incomplete cached step graphs). Widening the PK to
-- (workflow_id, step_id) lets each workflow keep its own copy of a shared step.
--
-- The new PK is strictly looser than the old one, so the currently deployed
-- code keeps working after this migration — apply it BEFORE deploying the
-- v1.9 workflow-extractor, whose steps upsert uses
-- onConflict: 'workflow_id,step_id' (requires this composite constraint).
--
-- Safe: no FK constraints reference workflow_steps, and there are zero
-- (workflow_id, step_id) duplicates under the current stricter PK. Table is
-- ~26K rows, so the lock window is negligible.
--
-- Forward-only: reverting to PRIMARY KEY (step_id) would first require deleting
-- cross-workflow duplicate step_ids.
--
-- Run manually in the Supabase dashboard (DDL is dashboard-only in this stack).

BEGIN;

ALTER TABLE public.workflow_steps
  DROP CONSTRAINT workflow_steps_pkey;

ALTER TABLE public.workflow_steps
  ADD CONSTRAINT workflow_steps_pkey PRIMARY KEY (workflow_id, step_id);

COMMIT;
