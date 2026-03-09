-- Workflow Intelligence Schema - Additional tables for deep workflow analysis
-- This migration adds tables for workflow steps, connections, triggers, actions, and snapshots

-- ============================================================
-- Add raw_json column to existing workflows table
-- ============================================================
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS raw_json JSONB DEFAULT '{}';

-- ============================================================
-- Workflow Steps
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  step_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_order INT,
  step_type TEXT,
  delay_minutes INT DEFAULT 0,
  template_id TEXT,
  branch_condition TEXT,
  raw_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflow_steps_workflow ON workflow_steps(workflow_id);
CREATE INDEX idx_workflow_steps_type ON workflow_steps(step_type);

-- ============================================================
-- Workflow Connections (graph edges between steps)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  from_step TEXT NOT NULL,
  to_step TEXT NOT NULL,
  condition TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflow_connections_workflow ON workflow_connections(workflow_id);
CREATE INDEX idx_workflow_connections_from ON workflow_connections(from_step);
CREATE INDEX idx_workflow_connections_to ON workflow_connections(to_step);

-- ============================================================
-- Workflow Triggers
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_triggers (
  trigger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  trigger_event TEXT,
  trigger_value TEXT,
  raw_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflow_triggers_workflow ON workflow_triggers(workflow_id);
CREATE INDEX idx_workflow_triggers_event ON workflow_triggers(trigger_event);
CREATE INDEX idx_workflow_triggers_event_value ON workflow_triggers(trigger_event, trigger_value);

-- ============================================================
-- Workflow Actions
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_actions (
  action_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  step_id TEXT,
  action_type TEXT,
  action_target TEXT,
  raw_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflow_actions_workflow ON workflow_actions(workflow_id);
CREATE INDEX idx_workflow_actions_type ON workflow_actions(action_type);
CREATE INDEX idx_workflow_actions_step ON workflow_actions(step_id);

-- ============================================================
-- Workflow Snapshots (version history for drift detection)
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_snapshots (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  json_structure JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_workflow_snapshots_workflow ON workflow_snapshots(workflow_id);
CREATE INDEX idx_workflow_snapshots_version ON workflow_snapshots(workflow_id, version);

-- ============================================================
-- Enable Row Level Security on new tables
-- ============================================================
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_snapshots ENABLE ROW LEVEL SECURITY;

-- Service role policy (full access for the MCP server)
CREATE POLICY "Service role full access" ON workflow_steps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflow_connections FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflow_triggers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflow_actions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access" ON workflow_snapshots FOR ALL USING (true) WITH CHECK (true);
