-- 017_contacts_address_columns.sql
-- address1 / city / state / postal_code on the GHL contacts mirror, plus the
-- two indexes the LP↔GHL link repair and its daily monitor scan on.
--
-- ⚠️ NOT APPLIED BY THIS PR. Mark applies it in the Supabase dashboard, against
-- the HL project (hl-workflow-intelligence-mcp), NOT the LP one. `contacts`
-- only exists here. DDL is dashboard-only per LP-MCP sql/README.md, and nothing
-- in this repo runs it at boot.
--
-- WHERE THE HANDOFF PUT IT. The 2026-09-18 handoff named this file
-- `sql/122_contacts_address_columns.sql` in LP-MCP. It is here instead, because
-- `contacts` lives in the HL Supabase and HL-MCP owns its migrations
-- (001–016). A copy in LP-MCP/sql/ would sit next to 121 other files that all
-- target the LP project and would invite being pasted into the wrong database,
-- where there is no `contacts` table to alter. LP-MCP carries its own
-- sql/122_lp_link_repair_indexes.sql for the LP-side index; the two are
-- separate migrations against separate projects and neither implies the other.
--
-- WHY THESE COLUMNS
-- ─────────────────
-- Market assignment, service-area checks and dedup all currently need a LIVE
-- GHL fetch because the mirror has no address at all. Verified 2026-09-18 on
-- 25,003 contacts: no address, city, state or postal column exists, and
-- custom_fields is not a usable fallback — 68 rows hold anything zip-like and
-- 358 anything address-like.
--
-- The immediate consumer is tier 2 of scripts/repair-lp-ghl-links.js (LP-MCP),
-- which raises a phone match to `confidence: high` when the zips agree. It
-- probes for postal_code and falls back to a live GHL read when the column is
-- absent, so THE REPAIR DOES NOT DEPEND ON THIS MIGRATION and neither blocks
-- the other.
--
-- WHY THE PHONE INDEX IS HERE AND NOT OPTIONAL
-- ────────────────────────────────────────────
-- GHL stores `+13524453161`; LP stores `3524453161`. Measured over the live
-- 344-opportunity cohort on 2026-09-18, a full-string compare across that
-- boundary matches 0 rows and a last-10-digit compare matches 110. Every match
-- in the repair and in the daily leak monitor therefore goes through
-- `right(regexp_replace(phone,'[^0-9]','','g'), 10)`, and without an index on
-- exactly that expression both table-scan 25k contacts on every pass.
--
-- Additive and idempotent, like every migration in this directory. Only
-- `contacts` is touched, which exists in both lineages (001_initial_schema), so
-- no to_regclass guard is needed (cf. the templates note in 015).
--
-- ROLLBACK:
--   ALTER TABLE contacts DROP COLUMN IF EXISTS address1;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS city;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS state;
--   ALTER TABLE contacts DROP COLUMN IF EXISTS postal_code;
--   DROP INDEX IF EXISTS idx_contacts_postal;
--   DROP INDEX IF EXISTS idx_contacts_phone10;
-- Dropping the columns is safe: syncContacts writes them but nothing reads them
-- for a decision, and the repair script probes for postal_code before using it.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address1    text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city        text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state       text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS postal_code text;

COMMENT ON COLUMN contacts.postal_code IS
  'GHL contact postalCode, mirrored by syncContacts. Never nulled by a payload that omits it — see contactHashableContent in src/extractor/entity-syncer.ts.';

CREATE INDEX IF NOT EXISTS idx_contacts_postal ON contacts (postal_code);

CREATE INDEX IF NOT EXISTS idx_contacts_phone10
  ON contacts (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10));

-- AFTER RUNNING — A FORCED RE-SYNC IS REQUIRED, AND A NORMAL ONE WILL NOT DO IT.
-- ─────────────────────────────────────────────────────────────────────────────
-- syncContacts is gated on payload_hash (015_payload_hashes.sql): an unchanged
-- contact is skipped and never written. All four columns above therefore stay
-- NULL on the existing 25,003 rows through any number of ordinary 15-minute
-- cycles — the gate cannot know the row is missing a column it has never seen.
--
-- The address is now INSIDE the hashed content, so the hash of every contact
-- changes the moment the new code deploys, and the next cycle rewrites all
-- 25,003 rows once, by itself. That is the intended path and it needs no flag.
--
-- If that pass is missed or has to be repeated, force one explicitly:
--
--   GHL_CONTACT_DELTA_MODE=off   → skips the gate entirely for one deploy,
--                                  then set it back. (See utils/delta-gate.ts.)
--
--   -- or, to re-arm the gate for a single cycle without a redeploy:
--   UPDATE contacts SET payload_hash = NULL WHERE postal_code IS NULL;
--
-- Either is SAFE TO RUN AFTER THE LINK REPAIR rather than before: tier 2 of the
-- repair falls back to a live GHL read per contact when postal_code is absent,
-- and the candidate set is a few hundred.
