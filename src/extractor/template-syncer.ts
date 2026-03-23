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
  const PAGE_SIZE = 25; // GHL default is 25 — match it
  let skip = 0;
  let totalCount = Infinity;
  let pageNum = 0;

  while (skip < totalCount) {
    pageNum++;
    const url = new URL(`/locations/${locationId}/templates`, baseUrl);
    url.searchParams.set('originId', locationId);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('skip', String(skip));

    console.log(`[TemplateSync] Fetching page ${pageNum}: ${url.toString()}`);

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Version: '2021-07-28',
        Accept: 'application/json',
      },
    });

    const statusCode = response.status;
    const rawBody = await response.text();

    // Debug: log raw response for diagnosis
    console.log(`[TemplateSync] Response status: ${statusCode}`);
    console.log(`[TemplateSync] Response body (first 2000 chars): ${rawBody.substring(0, 2000)}`);

    if (!response.ok) {
      throw new Error(`GHL Templates API ${statusCode}: ${rawBody}`);
    }

    // Parse response — handle different possible shapes
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error(`GHL Templates API returned invalid JSON: ${rawBody.substring(0, 500)}`);
    }

    // Log all top-level keys so we can see the actual response structure
    console.log(`[TemplateSync] Response keys: ${Object.keys(parsed).join(', ')}`);

    // Try multiple possible response shapes
    let templates: GHLTemplate[] = [];
    if (Array.isArray(parsed.templates)) {
      templates = parsed.templates;
    } else if (Array.isArray(parsed.data)) {
      templates = parsed.data as GHLTemplate[];
    } else if (Array.isArray(parsed)) {
      templates = parsed as unknown as GHLTemplate[];
    }

    // Try multiple possible totalCount field names
    if (totalCount === Infinity) {
      totalCount = (
        (parsed.totalCount as number) ||
        (parsed.total as number) ||
        (parsed.count as number) ||
        0
      );
    }

    console.log(`[TemplateSync] Page ${pageNum}: ${templates.length} templates, totalCount: ${totalCount}`);

    all.push(...templates);
    skip += PAGE_SIZE; // Always increment by PAGE_SIZE, not templates.length (to handle empty pages correctly)

    // Safety: stop after empty page or max pages
    if (templates.length === 0 || pageNum > 50) break;

    // Rate limit courtesy
    if (skip < totalCount) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[TemplateSync] Total fetched: ${all.length} templates across ${pageNum} page(s)`);
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
    console.log(`[TemplateSync] Processing ${templates.length} templates for upsert`);

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
    if (templates.length > 0) {
      const activeIds = templates.map(t => t.id);
      await softDeleteMissing('templates', 'ghl_template_id', activeIds, locationId);
    }

    await updateLastSynced('templates');
    await logSyncComplete(syncLogId, synced);
    console.log(`[TemplateSync] Templates synced: ${synced} (${errors.length} errors)`);
    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[TemplateSync] Template sync FAILED: ${msg}`);
    return { synced: 0, errors };
  }
}
