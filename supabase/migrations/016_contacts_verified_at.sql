-- 016_contacts_verified_at.sql
-- contacts.verified_at / verified_from — the GHL half of the freshness rulebook.
--
-- WHY A SECOND TIMESTAMP. synced_at only moves on a WRITE, and the payload-hash
-- gate means an unchanged contact is never written. So a contact that is
-- correct and untouched for a year looks identical to one nobody has checked
-- in a year. verified_at records the last time the sync COMPARED this row
-- against live GHL, whether or not anything changed — a hash match IS a
-- verification.
--
-- The precedence rules these columns serve live in LP-MCP:
-- docs/data-freshness-rulebook.md. GHL owns the conversation layer and the
-- consent state (tags, DNC, consent, engagement, last inbound); LP owns the
-- sales process.
--
-- Additive and idempotent — migrations here are applied by hand in the
-- Supabase SQL editor, and supabase/migrations/ also builds preview branches.
-- Only `contacts` is touched, which exists in both lineages (001_initial_schema),
-- so no to_regclass guard is needed (cf. the templates note in 015).

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verified_at   timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS verified_from text;

COMMENT ON COLUMN contacts.verified_at IS
  'Last compare against the live GHL contact (hash match or rewrite). Stamped by syncContacts when GHL_VERIFIED_AT_ENABLED=true.';

-- Soft-deleted contacts are excluded: a row we have stopped syncing cannot go
-- stale in any way we would act on, and counting it would drag the percentage
-- down forever. Matches the filter every reader already uses.
CREATE OR REPLACE VIEW v_contact_freshness AS
SELECT
  count(*)                                                          AS active_contacts,
  count(*) FILTER (WHERE verified_at >= now() - interval '1 day')    AS verified_24h,
  count(*) FILTER (WHERE verified_at >= now() - interval '7 days')   AS verified_7d,
  count(*) FILTER (WHERE verified_at IS NULL)                        AS never_verified,
  round(100.0 * count(*) FILTER (WHERE verified_at >= now() - interval '7 days')
        / greatest(count(*), 1), 2)                                  AS pct_verified_7d
FROM contacts
WHERE deleted_at IS NULL;
