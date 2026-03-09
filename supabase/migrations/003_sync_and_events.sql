-- Supabase ↔ GoHighLevel Sync & Events Schema
-- Adds tables for webhook events, incremental sync tracking, appointments,
-- funnel progression, and webhook failure monitoring.

-- ============================================================
-- Lead Events (event history for funnel analysis)
-- ============================================================
CREATE TABLE IF NOT EXISTS lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_hash TEXT UNIQUE NOT NULL,
  contact_id TEXT,
  event_type TEXT NOT NULL,
  source_system TEXT NOT NULL DEFAULT 'highlevel',
  event_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lead_events_contact ON lead_events(contact_id);
CREATE INDEX idx_lead_events_type ON lead_events(event_type);
CREATE INDEX idx_lead_events_time ON lead_events(event_time);
CREATE INDEX idx_lead_events_hash ON lead_events(event_hash);

-- ============================================================
-- Sync State (incremental sync cursor tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_name TEXT UNIQUE NOT NULL,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed initial sync state rows
INSERT INTO sync_state (entity_name) VALUES
  ('contacts'),
  ('opportunities'),
  ('appointments'),
  ('workflows')
ON CONFLICT (entity_name) DO NOTHING;

-- ============================================================
-- Appointments
-- ============================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_appointment_id TEXT UNIQUE NOT NULL,
  ghl_contact_id TEXT,
  ghl_calendar_id TEXT,
  ghl_location_id TEXT,
  title TEXT,
  status TEXT DEFAULT 'confirmed',
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  assigned_to TEXT,
  raw_json JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_appointments_ghl_id ON appointments(ghl_appointment_id);
CREATE INDEX idx_appointments_contact ON appointments(ghl_contact_id);
CREATE INDEX idx_appointments_calendar ON appointments(ghl_calendar_id);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_start ON appointments(start_time);

-- ============================================================
-- Contact Funnel Progression (computed funnel stages)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_funnel_progression (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id TEXT UNIQUE NOT NULL,
  current_stage TEXT NOT NULL DEFAULT 'lead_created',
  stage_history JSONB DEFAULT '[]',
  last_computed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_funnel_contact ON contact_funnel_progression(contact_id);
CREATE INDEX idx_funnel_stage ON contact_funnel_progression(current_stage);

-- ============================================================
-- Webhook Failures (error tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL,
  event_type TEXT,
  error_message TEXT,
  payload JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_webhook_failures_endpoint ON webhook_failures(endpoint);
CREATE INDEX idx_webhook_failures_time ON webhook_failures(created_at);

-- ============================================================
-- Enable Row Level Security
-- ============================================================
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_funnel_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_failures ENABLE ROW LEVEL SECURITY;

-- Service role policy (full access for the MCP server)
CREATE POLICY "Service role full access" ON lead_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON sync_state FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON appointments FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON contact_funnel_progression FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON webhook_failures FOR ALL USING (true) WITH CHECK (true);
