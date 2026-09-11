import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import { deriveAppointmentEventType, deriveMessageEventType } from '../utils/event-type.js';
import { normalizeDirection, extractMessageBody } from '../utils/normalize.js';
import { withBoundedRetry, isRetryableServiceCallError } from '../utils/retry.js';
import { trackBackground } from '../graceful-shutdown.js';
import {
  emitSystemEvent,
  contactToSystemEvent,
  opportunityToSystemEvent,
  appointmentToSystemEvent,
  messageToSystemEvent,
} from './event-bus.js';

/**
 * Creates a deterministic event hash for deduplication.
 */
function eventHash(sourceId: string, eventType: string, timestamp: string): string {
  return createHash('sha256')
    .update(`${sourceId}:${eventType}:${timestamp}`)
    .digest('hex');
}

/**
 * Inserts a lead_event row with dedup via event_hash unique constraint.
 * Returns true if inserted, false if duplicate.
 */
async function createLeadEvent(
  contactId: string | undefined,
  eventType: string,
  sourceId: string,
  timestamp: string,
  rawJson: unknown,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const hash = eventHash(sourceId || 'unknown', eventType, timestamp);

  const { error } = await supabase.from('lead_events').upsert(
    {
      event_hash: hash,
      contact_id: contactId || null,
      event_type: eventType,
      source_system: 'highlevel',
      event_time: timestamp,
      raw_json: rawJson,
    },
    { onConflict: 'event_hash', ignoreDuplicates: true },
  );

  return !error;
}

/**
 * v1.8: Batch variant of createLeadEvent. Takes an array of event specs and
 * performs a single bulk upsert per batch of 500 rows. Much faster than
 * sequential createLeadEvent() calls for sync jobs that process thousands
 * of contacts/appointments at once.
 *
 * Before: 3,774 contacts × 1 sequential Supabase round-trip = ~3-5 minutes
 *         per full contact sync (round-trip latency dominates).
 * After:  Ceil(3,774 / 500) = 8 bulk upserts = ~4 seconds total.
 *
 * Dedup semantics are preserved: event_hash has a unique constraint, and
 * ignoreDuplicates: true means existing rows are left untouched. Each row's
 * event_hash is computed the same way as the single-event path above, so
 * mixed usage (webhooks + batch sync) stays deduped correctly.
 *
 * Returns the number of rows attempted to be written (success count not
 * available through the batch API — failures log to console and throw).
 */
export interface LeadEventSpec {
  contactId: string | undefined;
  eventType: string;
  sourceId: string;
  timestamp: string;
  rawJson: unknown;
}

async function createLeadEventsBatch(specs: LeadEventSpec[]): Promise<number> {
  if (specs.length === 0) return 0;
  const supabase = getSupabaseClient();
  const BATCH_SIZE = 500;

  const rows = specs.map((s) => ({
    event_hash: eventHash(s.sourceId || 'unknown', s.eventType, s.timestamp),
    contact_id: s.contactId || null,
    event_type: s.eventType,
    source_system: 'highlevel',
    event_time: s.timestamp,
    raw_json: s.rawJson,
  }));

  let totalSubmitted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('lead_events').upsert(batch, {
      onConflict: 'event_hash',
      ignoreDuplicates: true,
    });
    if (error) {
      // Log but don't throw — one bad batch shouldn't kill the whole sync.
      // The sync log will still show the records_synced count for the entity,
      // and missing lead_events will be picked up on the next webhook fire
      // for that contact.
      console.error(
        `[LeadEvents] Batch upsert failed (${batch.length} rows, starting at index ${i}): ${error.message}`,
      );
    } else {
      totalSubmitted += batch.length;
    }
  }
  return totalSubmitted;
}

/**
 * Log a webhook failure for monitoring.
 */
async function logWebhookFailure(
  endpoint: string,
  eventType: string,
  error: string,
  payload: unknown,
  retryCount = 0,
): Promise<void> {
  const supabase = getSupabaseClient();
  const base = {
    endpoint,
    event_type: eventType,
    error_message: error,
    payload,
  };

  try {
    const { error: insertErr } = await supabase.from('webhook_failures').insert({
      ...base,
      retry_count: retryCount,
      last_retry_at: retryCount > 0 ? new Date().toISOString() : null,
    });
    if (!insertErr) return;

    // retry_count / last_retry_at arrive in migration 013. If the code is live
    // before the migration is applied, fall back to the pre-013 shape rather
    // than losing the row: an unlogged failure is invisible, and invisible
    // failures are the whole reason this project exists.
    console.warn(
      `[Webhook] webhook_failures insert failed (${insertErr.message}) — ` +
      'retrying without retry columns; apply migration 013',
    );
    await supabase.from('webhook_failures').insert(base);
  } catch {
    // Swallow logging errors to not break the webhook response
  }
}

// ─── workflow_executions tag-diff tracking ────────────────────────────
//
// GHL does not emit a native "workflow-executed" webhook event type, so
// the /webhooks/highlevel/workflow endpoint is effectively dead (no calls
// observed across 600k+ lead_events). Instead, every GHL workflow in this
// account follows the active-w* tag convention:
//
//   - Entering a workflow: the workflow's first step adds active-w{ID}
//   - Leaving a workflow: the exit conditions remove active-w{ID}
//
// We exploit this by diffing each contact webhook's incoming tags vs the
// tags we already have stored. Any active-w* addition becomes a
// workflow_executions row with status='running'; any removal closes the
// open row to status='completed'. This gives us the workflow enrollment
// analytics we never had, automatically, for every workflow in the system.
//
// Tag naming has two formats in this account:
//   1) Dotted:  active-w5.2, active-w8.0, active-w11.1 (matches W5.2, W8.0…)
//   2) Padded:  active-w04, active-w02 (matches W0.4, W0.2 — legacy two-digit)
//
// Resolution ranks published workflows above drafts and prefers main
// workflows over exit-condition (*E) siblings (e.g., active-w0.2 resolves
// to W0.2 rather than W0.2E).

const WORKFLOW_TAG_CACHE: Map<string, string> = new Map();
let workflowTagCacheExpiry = 0;
const WORKFLOW_TAG_CACHE_TTL_MS = 10 * 60 * 1000;

async function refreshWorkflowTagCache(): Promise<void> {
  const supabase = getSupabaseClient();

  // v2.1 (2026-05-22): Source the tag→workflow mapping from BOTH
  // workflow_registry.legacy_name AND workflows.name. The original
  // implementation only read workflows.name and matched a W-prefix
  // regex against it. That worked until the May 2026 workflow rename,
  // which moved every user-facing workflow from W-prefix (W0.x, W5.2,
  // W11.1) to canonical codes (E.0, S5.2, O.0-COOL). After the rename,
  // workflows.name no longer contains any W-prefix names, so the regex
  // returns 0 matches and the cache is empty. Every active-w* tag then
  // fails to resolve and workflow_executions silently stops accepting
  // writes — which is exactly what happened: writes stopped on
  // 2026-05-13 (1,420 rows total, last row 2026-05-13 09:35:34, zero
  // rows in the last 7 days as of 2026-05-22).
  //
  // The fix: workflow_registry preserves the old W-name in its
  // legacy_name column for every renamed workflow (e.g., S5.2's
  // legacy_name is "W5.2 - Appointment Rescue"). Reading that column
  // lets us restore the active-w5.2 → workflow_id mapping using the
  // same regex without changing any tag conventions in GHL itself.
  // workflows.name is kept as a fallback for any workflow that happens
  // to still carry a W-prefix name but isn't registered (rare).
  const [registryResult, workflowResult] = await Promise.all([
    supabase
      .from('workflow_registry')
      .select('workflow_id, legacy_name, ghl_status')
      .not('legacy_name', 'is', null),
    supabase
      .from('workflows')
      .select('ghl_workflow_id, name, status')
      .is('deleted_at', null),
  ]);

  const registryData = registryResult.data || [];
  const workflowData = workflowResult.data || [];

  if (registryResult.error && workflowResult.error) {
    console.warn(
      `[Webhook] workflow_tag cache refresh failed: registry=${registryResult.error.message} workflows=${workflowResult.error.message}`,
    );
    return;
  }
  if (registryData.length === 0 && workflowData.length === 0) {
    console.warn('[Webhook] workflow_tag cache refresh: both sources empty — keeping prior cache');
    return;
  }

  // Merge into a single normalized list. workflow_registry wins on
  // duplicate workflow_ids because legacy_name is the authoritative
  // post-rename source. Status comes from ghl_status (registry) or
  // status (workflows) — used only for the published-first tie-break.
  type CacheRow = { id: string; nameSource: string; status: string };
  const seen = new Set<string>();
  const rows: CacheRow[] = [];

  for (const r of registryData) {
    const id = (r.workflow_id as string) || '';
    const legacy = (r.legacy_name as string) || '';
    if (!id || !legacy || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, nameSource: legacy, status: (r.ghl_status as string) || 'unknown' });
  }
  for (const w of workflowData) {
    const id = (w.ghl_workflow_id as string) || '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, nameSource: (w.name as string) || '', status: (w.status as string) || 'unknown' });
  }

  // Sort: published first, then by UUID for stable tie-breaks. This
  // matches the order the backfill SQL uses, so runtime tag→UUID
  // resolution stays consistent with the one-time backfill done on
  // 2026-04-24.
  const sorted = rows.sort((a, b) => {
    const aPub = a.status === 'published' ? 0 : 1;
    const bPub = b.status === 'published' ? 0 : 1;
    if (aPub !== bPub) return aPub - bPub;
    return a.id.localeCompare(b.id);
  });

  const fresh = new Map<string, string>();
  for (const row of sorted) {
    // Extract short name: matches W<digits>.<digits> followed by space/dash.
    // This is the same pattern the backfill SQL uses ((^|non-alphanumeric)
    // W<digits>.<digits>(space|dash)), which prevents W5.2 from matching
    // W5.2E — exit-condition siblings are excluded from the tag mapping.
    const match = row.nameSource.match(/(?:^|[^A-Za-z0-9])(W\d+(?:\.\d+)?)(?:\s|-)/);
    if (!match) continue;
    const shortName = match[1]; // e.g. "W5.2", "W10.0", "W0.4"

    // Dotted tag: W5.2 -> active-w5.2
    const dottedTag = 'active-' + shortName.toLowerCase();
    if (!fresh.has(dottedTag)) fresh.set(dottedTag, row.id);

    // Padded legacy tag: W0.4 -> active-w04, W0.2 -> active-w02
    const paddedMatch = shortName.match(/^W0\.(\d)$/);
    if (paddedMatch) {
      const paddedTag = `active-w0${paddedMatch[1]}`;
      if (!fresh.has(paddedTag)) fresh.set(paddedTag, row.id);
    }
  }

  WORKFLOW_TAG_CACHE.clear();
  for (const [k, v] of fresh) WORKFLOW_TAG_CACHE.set(k, v);
  workflowTagCacheExpiry = Date.now() + WORKFLOW_TAG_CACHE_TTL_MS;
  console.log(
    `[Webhook] workflow_tag cache refreshed: ${WORKFLOW_TAG_CACHE.size} mappings ` +
    `(scanned ${registryData.length} registry + ${workflowData.length} workflows)`,
  );
}

async function resolveWorkflowIdFromTag(tag: string): Promise<string | null> {
  if (!tag || !tag.startsWith('active-w')) return null;
  if (Date.now() > workflowTagCacheExpiry) {
    await refreshWorkflowTagCache();
  }
  return WORKFLOW_TAG_CACHE.get(tag.toLowerCase()) ?? null;
}

/**
 * Diffs active-w* tags between the previous and new tag arrays for a
 * contact and writes workflow_executions rows accordingly.
 *
 *   - Added active-w* tag  -> INSERT (status='running', started_at=now)
 *   - Removed active-w* tag -> UPDATE the open 'running' row for that
 *                              (workflow, contact) to status='completed'
 *
 * Idempotent: if an 'active-w*' tag is added and a 'running' row already
 * exists for (workflow, contact), we skip the INSERT. This keeps the
 * behaviour sane when GHL re-fires a contact update webhook without any
 * actual tag change, or when a workflow re-adds its own active-w tag as
 * part of a self-rearming pattern.
 *
 * Silent on lookup or write failures — this function is ancillary to
 * webhook processing and must never break a webhook response. All errors
 * are logged at warn level.
 */
export async function syncWorkflowExecutionsFromTagDiff(
  contactId: string,
  locationId: string | null,
  newTags: string[],
  previousTags: string[],
): Promise<void> {
  const prevSet = new Set(previousTags);
  const newSet = new Set(newTags);

  const addedActiveW = newTags.filter((t) => t.startsWith('active-w') && !prevSet.has(t));
  const removedActiveW = previousTags.filter((t) => t.startsWith('active-w') && !newSet.has(t));

  if (addedActiveW.length === 0 && removedActiveW.length === 0) return;

  const supabase = getSupabaseClient();
  const now = nowET();

  for (const tag of addedActiveW) {
    const workflowId = await resolveWorkflowIdFromTag(tag);
    if (!workflowId) {
      console.warn(`[Webhook] active-w tag "${tag}" did not resolve to a workflow UUID (contact ${contactId})`);
      continue;
    }

    // Skip if an open 'running' row already exists for (workflow, contact).
    // Avoids duplicate rows when a webhook re-fires without true tag change.
    const { data: existing } = await supabase
      .from('workflow_executions')
      .select('id')
      .eq('ghl_workflow_id', workflowId)
      .eq('ghl_contact_id', contactId)
      .eq('status', 'running')
      .limit(1);
    if (existing && existing.length > 0) continue;

    const { error: insertError } = await supabase.from('workflow_executions').insert({
      ghl_workflow_id: workflowId,
      ghl_contact_id: contactId,
      ghl_location_id: locationId,
      status: 'running',
      started_at: now,
      execution_data: { source: 'tag_diff_webhook', tag },
    });
    if (insertError) {
      console.warn(`[Webhook] workflow_executions INSERT failed for ${workflowId} / ${contactId}: ${insertError.message}`);
    }
  }

  for (const tag of removedActiveW) {
    const workflowId = await resolveWorkflowIdFromTag(tag);
    if (!workflowId) continue; // already warned on add path if unresolvable

    const { error: updateError } = await supabase
      .from('workflow_executions')
      .update({ status: 'completed', completed_at: now })
      .eq('ghl_workflow_id', workflowId)
      .eq('ghl_contact_id', contactId)
      .eq('status', 'running');
    if (updateError) {
      console.warn(`[Webhook] workflow_executions UPDATE (completed) failed for ${workflowId} / ${contactId}: ${updateError.message}`);
    }
  }
}

// ---- Individual webhook handlers ----

async function handleContactWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.contactId) as string;
  const locationId = (payload.locationId as string) || null;
  const now = nowET();

  // Fetch previous tags BEFORE the upsert so we can diff. Missing contact
  // (first webhook for this id) is fine — previousTags is empty and any
  // active-w* tags in the incoming payload are treated as fresh enrollments.
  let previousTags: string[] = [];
  try {
    const { data: prev } = await supabase
      .from('contacts')
      .select('tags')
      .eq('ghl_contact_id', id)
      .maybeSingle();
    previousTags = (prev?.tags as string[]) || [];
  } catch {
    // Non-critical — fall through with empty previousTags. The upsert below
    // will still run. Tag-diff simply won't detect any removals this pass.
  }

  const newTags = (payload.tags as string[]) || [];

  // v2.2 — DELIBERATELY writes no payload_hash.
  //
  // A webhook payload is not always the complete record, so a hash computed
  // from it could coincidentally match what the next scheduled sync computes
  // from the full record and cause a real change to be skipped. Leaving the
  // stored hash stale is the safe direction: it will not match the next
  // cycle's freshly computed hash, so the row is treated as changed and
  // rewritten. See src/utils/delta-gate.ts.
  await supabase.from('contacts').upsert(
    {
      ghl_contact_id: id,
      ghl_location_id: locationId,
      first_name: (payload.firstName as string) || null,
      last_name: (payload.lastName as string) || null,
      email: (payload.email as string) || null,
      phone: (payload.phone as string) || null,
      company_name: (payload.companyName as string) || null,
      tags: newTags,
      source: (payload.source as string) || null,
      custom_fields: payload.customFields || {},
      date_added: (payload.dateAdded as string) || null,
      date_updated: (payload.dateUpdated as string) || now,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_contact_id' },
  );

  const eventType = payload.type === 'ContactCreate' ? 'contact_created' : 'contact_updated';
  const stableTs = (payload.dateUpdated || payload.dateAdded || now) as string;
  await createLeadEvent(id, eventType, id, stableTs, payload);

  // Track tag changes as separate events
  if (payload.tags && Array.isArray(payload.tags)) {
    const action = payload.action as string | undefined;
    if (action === 'tag_added' || action === 'tag_removed') {
      await createLeadEvent(id, action, id, stableTs, payload);
    }
  }

  // ── Populate workflow_executions from active-w* tag diff (non-blocking) ──
  // See comment block above syncWorkflowExecutionsFromTagDiff for rationale.
  trackBackground(syncWorkflowExecutionsFromTagDiff(id, locationId, newTags, previousTags).catch((err) => {
    console.warn(`[Webhook] workflow_executions tag-diff failed for contact ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }));

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = contactToSystemEvent(payload);
  if (systemEvent) {
    trackBackground(emitSystemEvent(systemEvent).catch(() => {})); // fire-and-forget
  }

  // ── Forward to LP MCP for tag-event emission (Wave 1.2) ──
  // LP MCP /webhooks/ghl-tag diffs vs contact_tag_snapshot and emits
  // ghl.tag_added / ghl.tag_removed system_events for the Decision
  // Engine. Fire-and-forget — never block the GHL webhook ack.
  if (payload.type === 'ContactTagUpdate') {
    trackBackground(forwardTagUpdateToLpMcp(id, newTags));
  }
}

/**
 * Forward a tag change to LP MCP, with bounded retry.
 *
 * Before 2026-08-29 this was a single fire-and-forget POST: one attempt, a 5s
 * timeout, and on failure a row in webhook_failures and nothing else. 4,222
 * tag events were lost that way, 4,150 of them to the 5s timeout alone. A
 * dropped tag event silently skips every tag-triggered agent rule, entry
 * hygiene check, and stage advancement for that contact.
 *
 * Three attempts at 2s / 10s / 60s. The ladder is deliberately wide at the
 * end: the 502s in the failure data are Railway cold starts and restarts, and
 * a container that is still booting needs closer to a minute than to a second.
 *
 * Still detached — this must never block the GHL webhook ack, which is what
 * the caller depends on.
 *
 * 2026-09-11: it is no longer lost on a redeploy. The note here used to read
 * "the retry chain lives in memory for up to ~75s, so a redeploy mid-chain
 * loses it". It now RETURNS its promise so the caller can hand it to
 * trackBackground, and graceful shutdown waits for the chain to finish before
 * the process exits. The full ladder (2s + 10s + 60s) fits inside the 90s
 * SHUTDOWN_GRACE_MS with room to spare, and on the happy path the whole thing
 * is done in well under 5s, so the drain is unaffected in normal operation.
 * webhook_failures and the replay tool remain the backstop for a chain that
 * genuinely outlives the grace window.
 *
 * occurred_at is stamped here rather than at the receiver so the value
 * survives a retry: LP MCP keys its emitted tag events on it, and a key that
 * shifted between attempts would let one change fire a rule twice.
 */
function forwardTagUpdateToLpMcp(contactId: string, newTags: string[]): Promise<void> {
  const lpMcpBaseUrl = process.env.LP_MCP_BASE_URL
    || 'https://lp-mcp-production.up.railway.app';
  const body = JSON.stringify({
    contact_id: contactId,
    tags: newTags,
    occurred_at: new Date().toISOString(),
  });

  let attempts = 0;

  return withBoundedRetry(
    async () => {
      attempts++;
      const response = await fetch(`${lpMcpBaseUrl}/webhooks/ghl-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '<no body>');
        // Message shape matters: isRetryableServiceCallError matches
        // /returned 5\d{2}/ to decide a 502 is worth another attempt.
        throw new Error(`LP MCP returned ${response.status}: ${text}`);
      }
      return response;
    },
    {
      maxAttempts: 3,
      delaysMs: [2_000, 10_000, 60_000],
      label: 'lp-mcp:/webhooks/ghl-tag',
      isRetryable: isRetryableServiceCallError,
    },
  ).catch(async (err) => {
    // Only now, with every attempt spent, is this a real failure.
    await logWebhookFailure(
      'lp-mcp:/webhooks/ghl-tag',
      'ContactTagUpdate',
      err instanceof Error ? err.message : String(err),
      { contact_id: contactId, tags: newTags },
      attempts,
    );
  // Collapse the success branch's Response to void — the caller only needs to
  // know the chain finished, never what LP MCP sent back.
  }).then(() => {});
}

async function handleOpportunityWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.opportunityId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

  // v2.2 — DELIBERATELY writes no payload_hash.
  //
  // A webhook payload is not always the complete record, so a hash computed
  // from it could coincidentally match what the next scheduled sync computes
  // from the full record and cause a real change to be skipped. Leaving the
  // stored hash stale is the safe direction: it will not match the next
  // cycle's freshly computed hash, so the row is treated as changed and
  // rewritten. See src/utils/delta-gate.ts.
  await supabase.from('opportunities').upsert(
    {
      ghl_opportunity_id: id,
      ghl_pipeline_id: (payload.pipelineId as string) || '',
      ghl_stage_id: (payload.pipelineStageId || payload.stageId) as string || null,
      ghl_contact_id: contactId || null,
      ghl_location_id: (payload.locationId as string) || null,
      name: (payload.name as string) || 'Unnamed',
      status: (payload.status as string) || 'open',
      monetary_value: (payload.monetaryValue as number) || null,
      currency: (payload.currency as string) || 'USD',
      source: (payload.source as string) || null,
      assigned_to: (payload.assignedTo as string) || null,
      custom_fields: payload.customFields || {},
      date_added: (payload.dateAdded as string) || (payload.createdAt as string) || null,
      date_updated: (payload.dateUpdated as string) || (payload.updatedAt as string) || now,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_opportunity_id' },
  );

  const eventType =
    payload.type === 'OpportunityCreate' ? 'opportunity_created' :
    payload.previousStageId ? 'pipeline_stage_changed' :
    'opportunity_updated';
  const stableTs = (payload.dateUpdated || payload.updatedAt || payload.dateAdded || payload.createdAt || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = opportunityToSystemEvent(payload);
  if (systemEvent) {
    trackBackground(emitSystemEvent(systemEvent).catch(() => {}));
  }
}

async function handleAppointmentWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.appointmentId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

  // v2.2 — DELIBERATELY writes no payload_hash.
  //
  // A webhook payload is not always the complete record, so a hash computed
  // from it could coincidentally match what the next scheduled sync computes
  // from the full record and cause a real change to be skipped. Leaving the
  // stored hash stale is the safe direction: it will not match the next
  // cycle's freshly computed hash, so the row is treated as changed and
  // rewritten. See src/utils/delta-gate.ts.
  await supabase.from('appointments').upsert(
    {
      ghl_appointment_id: id,
      ghl_contact_id: contactId || null,
      ghl_calendar_id: (payload.calendarId as string) || null,
      ghl_location_id: (payload.locationId as string) || null,
      title: (payload.title as string) || null,
      status: (payload.status as string) || 'confirmed',
      start_time: (payload.startTime as string) || null,
      end_time: (payload.endTime as string) || null,
      assigned_to: (payload.assignedUserId as string) || null,
      raw_json: payload,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_appointment_id' },
  );

  const eventType = deriveAppointmentEventType((payload.status as string) || '');
  const stableTs = (payload.startTime || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = appointmentToSystemEvent(payload);
  if (systemEvent) {
    trackBackground(emitSystemEvent(systemEvent).catch(() => {}));
  }
}

async function handleMessageWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.messageId) as string;
  const contactId = payload.contactId as string | undefined;
  const direction = normalizeDirection(payload.direction as string | number | undefined);
  const msgType = (payload.type as string) || 'sms';
  const now = nowET();

  await supabase.from('messages').upsert(
    {
      ghl_message_id: id,
      ghl_conversation_id: (payload.conversationId as string) || '',
      ghl_contact_id: contactId || null,
      direction,
      type: msgType,
      body: extractMessageBody(payload),
      status: (payload.status as string) || 'delivered',
      sent_at: (payload.dateAdded as string) || now,
    },
    { onConflict: 'ghl_message_id' },
  );

  const eventType = deriveMessageEventType({ direction, type: msgType, status: payload.status as string });
  const stableTs = (payload.dateAdded || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);

  // ── Forward inbound messages to agentic event bus (non-blocking) ──
  const systemEvent = messageToSystemEvent(payload);
  if (systemEvent) {
    trackBackground(emitSystemEvent(systemEvent).catch(() => {}));
  }
}

async function handleWorkflowWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.workflowId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

  // v2.2 — DELIBERATELY writes no payload_hash.
  //
  // A webhook payload is not always the complete record, so a hash computed
  // from it could coincidentally match what the next scheduled sync computes
  // from the full record and cause a real change to be skipped. Leaving the
  // stored hash stale is the safe direction: it will not match the next
  // cycle's freshly computed hash, so the row is treated as changed and
  // rewritten. See src/utils/delta-gate.ts.
  await supabase.from('workflows').upsert(
    {
      ghl_workflow_id: id,
      ghl_location_id: (payload.locationId as string) || null,
      name: (payload.name as string) || 'Unknown',
      status: (payload.status as string) || 'draft',
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_workflow_id' },
  );

  const stableTs = (payload.dateAdded || now) as string;
  await createLeadEvent(contactId, 'workflow_executed', id, stableTs, payload);

  // Also populate workflow_executions table. This path is dead in practice
  // (GHL does not emit a workflow-executed event type), but we keep it so
  // any future GHL-side webhook actions that POST here continue to work.
  try {
    await supabase.from('workflow_executions').insert({
      ghl_workflow_id: id,
      ghl_contact_id: contactId || null,
      ghl_location_id: (payload.locationId as string) || null,
      status: (payload.status as string) || 'completed',
      started_at: stableTs,
      completed_at: now,
      execution_data: payload,
    });
  } catch {
    // Non-critical — log but don't fail the webhook
    console.warn(`[Webhook] Failed to insert workflow_execution for workflow ${id}`);
  }

  // ── Forward to agentic event bus (non-blocking) ──
  trackBackground(emitSystemEvent({
    event_type: 'workflow.contact_added',
    source: 'ghl',
    entity_type: 'workflow',
    entity_id: id,
    ghl_contact_id: contactId,
    payload,
    priority: 'normal',
    event_timestamp: stableTs,
  }).catch(() => {}));
}

// ---- Main webhook router ----

const WEBHOOK_HANDLERS: Record<string, (payload: Record<string, unknown>) => Promise<void>> = {
  '/webhooks/highlevel/contact': handleContactWebhook,
  '/webhooks/highlevel/opportunity': handleOpportunityWebhook,
  '/webhooks/highlevel/appointment': handleAppointmentWebhook,
  '/webhooks/highlevel/message': handleMessageWebhook,
  '/webhooks/highlevel/workflow': handleWorkflowWebhook,
};

/**
 * Handles an incoming GoHighLevel webhook.
 * Returns true if the pathname matched a known webhook endpoint.
 */
export async function handleWebhook(
  pathname: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const handler = WEBHOOK_HANDLERS[pathname];
  if (!handler) return false;

  try {
    await handler(body);
    console.log(`[Webhook] Processed ${pathname} successfully`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Webhook] Error processing ${pathname}: ${msg}`);
    await logWebhookFailure(pathname, pathname.split('/').pop() || '', msg, body);
  }

  return true;
}

/**
 * Utility: createLeadEvent is exported for use by scheduled sync jobs too.
 */
export { createLeadEvent, createLeadEventsBatch, eventHash };
