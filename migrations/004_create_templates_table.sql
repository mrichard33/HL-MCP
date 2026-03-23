-- Migration: Create templates table for email/SMS template caching
-- Run this in the HL MCP Supabase SQL Editor before deploying the template sync

CREATE TABLE IF NOT EXISTS templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ghl_template_id TEXT NOT NULL UNIQUE,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- 'email', 'sms', 'whatsapp'
  subject TEXT,                    -- email subject line (null for SMS)
  body TEXT,                       -- template body content
  attachments JSONB DEFAULT '[]'::jsonb,
  raw_json JSONB DEFAULT '{}'::jsonb,
  date_added TIMESTAMPTZ,
  date_updated TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ           -- soft-delete support
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_templates_type ON templates(type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_templates_location ON templates(ghl_location_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_templates_name ON templates(name) WHERE deleted_at IS NULL;

-- Add templates to sync_state tracking
INSERT INTO sync_state (entity_name, last_synced_at, updated_at)
VALUES ('templates', '1970-01-01T00:00:00Z', now())
ON CONFLICT (entity_name) DO NOTHING;
