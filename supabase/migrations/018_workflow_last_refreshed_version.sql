-- 018_workflow_last_refreshed_version.sql
-- workflows.last_refreshed_version — the GHL version whose step rows are
-- actually in the cache.
--
-- ⚠️ NOT APPLIED BY THIS PR. Mark applies it in the Supabase dashboard, against
-- the HL project (hl-workflow-intelligence-mcp). Nothing in this repo runs DDL
-- at boot. Apply it BEFORE the deploy: until it exists, the nightly refresh
-- fails its version read and does nothing, and refresh_workflow reports
-- version_recorded=false (the refresh itself still works).
--
-- WHY
-- ───
-- workflows.version is written by every sync, including the hourly bulk sync
-- that refreshed 266 workflows on 2026-09-24 and rebuilt 0 step rows. So
-- `version` says what GHL has, not what workflow_steps holds, and nothing
-- could tell the two apart. This column is written ONLY when the step rows
-- were really rebuilt without error (src/extractor/workflow-refresh.ts), so
-- `version <> last_refreshed_version` means "the cached structure is stale".
--
-- NULL means never refreshed by that path — the nightly job treats it as
-- stale and refreshes it, which is what the first night does for everything.
--
-- Additive and idempotent. No backfill: backfilling from `version` would claim
-- a freshness nobody verified.

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS last_refreshed_version integer;

COMMENT ON COLUMN public.workflows.last_refreshed_version IS
  'GHL version whose workflow_steps/_actions/_connections/_triggers rows are in the cache. Set only after a successful step rebuild (refresh_workflow / nightly refresh). NULL = never refreshed.';
