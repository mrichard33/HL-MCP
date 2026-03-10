-- ============================================================
-- GHL OAuth Token Storage
-- Persists OAuth 2.0 tokens so they survive server restarts.
-- One row per GHL location (most setups have exactly one).
-- ============================================================

CREATE TABLE IF NOT EXISTS ghl_oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id TEXT UNIQUE NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE ghl_oauth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON ghl_oauth_tokens FOR ALL USING (true) WITH CHECK (true);
