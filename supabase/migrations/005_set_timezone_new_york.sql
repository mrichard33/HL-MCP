-- ============================================================
-- Set database timezone to America/New_York
-- All TIMESTAMPTZ values will display in Eastern Time by default.
-- ============================================================

ALTER DATABASE postgres SET timezone TO 'America/New_York';

-- Also set for the current session (takes effect immediately)
SET timezone = 'America/New_York';

-- Update all DEFAULT now() to use the New York timezone
-- (TIMESTAMPTZ stores absolute time, so now() is correct regardless,
-- but this ensures any TIMESTAMP WITHOUT TIME ZONE columns behave as expected)
