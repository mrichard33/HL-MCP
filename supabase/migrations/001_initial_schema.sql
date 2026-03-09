-- GoHighLevel Workflow Intelligence MCP - Initial Schema
-- This migration creates all tables needed for GHL CRM & Workflow data caching

-- ============================================================
-- Contacts
-- ============================================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_contact_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  company_name TEXT,
  tags TEXT[] DEFAULT '{}',
  source TEXT,
  custom_fields JSONB DEFAULT '{}',
  date_added TIMESTAMPTZ,
  date_updated TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contacts_ghl_id ON contacts(ghl_contact_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE INDEX idx_contacts_tags ON contacts USING GIN(tags);

-- ============================================================
-- Pipelines
-- ============================================================
CREATE TABLE IF NOT EXISTS pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_pipeline_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  stages JSONB DEFAULT '[]',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Opportunities (Deals)
-- ============================================================
CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_opportunity_id TEXT UNIQUE NOT NULL,
  ghl_pipeline_id TEXT NOT NULL,
  ghl_stage_id TEXT,
  ghl_contact_id TEXT,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  monetary_value NUMERIC(12, 2),
  currency TEXT DEFAULT 'USD',
  source TEXT,
  assigned_to TEXT,
  custom_fields JSONB DEFAULT '{}',
  date_added TIMESTAMPTZ,
  date_updated TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_opportunities_ghl_id ON opportunities(ghl_opportunity_id);
CREATE INDEX idx_opportunities_pipeline ON opportunities(ghl_pipeline_id);
CREATE INDEX idx_opportunities_contact ON opportunities(ghl_contact_id);
CREATE INDEX idx_opportunities_status ON opportunities(status);

-- ============================================================
-- Workflows
-- ============================================================
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_workflow_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  version INT DEFAULT 1,
  trigger_type TEXT,
  trigger_config JSONB DEFAULT '{}',
  actions JSONB DEFAULT '[]',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflows_ghl_id ON workflows(ghl_workflow_id);
CREATE INDEX idx_workflows_status ON workflows(status);

-- ============================================================
-- Workflow Executions (Run history)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_workflow_id TEXT NOT NULL,
  ghl_contact_id TEXT,
  ghl_location_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  steps_completed INT DEFAULT 0,
  steps_total INT DEFAULT 0,
  error_message TEXT,
  execution_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_executions_workflow ON workflow_executions(ghl_workflow_id);
CREATE INDEX idx_executions_status ON workflow_executions(status);
CREATE INDEX idx_executions_started ON workflow_executions(started_at);

-- ============================================================
-- Conversations
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_conversation_id TEXT UNIQUE NOT NULL,
  ghl_contact_id TEXT NOT NULL,
  ghl_location_id TEXT,
  type TEXT DEFAULT 'sms',
  status TEXT DEFAULT 'open',
  last_message_at TIMESTAMPTZ,
  unread_count INT DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_conversations_ghl_id ON conversations(ghl_conversation_id);
CREATE INDEX idx_conversations_contact ON conversations(ghl_contact_id);

-- ============================================================
-- Messages
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_message_id TEXT UNIQUE NOT NULL,
  ghl_conversation_id TEXT NOT NULL,
  ghl_contact_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type TEXT DEFAULT 'sms',
  body TEXT,
  status TEXT DEFAULT 'delivered',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_messages_conversation ON messages(ghl_conversation_id);
CREATE INDEX idx_messages_sent ON messages(sent_at);

-- ============================================================
-- Sync Log (track data synchronization)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  sync_type TEXT NOT NULL DEFAULT 'full',
  status TEXT NOT NULL DEFAULT 'running',
  records_synced INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_sync_log_entity ON sync_log(entity_type);
CREATE INDEX idx_sync_log_status ON sync_log(status);

-- ============================================================
-- Enable Row Level Security
-- ============================================================
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_log ENABLE ROW LEVEL SECURITY;

-- Service role policy (full access for the MCP server)
CREATE POLICY "Service role full access" ON contacts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON pipelines FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON opportunities FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflows FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflow_executions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON messages FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON sync_log FOR ALL USING (true) WITH CHECK (true);
