/**
 * Template Sync — fetches email/SMS templates from GHL location templates API
 * and caches them in Supabase.
 *
 * Uses GET /locations/:locationId/templates (API version 2021-07-28)
 * Paginated via skip/limit. Supports type filter (email, sms, whatsapp).
 */

import { getSupabaseClient } from '../clients/supabase.js';
import { updateLastSynced } from './entity-syncer.js';
import { nowET } from '../utils/timezone.js';
import { softDeleteMissing } from './entity-syncer.js';
import type { GHLTemplate } from '../types/ghl.js';

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';

/**
 * Fetch all templates from GHL location templates API with pagination.
 * This uses the /locations/:locationId/templates endpoint, which
 * returns both email and SMS templates in a single paginated response.
 */
async function fetchAllLocationTemplates(): Promise<GHLTemplate[]> {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const baseUrl = process.env.GHL_BASE_URL || DEFAULT_BASE_URL;

  if (!apiKey || !locationId) {
    throw new Error('GHL_API_KEY and GHL_LOCATION_ID are required for template sync');
  }

  const all: GHLTemplate[] = [];
  const PAGE_SIZE = 100;
  let skip = 0;
  let totalCount = Infinity;

  while (skip < totalCount) {
    const url = new URL(`/locations/${locationId}/templates`, baseUrl);
    url.searchParams.set('originId', locationId);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('skip', String(skip));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL Templates API ${response.status}: ${errorBody}`);
    }

    const data = await response.json() as { templates: GHLTemplate[]; totalCount: number };
    const templates = data.templates || [];
    totalCount = data.totalCount || 0;

    all.push(...templates);
    skip += templates.length;

    // Safety: if API returns empty page, stop
    if (templates.length === 0) break;

    // Rate limit courtesy: small delay between pages
    if (skip < totalCount) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  return all;
}

// ---- Sync Log Helpers (reuse pattern from entity-syncer) ----

async function logSyncStart(entityType: string): Promise<string | null> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('sync_log')
    .insert({ entity_type: entityType, sync_type: 'incremental', status: 'running' })
    .select('id')
    .single();
  return data?.id || null;
}

async function logSyncComplete(syncLogId: string | null, recordsSynced: number): Promise<void> {
  if (!syncLogId) return;
  const supabase = getSupabaseClient();
  await supabase.from('sync_log').update({
    status: 'completed',
    records_synced: recordsSynced,
    completed_at: nowET(),
  }).eq('id', syncLogId);
}

async function logSyncFailed(syncLogId: string | null, errorMessage: string): Promise<void> {
  if (!syncLogId) return;
  const supabase = getSupabaseClient();
  await supabase.from('sync_log').update({
    status: 'failed',
    error_message: errorMessage,
    completed_at: nowET(),
  }).eq('id', syncLogId);
}

// ---- Main Sync Function ----

export async function syncTemplates(): Promise<{ synced: number; errors: string[] }> {
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('templates');
  const locationId = process.env.GHL_LOCATION_ID || '';
  const now = nowET();
  let synced = 0;

  try {
    const templates = await fetchAllLocationTemplates();
    console.log(`[TemplateSync] Fetched ${templates.length} templates from GHL`);

    for (const t of templates) {
      try {
        await supabase.from('templates').upsert(
          {
            ghl_template_id: t.id,
            ghl_location_id: locationId,
            name: t.name || 'Untitled',
            type: t.type || 'email',
            subject: t.subject || null,
            body: t.body || null,
            attachments: t.attachments || [],
            raw_json: t,
            date_added: t.dateAdded || null,
            date_updated: t.dateUpdated || null,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_template_id' },
        );
        synced++;
      } catch (err) {
        errors.push(`Template ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete templates no longer in GHL
    const activeIds = templates.map(t => t.id);
    await softDeleteMissing('templates', 'ghl_template_id', activeIds, locationId);

    await updateLastSynced('templates');
    await logSyncComplete(syncLogId, synced);
    console.log(`[TemplateSync] Templates synced: ${synced} (${errors.length} errors)`);
    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[TemplateSync] Template sync failed: ${msg}`);
    return { synced: 0, errors };
  }
}
