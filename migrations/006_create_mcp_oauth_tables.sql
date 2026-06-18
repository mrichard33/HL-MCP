-- Migration: Inbound connector OAuth persistence (Claude.ai → HL MCP)
-- Run in the HL MCP Supabase SQL Editor BEFORE deploying the auth/oauth.ts v2 change.
--
-- Replaces the previous in-memory token store. Persisting these tables is what
-- lets the Claude.ai connector survive Railway redeploys/restarts without a
-- re-authentication prompt. Mirrors the durable pattern of ghl_oauth_tokens.

CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_secret  TEXT NOT NULL,
  redirect_uris  TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_auth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
  token       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
  token       TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_access_tokens_expires ON mcp_oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_auth_codes_expires ON mcp_oauth_auth_codes(expires_at);
