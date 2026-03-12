import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { createLeadEvent } from '../webhooks/handler.js';
import { nowET, toET } from '../utils/timezone.js';
import { deriveContactEventType, deriveAppointmentEventType, deriveMessageEventType } from '../utils/event-type.js';
import { normalizeDirection } from '../utils/normalize.js';

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

// ---- Contact Sync (every 15 min) ----

export async function syncContacts(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('contacts');

  try {
    // Fetch ALL contacts with pagination (no updatedAfter — not supported by GHL API v2)
    const contacts = await ghl.getAllContacts();

    const now = nowET();
    for (const c of contacts) {
      try {
        await supabase.from('contacts').upsert(
          {
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
          },
          { onConflict: 'ghl_contact_id' },
        );

        const stableTs = c.dateUpdated || c.dateAdded;
        if (stableTs) {
          const eventType = deriveContactEventType({ dateAdded: c.dateAdded, dateUpdated: c.dateUpdated });
          await createLeadEvent(c.id, eventType, c.id, stableTs, c);
        }
      } catch (err) {
        errors.push(`Contact ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete contacts no longer in GHL
    const activeContactIds = contacts.map((c) => c.id);
    await softDeleteMissing('contacts', 'ghl_contact_id', activeContactIds, ghl.getLocationId());

    await updateLastSynced('contacts');
    await logSyncComplete(syncLogId, contacts.length);
    console.log(`[EntitySync] Contacts synced: ${contacts.length}`);
    return { synced: contacts.length, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Contact sync failed: ${msg}`);
    return { synced: 0, errors };
  }
}

// ---- Opportunity Sync (every 15 min) ----

export async function syncOpportunities(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('opportunities');

  try {
    // Fetch ALL opportunities with pagination (locationId always included now)
    const opportunities = await ghl.getAllOpportunities();

    const now = nowET();
    for (const o of opportunities) {
      try {
        await supabase.from('opportunities').upsert(
          {
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
          },
          { onConflict: 'ghl_opportunity_id' },
        );

        const stableTs = o.dateUpdated || o.updatedAt || o.dateAdded || o.createdAt;
        if (stableTs) {
          await createLeadEvent(o.contactId, 'opportunity_updated', o.id, stableTs, o);
        }
      } catch (err) {
        errors.push(`Opportunity ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete opportunities no longer in GHL
    const activeOppIds = opportunities.map((o) => o.id);
    await softDeleteMissing('opportunities', 'ghl_opportunity_id', activeOppIds, ghl.getLocationId());

    await updateLastSynced('opportunities');
    await logSyncComplete(syncLogId, opportunities.length);
    console.log(`[EntitySync] Opportunities synced: ${opportunities.length}`);
    return { synced: opportunities.length, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Opportunity sync failed: ${msg}`);
    return { synced: 0, errors };
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
    const events = await ghl.getAllAppointments({ startTime, endTime });
    if (events.length === 0) {
      console.warn('[EntitySync] No appointments returned — check that calendars exist and GHL_LOCATION_ID is correct');
    }

    const now = nowET();
    let synced = 0;
    for (const apt of events) {
      try {
        await supabase.from('appointments').upsert(
          {
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
          },
          { onConflict: 'ghl_appointment_id' },
        );

        const eventType = deriveAppointmentEventType(apt.status);
        if (apt.startTime) {
          await createLeadEvent(apt.contactId, eventType, apt.id, apt.startTime, apt);
        }
        synced++;
      } catch (err) {
        errors.push(`Appointment ${apt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Soft-delete appointments no longer in GHL (within the synced time window)
    const activeAptIds = events.map((a) => a.id);
    await softDeleteMissing('appointments', 'ghl_appointment_id', activeAptIds, ghl.getLocationId());

    await updateLastSynced('appointments');
    await logSyncComplete(syncLogId, synced);
    console.log(`[EntitySync] Appointments synced: ${synced}`);
    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Appointment sync failed: ${msg}`);
    return { synced: 0, errors };
  }
}

// ---- Pipeline Sync (every 30 min) ----

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

// ---- Conversation & Message Sync (every 15 min) — direct GHL OAuth calls ----

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 3000; // 3s pause between batches to stay under GHL rate limits
const MAX_CONTACTS_PER_SYNC = 200; // Limit per run to avoid timeouts

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

  // Check if OAuth is configured
  if (!ghl.isOAuthConfigured) {
    console.warn('[EntitySync] GHL OAuth not configured — skipping conversations/messages sync. ' +
      'Set GHL_OAUTH_CLIENT_ID and GHL_OAUTH_CLIENT_SECRET, then visit /crm-oauth/authorize.');
    return { synced_conversations: 0, synced_messages: 0, errors: ['GHL OAuth not configured'] };
  }

  const syncLogId = await logSyncStart('conversations');
  const msgSyncLogId = await logSyncStart('messages');

  try {
    // Get all contact IDs (exclude soft-deleted)
    const { data: allContacts, error: allError } = await supabase
      .from('contacts')
      .select('ghl_contact_id')
      .is('deleted_at', null)
      .order('date_added', { ascending: true });
    if (allError) throw new Error(`Failed to fetch contacts: ${allError.message}`);
    if (!allContacts?.length) {
      console.warn('[EntitySync] No contacts found in Supabase — sync contacts first');
      await logSyncComplete(syncLogId, 0);
      return { synced_conversations: 0, synced_messages: 0, errors: [] };
    }

    // Determine backfill vs incremental mode
    // Backfill: process contacts that have NEVER had conversations checked
    // Incremental: all contacts covered, refresh most recently updated
    const { data: syncedRows } = await supabase
      .from('conversations')
      .select('ghl_contact_id');
    const syncedIds = new Set((syncedRows || []).map(r => r.ghl_contact_id));
    const unsyncedContacts = allContacts.filter(c => !syncedIds.has(c.ghl_contact_id));

    let contacts: { ghl_contact_id: string }[];
    if (unsyncedContacts.length > 0) {
      // Backfill mode — drip through unsynced contacts
      contacts = unsyncedContacts.slice(0, MAX_CONTACTS_PER_SYNC);
      console.log(`[EntitySync] Backfill: syncing ${contacts.length} of ${unsyncedContacts.length} remaining unsynced contacts (${allContacts.length} total)`);
    } else {
      // All contacts covered — incremental mode (round-robin by oldest synced_at)
      // Prioritize contacts whose conversations were checked longest ago,
      // ensuring all contacts are periodically re-checked for new messages.
      const { data: staleConversations } = await supabase
        .from('conversations')
        .select('ghl_contact_id, synced_at')
        .is('deleted_at', null)
        .order('synced_at', { ascending: true })
        .limit(MAX_CONTACTS_PER_SYNC);

      if (staleConversations && staleConversations.length > 0) {
        // Deduplicate contact IDs (a contact may have multiple conversations)
        const seen = new Set<string>();
        contacts = [];
        for (const row of staleConversations) {
          if (!seen.has(row.ghl_contact_id)) {
            seen.add(row.ghl_contact_id);
            contacts.push({ ghl_contact_id: row.ghl_contact_id });
          }
          if (contacts.length >= MAX_CONTACTS_PER_SYNC) break;
        }
        const oldestSyncedAt = staleConversations[0]?.synced_at || 'unknown';
        console.log(`[EntitySync] Incremental (round-robin): refreshing ${contacts.length} contacts, oldest synced_at: ${oldestSyncedAt}`);
      } else {
        contacts = allContacts.slice(0, MAX_CONTACTS_PER_SYNC);
        console.log(`[EntitySync] Incremental: refreshing ${contacts.length} contacts (fallback to all contacts)`);
      }
    }

    let totalConversations = 0;
    let totalMessages = 0;
    const now = nowET();

    // Process contacts in batches
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);

      // Process each contact in the batch concurrently
      const results = await Promise.allSettled(
        batch.map(async (contact) => {
          const contactId = contact.ghl_contact_id;
          let convCount = 0;
          let msgCount = 0;

          try {
            // Fetch conversations for this contact
            const { conversations } = await ghl.getConversations({ contactId, limit: 50 });

            if (conversations.length === 0) {
              // Mark contact as checked so it won't appear in backfill again
              await supabase.from('conversations').upsert({
                ghl_conversation_id: `no-conv-${contactId}`,
                ghl_contact_id: contactId,
                type: 'none',
                synced_at: now,
                updated_at: now,
              }, { onConflict: 'ghl_conversation_id' });
            }

            for (const conv of conversations) {
              // Upsert conversation
              const { error: convError } = await supabase.from('conversations').upsert(
                {
                  ghl_conversation_id: conv.id,
                  ghl_contact_id: conv.contactId,
                  ghl_location_id: conv.locationId || null,
                  type: conv.type || null,
                  last_message_at: toISODate(conv.lastMessageDate),
                  unread_count: conv.unreadCount || 0,
                  synced_at: now,
                  updated_at: now,
                },
                { onConflict: 'ghl_conversation_id' },
              );
              if (convError) {
                errors.push(`Conv upsert ${conv.id}: ${convError.message}`);
                continue; // skip messages for this conversation
              }
              convCount++;

              // Fetch and upsert messages for this conversation (with pagination)
              try {
                const messageList = await ghl.getAllMessages(conv.id, 5);
                for (const msg of messageList) {
                  const { error: msgError } = await supabase.from('messages').upsert(
                    {
                      ghl_message_id: msg.id,
                      ghl_conversation_id: msg.conversationId || conv.id,
                      ghl_contact_id: msg.contactId || contactId,
                      direction: normalizeDirection(msg.direction),
                      type: msg.type || 'sms',
                      body: msg.body || msg.message || msg.text || null,
                      status: msg.status || 'delivered',
                      sent_at: toISODate(msg.dateAdded) || now,
                    },
                    { onConflict: 'ghl_message_id' },
                  );
                  if (msgError) {
                    errors.push(`Msg upsert ${msg.id}: ${msgError.message}`);
                    continue;
                  }
                  msgCount++;
                }
              } catch (msgErr) {
                errors.push(`Messages for conv ${conv.id}: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
              }
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            errors.push(`Contact ${contactId}: ${errMsg}`);
            console.error(`[EntitySync] Failed to sync conversations for contact ${contactId}: ${errMsg}`);
          }

          return { convCount, msgCount };
        }),
      );

      // Aggregate counts from this batch
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalConversations += result.value.convCount;
          totalMessages += result.value.msgCount;
        }
      }

      // Pause between batches to avoid rate limits (skip after last batch)
      if (i + BATCH_SIZE < contacts.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Create lead events for any newly synced messages
    const eventsCreated = await createLeadEventsForRecentMessages();
    if (eventsCreated > 0) {
      console.log(`[EntitySync] Created ${eventsCreated} lead events for recent messages`);
    }

    await updateLastSynced('conversations');
    await updateLastSynced('messages');
    await logSyncComplete(syncLogId, totalConversations);
    await logSyncComplete(msgSyncLogId, totalMessages);
    console.log(`[EntitySync] Conversations synced: ${totalConversations}, Messages synced: ${totalMessages}`);

    if (errors.length > 0) {
      console.error(`[EntitySync] ${errors.length} errors during conversation sync:`);
      for (const e of errors.slice(0, 10)) {
        console.error(`  - ${e}`);
      }
      if (errors.length > 10) {
        console.error(`  ... and ${errors.length - 10} more`);
      }
    }

    return { synced_conversations: totalConversations, synced_messages: totalMessages, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSyncFailed(syncLogId, msg);
    await logSyncFailed(msgSyncLogId, msg);
    console.error(`[EntitySync] Conversation sync failed: ${msg}`);
    return { synced_conversations: 0, synced_messages: 0, errors: [msg] };
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
