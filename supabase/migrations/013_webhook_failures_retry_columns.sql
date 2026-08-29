-- 013 — webhook_failures retry + replay bookkeeping (Project 2, 2026-08-29)
--
-- webhook_failures was a write-only graveyard: a failed forward was recorded
-- and then abandoned, with no retry and no way to tell an event that had been
-- recovered from one that had not. 4,222 rows accumulated that way.
--
-- retry_count / last_retry_at record what the caller's bounded retry already
-- tried before giving up, so a row here means "3 attempts failed", not
-- "we tried once".
--
-- replayed_at marks a row as recovered. It is the completion signal for the
-- backfill: a NULL replayed_at on a row inside the replay window is
-- outstanding work.

ALTER TABLE webhook_failures
  ADD COLUMN IF NOT EXISTS retry_count   int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS replayed_at   timestamptz;

-- The replay tool's only read: unreplayed rows, newest-first, inside a
-- hard-bounded window.
CREATE INDEX IF NOT EXISTS idx_webhook_failures_replay
  ON webhook_failures (created_at DESC)
  WHERE replayed_at IS NULL;

-- The daily alert counts rows in the last 24h.
CREATE INDEX IF NOT EXISTS idx_webhook_failures_created
  ON webhook_failures (created_at DESC);
