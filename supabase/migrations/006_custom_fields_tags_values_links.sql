-- Custom Fields, Tags, Custom Values, and Trigger Links tables
-- Adds tables for syncing GHL account-level configuration data

-- ============================================================
-- Custom Fields (field definitions from the HighLevel account)
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_field_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  field_key TEXT,
  data_type TEXT,
  placeholder TEXT,
  position INT,
  model TEXT,
  raw_json JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_custom_fields_ghl_id ON custom_fields(ghl_field_id);
CREATE INDEX idx_custom_fields_model ON custom_fields(model);
CREATE INDEX idx_custom_fields_key ON custom_fields(field_key);

-- ============================================================
-- Custom Values (location-level key-value pairs)
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_value_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  field_key TEXT,
  value TEXT,
  raw_json JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_custom_values_ghl_id ON custom_values(ghl_value_id);
CREATE INDEX idx_custom_values_key ON custom_values(field_key);

-- ============================================================
-- Tags (all tags in the account)
-- ============================================================
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_tag_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT NOT NULL,
  raw_json JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tags_ghl_id ON tags(ghl_tag_id);
CREATE INDEX idx_tags_name ON tags(name);

-- ============================================================
-- Trigger Links (links managed in HighLevel)
-- ============================================================
CREATE TABLE IF NOT EXISTS trigger_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_link_id TEXT UNIQUE NOT NULL,
  ghl_location_id TEXT,
  name TEXT,
  redirect_to TEXT,
  url TEXT,
  raw_json JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_trigger_links_ghl_id ON trigger_links(ghl_link_id);
CREATE INDEX idx_trigger_links_name ON trigger_links(name);

-- ============================================================
-- Seed sync_state rows for new entities
-- ============================================================
INSERT INTO sync_state (entity_name) VALUES
  ('custom_fields'),
  ('custom_values'),
  ('tags'),
  ('trigger_links')
ON CONFLICT (entity_name) DO NOTHING;

-- ============================================================
-- Enable Row Level Security
-- ============================================================
ALTER TABLE custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_links ENABLE ROW LEVEL SECURITY;

-- Service role policy (full access for the MCP server)
CREATE POLICY "Service role full access" ON custom_fields FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON custom_values FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON tags FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON trigger_links FOR ALL USING (true) WITH CHECK (true);
