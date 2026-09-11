import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { createLeadEvent, createLeadEventsBatch, syncWorkflowExecutionsFromTagDiff, type LeadEventSpec } from '../webhooks/handler.js';
import { nowET, toET } from '../utils/timezone.js';
import { deriveContactEventType, deriveAppointmentEventType, deriveMessageEventType } from '../utils/event-type.js';
import { normalizeDirection } from '../utils/normalize.js';
import type { GHLContact, GHLOpportunity, GHLConversation, GHLPaginationMeta, GHLMessage, GHLAppointment } from '../types/ghl.js';
import { createHash } from 'node:crypto';

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

// v2.1: both terminal writes are guarded with .eq('status', 'running') so they
// can only move a row OUT of 'running', never overwrite a terminal state that
// something else already set.
//
// Without the guard, a run abandoned by the scheduler's Promise.race kept
// executing in the background, and when it eventually finished — often 40+
// minutes after sync-reaper had already marked the row 'failed' — it flipped
// that row back to 'completed'. Production rows carried status='completed'
// alongside the reaper's own error_message, and get_sync_health (failed/total)
// therefore under-reported the true failure rate: opportunities showed 27
// "completed" runs that had in fact all been abandoned mid-flight. The
// scheduler released the mutex and moved on at the timeout, so 'failed' is the
// honest record of what happened; a late completion is not a completion.
async function logSyncComplete(syncLogId: string | null, recordsSynced: number): Promise<void> {
  if (!syncLogId) return;
  const supabase = getSupabaseClient();
  await supabase.from('sync_log').update({
    status: 'completed',
    records_synced: recordsSynced,
    completed_at: nowET(),
  }).eq('id', syncLogId).eq('status', 'running');
}

async function logSyncFailed(syncLogId: string | null, errorMessage: string): Promise<void> {
  if (!syncLogId) return;
  const supabase = getSupabaseClient();
  await supabase.from('sync_log').update({
    status: 'failed',
    error_message: errorMessage,
    completed_at: nowET(),
  }).eq('id', syncLogId).eq('status', 'running');
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

// Appointment delta gate. The -14d/+30d window fetch is unavoidable (GHL
// calendar events expose no reliable dateUpdated filter), but blindly
// upserting the whole window wrote ~1,790 rows every 15 min (~170K/day)
// into a ~10K-row table. Modes:
//   off     — legacy: upsert everything
//   shadow  — compute + store payload hashes, log would-skip, upsert everything
//   enforce — upsert only rows whose payload hash changed
const APPT_SYNC_DELTA_MODE = (process.env.APPT_SYNC_DELTA_MODE || 'shadow').toLowerCase();

function apptPayloadHash(row: Record<string, unknown>): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc: Record<string, unknown>, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(row))).digest('hex');
}

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
 * Decide whether a soft-delete batch is plausible or looks like a bug.
 *
 * v2.1: a runaway delete is always caused by the *active list* being wrong
 * (truncated fetch, ignored filter, partial API outage), never by GHL genuinely
 * dropping a large share of a location at once. Normal churn on this tenant is
 * 4-33 rows/day against ~21k opportunities (~0.15%), so a 2% ceiling leaves
 * more than 10x headroom while still catching a clipped list.
 *
 * Refusing is the safe direction: a missed delete leaves a stale row that the
 * next clean cycle removes, while an over-delete silently hides live records
 * from every report that reads the cache.
 */
export function isSoftDeleteBatchPlausible(
  deleteCount: number,
  existingCount: number,
): { ok: boolean; limit: number } {
  const ratio = parseFloat(process.env.SOFT_DELETE_MAX_RATIO || '0.02');
  const minAbs = parseInt(process.env.SOFT_DELETE_MIN_ABS || '50', 10);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 0.02;
  const safeMinAbs = Number.isFinite(minAbs) && minAbs > 0 ? minAbs : 50;
  const limit = Math.max(safeMinAbs, Math.floor(existingCount * safeRatio));
  return { ok: deleteCount <= limit, limit };
}

/**
 * Soft-delete records in Supabase that are no longer present in the GHL API response.
 * Sets deleted_at timestamp on records whose GHL ID is not in the provided set,
 * and clears deleted_at on records that reappear.
 *
 * v2.1 — two correctness fixes, both about not deleting things that exist:
 *
 *   1. The "currently active in Supabase" read was a bare .select() with no
 *      .range() pagination, so PostgREST capped it at 1,000 rows. On tables far
 *      past that (21k opportunities, 23k contacts) the reconcile only ever
 *      examined the first 1,000 rows — it was almost entirely inert, which is
 *      the only reason the truncated 20,000-record fetch documented in
 *      GHLClient.getAllOpportunitiesChecked() never mass-deleted anything. Both
 *      bugs had to be fixed together: fixing either one alone is unsafe.
 *
 *   2. `listIsComplete: false` now skips the delete pass entirely. Restores
 *      still run — a record present in a short list definitely exists — but
 *      absence from a clipped list proves nothing.
 */
export async function softDeleteMissing(
  table: string,
  ghlIdColumn: string,
  activeGhlIds: string[],
  locationId: string,
  options?: { listIsComplete?: boolean },
): Promise<{ deleted: number; restored: number; skipped?: string }> {
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

  if (options?.listIsComplete === false) {
    const skipped = `active list for ${table} was truncated — delete pass skipped (restores still applied)`;
    console.error(`[EntitySync] softDeleteMissing: ${skipped}`);
    return { deleted: 0, restored, skipped };
  }

  // Get all active GHL IDs currently in Supabase for this location.
  // v2.1: paginated — see the 1,000-row PostgREST cap note above.
  const existingIds: string[] = [];
  for (let page = 0; ; page++) {
    const from = page * PAGINATION_PAGE_SIZE;
    const to = from + PAGINATION_PAGE_SIZE - 1;

    let query = supabase
      .from(table)
      .select(ghlIdColumn)
      .is('deleted_at', null);

    // Only filter by location if the table has the column (most do)
    if (locationId) {
      query = query.eq('ghl_location_id', locationId);
    }

    const { data, error } = await query.range(from, to);
    if (error) {
      const skipped = `failed to page active ${table} ids (page ${page}): ${error.message} — delete pass skipped`;
      console.error(`[EntitySync] softDeleteMissing: ${skipped}`);
      return { deleted: 0, restored, skipped };
    }
    if (!data || data.length === 0) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of data as any[]) {
      const id = row[ghlIdColumn] as string;
      if (id) existingIds.push(id);
    }
    if (data.length < PAGINATION_PAGE_SIZE) break;
  }

  if (existingIds.length === 0) return { deleted: 0, restored };

  const activeSet = new Set(activeGhlIds);
  const toDelete = existingIds.filter((id) => !activeSet.has(id));

  if (toDelete.length === 0) return { deleted: 0, restored };

  const plausible = isSoftDeleteBatchPlausible(toDelete.length, existingIds.length);
  if (!plausible.ok) {
    const skipped =
      `refusing to soft-delete ${toDelete.length} of ${existingIds.length} ${table} rows — ` +
      `over the ${plausible.limit}-row safety limit. This almost always means the GHL list was ` +
      'incomplete, not that GHL dropped the records. Investigate before overriding via ' +
      'SOFT_DELETE_MAX_RATIO / SOFT_DELETE_MIN_ABS.';
    console.error(`[EntitySync] softDeleteMissing: ${skipped}`);
    return { deleted: 0, restored, skipped };
  }

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
    let contactListTruncated = false;
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
          const full = await ghl.getAllContactsChecked();
          contacts = full.contacts;
          contactListTruncated = full.truncated;
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
      const full = await ghl.getAllContactsChecked();
      contacts = full.contacts;
      contactListTruncated = full.truncated;
      console.log(
        `[EntitySync] syncContacts: fetched ${contacts.length} contacts` +
        (contactListTruncated ? ' (TRUNCATED — soft-delete will be skipped)' : ''),
      );
    }

    if (contacts.length === 0) {
      console.log('[EntitySync] syncContacts: no changes to sync');
      await updateLastSynced('contacts');
      await logSyncComplete(syncLogId, 0);
      return { synced: 0, skipped: 0, mode: effectiveMode, errors };
    }

    // v2.0 (workflow_executions repair, 2026-05-05): pre-fetch existing
    // tags so we can diff active-w* enrollments after the upsert (see
    // tag-diff loop below). Populates workflow_executions even when GHL
    // contact webhooks aren't being delivered — which has been the case
    // all along: 0 [Webhook] log lines all-time, 0 webhook_failures rows
    // ever, 0 tag_added/tag_removed/workflow_executed event types in
    // 782k+ lead_events. EntitySync runs every 15 min, so workflow
    // enrollment analytics stay current at that resolution as long as
    // this sync runs. The tag-diff path is documented in handler.ts.
    const previousTagsByContact = new Map<string, string[]>();
    {
      const ids = contacts.map((c) => c.id);
      for (let i = 0; i < ids.length; i += UPSERT_BATCH_SIZE) {
        const slice = ids.slice(i, i + UPSERT_BATCH_SIZE);
        const { data: existing } = await supabase
          .from('contacts')
          .select('ghl_contact_id, tags')
          .in('ghl_contact_id', slice);
        if (existing) {
          for (const row of existing as { ghl_contact_id: string; tags: string[] | null }[]) {
            previousTagsByContact.set(row.ghl_contact_id, row.tags || []);
          }
        }
      }
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

    // v2.0 (workflow_executions repair): populate workflow_executions
    // from active-w* tag diffs. syncWorkflowExecutionsFromTagDiff inserts
    // a 'running' row for any active-w* tag added since previousTags,
    // and updates the matching open row to 'completed' for any active-w*
    // tag removed. Same mechanism the webhook handler uses; this hook
    // ensures it runs every sync cycle regardless of webhook delivery.
    // Per-contact errors are logged but never break the sync. Sequential
    // is intentional — the function's existing-row check + insert pattern
    // has a TOCTOU race under concurrent execution.
    let tagDiffsRan = 0;
    let tagDiffsFailed = 0;
    for (const c of contacts) {
      const prev = previousTagsByContact.get(c.id) || [];
      const next = c.tags || [];
      try {
        await syncWorkflowExecutionsFromTagDiff(c.id, c.locationId || null, next, prev);
        tagDiffsRan++;
      } catch (err) {
        tagDiffsFailed++;
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[EntitySync] syncContacts: tag-diff failed for ${c.id}: ${m}`);
      }
    }
    if (tagDiffsRan + tagDiffsFailed > 0) {
      console.log(`[EntitySync] syncContacts: tag-diff processed ${tagDiffsRan} contacts (${tagDiffsFailed} failed)`);
    }

    // v1.8 (T2.1b): Batch lead_events instead of 3,774 sequential upserts.
    // Build all event specs, then hand to createLeadEventsBatch which does
    // ceil(N/500) bulk upserts. Turns a ~3-5 min sequential loop into a
    // ~3-5 second batched operation on full contact sync. Dedup semantics
    // preserved via event_hash unique constraint with ignoreDuplicates:true.
    console.log('[EntitySync] syncContacts: building lead event specs...');
    const leadEventSpecs: LeadEventSpec[] = [];
    for (const c of contacts) {
      const stableTs = c.dateUpdated || c.dateAdded;
      if (!stableTs) continue;
      try {
        leadEventSpecs.push({
          contactId: c.id,
          eventType: deriveContactEventType({ dateAdded: c.dateAdded, dateUpdated: c.dateUpdated }),
          sourceId: c.id,
          timestamp: stableTs,
          rawJson: c,
        });
      } catch (err) {
        errors.push(`Contact event spec ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const eventsWritten = await createLeadEventsBatch(leadEventSpecs);
    console.log(`[EntitySync] syncContacts: wrote ${eventsWritten}/${leadEventSpecs.length} lead events (batched)`);

    // v1.6: Soft-delete only runs in full mode — incremental can't see
    // records that GHL has removed since there's nothing to diff against.
    if (effectiveMode === 'full') {
      const activeContactIds = contacts.map((c) => c.id);
      const result = await softDeleteMissing(
        'contacts',
        'ghl_contact_id',
        activeContactIds,
        ghl.getLocationId(),
        { listIsComplete: !contactListTruncated },
      );
      if (result.skipped) errors.push(`Soft-delete skipped: ${result.skipped}`);
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
 * Supports 'incremental' and 'full' modes.
 *
 *   - 'full': fetch all via GET /opportunities/search, upsert all,
 *     run softDeleteMissing. Used on boot and by the daily 3:10 AM
 *     ET reconcile cron.
 *
 *   - 'incremental' (T2.3b, v1.8):
 *       1. Try POST /opportunities/search with a server-side
 *          dateUpdated filter first via getOpportunitiesUpdatedSince.
 *          Expected cost: 1-3 API calls, ~1-2s runtime, returns only
 *          the handful of opps that actually changed.
 *       2. If the server reports a suspiciously high total (>1500)
 *          the filter was probably ignored by GHL — fall back to
 *          the legacy path.
 *       3. If the search throws (400, 500, etc.) fall back to the
 *          legacy path.
 *       4. LEGACY FALLBACK: fetch all opps via GET, build a
 *          date_updated map from Supabase, client-side diff.
 *          Same behavior as the pre-T2.3b code. Works fine, just
 *          slower (~27 API calls, ~10-12s).
 *
 *   Either incremental path skips softDeleteMissing (can't see
 *   GHL-side deletions reliably from an incremental result set).
 *   The daily full reconcile handles that.
 */
export async function syncOpportunities(options?: { mode?: SyncMode }): Promise<SyncResult> {
  const mode: SyncMode = options?.mode ?? 'full';
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('opportunities');

  try {
    let toUpsert: GHLOpportunity[] = [];
    let skippedUnchanged = 0;
    // In full mode we always need the full list for softDelete. In
    // incremental we only populate it on the fallback path.
    let fullList: GHLOpportunity[] | null = null;
    let fullListTruncated = false;
    let incrementalPath: 'server-filter' | 'client-diff' | 'none' = 'none';

    if (mode === 'incremental') {
      const sinceIso = await computeIncrementalFloor('opportunities');
      if (!sinceIso) {
        console.log('[EntitySync] syncOpportunities: incremental requested but no prior sync — running full');
        // Re-route to full mode within this run
        console.log('[EntitySync] syncOpportunities: full mode — fetching all from GHL...');
        fullList = await ghl.getAllOpportunities();
        console.log(`[EntitySync] syncOpportunities: fetched ${fullList.length} opportunities from GHL`);
        toUpsert = fullList;
      } else {
        console.log(`[EntitySync] syncOpportunities: incremental, floor=${sinceIso} (overlap=${INCREMENTAL_OVERLAP_MINUTES}min)`);

        // ── Path 1: server-side filter (T2.3b) ──────────────────
        try {
          const result = await ghl.getOpportunitiesUpdatedSince(sinceIso);
          const reported = result.totalReportedByServer;
          // Sanity threshold: a normal 15-min window should return a
          // small subset. If the server reports >1500 opps it almost
          // certainly means the filter was silently ignored — GHL
          // returned the entire location. Fall back to client-diff.
          if (typeof reported === 'number' && reported > 1500) {
            console.warn(`[EntitySync] syncOpportunities: server filter returned total=${reported} — appears ignored, falling back to GET + client diff`);
          } else {
            toUpsert = result.opportunities;
            incrementalPath = 'server-filter';
            console.log(`[EntitySync] syncOpportunities: server-filtered ${toUpsert.length} changed opps (server total=${reported ?? 'n/a'})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[EntitySync] syncOpportunities: server-side search failed (${msg}) — falling back to GET + client diff`);
        }

        // ── Path 2 (fallback): client-side diff ─────────────────
        if (incrementalPath === 'none') {
          console.log('[EntitySync] syncOpportunities: fallback path — fetching all opportunities from GHL for client-side diff...');
          fullList = await ghl.getAllOpportunities();
          console.log(`[EntitySync] syncOpportunities: fetched ${fullList.length} opportunities from GHL`);

          // Build a map of existing opportunity id → date_updated from
          // Supabase. Paginated past the 1000-row PostgREST cap.
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
            toUpsert = fullList.filter((o) => {
              const incomingTs = o.dateUpdated || o.updatedAt;
              if (!incomingTs) return true; // Unknown freshness — upsert to be safe
              const existing = existingDates.get(o.id);
              if (!existing) return true; // New record never seen before
              // Strictly greater — equal means identical row, skip.
              return new Date(incomingTs).getTime() > new Date(existing).getTime();
            });
            skippedUnchanged = fullList.length - toUpsert.length;
            console.log(`[EntitySync] syncOpportunities: diff — ${toUpsert.length} changed, ${skippedUnchanged} unchanged (skipped)`);
          } else {
            toUpsert = fullList;
          }
          incrementalPath = 'client-diff';
        }
      }
    } else {
      // Full mode
      console.log('[EntitySync] syncOpportunities: full mode — fetching all opportunities from GHL...');
      const full = await ghl.getAllOpportunitiesChecked();
      fullList = full.opportunities;
      fullListTruncated = full.truncated;
      console.log(
        `[EntitySync] syncOpportunities: fetched ${fullList.length} opportunities from GHL` +
        (fullListTruncated ? ' (TRUNCATED — soft-delete will be skipped)' : ''),
      );
      toUpsert = fullList;
    }

    if (toUpsert.length === 0) {
      console.log(`[EntitySync] syncOpportunities: no rows to write (path=${incrementalPath === 'none' ? 'full' : incrementalPath})`);
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

    // v1.6: Soft-delete only runs in full mode (requires the full remote list
    // to diff against Supabase). fullList is guaranteed non-null here because
    // full mode always populates it above.
    if (mode === 'full' && fullList) {
      const activeOppIds = fullList.map((o) => o.id);
      const result = await softDeleteMissing(
        'opportunities',
        'ghl_opportunity_id',
        activeOppIds,
        ghl.getLocationId(),
        { listIsComplete: !fullListTruncated },
      );
      if (result.skipped) errors.push(`Soft-delete skipped: ${result.skipped}`);
    }

    await updateLastSynced('opportunities');
    await logSyncComplete(syncLogId, toUpsert.length);
    const pathLabel = mode === 'full' ? 'full' : incrementalPath;
    console.log(`[EntitySync] Opportunities synced (${pathLabel}): ${toUpsert.length} (skipped ${skippedUnchanged})`);
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

    // GHL /calendars/events returns the live status under `appointmentStatus`
    // (legacy typo variant: `appoinmentStatus`). The previous code read
    // `apt.status`, which the events API never sends — so every row defaulted
    // to 'confirmed', masking cancellations and no-shows. Read the real field.
    const apptStatusOf = (apt: GHLAppointment): string =>
      apt.appointmentStatus || apt.appoinmentStatus || apt.status || 'confirmed';

    // v1.4: Batch upserts. Delta gate hashes CONTENT fields only —
    // synced_at/updated_at change every cycle by construction and would
    // defeat the gate.
    const allRows = events.map((apt) => {
      const content = {
        ghl_appointment_id: apt.id,
        ghl_contact_id: apt.contactId || null,
        ghl_calendar_id: apt.calendarId || null,
        ghl_location_id: apt.locationId || null,
        title: apt.title || null,
        status: apptStatusOf(apt),
        start_time: apt.startTime || null,
        end_time: apt.endTime || null,
        assigned_to: apt.assignedUserId || null,
        raw_json: apt,
      };
      return {
        ...content,
        payload_hash: APPT_SYNC_DELTA_MODE !== 'off' ? apptPayloadHash(content) : null,
        synced_at: now,
        updated_at: now,
      };
    });

    // Delta gate: load stored hashes (chunked — .in() serializes into the
    // URL) and keep only changed rows. Fails open: prefetch error (e.g.
    // payload_hash column missing) runs the cycle ungated.
    let rows = allRows;
    let skippedUnchanged = 0;
    if (APPT_SYNC_DELTA_MODE !== 'off') {
      const storedHash = new Map<string, string | null>();
      let prefetchOk = true;
      for (const batch of chunk(allRows.map((r) => r.ghl_appointment_id), UPSERT_BATCH_SIZE)) {
        const { data, error } = await supabase
          .from('appointments')
          .select('ghl_appointment_id, payload_hash')
          .in('ghl_appointment_id', batch);
        if (error) {
          console.warn(`[EntitySync] syncAppointments: hash prefetch failed (${error.message}) — cycle runs ungated`);
          prefetchOk = false;
          break;
        }
        for (const r of (data || []) as { ghl_appointment_id: string; payload_hash: string | null }[]) {
          storedHash.set(r.ghl_appointment_id, r.payload_hash);
        }
      }
      if (prefetchOk) {
        const changed = allRows.filter((r) => storedHash.get(r.ghl_appointment_id) !== r.payload_hash);
        skippedUnchanged = allRows.length - changed.length;
        if (APPT_SYNC_DELTA_MODE === 'enforce') {
          rows = changed;
          console.log(`[EntitySync] syncAppointments: delta enforce — ${changed.length} changed, ${skippedUnchanged} unchanged skipped`);
        } else {
          console.log(`[EntitySync] syncAppointments: delta shadow — ${changed.length} changed, ${skippedUnchanged} would skip (writing all)`);
        }
      }
    }

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
    console.log(`[EntitySync] syncAppointments: upserted ${upsertedCount}/${rows.length} appointments (${skippedUnchanged} unchanged)`);

    // v1.8 (T2.1b): Batched lead events for appointments. Previously a 500-
    // to-1000-iteration sequential loop per 15-min cycle. Now a single
    // batched upsert. Appointments have useful derived event types for
    // funnel progression (appointment_booked / appointment_showed /
    // appointment_cancelled), so we keep this path intact — just batch it.
    console.log('[EntitySync] syncAppointments: building lead event specs...');
    // Enforce mode: only changed appointments can produce NEW lead events —
    // unchanged ones already emitted theirs (event_hash dedupes regardless;
    // this stops rebuilding ~1,700 specs per cycle).
    const changedIds = new Set(rows.map((r) => r.ghl_appointment_id));
    const leadEventSpecs: LeadEventSpec[] = [];
    for (const apt of events) {
      if (APPT_SYNC_DELTA_MODE === 'enforce' && !changedIds.has(apt.id)) continue;
      if (!apt.startTime || !apt.contactId) continue;
      try {
        leadEventSpecs.push({
          contactId: apt.contactId,
          eventType: deriveAppointmentEventType(apptStatusOf(apt)),
          sourceId: apt.id,
          timestamp: apt.startTime,
          rawJson: apt,
        });
      } catch (err) {
        errors.push(`Appointment event spec ${apt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const eventsWritten = await createLeadEventsBatch(leadEventSpecs);
    console.log(`[EntitySync] syncAppointments: wrote ${eventsWritten}/${leadEventSpecs.length} lead events (batched)`);

    // Tombstone ONLY appointments GHL explicitly reports as deleted.
    //
    // This used to call softDeleteMissing(), which is table-wide and window-
    // blind: it selects every non-deleted row for the location and tombstones
    // any id absent from the current fetch. But this sync deliberately fetches
    // a BOUNDED window (-14d/+30d above), so every appointment outside that
    // window was tombstoned on every pass — the comment here said "within the
    // synced time window", but nothing implemented that.
    //
    // Measured 2026-07-28: 8,028 of 8,087 rows (99.3%) carried deleted_at while
    // GHL's own raw_json.deleted was false on EVERY ONE of them — not a single
    // tombstone in the table corresponded to a real deletion. The rows arrived
    // in identical-microsecond batches (993 at 2026-06-15T20:30:02.025, 975,
    // 846, 751, 703 …), the signature of a bulk sweep. Anything filtering
    // `deleted_at IS NULL` — including the appointment capacity/fill dashboard
    // — was reading under 1% of the book.
    //
    // A second, subtler path corrupted rows INSIDE the window: a short or empty
    // page from the paginated fetch drops live ids out of activeAptIds, and the
    // sweep reads that gap as deletion. (Same fault visible elsewhere as
    // "empty page at startIndex=N but probe found rows".) That accounted for
    // the 297 tombstoned future-dated appointments.
    //
    // So absence is not a usable delete signal here on either count. GHL's
    // /calendars/events feed carries an explicit `deleted` field on every
    // event, and cancellation is already captured in `status` — which is the
    // signal consumers actually want. Tombstone on the explicit flag only.
    //
    // NOTE: softDeleteMissing() is still correct for the UNBOUNDED syncs that
    // fetch a full entity list (contacts, opportunities, workflows, tags …),
    // where absence really does mean the record is gone. Their tombstone rates
    // are 2-3%, consistent with real deletions. This change is scoped to
    // appointments precisely because only this sync pairs a bounded fetch with
    // a table-wide sweep.
    // BOTH of these must be CHUNKED. PostgREST serializes .in() into the URL
    // query string, so a single call with the whole event list (~2,240 ids,
    // ~56KB) blows the server's URL length limit and the request fails. The
    // first cut of this shipped unchunked with no error check on the restore
    // and silently did nothing: 2,040 in-window rows stayed tombstoned across
    // four sync passes. Chunk at UPSERT_BATCH_SIZE and check every error.
    const deletedAptIds = events.filter((a) => a.deleted === true).map((a) => a.id);
    let tombstonedCount = 0;
    for (const batch of chunk(deletedAptIds, UPSERT_BATCH_SIZE)) {
      const { data: rows, error: tombstoneErr } = await supabase
        .from('appointments')
        .update({ deleted_at: now, updated_at: now })
        .in('ghl_appointment_id', batch)
        .is('deleted_at', null)
        .select('ghl_appointment_id');
      if (tombstoneErr) {
        errors.push(`Appointment tombstone: ${tombstoneErr.message}`);
        console.error(`[EntitySync] syncAppointments: tombstone batch failed: ${tombstoneErr.message}`);
      } else {
        tombstonedCount += rows?.length || 0;
      }
    }
    if (tombstonedCount > 0) {
      console.log(`[EntitySync] syncAppointments: tombstoned ${tombstonedCount} GHL-deleted appointments`);
    }

    // Restore any row GHL is currently reporting as NOT deleted. This unwinds
    // the historical false tombstones as those appointments come back through
    // the sync window, so the repair is self-healing for in-window rows.
    const liveAptIds = events.filter((a) => a.deleted !== true).map((a) => a.id);
    let restoredCount = 0;
    for (const batch of chunk(liveAptIds, UPSERT_BATCH_SIZE)) {
      const { data: rows, error: restoreErr } = await supabase
        .from('appointments')
        .update({ deleted_at: null, updated_at: now })
        .in('ghl_appointment_id', batch)
        .not('deleted_at', 'is', null)
        .select('ghl_appointment_id');
      if (restoreErr) {
        errors.push(`Appointment restore: ${restoreErr.message}`);
        console.error(`[EntitySync] syncAppointments: restore batch failed: ${restoreErr.message}`);
      } else {
        restoredCount += rows?.length || 0;
      }
    }
    if (restoredCount > 0) {
      console.log(`[EntitySync] syncAppointments: restored ${restoredCount} falsely-tombstoned appointments`);
    }

    await updateLastSynced('appointments');
    await logSyncComplete(syncLogId, rows.length);
    console.log(`[EntitySync] Appointments synced: ${rows.length} written, ${skippedUnchanged} unchanged (mode=${APPT_SYNC_DELTA_MODE})`);
    return { synced: rows.length, errors };
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
