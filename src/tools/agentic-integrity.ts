/**
 * Agentic Integrity Tools — src/tools/agentic-integrity.ts
 *
 * Two tools that pair with the LP MCP MVI Antifragile v2.5 patches:
 *
 *   audit_namespace_violations
 *     Returns contacts whose tags stack within an exclusive namespace.
 *     Use case: catch tag-stacking that slipped past the LP MCP write-time
 *     enforcement, plus a one-time cleanup of historical violations.
 *
 *   get_drift_candidates
 *     Returns contacts carrying a closure tag (default
 *     stage:long-term-nurture) that haven't been updated in the configured
 *     lookback. Used by the LP MCP drift detector to find contacts where
 *     GHL looks closed but LP disposition may still be active.
 *
 * Both tools query the HL MCP contacts cache (Supabase). They do NOT call
 * the GHL API — the cache is the read path of record for these queries
 * because syncs run frequently and the latency of a per-contact GHL fetch
 * would make the audit O(n) GHL calls.
 */

import { z } from 'zod';
import { getSupabaseClient } from '../clients/supabase.js';

const DEFAULT_NAMESPACES = ['p3:', 'loss-reason:', 'stage:', 'active-entry:', 'buyer:'];

// LP custom field IDs as configured in GHL. Mirrors lp-mcp/src/actions/resolvers.js
// (FIELD_LP_PROSPECT_ID = 'ZRQAVrzhtzApzLlHmT87'). The drift candidate tool
// reads both the prospect and lead ID. The lead ID field is the `BbUJ6...`
// per the handoff doc; if production uses a different ID, set
// HL_FIELD_LP_PROSPECT_ID / HL_FIELD_LP_LEAD_ID env vars to override.
const FIELD_LP_PROSPECT_ID = process.env.HL_FIELD_LP_PROSPECT_ID || 'ZRQAVrzhtzApzLlHmT87';
const FIELD_LP_LEAD_ID = process.env.HL_FIELD_LP_LEAD_ID || 'BbUJ6RrdTjjEqqRA8JVx';

type CustomFieldEntry = { id?: string; value?: unknown };

function decodeCustomField(customFields: unknown, fieldId: string): string | null {
  if (!customFields) return null;
  if (Array.isArray(customFields)) {
    const f = (customFields as CustomFieldEntry[]).find((x) => x?.id === fieldId);
    if (!f || f.value === null || f.value === undefined) return null;
    const trimmed = String(f.value).trim();
    if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'null') return null;
    return trimmed;
  }
  if (typeof customFields === 'object') {
    const obj = customFields as Record<string, unknown>;
    const raw = obj[fieldId];
    if (raw === null || raw === undefined) return null;
    const trimmed = String(raw).trim();
    if (!trimmed || trimmed.toLowerCase() === 'none' || trimmed.toLowerCase() === 'null') return null;
    return trimmed;
  }
  return null;
}

export const agenticIntegrityTools = {
  audit_namespace_violations: {
    description:
      'Audit contacts for tag-stacking within exclusive namespaces (p3:, loss-reason:, stage:, active-entry:, buyer:). Returns one entry per (contact, namespace) where more than one tag from that family is present. Pair with LP MCP namespace exclusivity enforcement.',
    inputSchema: z.object({
      namespaces: z.array(z.string()).optional().describe(
        'Tag prefixes to audit. Defaults to ["p3:", "loss-reason:", "stage:", "active-entry:", "buyer:"].'
      ),
      limit: z.number().optional().default(500).describe('Max contacts to scan (default 500)'),
      contact_id: z.string().optional().describe('Optional: scope the audit to a single GHL contact ID'),
    }),
    handler: async (args: { namespaces?: string[]; limit?: number; contact_id?: string }) => {
      const namespaces = args.namespaces && args.namespaces.length > 0 ? args.namespaces : DEFAULT_NAMESPACES;
      const limit = Math.max(1, Math.min(args.limit ?? 500, 5000));
      const supabase = getSupabaseClient();

      let qb = supabase
        .from('contacts')
        .select('ghl_contact_id, tags')
        .is('deleted_at', null)
        .not('tags', 'is', null)
        .limit(limit);

      if (args.contact_id) qb = qb.eq('ghl_contact_id', args.contact_id);

      const { data, error } = await qb;
      if (error) throw new Error(`Supabase error: ${error.message}`);

      type Violation = { contact_id: string; namespace: string; tags: string[] };
      const violations: Violation[] = [];

      for (const row of data || []) {
        const ghlId = (row as Record<string, unknown>).ghl_contact_id as string;
        const rawTags = (row as Record<string, unknown>).tags;
        const tags: string[] = Array.isArray(rawTags) ? (rawTags as string[]) : [];
        if (!ghlId || tags.length === 0) continue;

        for (const ns of namespaces) {
          const matching = tags.filter((t) => typeof t === 'string' && t.startsWith(ns));
          if (matching.length > 1) {
            violations.push({ contact_id: ghlId, namespace: ns, tags: matching });
          }
        }
      }

      return {
        scanned: data?.length || 0,
        namespaces,
        violation_count: violations.length,
        violations,
        source: 'supabase',
      };
    },
  },

  get_drift_candidates: {
    description:
      'Returns contacts that look closed in GHL (carrying the closure_tag, e.g. stage:long-term-nurture) but were last updated more than closed_for_hours ago. Used by the LP MCP drift detector to cross-check against active LP dispositions. Decodes lp_prospect_id and lp_lead_id from custom fields.',
    inputSchema: z.object({
      closure_tag: z.string().describe('Tag indicating GHL-side closure (e.g. "stage:long-term-nurture")'),
      closed_for_hours: z.number().optional().default(24).describe('Min hours since date_updated. Default 24.'),
      limit: z.number().optional().default(1000).describe('Max contacts to return. Default 1000.'),
    }),
    handler: async (args: { closure_tag: string; closed_for_hours?: number; limit?: number }) => {
      const closedForHours = args.closed_for_hours ?? 24;
      const limit = Math.max(1, Math.min(args.limit ?? 1000, 5000));
      const cutoff = new Date(Date.now() - closedForHours * 3_600_000).toISOString();
      const supabase = getSupabaseClient();

      // Try array-containment first (text[] schema). If the tags column
      // is JSONB, this will surface as a query error and we fall back.
      let data: Record<string, unknown>[] | null = null;
      let lastError: string | null = null;
      try {
        const result = await supabase
          .from('contacts')
          .select('ghl_contact_id, custom_fields, date_updated, tags')
          .is('deleted_at', null)
          .contains('tags', [args.closure_tag] as unknown as string)
          .lte('date_updated', cutoff)
          .limit(limit);
        if (result.error) {
          lastError = result.error.message;
        } else {
          data = result.data as unknown as Record<string, unknown>[];
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      // Fallback: JSONB containment using the cs (contains) filter.
      if (!data) {
        const result = await supabase
          .from('contacts')
          .select('ghl_contact_id, custom_fields, date_updated, tags')
          .is('deleted_at', null)
          .filter('tags', 'cs', JSON.stringify([args.closure_tag]))
          .lte('date_updated', cutoff)
          .limit(limit);
        if (result.error) {
          throw new Error(`Supabase error (both schema attempts failed): array=${lastError}; jsonb=${result.error.message}`);
        }
        data = result.data as unknown as Record<string, unknown>[];
      }

      const contacts = (data || []).map((row) => {
        const ghlId = row.ghl_contact_id as string;
        const customFields = row.custom_fields;
        const lpProspectId = decodeCustomField(customFields, FIELD_LP_PROSPECT_ID);
        const lpLeadId = decodeCustomField(customFields, FIELD_LP_LEAD_ID);
        return {
          contact_id: ghlId,
          lp_prospect_id: lpProspectId,
          lp_lead_id: lpLeadId,
          closed_at: row.date_updated as string | null,
        };
      }).filter((x) => x.lp_prospect_id);

      return {
        scanned: data?.length || 0,
        contacts,
        closure_tag: args.closure_tag,
        closed_for_hours: closedForHours,
        source: 'supabase',
      };
    },
  },
};
