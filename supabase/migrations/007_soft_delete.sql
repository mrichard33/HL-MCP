-- Soft-delete support for all GHL-synced tables
-- Adds a deleted_at column so records removed from GHL are preserved with an audit trail
-- rather than being hard-deleted from Supabase.

-- ============================================================
-- Add deleted_at to all synced entity tables
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE custom_values ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE trigger_links ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- ============================================================
-- Partial indexes for efficient "active only" queries
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(ghl_contact_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipelines_active ON pipelines(ghl_pipeline_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_active ON opportunities(ghl_opportunity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_active ON workflows(ghl_workflow_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appointments_active ON appointments(ghl_appointment_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_active ON conversations(ghl_conversation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_fields_active ON custom_fields(ghl_field_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_values_active ON custom_values(ghl_value_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tags_active ON tags(ghl_tag_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_trigger_links_active ON trigger_links(ghl_link_id) WHERE deleted_at IS NULL;
