import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { createLeadEvent } from '../webhooks/handler.js';
import { nowET, toET } from '../utils/timezone.js';
import { deriveContactEventType, deriveAppointmentEventType, deriveMessageEventType } from '../utils/event-type.js';
import { normalizeDirection } from '../utils/normalize.js';
import type { GHLContact, GHLOpportunity, GHLConversation, GHLPaginationMeta, GHLMessage } from '../types/ghl.js';

// ---- Sync State Helpers ----

async function getLastSynced(entityName: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .from('sync_state')
    .select('last_synced_at')
    .eq('entity_name', entityName)
    .single();

  return data?.last_synced_at || '1970-01-01T00:00:00Z';
}

export async function updateLastSynced(entityName: string): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase
    .from('sync_state')
    .upsert(
      {
        entity_name: entityName,
        last_synced_at: nowET(),
        updated_at: nowET(),
      },
      { onConflict: 'entity_name' },
    );
}

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

// v1.4: Batch size for Supabase bulk upserts. 500 is well under PostgREST's
// default 1000-row limit and keeps any single request under ~5MB JSON payload.
const UPSERT_BATCH_SIZE = 500;

// v1.5: PostgREST caps single-query result sets at 1000 rows by default.
// For any `.select()` that can return more than that (contacts, conversations,
// lead_events), we must paginate via .range() or the result silently truncates.
const PAGINATION_PAGE_SIZE = 1000;

// v1.6: Incremental sync overlap buffer — minutes subtracted from
// last_synced_at when computing the dateUpdated floor for incremental
// fetches. Covers GHL's write-to-index lag and scheduler clock skew so
// a record that changes right around the sync boundary can't slip
// through both cycles. Override via env: INCREMENTAL_SYNC_OVERLAP_MINUTES.
const INCREMENTAL_OVERLAP_MINUTES = parseInt(
  process.env.INCREMENTAL_SYNC_OVERLAP_MINUTES || '10',
  10,
);

/**
 * Chunk an array into batches of a given size.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// v1.6: Compute the "since" floor for an incremental sync by subtracting
// the overlap buffer from the entity's last_synced_at.
async function computeIncrementalFloor(entityName: string): Promise<string | null> {
  const lastSynced = await getLastSynced(entityName);
  if (lastSynced.startsWith('1970-01-01')) return null; // First run — caller falls back to full
  const floorMs = Date.parse(lastSynced) - INCREMENTAL_OVERLAP_MINUTES * 60_000;
  return new Date(floorMs).toISOString();
}

// ---- Soft-Delete Helper ----

/**
 * Soft-delete records in Supabase that are no longer present in the GHL API response.
 * Sets deleted_at timestamp on records whose GHL ID is not in the provided set,
 * and clears deleted_at on records that reappear.
 */
export async function softDeleteMissing(
  table: string,
  ghlIdColumn: string,
  activeGhlIds: string[],
  locationId: string,
): Promise<{ deleted: number; restored: number }> {
  const supabase = getSupabaseClient();
  const now = nowET();

  // Restore any previously soft-deleted records that are back in the API response
  let restored = 0;
  if (activeGhlIds.length > 0) {
    const { data: restoredRows } = await supabase
      .from(table)
      .update({ deleted_at: null, updated_at: now })
      .in(ghlIdColumn, activeGhlIds)
      .not('deleted_at', 'is', null)
      .select(ghlIdColumn);
    restored = restoredRows?.length || 0;
  }

  // Get all active GHL IDs currently in Supabase for this location
  let query = supabase
    .from(table)
    .select(ghlIdColumn)
    .is('deleted_at', null);

  // Only filter by location if the table has the column (most do)
  if (locationId) {
    query = query.eq('ghl_location_id', locationId);
  }

  const { data: existingRows } = await query;
  if (!existingRows?.length) return { deleted: 0, restored };

  const activeSet = new Set(activeGhlIds);
  const toDelete = existingRows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => r[ghlIdColumn] as string)
    .filter((id: string) => !activeSet.has(id));

  if (toDelete.length === 0) return { deleted: 0, restored };

  const { data: deletedRows } = await supabase
    .from(table)
    .update({ deleted_at: now, updated_at: now })
    .in(ghlIdColumn, toDelete)
    .select(ghlIdColumn);

  const deleted = deletedRows?.length || 0;
  if (deleted > 0) {
    console.log(`[EntitySync] Soft-deleted ${deleted} records from ${table}`);
  }
  if (restored > 0) {
    console.log(`[EntitySync] Restored ${restored} previously deleted records in ${table}`);
  }

  return { deleted, restored };
}

// ---- Contact Sync ----

export type SyncMode = 'incremental' | 'full';

export interface SyncResult {
  synced: number;
  skipped?: number;
  mode?: SyncMode | 'incremental-failed';
  errors: string[];
}

/**
 * Sync contacts from GHL to Supabase.
 *
 * v1.6: Supports two modes:
 *   - 'incremental' (default): fetches only contacts updated since
 *     `last_synced_at - overlap_buffer` using POST /contacts/search.
 *     Skips softDeleteMissing (can't see deleted records remotely).
 *     On first run (no prior sync) or on search API failure, falls
 *     back to a full sync this cycle. Daily full reconcile handles
 *     any drift.
 *   - 'full': fetches every contact via GET /contacts/ and runs
 *     softDeleteMissing. Used on boot and by the daily 3 AM ET cron.
 */
export async function syncContacts(options?: { mode?: SyncMode }): Promise<SyncResult> {
  const requestedMode: SyncMode = options?.mode ?? 'full';
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('contacts');

  try {
    let effectiveMode: SyncMode = requestedMode;
    let sinceIso: string | null = null;

    if (requestedMode === 'incremental') {
      sinceIso = await computeIncrementalFloor('contacts');
      if (!sinceIso) {
        console.log('[EntitySync] syncContacts: incremental requested but no prior sync — running full');
        effectiveMode = 'full';
      } else {
        console.log(`[EntitySync] syncContacts: incremental, floor=${sinceIso} (overlap=${INCREMENTAL_OVERLAP_MINUTES}min)`);
      }
    } else {
      console.log('[EntitySync] syncContacts: full sync requested');
    }

    let contacts: GHLContact[];
    if (effectiveMode === 'incremental' && sinceIso) {
      try {
        const result = await ghl.getContactsUpdatedSince(sinceIso);
        const reported = result.totalReportedByServer;
        // Sanity check: a normal 15-min incremental should return a small
        // subset (typically <100). If we get back something that looks like
        // the whole location, the filter was ignored by GHL — fall back to
        // a full fetch this cycle rather than trusting bad data.
        if (typeof reported === 'number' && reported > 1000) {
          console.warn(`[EntitySync] syncContacts: incremental returned total=${reported} — filter likely ignored, falling back to full`);
          contacts = await ghl.getAllContacts();
          effectiveMode = 'full';
        } else {
          contacts = result.contacts;
          console.log(`[EntitySync] syncContacts: incremental fetched ${contacts.length} changed (server total=${reported ?? 'n/a'})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[EntitySync] syncContacts: incremental search failed (${msg}) — skipping cycle; daily full will reconcile`);
        errors.push(`Incremental fetch failed: ${msg}`);
        await logSyncComplete(syncLogId, 0);
        return { synced: 0, skipped: 0, mode: 'incremental-failed', errors };
      }
    } else {
      console.log('[EntitySync] syncContacts: fetching all contacts from GHL...');
      contacts = await ghl.getAllContacts();
      console.log(`[EntitySync] syncContacts: fetched ${contacts.length} contacts`);
    }

    if (contacts.length === 0) {
      console.log('[EntitySync] syncContacts: no changes to sync');
      await updateLastSynced('contacts');
      await logSyncComplete(syncLogId, 0);
      return { synced: 0, skipped: 0, mode: effectiveMode, errors };
    }

    const now = nowET();
    const rows = contacts.map((c) => ({
      ghl_contact_id: c.id,
      ghl_location_id: c.locationId || null,
      first_name: c.firstName || null,
      last_name: c.lastName || null,
      email: c.email || null,
      phone: c.phone || null,
      company_name: c.companyName || null,
      tags: c.tags || [],
      source: c.source || null,
      custom_fields: c.customFields || {},
      date_added: c.dateAdded || null,
      date_updated: c.dateUpdated || now,
      synced_at: now,
      updated_at: now,
    }));

    let upsertedCount = 0;
    for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
      const { error } = await supabase.from('contacts').upsert(batch, { onConflict: 'ghl_contact_id' });
      if (error) {
        errors.push(`Contact batch upsert: ${error.message}`);
        console.error(`[EntitySync] Contact batch upsert failed: ${error.message}`);
      } else {
        upsertedCount += batch.length;
      }
    }
    console.log(`[EntitySync] syncContacts: upserted ${upsertedCount}/${rows.length} contacts`);

    // v1.4: createLeadEvent stays sequential for ordering. In incremental
    // mode this only iterates the changed subset, not all 3,400+ contacts.
    console.log('[EntitySync] syncContacts: creating lead events...');
    let eventsCreated = 0;
    for (const c of contacts) {
      const stableTs = c.dateUpdated || c.dateAdded;
      if (!stableTs) continue;
      try {
        const eventType = deriveContactEventType({ dateAdded: c.dateAdded, dateUpdated: c.dateUpdated });
        await createLeadEvent(c.id, eventType, c.id, stableTs, c);
        eventsCreated++;
      } catch (err) {
        errors.push(`Contact event ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`[EntitySync] syncContacts: created ${eventsCreated} lead events`);

    // v1.6: Soft-delete only runs in full mode — incremental can't see
    // records that GHL has removed since there's nothing to diff against.
    if (effectiveMode === 'full') {
      const activeContactIds = contacts.map((c) => c.id);
      await softDeleteMissing('contacts', 'ghl_contact_id', activeContactIds, ghl.getLocationId());
    }

    await updateLastSynced('contacts');
    await logSyncComplete(syncLogId, contacts.length);
    console.log(`[EntitySync] Contacts synced (${effectiveMode}): ${contacts.length}`);
    return { synced: contacts.length, skipped: 0, mode: effectiveMode, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Contact sync failed: ${msg}`);
    return { synced: 0, skipped: 0, mode: requestedMode, errors };
  }
}

// ---- Opportunity Sync ----

/**
 * Sync opportunities from GHL to Supabase.
 *
 * v1.6: Supports 'incremental' and 'full' modes.
 *   - 'full': current v1.4 behavior — fetch all, upsert all, softDelete sweep.
 *   - 'incremental': fetch all from GHL (the opportunities search endpoint
 *     doesn't reliably accept a server-side dateUpdated filter, so we still
 *     pay the GHL API cost), then diff against Supabase's date_updated
 *     column to find only records that actually changed. Upsert only the
 *     changed subset. Skip softDeleteMissing. Saves the ~2,700 row-per-cycle
 *     Supabase write amplification, which was the larger issue.
 *
 *     TODO v1.7: investigate POST /opportunities/search with a filter body;
 *     some tenants support it and it would let us skip the GHL fetch too.
 */
export async function syncOpportunities(options?: { mode?: SyncMode }): Promise<SyncResult> {
  const mode: SyncMode = options?.mode ?? 'full';
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('opportunities');

  try {
    console.log(`[EntitySync] syncOpportunities: ${mode} mode — fetching all opportunities from GHL...`);
    const opportunities = await ghl.getAllOpportunities();
    console.log(`[EntitySync] syncOpportunities: fetched ${opportunities.length} opportunities from GHL`);

    let toUpsert: GHLOpportunity[] = opportunities;
    let skippedUnchanged = 0;

    if (mode === 'incremental') {
      // Build a map of existing opportunity id → date_updated from Supabase.
      // Paginated past the 1000-row PostgREST cap (v1.5 lesson).
      const existingDates = new Map<string, string>();
      for (let page = 0; ; page++) {
        const from = page * PAGINATION_PAGE_SIZE;
        const to = from + PAGINATION_PAGE_SIZE - 1;
        const { data, error } = await supabase
          .from('opportunities')
          .select('ghl_opportunity_id, date_updated')
          .is('deleted_at', null)
          .range(from, to);
        if (error) {
          console.warn(`[EntitySync] syncOpportunities: failed to load date_updated map (page ${page}): ${error.message} — falling back to full upsert`);
          existingDates.clear();
          break;
        }
        if (!data || data.length === 0) break;
        for (const row of data as { ghl_opportunity_id: string; date_updated: string | null }[]) {
          if (row.ghl_opportunity_id && row.date_updated) {
            existingDates.set(row.ghl_opportunity_id, row.date_updated);
          }
        }
        if (data.length < PAGINATION_PAGE_SIZE) break;
      }

      if (existingDates.size > 0) {
        toUpsert = opportunities.filter((o) => {
          const incomingTs = o.dateUpdated || o.updatedAt;
          if (!incomingTs) return true; // Unknown freshness — upsert to be safe
          const existing = existingDates.get(o.id);
          if (!existing) return true; // New record never seen before
          // Strictly greater — equal means identical row, skip.
          return new Date(incomingTs).getTime() > new Date(existing).getTime();
        });
        skippedUnchanged = opportunities.length - toUpsert.length;
        console.log(`[EntitySync] syncOpportunities: diff — ${toUpsert.length} changed, ${skippedUnchanged} unchanged (skipped)`);
      }
    }

    if (toUpsert.length === 0) {
      console.log('[EntitySync] syncOpportunities: no rows to write');
      await updateLastSynced('opportunities');
      await logSyncComplete(syncLogId, 0);
      return { synced: 0, skipped: skippedUnchanged, mode, errors };
    }

    const now = nowET();
    const rows = toUpsert.map((o) => ({
      ghl_opportunity_id: o.id,
      ghl_pipeline_id: o.pipelineId,
      ghl_stage_id: o.pipelineStageId || null,
      ghl_contact_id: o.contactId || null,
      ghl_location_id: o.locationId || null,
      name: o.name,
      status: o.status,
      monetary_value: o.monetaryValue || null,
      currency: o.currency || 'USD',
      source: o.source || null,
      assigned_to: o.assignedTo || null,
      custom_fields: o.customFields || {},
      date_added: o.dateAdded || o.createdAt || null,
      date_updated: o.dateUpdated || o.updatedAt || now,
      synced_at: now,
      updated_at: now,
    }));

    let upsertedCount = 0;
    for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
      const { error } = await supabase.from('opportunities').upsert(batch, { onConflict: 'ghl_opportunity_id' });
      if (error) {
        errors.push(`Opportunity batch upsert: ${error.message}`);
        console.error(`[EntitySync] Opportunity batch upsert failed: ${error.message}`);
      } else {
        upsertedCount += batch.length;
      }
    }
    console.log(`[EntitySync] syncOpportunities: upserted ${upsertedCount}/${rows.length} opportunities`);

    // v1.4: createLeadEvent skipped in bulk — opportunity webhooks handle real-time events.

    // v1.6: Soft-delete only runs in full mode.
    if (mode === 'full') {
      const activeOppIds = opportunities.map((o) => o.id);
      await softDeleteMissing('opportunities', 'ghl_opportunity_id', activeOppIds, ghl.getLocationId());
    }

    await updateLastSynced('opportunities');
    await logSyncComplete(syncLogId, toUpsert.length);
    console.log(`[EntitySync] Opportunities synced (${mode}): ${toUpsert.length} (skipped ${skippedUnchanged})`);
    return { synced: toUpsert.length, skipped: skippedUnchanged, mode, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Opportunity sync failed: ${msg}`);
    return { synced: 0, skipped: 0, mode, errors };
  }
}

// ---- Appointment Sync (every 15 min) ----

export async function syncAppointments(options?: {
  startTime?: string;
  endTime?: string;
}): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('appointments');

  try {
    // Fetch appointments across ALL calendars (calendarId is required by GHL API)
    // Default: 2 weeks back to 30d forward (for scheduled sync); callers can override for initial population
    const startTime = options?.startTime ?? toET(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const endTime = options?.endTime ?? toET(Date.now() + 30 * 24 * 60 * 60 * 1000);
    console.log(`[EntitySync] syncAppointments: fetching appointments from ${startTime} to ${endTime}...`);
    const events = await ghl.getAllAppointments({ startTime, endTime });
    console.log(`[EntitySync] syncAppointments: fetched ${events.length} appointments, batching upserts...`);

    if (events.length === 0) {
      console.warn('[EntitySync] No appointments returned — check that calendars exist and GHL_LOCATION_ID is correct');
    }

    const now = nowET();

    // v1.4: Batch upserts
    const rows = events.map((apt) => ({
      ghl_appointment_id: apt.id,
      ghl_contact_id: apt.contactId || null,
      ghl_calendar_id: apt.calendarId || null,
      ghl_location_id: apt.locationId || null,
      title: apt.title || null,
      status: apt.status || 'confirmed',
      start_time: apt.startTime || null,
      end_time: apt.endTime || null,
      assigned_to: apt.assignedUserId || null,
      raw_json: apt,
      synced_at: now,
      updated_at: now,
    }));

    let upsertedCount = 0;
    for (const batch of chunk(rows, UPSERT_BATCH_SIZE)) {
      const { error } = await supabase.from('appointments').upsert(batch, { onConflict: 'ghl_appointment_id' });
      if (error) {
        errors.push(`Appointment batch upsert: ${error.message}`);
        console.error(`[EntitySync] Appointment batch upsert failed: ${error.message}`);
      } else {
        upsertedCount += batch.length;
      }
    }
    console.log(`[EntitySync] syncAppointments: upserted ${upsertedCount}/${rows.length} appointments`);

    // Create lead events for appointments — kept sequential because volume is manageable (~140)
    // and the derived event type matters for funnel progression.
    console.log('[EntitySync] syncAppointments: creating lead events...');
    let eventsCreated = 0;
    for (const apt of events) {
      if (!apt.startTime) continue;
      try {
        const eventType = deriveAppointmentEventType(apt.status);
        await createLeadEvent(apt.contactId, eventType, apt.id, apt.startTime, apt);
        eventsCreated++;
      } catch (err) {
        errors.push(`Appointment event ${apt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`[EntitySync] syncAppointments: created ${eventsCreated} lead events`);

    // Soft-delete appointments no longer in GHL (within the synced time window)
    const activeAptIds = events.map((a) => a.id);
    await softDeleteMissing('appointments', 'ghl_appointment_id', activeAptIds, ghl.getLocationId());

    await updateLastSynced('appointments');
    await logSyncComplete(syncLogId, events.length);
    console.log(`[EntitySync] Appointments synced: ${events.length}`);
    return { synced: events.length, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Appointment sync failed: ${msg}`);
    return { synced: 0, errors };
  }
}

// ---- Pipeline Sync ----

export async function syncPipelines(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('pipelines');

  try {
    const pipelines = await ghl.getPipelines();
    const now = nowET();
    const locationId = ghl.getLocationId();

    const rows = pipelines.map((p) => ({
      ghl_pipeline_id: p.id,
      ghl_location_id: p.locationId || locationId,
      name: p.name,
      stages: p.stages,
      synced_at: now,
    }));

    const { error } = await supabase.from('pipelines').upsert(rows, { onConflict: 'ghl_pipeline_id' });
    if (error) throw new Error(`Supabase error: ${error.message}`);

    // Soft-delete pipelines no longer in GHL
    const activePipelineIds = pipelines.map((p) => p.id);
    await softDeleteMissing('pipelines', 'ghl_pipeline_id', activePipelineIds, locationId);

    await updateLastSynced('pipelines');
    await logSyncComplete(syncLogId, rows.length);
    console.log(`[EntitySync] Pipelines synced: ${rows.length}`);
    return { synced: rows.length, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Pipeline sync failed: ${msg}`);
    return { synced: 0, errors };
  }
}

// ---- Conversation & Message Sync (every 15 min) ----
//
// v1.7 — Rewritten watermark-based. Walks GET /conversations/search
// sorted DESC by last_message_date at the location level, stops when
// we pass the floor (messages.last_synced_at - overlap). For each
// conversation with recent activity, fetches only the NEW messages via
// getAllMessages(..., sinceIso). Historical conversations with no new
// activity are left alone — no backfill, no wasted API calls.
//
// Old behavior (v1.4-v1.6) iterated ~3,700 contacts in 300-size batches
// with 5s/1s delays, hitting conversations+messages endpoints per-contact.
// Best case: 7+ minutes per cycle. Worst case (hit any slow API call): the
// runJob mutex pinned forever and the messages entity stopped syncing
// for 16 days (2026-04-07 to 2026-04-23). That mode is gone.

// v1.7: Max conversation pages to walk per cycle. 50 × 100/page = 5000
// conversations max. In practice the watermark stops iteration well
// before this — every conversation older than floor ends the walk.
const MAX_CONV_PAGES_PER_CYCLE = 50;
const CONV_PAGE_SIZE = 100;
// Small pause between pages to stay well under rate limits. The token
// bucket in ghl-rate-limiter.ts already enforces per-second caps, so
// this is mostly defensive.
const INTER_PAGE_DELAY_MS = 500;

/** Convert GHL date values (ms timestamp or ISO string) to ISO string for PostgreSQL TIMESTAMPTZ. */
function toISODate(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  // If it looks like a ms timestamp (> year 2000 in ms), convert to ISO
  if (!isNaN(n) && n > 946684800000) {
    return new Date(n).toISOString();
  }
  // Already an ISO string or other valid date format
  return typeof value === 'string' ? value : null;
}

/** Parse GHL date (ISO string or ms timestamp) to epoch ms. Returns 0 if unparseable. */
function toEpochMs(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const n = Number(value);
  if (!isNaN(n) && n > 946684800000) return n;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? 0 : parsed;
}

/** Small helper to pause between batches. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create lead events for recently synced messages that don't yet have events.
 * Queries messages from the last 20 minutes and checks against lead_events.
 */
async function createLeadEventsForRecentMessages(): Promise<number> {
  const supabase = getSupabaseClient();
  const cutoff = toET(Date.now() - 20 * 60 * 1000);

  const { data: recentMessages, error } = await supabase
    .from('messages')
    .select('ghl_message_id, ghl_conversation_id, ghl_contact_id, direction, type, body, status, sent_at')
    .gte('sent_at', cutoff);

  if (error || !recentMessages?.length) return 0;

  let created = 0;
  for (const msg of recentMessages) {
    try {
      const eventType = deriveMessageEventType({ direction: msg.direction, type: msg.type, status: msg.status });
      await createLeadEvent(msg.ghl_contact_id, eventType, msg.ghl_message_id, msg.sent_at || nowET(), msg);
      created++;
    } catch {
      // Duplicate events are expected (deduped by event_hash) — ignore
    }
  }

  return created;
}

export async function syncConversationsAndMessages(): Promise<{ synced_conversations: number; synced_messages: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];

  // OAuth required for /conversations/* endpoints.
  if (!ghl.isOAuthConfigured) {
    console.warn('[EntitySync] GHL OAuth not configured — skipping conversations/messages sync. ' +
      'Set GHL_OAUTH_CLIENT_ID and GHL_OAUTH_CLIENT_SECRET, then visit /crm-oauth/authorize.');
    return { synced_conversations: 0, synced_messages: 0, errors: ['GHL OAuth not configured'] };
  }

  const convSyncLogId = await logSyncStart('conversations');
  const msgSyncLogId = await logSyncStart('messages');

  // Compute watermark floor from messages.last_synced_at.
  // On first run (epoch sentinel), use a 30-day lookback rather than
  // pulling the entire location history. Historical backfill is a
  // separate concern addressed by one-time tooling if ever needed.
  const lastSyncedMsgs = await getLastSynced('messages');
  let floorMs: number;
  if (lastSyncedMsgs.startsWith('1970-01-01')) {
    floorMs = Date.now() - 30 * 86_400_000;
    console.log('[EntitySync] syncConversationsAndMessages: first run — using 30-day lookback');
  } else {
    floorMs = Date.parse(lastSyncedMsgs) - INCREMENTAL_OVERLAP_MINUTES * 60_000;
    console.log(`[EntitySync] syncConversationsAndMessages: floor=${new Date(floorMs).toISOString()} (overlap=${INCREMENTAL_OVERLAP_MINUTES}min)`);
  }
  const floorIso = new Date(floorMs).toISOString();

  let totalConversations = 0;
  let totalMessages = 0;
  let pagesWalked = 0;
  let stopReason = 'end of pages';

  try {
    const now = nowET();
    let startAfter: string | undefined;
    let startAfterId: string | undefined;

    pageLoop: for (let page = 0; page < MAX_CONV_PAGES_PER_CYCLE; page++) {
      const result: { conversations: GHLConversation[]; meta?: GHLPaginationMeta; total?: number } =
        await ghl.getConversations({
          limit: CONV_PAGE_SIZE,
          startAfter,
          startAfterId,
          sortBy: 'last_message_date',
          sort: 'desc',
        });
      pagesWalked++;

      const conversations = result.conversations || [];
      if (conversations.length === 0) {
        stopReason = 'no more conversations';
        break;
      }

      for (const conv of conversations) {
        const convLastMs = toEpochMs((conv as { lastMessageDate?: string | number }).lastMessageDate);

        // DESC order guarantees: once we see a conversation older than
        // the floor, every subsequent conversation is also older — so
        // we stop the entire walk, not just skip.
        if (convLastMs > 0 && convLastMs < floorMs) {
          stopReason = `watermark hit at conv ${conv.id} (lastMessageDate=${new Date(convLastMs).toISOString()})`;
          break pageLoop;
        }

        // Upsert conversation metadata.
        const { error: convErr } = await supabase.from('conversations').upsert(
          {
            ghl_conversation_id: conv.id,
            ghl_contact_id: (conv as { contactId?: string }).contactId || null,
            ghl_location_id: (conv as { locationId?: string }).locationId || null,
            type: (conv as { type?: string }).type || null,
            last_message_at: toISODate((conv as { lastMessageDate?: string | number }).lastMessageDate),
            unread_count: (conv as { unreadCount?: number }).unreadCount || 0,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_conversation_id' },
        );
        if (convErr) {
          errors.push(`Conv upsert ${conv.id}: ${convErr.message}`);
          continue;
        }
        totalConversations++;

        // Fetch messages for this conversation, filtered to >= floor.
        // getAllMessages breaks pagination early once oldest-in-page
        // predates floorIso, so heavy-history conversations cost ~1 API call.
        try {
          const newMsgs: GHLMessage[] = await ghl.getAllMessages(conv.id, 20, floorIso);

          if (newMsgs.length > 0) {
            const contactId = (conv as { contactId?: string }).contactId || null;
            const msgRows = newMsgs.map((msg) => ({
              ghl_message_id: msg.id,
              ghl_conversation_id: (msg as { conversationId?: string }).conversationId || conv.id,
              ghl_contact_id: (msg as { contactId?: string }).contactId || contactId,
              direction: normalizeDirection((msg as { direction?: string }).direction),
              type: (msg as { type?: string }).type || 'sms',
              body: (msg as { body?: string; message?: string; text?: string }).body
                || (msg as { message?: string }).message
                || (msg as { text?: string }).text
                || null,
              status: (msg as { status?: string }).status || 'delivered',
              sent_at: toISODate((msg as { dateAdded?: string | number }).dateAdded) || now,
            }));
            for (const batch of chunk(msgRows, UPSERT_BATCH_SIZE)) {
              const { error: msgErr } = await supabase.from('messages').upsert(batch, { onConflict: 'ghl_message_id' });
              if (msgErr) {
                errors.push(`Msg batch conv ${conv.id}: ${msgErr.message}`);
              } else {
                totalMessages += batch.length;
              }
            }
          }
        } catch (msgErr) {
          const m = msgErr instanceof Error ? msgErr.message : String(msgErr);
          errors.push(`Messages for conv ${conv.id}: ${m}`);
          console.error(`[EntitySync] Messages for conv ${conv.id}: ${m}`);
          // Reset this conversation's synced_at so the next cycle will
          // see it as stale and retry. Non-fatal — worst case we just
          // re-attempt next cycle with the same watermark.
          try {
            await supabase.from('conversations')
              .update({ synced_at: '2000-01-01T00:00:00Z' })
              .eq('ghl_conversation_id', conv.id);
          } catch {
            /* non-fatal */
          }
        }
      }

      // Advance pagination cursor.
      startAfter = result.meta?.startAfter;
      startAfterId = result.meta?.startAfterId;
      if (!startAfter && !startAfterId) {
        stopReason = 'no pagination cursor';
        break;
      }
      if (conversations.length < CONV_PAGE_SIZE) {
        stopReason = 'partial page';
        break;
      }

      await sleep(INTER_PAGE_DELAY_MS);
    }

    if (pagesWalked >= MAX_CONV_PAGES_PER_CYCLE) {
      stopReason = `page cap (${MAX_CONV_PAGES_PER_CYCLE}) — next cycle resumes from new watermark`;
    }

    // Lead events for any messages that landed in the last 20 min window.
    const eventsCreated = await createLeadEventsForRecentMessages();
    if (eventsCreated > 0) {
      console.log(`[EntitySync] Created ${eventsCreated} lead events for recent messages`);
    }

    await updateLastSynced('conversations');
    await updateLastSynced('messages');
    await logSyncComplete(convSyncLogId, totalConversations);
    await logSyncComplete(msgSyncLogId, totalMessages);
    console.log(`[EntitySync] syncConversationsAndMessages: ${totalConversations} convs, ${totalMessages} msgs across ${pagesWalked} page(s) — ${stopReason}`);

    if (errors.length > 0) {
      console.error(`[EntitySync] ${errors.length} errors during conversation sync:`);
      for (const e of errors.slice(0, 10)) console.error(`  - ${e}`);
      if (errors.length > 10) console.error(`  ... and ${errors.length - 10} more`);
    }

    return { synced_conversations: totalConversations, synced_messages: totalMessages, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSyncFailed(convSyncLogId, msg);
    await logSyncFailed(msgSyncLogId, msg);
    console.error(`[EntitySync] Conversation sync failed: ${msg}`);
    return { synced_conversations: totalConversations, synced_messages: totalMessages, errors: [msg] };
  }
}

// ---- Funnel Stage Derivation (hourly) ----

const FUNNEL_STAGES = [
  'lead_created',
  'contacted',
  'engaged',
  'appointment_booked',
  'appointment_showed',
  'won',
] as const;

type FunnelStage = typeof FUNNEL_STAGES[number];

function deriveFunnelStage(events: { event_type: string; event_time: string }[]): { stage: FunnelStage; history: { stage: string; entered_at: string }[] } {
  // Build a map of event_type → earliest event_time
  const earliestByType = new Map<string, string>();
  for (const e of events) {
    const existing = earliestByType.get(e.event_type);
    if (!existing || e.event_time < existing) {
      earliestByType.set(e.event_type, e.event_time);
    }
  }

  const history: { stage: string; entered_at: string }[] = [];
  let currentStage: FunnelStage = 'lead_created';

  // Find the earliest event overall for lead_created timestamp
  const allTimes = events.map(e => e.event_time).filter(Boolean);
  const earliestOverall = allTimes.length > 0 ? allTimes.sort()[0] : nowET();
  history.push({ stage: 'lead_created', entered_at: earliestOverall });

  // Helper: find earliest time among multiple event types
  const earliestAmong = (...types: string[]): string | null => {
    let earliest: string | null = null;
    for (const t of types) {
      const time = earliestByType.get(t);
      if (time && (!earliest || time < earliest)) earliest = time;
    }
    return earliest;
  };

  const contactedAt = earliestAmong('sms_sent', 'email_sent');
  if (contactedAt) {
    currentStage = 'contacted';
    history.push({ stage: 'contacted', entered_at: contactedAt });
  }

  const engagedAt = earliestAmong('sms_received', 'email_received', 'email_replied', 'sms_replied');
  if (engagedAt) {
    currentStage = 'engaged';
    history.push({ stage: 'engaged', entered_at: engagedAt });
  }

  const bookedAt = earliestAmong('appointment_booked');
  if (bookedAt) {
    currentStage = 'appointment_booked';
    history.push({ stage: 'appointment_booked', entered_at: bookedAt });
  }

  const showedAt = earliestAmong('appointment_showed');
  if (showedAt) {
    currentStage = 'appointment_showed';
    history.push({ stage: 'appointment_showed', entered_at: showedAt });
  }

  const wonAt = earliestAmong('opportunity_won');
  if (wonAt) {
    currentStage = 'won';
    history.push({ stage: 'won', entered_at: wonAt });
  }

  return { stage: currentStage, history };
}

export async function computeFunnelProgression(): Promise<{ computed: number; errors: string[] }> {
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('funnel_progression');

  try {
    // Get distinct contact_ids from lead_events
    const { data: contacts, error: fetchError } = await supabase
      .from('lead_events')
      .select('contact_id')
      .not('contact_id', 'is', null);

    if (fetchError) throw new Error(fetchError.message);

    // Deduplicate contact IDs
    const contactIds = [...new Set((contacts || []).map((r: { contact_id: unknown }) => r.contact_id as string).filter(Boolean))];

    let computed = 0;
    const now = nowET();

    for (const contactId of contactIds) {
      try {
        // Get all events for this contact with timestamps
        const { data: events } = await supabase
          .from('lead_events')
          .select('event_type, event_time')
          .eq('contact_id', contactId);

        const eventList = (events || []).map((e: { event_type: unknown; event_time: unknown }) => ({
          event_type: e.event_type as string,
          event_time: e.event_time as string,
        }));
        const { stage, history } = deriveFunnelStage(eventList);

        await supabase.from('contact_funnel_progression').upsert(
          {
            contact_id: contactId,
            current_stage: stage,
            stage_history: history,
            last_computed_at: now,
            updated_at: now,
          },
          { onConflict: 'contact_id' },
        );
        computed++;
      } catch (err) {
        errors.push(`Contact ${contactId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await logSyncComplete(syncLogId, computed);
    console.log(`[EntitySync] Funnel progression computed for ${computed} contacts`);
    return { computed, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Funnel computation failed: ${msg}`);
    return { computed: 0, errors };
  }
}

// ---- Custom Fields Sync ----

export async function syncCustomFields(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const now = nowET();
  let synced = 0;
  const errors: string[] = [];
  const syncLogId = await logSyncStart('custom_fields');

  try {
    const customFields = await ghl.getCustomFields();

    for (const cf of customFields) {
      try {
        await supabase.from('custom_fields').upsert(
          {
            ghl_field_id: cf.id,
            ghl_location_id: ghl.getLocationId(),
            name: cf.name,
            field_key: cf.fieldKey || null,
            data_type: cf.dataType || null,
            placeholder: cf.placeholder || null,
            position: cf.position ?? null,
            model: cf.model || null,
            raw_json: cf,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_field_id' },
        );
        synced++;
      } catch (err) {
        errors.push(`CustomField ${cf.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete custom fields no longer in GHL
    const activeFieldIds = customFields.map((cf) => cf.id);
    await softDeleteMissing('custom_fields', 'ghl_field_id', activeFieldIds, ghl.getLocationId());

    await logSyncComplete(syncLogId, synced);
    await updateLastSynced('custom_fields');
    console.log(`[EntitySync] Custom fields synced: ${synced}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Custom fields sync failed: ${msg}`);
  }

  return { synced, errors };
}

// ---- Custom Values Sync ----

export async function syncCustomValues(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const now = nowET();
  let synced = 0;
  const errors: string[] = [];
  const syncLogId = await logSyncStart('custom_values');

  try {
    const customValues = await ghl.getCustomValues();

    for (const cv of customValues) {
      try {
        await supabase.from('custom_values').upsert(
          {
            ghl_value_id: cv.id,
            ghl_location_id: ghl.getLocationId(),
            name: cv.name,
            field_key: cv.fieldKey || null,
            value: cv.value || null,
            raw_json: cv,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_value_id' },
        );
        synced++;
      } catch (err) {
        errors.push(`CustomValue ${cv.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete custom values no longer in GHL
    const activeValueIds = customValues.map((cv) => cv.id);
    await softDeleteMissing('custom_values', 'ghl_value_id', activeValueIds, ghl.getLocationId());

    await logSyncComplete(syncLogId, synced);
    await updateLastSynced('custom_values');
    console.log(`[EntitySync] Custom values synced: ${synced}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Custom values sync failed: ${msg}`);
  }

  return { synced, errors };
}

// ---- Tags Sync ----

export async function syncTags(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const now = nowET();
  let synced = 0;
  const errors: string[] = [];
  const syncLogId = await logSyncStart('tags');

  try {
    const tags = await ghl.getTags();

    for (const tag of tags) {
      try {
        await supabase.from('tags').upsert(
          {
            ghl_tag_id: tag.id,
            ghl_location_id: ghl.getLocationId(),
            name: tag.name,
            raw_json: tag,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_tag_id' },
        );
        synced++;
      } catch (err) {
        errors.push(`Tag ${tag.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete tags no longer in GHL
    const activeTagIds = tags.map((t) => t.id);
    await softDeleteMissing('tags', 'ghl_tag_id', activeTagIds, ghl.getLocationId());

    await logSyncComplete(syncLogId, synced);
    await updateLastSynced('tags');
    console.log(`[EntitySync] Tags synced: ${synced}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Tags sync failed: ${msg}`);
  }

  return { synced, errors };
}

// ---- Trigger Links Sync ----

export async function syncTriggerLinks(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const now = nowET();
  let synced = 0;
  const errors: string[] = [];
  const syncLogId = await logSyncStart('trigger_links');

  try {
    const links = await ghl.getLinks();

    // Log first link's keys to help diagnose field mapping
    if (links.length > 0) {
      console.log(`[EntitySync] Trigger link sample keys: ${Object.keys(links[0]).join(', ')}`);
    }

    for (const link of links) {
      try {
        // GHL API may return the generated tracking URL under various field names
        const raw = link as Record<string, unknown>;
        const linkUrl = (
          raw.url || raw.linkUrl || raw.link || raw.shortUrl ||
          raw.fullUrl || raw.trackingUrl || raw.generatedUrl ||
          raw.fieldKey || null
        ) as string | null;
        const redirectTo = (
          raw.redirectTo || raw.redirect_to || raw.redirectUrl ||
          raw.destination || raw.targetUrl || null
        ) as string | null;

        await supabase.from('trigger_links').upsert(
          {
            ghl_link_id: link.id,
            ghl_location_id: link.locationId || ghl.getLocationId(),
            name: link.name || null,
            redirect_to: redirectTo,
            url: linkUrl,
            raw_json: link,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_link_id' },
        );
        synced++;
      } catch (err) {
        errors.push(`Link ${link.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete trigger links no longer in GHL
    const activeLinkIds = links.map((l) => l.id);
    await softDeleteMissing('trigger_links', 'ghl_link_id', activeLinkIds, ghl.getLocationId());

    await logSyncComplete(syncLogId, synced);
    await updateLastSynced('trigger_links');
    console.log(`[EntitySync] Trigger links synced: ${synced}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Trigger links sync failed: ${msg}`);
  }

  return { synced, errors };
}
