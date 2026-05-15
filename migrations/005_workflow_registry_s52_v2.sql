-- ============================================================================
-- Migration: workflow_registry entry for S5.2 v2 (Spec v1.2)
-- Date: 2026-05-14
-- ----------------------------------------------------------------------------
-- Adds the new S5.2 v2 policy executor workflow to the canonical registry
-- and marks the legacy S5.2 workflow (613dbbbd-...) as deprecated.
--
-- Run this in the HL MCP Supabase SQL Editor.
--
-- NOTE: This migration assumes workflow_registry already exists with the
-- columns referenced below. The HL MCP schema is canonical-code aware
-- (see src/tools/contamination-check.ts).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Mark the legacy S5.2 workflow as deprecated
-- ----------------------------------------------------------------------------
UPDATE workflow_registry
SET
  deprecated         = true,
  deprecation_reason = 'Replaced by S5.2 v2 (policy executor) — Spec v1.2',
  deprecation_date   = now(),
  canonical_code     = 'S5.2-legacy'
WHERE workflow_id = '613dbbbd-b7af-4be0-81fa-371f3e1d7b14';

-- ----------------------------------------------------------------------------
-- 2. Insert (or upsert) the new S5.2 v2 workflow
-- ----------------------------------------------------------------------------
INSERT INTO workflow_registry (
  workflow_id,
  canonical_code,
  canonical_name,
  stage_family,
  psychological_stage,
  trust_state,
  message_pressure_level,
  cadence_profile,
  allowed_trust_states,
  routes_to,
  receives_from,
  status,
  notes
) VALUES (
  '0a6a1349-0b44-429b-91e1-4c5be264cd9f',
  'S5.2',
  'S5.2 Appointment Rescue (Policy Executor)',
  'S5.x',
  'rescue',
  'recent-momentum',
  'low-moderate',
  'state-driven',
  ARRAY['recent-momentum', 'fragile-momentum'],
  ARRAY['APPT-Handler', 'L.5'],
  ARRAY['Decision-Engine'],
  'active',
  'Policy executor for APPOINTMENT_FRICTION.* and APPOINTMENT_DISRUPTION.* per Spec v1.2. State substrate lives in LP MCP Supabase.'
)
ON CONFLICT (workflow_id) DO UPDATE SET
  canonical_code         = EXCLUDED.canonical_code,
  canonical_name         = EXCLUDED.canonical_name,
  stage_family           = EXCLUDED.stage_family,
  psychological_stage    = EXCLUDED.psychological_stage,
  trust_state            = EXCLUDED.trust_state,
  message_pressure_level = EXCLUDED.message_pressure_level,
  cadence_profile        = EXCLUDED.cadence_profile,
  allowed_trust_states   = EXCLUDED.allowed_trust_states,
  routes_to              = EXCLUDED.routes_to,
  receives_from          = EXCLUDED.receives_from,
  status                 = EXCLUDED.status,
  notes                  = EXCLUDED.notes;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification
-- ----------------------------------------------------------------------------
-- SELECT workflow_id, canonical_code, status, deprecated, deprecation_reason
-- FROM workflow_registry
-- WHERE workflow_id IN (
--   '613dbbbd-b7af-4be0-81fa-371f3e1d7b14',
--   '0a6a1349-0b44-429b-91e1-4c5be264cd9f'
-- );
