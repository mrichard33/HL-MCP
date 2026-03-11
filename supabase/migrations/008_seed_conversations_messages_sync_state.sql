-- Seed sync_state rows for conversations and messages entities
-- so they are tracked alongside contacts, opportunities, etc.
INSERT INTO sync_state (entity_name) VALUES
  ('conversations'),
  ('messages')
ON CONFLICT (entity_name) DO NOTHING;
