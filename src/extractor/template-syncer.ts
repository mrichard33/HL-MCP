/**
 * Template Sync — fetches templates from BOTH GHL template endpoints:
 *
 * 1. Location Templates: GET /locations/:locationId/templates
 *    → SMS/email messaging templates (canned responses)
 *
 * 2. Email Builder: GET /emails/builder
 *    → Designed email templates built in the GHL email builder
 *    → Response key is "builders" not "templates"
 *    → Top-level returns folders + standalone templates
 *    → Pass parentId=FOLDER_ID to fetch templates inside a folder
 *    → Recursive crawl needed to get all ~103 templates
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

    const res = await fetch(url.toString(), { headers: authHeaders(apiKey) });
    const rawBody = await res.text();

    if (!res.ok) {
      console.log(`[TemplateSync] [LocationTemplates] API error ${res.status}, skipping`);
      break;
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody); } catch { break; }

    const templates: GHLTemplate[] = Array.isArray(parsed.templates)
      ? parsed.templates
      : Array.isArray(parsed.data) ? parsed.data as GHLTemplate[] : [];

    const total = (parsed.totalCount as number) || (parsed.total as number) || 0;
    console.log(`[TemplateSync] [LocationTemplates] Page ${pageNum}: ${templates.length} items (total: ${total})`);

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
//
// Top-level returns mix of folders (templateType="folder") and
// standalone templates (templateType="html"). To get all templates,
// we recursively fetch children of each folder using parentId.
// ────────────────────────────────────────────────────────────

interface BuilderItem {
  id: string;
  name: string;
  templateType: string;
  childCount?: number;
  subject?: string;
  html?: string;
  body?: string;
  htmlBody?: string;
  previewUrl?: string;
  dateAdded?: string;
  lastUpdated?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: string;
  isPlainText?: boolean;
  [key: string]: unknown;
}

/**
 * Fetch one page of email builder items, optionally inside a folder.
 */
async function fetchBuilderPage(parentId?: string, offset = 0, limit = 25): Promise<{ items: BuilderItem[]; total: number }> {
  const { apiKey, locationId, baseUrl } = getConfig();

  const url = new URL('/emails/builder', baseUrl);
  url.searchParams.set('locationId', locationId);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  if (parentId) {
    url.searchParams.set('parentId', parentId);
  }

  const res = await fetch(url.toString(), { headers: authHeaders(apiKey) });
  const rawBody = await res.text();

  if (!res.ok) {
    console.error(`[TemplateSync] [EmailBuilder] API error ${res.status}: ${rawBody.substring(0, 500)}`);
    return { items: [], total: 0 };
  }

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawBody); } catch { return { items: [], total: 0 }; }

  // Items live in "builders" key
  const items: BuilderItem[] = Array.isArray(parsed.builders) ? parsed.builders as BuilderItem[] : [];

  // Total is [{total: N}] or a number
  let total = 0;
  const rawTotal = parsed.total || parsed.totalCount;
  if (typeof rawTotal === 'number') {
    total = rawTotal;
  } else if (Array.isArray(rawTotal) && rawTotal.length > 0 && typeof rawTotal[0] === 'object') {
    total = (rawTotal[0] as Record<string, number>).total || 0;
  }

  return { items, total };
}

/**
 * Fetch ALL email builder templates, recursively crawling folders.
 * Returns both folders (for organizational context) and actual templates.
 */
async function fetchEmailBuilderTemplates(): Promise<GHLTemplate[]> {
  const allTemplates: GHLTemplate[] = [];
  const allFolders: GHLTemplate[] = [];

  // Queue of folders to crawl: [folderId, folderName, depth]
  const folderQueue: [string | undefined, string, number][] = [[undefined, 'root', 0]];
  let totalApiCalls = 0;
  const MAX_API_CALLS = 100; // Safety limit
  const MAX_DEPTH = 5;       // Prevent infinite recursion

  while (folderQueue.length > 0 && totalApiCalls < MAX_API_CALLS) {
    const [parentId, parentName, depth] = folderQueue.shift()!;
    let offset = 0;
    let pageNum = 0;
    let totalInFolder = Infinity;

    const label = parentId ? `folder "${parentName}" (${parentId})` : 'root';
    console.log(`[TemplateSync] [EmailBuilder] Crawling ${label}...`);

    while (offset < totalInFolder && totalApiCalls < MAX_API_CALLS) {
      pageNum++;
      totalApiCalls++;

      const { items, total } = await fetchBuilderPage(parentId, offset, 25);

      if (totalInFolder === Infinity) {
        totalInFolder = total;
      }

      let templatesFound = 0;
      let foldersFound = 0;

      for (const item of items) {
        if (item.templateType === 'folder') {
          foldersFound++;
          // Store folder for context
          allFolders.push({
            id: item.id,
            name: item.name || 'Untitled Folder',
            type: 'folder' as unknown as 'email',
            dateAdded: item.dateAdded || item.createdAt || undefined,
            dateUpdated: item.lastUpdated || item.updatedAt || undefined,
            _source: 'email_builder',
            _raw: item,
          } as GHLTemplate);

          // Queue folder for recursive crawl (if it has children)
          const childCount = item.childCount || 0;
          if (childCount > 0 && depth < MAX_DEPTH) {
            folderQueue.push([item.id, item.name, depth + 1]);
          }
        } else {
          // Actual template (html, code, etc.)
          templatesFound++;
          allTemplates.push({
            id: item.id,
            name: item.name || 'Untitled',
            type: 'email' as const,
            subject: (item.subject || null) as string | undefined,
            body: (item.html || item.body || item.htmlBody || null) as string | undefined,
            dateAdded: item.dateAdded || item.createdAt || undefined,
            dateUpdated: item.lastUpdated || item.updatedAt || undefined,
            _source: 'email_builder',
            _raw: item,
          } as GHLTemplate);
        }
      }

      console.log(`[TemplateSync] [EmailBuilder] ${label} page ${pageNum}: ${templatesFound} templates, ${foldersFound} folders (total in level: ${totalInFolder})`);

      offset += 25;
      if (items.length === 0) break;

      // Rate limit courtesy
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[TemplateSync] [EmailBuilder] Crawl complete: ${allTemplates.length} templates, ${allFolders.length} folders, ${totalApiCalls} API calls`);

  // Return both folders and templates — folders get templateType='folder' in raw_json
  return [...allFolders, ...allTemplates];
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
    console.log('[TemplateSync] === Starting template sync ===');

    const locationTemplates = await fetchLocationTemplates();
    console.log(`[TemplateSync] Location templates: ${locationTemplates.length}`);

    const emailBuilderItems = await fetchEmailBuilderTemplates();
    console.log(`[TemplateSync] Email builder items (templates + folders): ${emailBuilderItems.length}`);

    // Combine, deduplicating by ID
    const seen = new Set<string>();
    const allItems: GHLTemplate[] = [];
    for (const t of [...locationTemplates, ...emailBuilderItems]) {
      const id = t.id || (t as Record<string, unknown>)._id as string;
      if (id && !seen.has(id)) {
        seen.add(id);
        allItems.push(t);
      }
    }

    console.log(`[TemplateSync] Combined unique items: ${allItems.length}`);

    for (const t of allItems) {
      try {
        const raw = (t as Record<string, unknown>)._raw || t;
        const templateType = (raw as Record<string, unknown>).templateType as string || undefined;
        await supabase.from('templates').upsert(
          {
            ghl_template_id: t.id || (t as Record<string, unknown>)._id as string,
            ghl_location_id: locationId,
            name: t.name || 'Untitled',
            type: templateType === 'folder' ? 'folder' : (t.type || 'email'),
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

    if (allItems.length > 0) {
      const activeIds = allItems.map(t => t.id || (t as Record<string, unknown>)._id as string).filter(Boolean);
      await softDeleteMissing('templates', 'ghl_template_id', activeIds, locationId);
    }

    await updateLastSynced('templates');
    await logSyncComplete(syncLogId, synced);

    const templateCount = allItems.filter(t => {
      const raw = (t as Record<string, unknown>)._raw || t;
      return (raw as Record<string, unknown>).templateType !== 'folder';
    }).length;
    const folderCount = allItems.length - templateCount;
    console.log(`[TemplateSync] === Sync complete: ${synced} synced (${templateCount} templates, ${folderCount} folders), ${errors.length} errors ===`);

    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[TemplateSync] === Sync FAILED: ${msg} ===`);
    return { synced: 0, errors };
  }
}
