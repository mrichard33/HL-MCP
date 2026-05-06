/**
 * Contamination Check Tool — src/tools/contamination-check.ts
 *
 * Phase 2.5 of the Workflow Registry rollout. Runs ontology guardrail
 * audits against workflow_registry and returns any framework violations.
 *
 * Five violation classes:
 *   1. lever_stage_mismatch — urgency lever outside reactivation/conversion/support
 *   2. pressure_stage_mismatch — awareness stage with high/compression pressure
 *   3. compression_outside_reactivation — compression pressure outside Stage 5
 *   4. missing_trust_guardrail — user-facing high-pressure workflow without allowed_trust_states
 *   5. orphan_workflow — active stage workflow disconnected from the orchestration graph
 *
 * Designed for nightly cron via n8n. Optionally posts a GroupMe alert on
 * first violation (only when post_alert=true and violations exist).
 *
 * MVI v1.0 (2026-05-06).
 */

import { z } from 'zod';
import { getSupabaseClient } from '../clients/supabase.js';

type Violation = {
  violation_type: string;
  canonical_code: string;
  canonical_name: string;
  stage_family: string;
  psychological_stage: string | null;
  message_pressure_level: string | null;
  primary_copy_levers: string[] | null;
  detail: string;
};

type RegistryRow = {
  canonical_code: string;
  canonical_name: string;
  stage_family: string;
  psychological_stage: string | null;
  message_pressure_level: string | null;
  primary_copy_levers: string[] | null;
  allowed_trust_states: string[] | null;
  is_user_facing: boolean | null;
  routes_to: string[] | null;
  receives_from: string[] | null;
  status: string | null;
};

const REACTIVATION_STAGES = new Set(['reactivation', 'conversion', 'support']);
const HIGH_PRESSURE = new Set(['high', 'compression']);
const SYSTEM_FAMILIES = new Set(['I', 'U', 'B', 'EXT', 'LEGACY', 'A']);

function arrayLen(arr: string[] | null | undefined): number {
  return Array.isArray(arr) ? arr.length : 0;
}

export const contaminationCheckTools = {
  check_contamination: {
    description:
      'Audit workflow_registry for ontology violations: lever-stage mismatches, pressure-stage mismatches, compression outside reactivation, missing trust guardrails, orphan workflows. Optionally posts GroupMe alert when violations are found.',
    inputSchema: z.object({
      post_alert: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true and violations exist, post a GroupMe alert via GROUPME_BOT_ID env var.'),
      include_orphans: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include orphan workflow check (active stage workflows with no graph connections).'),
    }),
    handler: async (args: { post_alert?: boolean; include_orphans?: boolean }) => {
      const includeOrphans = args.include_orphans ?? true;
      const postAlert = args.post_alert ?? false;
      const supabase = getSupabaseClient();

      const { data, error } = await supabase
        .from('workflow_registry')
        .select(
          'canonical_code, canonical_name, stage_family, psychological_stage, message_pressure_level, primary_copy_levers, allowed_trust_states, is_user_facing, routes_to, receives_from, status',
        );

      if (error) throw new Error(`Supabase error: ${error.message}`);

      const rows = (data || []) as RegistryRow[];
      const violations: Violation[] = [];

      for (const row of rows) {
        const levers = row.primary_copy_levers || [];

        // 1. Lever-stage mismatch
        if (
          levers.includes('urgency') &&
          row.psychological_stage &&
          !REACTIVATION_STAGES.has(row.psychological_stage)
        ) {
          violations.push({
            violation_type: 'lever_stage_mismatch',
            canonical_code: row.canonical_code,
            canonical_name: row.canonical_name,
            stage_family: row.stage_family,
            psychological_stage: row.psychological_stage,
            message_pressure_level: row.message_pressure_level,
            primary_copy_levers: levers,
            detail: 'urgency lever used outside reactivation/conversion/support stage',
          });
        }

        // 2. Pressure-stage mismatch
        if (
          row.psychological_stage === 'awareness' &&
          row.message_pressure_level &&
          HIGH_PRESSURE.has(row.message_pressure_level)
        ) {
          violations.push({
            violation_type: 'pressure_stage_mismatch',
            canonical_code: row.canonical_code,
            canonical_name: row.canonical_name,
            stage_family: row.stage_family,
            psychological_stage: row.psychological_stage,
            message_pressure_level: row.message_pressure_level,
            primary_copy_levers: levers,
            detail: 'awareness-stage workflow carries high/compression pressure',
          });
        }

        // 3. Compression outside reactivation
        if (
          row.message_pressure_level === 'compression' &&
          row.psychological_stage !== 'reactivation'
        ) {
          violations.push({
            violation_type: 'compression_outside_reactivation',
            canonical_code: row.canonical_code,
            canonical_name: row.canonical_name,
            stage_family: row.stage_family,
            psychological_stage: row.psychological_stage,
            message_pressure_level: row.message_pressure_level,
            primary_copy_levers: levers,
            detail: 'compression pressure used outside Stage 5 reactivation',
          });
        }

        // 4. Missing trust guardrail
        if (
          row.is_user_facing === true &&
          row.message_pressure_level &&
          HIGH_PRESSURE.has(row.message_pressure_level) &&
          arrayLen(row.allowed_trust_states) === 0
        ) {
          violations.push({
            violation_type: 'missing_trust_guardrail',
            canonical_code: row.canonical_code,
            canonical_name: row.canonical_name,
            stage_family: row.stage_family,
            psychological_stage: row.psychological_stage,
            message_pressure_level: row.message_pressure_level,
            primary_copy_levers: levers,
            detail: 'user-facing high-pressure workflow missing allowed_trust_states guardrail',
          });
        }

        // 5. Orphan workflow
        if (
          includeOrphans &&
          row.status === 'active' &&
          !SYSTEM_FAMILIES.has(row.stage_family) &&
          arrayLen(row.routes_to) === 0 &&
          arrayLen(row.receives_from) === 0
        ) {
          violations.push({
            violation_type: 'orphan_workflow',
            canonical_code: row.canonical_code,
            canonical_name: row.canonical_name,
            stage_family: row.stage_family,
            psychological_stage: row.psychological_stage,
            message_pressure_level: row.message_pressure_level,
            primary_copy_levers: levers,
            detail: 'active stage workflow has no graph connections (no routes_to, no receives_from)',
          });
        }
      }

      // Group by violation type for the summary
      const byType: Record<string, number> = {};
      for (const v of violations) {
        byType[v.violation_type] = (byType[v.violation_type] || 0) + 1;
      }

      const result = {
        scanned: rows.length,
        violation_count: violations.length,
        by_type: byType,
        violations,
        scanned_at: new Date().toISOString(),
        source: 'workflow_registry',
      };

      // Optional GroupMe alert when violations exist
      if (postAlert && violations.length > 0) {
        const botId = process.env.GROUPME_BOT_ID;
        if (botId) {
          const summary = Object.entries(byType)
            .map(([k, n]) => `${k}: ${n}`)
            .join(' | ');
          const sample = violations
            .slice(0, 3)
            .map((v) => `${v.canonical_code} (${v.violation_type})`)
            .join(', ');
          const message = `🛡️ Contamination Check — ${violations.length} violation${violations.length === 1 ? '' : 's'} found.\n${summary}\n\nFirst few: ${sample}\n\nFull detail in n8n run.`;
          try {
            await fetch('https://api.groupme.com/v3/bots/post', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bot_id: botId, text: message.slice(0, 1000) }),
            });
          } catch (err) {
            console.error(
              '[contamination-check] GroupMe alert failed:',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }

      return result;
    },
  },
};
