/**
 * WP GHL Projection — src/wp/ghl-projection.ts
 *
 * Projects Weakest Point page events onto the GHL contact via the repo's
 * existing GHLClient (tags, custom fields, optional workflow enrollment).
 * Custom-field keys are resolved to GHL field IDs at runtime through a
 * cached lookup; fields that don't exist yet in GHL are logged and skipped
 * (Mark creates them manually).
 *
 * Event -> action map lives in projectEventToGhl. Idempotency is enforced
 * by the caller (src/wp/telemetry.ts) against wp_page_events.ghl_synced.
 */

import { GHLClient } from '../clients/ghl.js';

/** Intended custom-field keys (GHL fieldKey arrives as "contact.<key>"). */
const WP_FIELD_KEYS = [
  'wp_gate_status',
  'wp_last_engaged',
  'wp_risk_grade',
  'wp_weakest_point',
  'wp_watch_pct',
] as const;

type WpFieldKey = (typeof WP_FIELD_KEYS)[number];

const FIELD_CACHE_TTL_MS = 10 * 60 * 1000;

let fieldCache: { map: Map<WpFieldKey, string>; fetchedAt: number } | null = null;

async function getWpFieldIdMap(ghl: GHLClient): Promise<Map<WpFieldKey, string>> {
  if (fieldCache && Date.now() - fieldCache.fetchedAt < FIELD_CACHE_TTL_MS) {
    return fieldCache.map;
  }
  const fields = await ghl.getCustomFields();
  const map = new Map<WpFieldKey, string>();
  for (const field of fields) {
    const byKey = (field.fieldKey ?? '').replace(/^contact\./, '').toLowerCase();
    const byName = (field.name ?? '').toLowerCase().replace(/\s+/g, '_');
    for (const key of WP_FIELD_KEYS) {
      if (byKey === key || byName === key) map.set(key, field.id);
    }
  }
  fieldCache = { map, fetchedAt: Date.now() };
  return map;
}

interface WpProjectionEvent {
  event: string;
  contactId: string;
  clientTs: string;
  data: Record<string, unknown>;
}

/**
 * Apply the GHL side effects for one resolved event. Throws on failure so
 * the caller leaves ghl_synced=false and the projection retries on the next
 * occurrence of the same event.
 */
export async function projectEventToGhl(evt: WpProjectionEvent): Promise<void> {
  const ghl = new GHLClient();
  const fieldIds = await getWpFieldIdMap(ghl);

  const fields: Array<{ id: string; field_value: string | number }> = [];
  const addField = (key: WpFieldKey, value: string | number) => {
    const id = fieldIds.get(key);
    if (!id) {
      console.warn(`[wp-ghl] custom field "${key}" not found in GHL — skipping (create it in GHL to enable)`);
      return;
    }
    fields.push({ id, field_value: value });
  };

  const tags: string[] = [];

  switch (evt.event) {
    case 'gate_complete':
      tags.push('wp:gate-complete');
      addField('wp_gate_status', 'complete');
      addField('wp_last_engaged', evt.clientTs);
      break;

    case 'gate_start':
      // Custom fields only — no tag, to avoid tag noise
      addField('wp_gate_status', 'started');
      addField('wp_last_engaged', evt.clientTs);
      break;

    case 'cta_click':
      tags.push('wp:cta-click');
      addField('wp_last_engaged', evt.clientTs);
      break;

    case 'guide_cta_click':
      // Documented Home Protection Guide (/guide) — Protection Profile Review CTA.
      // Distinct tag so agent_rules can route on guide intent separately from
      // the film-page CTA.
      tags.push('guide:cta-click');
      addField('wp_last_engaged', evt.clientTs);
      break;

    case 'report_ready':
      // data also carries total_opportunity_cost and static_load — Supabase only
      if (evt.data.grade !== undefined) addField('wp_risk_grade', String(evt.data.grade));
      if (evt.data.weakest_point !== undefined) addField('wp_weakest_point', String(evt.data.weakest_point));
      break;

    case 'video_progress': {
      // wp_watch_pct = max(existing, data.pct) — only write on increase
      const pct = Number(evt.data.pct);
      if (!Number.isFinite(pct)) return;
      const fieldId = fieldIds.get('wp_watch_pct');
      if (!fieldId) {
        console.warn('[wp-ghl] custom field "wp_watch_pct" not found in GHL — skipping');
        return;
      }
      const contact = await ghl.getContact(evt.contactId);
      const existingEntry = (contact.customFields ?? []).find((f) => String(f.id) === fieldId);
      const existing = Number(existingEntry?.value ?? 0) || 0;
      if (pct > existing) fields.push({ id: fieldId, field_value: pct });
      break;
    }

    default:
      return; // page_view and anything else: Supabase only
  }

  if (tags.length > 0) {
    await ghl.addContactTags(evt.contactId, tags);
  }
  if (fields.length > 0) {
    await ghl.updateContactCustomFields(evt.contactId, fields);
  }

  if (evt.event === 'gate_complete' && process.env.WP_FOLLOWUP_WORKFLOW_ID) {
    await ghl.enrollContactInWorkflow(process.env.WP_FOLLOWUP_WORKFLOW_ID, evt.contactId);
  }
}
