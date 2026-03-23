/**
 * Template Sync — fetches templates from BOTH GHL template endpoints:
 *
 * 1. Location Templates: GET /locations/:locationId/templates
 *    → SMS/email messaging templates (canned responses)
 *
 * 2. Email Builder: GET /emails/builder
 *    → Designed email templates built in the GHL email builder
 *
 * Both are synced into the same Supabase `templates` table.
 */

import { getSupabaseClient } from '../clients/supabase.js';
import { updateLastSynced } from './entity-syncer.js';
import { nowET } from '../utils/timezone.js';
import { softDeleteMissing } from './entity-syncer.js';
import type { GHLTemplate } from '../types/ghl.js';

const DEFAULT_BASE_URL = 'https://services.leadconnectorhq.com';

function getConfig() {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const baseUrl = process.env.GHL_BASE_URL || DEFAULT_BASE_URL;
  if (!apiKey || !locationId) throw new Error('GHL_API_KEY and GHL_LOCATION_ID are required');
  return { apiKey, locationId, baseUrl };
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
    Accept: 'application/json',
  };
}

// ────────────────────────────────────────────────────────────
// Source 1: Location Templates  (GET /locations/:id/templates)
// ────────────────────────────────────────────────────────────

async function fetchLocationTemplates(): Promise<GHLTemplate[]> {
  const { apiKey, locationId, baseUrl } = getConfig();
  const all: GHLTemplate[] = [];
  const PAGE_SIZE = 25;
  let skip = 0;
  let pageNum = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pageNum++;
    const url = new URL(`/locations/${locationId}/templates`, baseUrl);
    url.searchParams.set('originId', locationId);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('skip', String(skip));

    console.log(`[TemplateSync] [LocationTemplates] Page ${pageNum}: ${url.toString()}`);

    const res = await fetch(url.toString(), { headers: authHeaders(apiKey) });
    const rawBody = await res.text();

    console.log(`[TemplateSync] [LocationTemplates] ${res.status}: ${rawBody.substring(0, 1000)}`);

    if (!res.ok) {
      console.error(`[TemplateSync] [LocationTemplates] API error ${res.status}, skipping this source`);
      break;
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody); } catch { break; }

    const templates: GHLTemplate[] = Array.isArray(parsed.templates)
      ? parsed.templates
      : Array.isArray(parsed.data) ? parsed.data as GHLTemplate[] : [];

    const total = (parsed.totalCount as number) || (parsed.total as number) || 0;

    console.log(`[TemplateSync] [LocationTemplates] Page ${pageNum}: ${templates.length} templates (total: ${total})`);

    // Tag each template with source
    for (const t of templates) { t._source = 'location_templates'; }
    all.push(...templates);

    skip += PAGE_SIZE;
    if (templates.length === 0 || skip >= total || pageNum > 50) break;
    await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

// ────────────────────────────────────────────────────────────
// Source 2: Email Builder  (GET /emails/builder)
// ────────────────────────────────────────────────────────────

async function fetchEmailBuilderTemplates(): Promise<GHLTemplate[]> {
  const { apiKey, locationId, baseUrl } = getConfig();
  const all: GHLTemplate[] = [];
  const PAGE_SIZE = 25;
  let offset = 0;
  let pageNum = 0;
  let keepGoing = true;

  while (keepGoing) {
    pageNum++;
    const url = new URL('/emails/builder', baseUrl);
    url.searchParams.set('locationId', locationId);
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('originId', locationId);
    url.searchParams.set('status', 'published');

    console.log(`[TemplateSync] [EmailBuilder] Page ${pageNum}: ${url.toString()}`);

    const res = await fetch(url.toString(), { headers: authHeaders(apiKey) });
    const rawBody = await res.text();

    console.log(`[TemplateSync] [EmailBuilder] ${res.status}: ${rawBody.substring(0, 2000)}`);

    if (!res.ok) {
      console.error(`[TemplateSync] [EmailBuilder] API error ${res.status}, skipping this source`);
      break;
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody); } catch { break; }

    // Log all top-level keys to understand the response structure
    const keys = Object.keys(parsed);
    console.log(`[TemplateSync] [EmailBuilder] Response keys: ${keys.join(', ')}`);
    for (const key of keys) {
      const val = parsed[key];
      if (Array.isArray(val)) {
        console.log(`[TemplateSync] [EmailBuilder]   ${key}: Array[${val.length}]${val.length > 0 ? ` first item keys: ${Object.keys(val[0]).join(',')}` : ''}`);
      } else {
        console.log(`[TemplateSync] [EmailBuilder]   ${key}: ${typeof val} = ${JSON.stringify(val).substring(0, 200)}`);
      }
    }

    // Try all possible array locations in the response
    let templates: GHLTemplate[] = [];
    for (const key of keys) {
      const val = parsed[key];
      if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null && ('id' in val[0] || '_id' in val[0] || 'name' in val[0])) {
        console.log(`[TemplateSync] [EmailBuilder] Found template array at key '${key}' with ${val.length} items`);
        templates = val.map((item: Record<string, unknown>) => ({
          id: (item.id || item._id) as string,
          name: (item.name || item.templateName || 'Untitled') as string,
          type: 'email' as const,
          subject: (item.subject || null) as string | undefined,
          body: (item.html || item.body || item.htmlBody || null) as string | undefined,
          dateAdded: (item.createdAt || item.created_at || item.dateAdded || null) as string | undefined,
          dateUpdated: (item.updatedAt || item.updated_at || item.dateUpdated || null) as string | undefined,
          _source: 'email_builder',
          _raw: item,
        })) as GHLTemplate[];
        break;
      }
    }

    // Also check if the response IS the array (no wrapping object)
    if (templates.length === 0 && Array.isArray(parsed)) {
      templates = (parsed as unknown as Record<string, unknown>[]).map((item) => ({
        id: (item.id || item._id) as string,
        name: (item.name || 'Untitled') as string,
        type: 'email' as const,
        _source: 'email_builder',
        _raw: item,
      })) as GHLTemplate[];
    }

    all.push(...templates);
    offset += PAGE_SIZE;

    // Determine total from response
    const rawTotal = parsed.total || parsed.totalCount || parsed.count;
    let total = 0;
    if (typeof rawTotal === 'number') {
      total = rawTotal;
    } else if (Array.isArray(rawTotal) && rawTotal.length > 0 && typeof rawTotal[0] === 'object') {
      total = (rawTotal[0] as Record<string, number>).total || 0;
    }

    console.log(`[TemplateSync] [EmailBuilder] Page ${pageNum}: ${templates.length} templates (total: ${total})`);

    if (templates.length === 0 || offset >= total || pageNum > 50) keepGoing = false;
    if (keepGoing) await new Promise(r => setTimeout(r, 300));
  }

  return all;
}

// ────────────────────────────────────────────────────────────
// Sync Log Helpers
// ────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────
// Main Sync Function
// ────────────────────────────────────────────────────────────

export async function syncTemplates(): Promise<{ synced: number; errors: string[] }> {
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('templates');
  const locationId = process.env.GHL_LOCATION_ID || '';
  const now = nowET();
  let synced = 0;

  try {
    // Fetch from BOTH sources
    console.log('[TemplateSync] === Starting dual-source template sync ===');

    const locationTemplates = await fetchLocationTemplates();
    console.log(`[TemplateSync] Location templates: ${locationTemplates.length}`);

    const emailBuilderTemplates = await fetchEmailBuilderTemplates();
    console.log(`[TemplateSync] Email builder templates: ${emailBuilderTemplates.length}`);

    // Combine, deduplicating by ID
    const seen = new Set<string>();
    const allTemplates: GHLTemplate[] = [];
    for (const t of [...locationTemplates, ...emailBuilderTemplates]) {
      const id = t.id || (t as Record<string, unknown>)._id as string;
      if (id && !seen.has(id)) {
        seen.add(id);
        allTemplates.push(t);
      }
    }

    console.log(`[TemplateSync] Combined unique templates: ${allTemplates.length}`);

    // Upsert to Supabase
    for (const t of allTemplates) {
      try {
        const raw = (t as Record<string, unknown>)._raw || t;
        await supabase.from('templates').upsert(
          {
            ghl_template_id: t.id || (t as Record<string, unknown>)._id as string,
            ghl_location_id: locationId,
            name: t.name || 'Untitled',
            type: t.type || 'email',
            subject: t.subject || null,
            body: t.body || null,
            attachments: t.attachments || [],
            raw_json: raw,
            date_added: t.dateAdded || null,
            date_updated: t.dateUpdated || null,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_template_id' },
        );
        synced++;
      } catch (err) {
        const id = t.id || (t as Record<string, unknown>)._id;
        errors.push(`Template ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Only soft-delete if we actually found templates (avoid wiping on API failure)
    if (allTemplates.length > 0) {
      const activeIds = allTemplates.map(t => t.id || (t as Record<string, unknown>)._id as string).filter(Boolean);
      await softDeleteMissing('templates', 'ghl_template_id', activeIds, locationId);
    }

    await updateLastSynced('templates');
    await logSyncComplete(syncLogId, synced);
    console.log(`[TemplateSync] === Sync complete: ${synced} synced, ${errors.length} errors ===`);
    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[TemplateSync] === Sync FAILED: ${msg} ===`);
    return { synced: 0, errors };
  }
}
