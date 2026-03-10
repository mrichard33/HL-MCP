import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { createLeadEvent } from '../webhooks/handler.js';
import { nowET, toET } from '../utils/timezone.js';

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

async function updateLastSynced(entityName: string): Promise<void> {
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

        const eventType = c.dateAdded === c.dateUpdated ? 'contact_created' : 'contact_updated';
        const stableTs = c.dateUpdated || c.dateAdded || now;
        await createLeadEvent(c.id, eventType, c.id, stableTs, c);
      } catch (err) {
        errors.push(`Contact ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('contacts');
    await logSyncComplete(syncLogId, contacts.length);
    console.error(`[EntitySync] Contacts synced: ${contacts.length}`);
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
            date_added: o.dateAdded || null,
            date_updated: o.dateUpdated || now,
            synced_at: now,
            updated_at: now,
          },
          { onConflict: 'ghl_opportunity_id' },
        );

        const stableTs = o.dateUpdated || o.dateAdded || now;
        await createLeadEvent(o.contactId, 'opportunity_updated', o.id, stableTs, o);
      } catch (err) {
        errors.push(`Opportunity ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('opportunities');
    await logSyncComplete(syncLogId, opportunities.length);
    console.error(`[EntitySync] Opportunities synced: ${opportunities.length}`);
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
    // Default: 24h back to 30d forward (for scheduled sync); callers can override for initial population
    const startTime = options?.startTime ?? toET(Date.now() - 24 * 60 * 60 * 1000);
    const endTime = options?.endTime ?? toET(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const events = await ghl.getAllAppointments({ startTime, endTime });

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

        const eventType = apt.status === 'showed' ? 'appointment_showed' :
                          apt.status === 'noshow' ? 'appointment_noshow' :
                          apt.status === 'cancelled' ? 'appointment_cancelled' :
                          'appointment_booked';
        const stableTs = apt.startTime || now;
        await createLeadEvent(apt.contactId, eventType, apt.id, stableTs, apt);
        synced++;
      } catch (err) {
        errors.push(`Appointment ${apt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('appointments');
    await logSyncComplete(syncLogId, synced);
    console.error(`[EntitySync] Appointments synced: ${synced}`);
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

    const rows = pipelines.map((p) => ({
      ghl_pipeline_id: p.id,
      ghl_location_id: p.locationId || null,
      name: p.name,
      stages: p.stages,
      synced_at: now,
    }));

    const { error } = await supabase.from('pipelines').upsert(rows, { onConflict: 'ghl_pipeline_id' });
    if (error) throw new Error(`Supabase error: ${error.message}`);

    await updateLastSynced('pipelines');
    await logSyncComplete(syncLogId, rows.length);
    console.error(`[EntitySync] Pipelines synced: ${rows.length}`);
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

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 2000; // 2s pause between batches to stay under GHL rate limits
const MAX_CONTACTS_PER_SYNC = 100; // Limit per run to avoid timeouts

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
      const msgType = msg.type || 'sms';
      let eventType: string;
      if (msg.direction === 'inbound') {
        eventType = msgType === 'email' ? 'email_received' : 'sms_received';
      } else {
        eventType = msgType === 'email' ? 'email_sent' : 'sms_sent';
      }
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

  try {
    // Get contacts from Supabase (already synced by contact sync job)
    const { data: contacts, error: contactError } = await supabase
      .from('contacts')
      .select('ghl_contact_id')
      .order('date_updated', { ascending: false })
      .limit(MAX_CONTACTS_PER_SYNC);

    if (contactError) throw new Error(`Failed to fetch contacts: ${contactError.message}`);
    if (!contacts?.length) {
      console.error('[EntitySync] No contacts found in Supabase — sync contacts first');
      await logSyncComplete(syncLogId, 0);
      return { synced_conversations: 0, synced_messages: 0, errors: [] };
    }

    console.error(`[EntitySync] Syncing conversations for ${contacts.length} contacts (batch size: ${BATCH_SIZE})...`);

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

            for (const conv of conversations) {
              // Upsert conversation
              await supabase.from('conversations').upsert(
                {
                  ghl_conversation_id: conv.id,
                  ghl_contact_id: conv.contactId,
                  ghl_location_id: conv.locationId || null,
                  type: conv.type || 'sms',
                  last_message_at: conv.lastMessageDate || null,
                  unread_count: conv.unreadCount || 0,
                  synced_at: now,
                  updated_at: now,
                },
                { onConflict: 'ghl_conversation_id' },
              );
              convCount++;

              // Fetch and upsert messages for this conversation
              try {
                const msgResponse = await ghl.getMessages(conv.id);

                // Debug: log response shape on first conversation to diagnose API format
                if (convCount === 1 && i === 0) {
                  console.error(`[EntitySync] DEBUG getMessages response keys: ${JSON.stringify(Object.keys(msgResponse))}`);
                  if (msgResponse.messages && !Array.isArray(msgResponse.messages)) {
                    console.error(`[EntitySync] DEBUG messages type: ${typeof msgResponse.messages}, keys: ${JSON.stringify(Object.keys(msgResponse.messages as any))}`);
                  }
                }

                // Handle various response shapes from GHL API
                const messageList = Array.isArray(msgResponse.messages)
                  ? msgResponse.messages
                  : Array.isArray((msgResponse as any).messages?.messages)
                    ? (msgResponse as any).messages.messages
                    : [];
                for (const msg of messageList) {
                  await supabase.from('messages').upsert(
                    {
                      ghl_message_id: msg.id,
                      ghl_conversation_id: msg.conversationId || conv.id,
                      ghl_contact_id: msg.contactId || contactId,
                      direction: msg.direction || 'outbound',
                      type: msg.type || 'sms',
                      body: msg.body || null,
                      status: msg.status || 'delivered',
                      sent_at: msg.dateAdded || now,
                    },
                    { onConflict: 'ghl_message_id' },
                  );
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
      console.error(`[EntitySync] Created ${eventsCreated} lead events for recent messages`);
    }

    await updateLastSynced('conversations');
    await logSyncComplete(syncLogId, totalConversations + totalMessages);
    console.error(`[EntitySync] Conversations synced: ${totalConversations}, Messages synced: ${totalMessages}`);

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

function deriveFunnelStage(eventTypes: string[]): { stage: FunnelStage; history: { stage: string; entered_at: string }[] } {
  const typeSet = new Set(eventTypes);
  const now = nowET();
  const history: { stage: string; entered_at: string }[] = [];
  let currentStage: FunnelStage = 'lead_created';

  // Build progression
  history.push({ stage: 'lead_created', entered_at: now });

  if (typeSet.has('sms_sent') || typeSet.has('email_sent')) {
    currentStage = 'contacted';
    history.push({ stage: 'contacted', entered_at: now });
  }

  if (typeSet.has('sms_received') || typeSet.has('email_received') || typeSet.has('email_replied') || typeSet.has('sms_replied')) {
    currentStage = 'engaged';
    history.push({ stage: 'engaged', entered_at: now });
  }

  if (typeSet.has('appointment_booked')) {
    currentStage = 'appointment_booked';
    history.push({ stage: 'appointment_booked', entered_at: now });
  }

  if (typeSet.has('appointment_showed')) {
    currentStage = 'appointment_showed';
    history.push({ stage: 'appointment_showed', entered_at: now });
  }

  if (typeSet.has('opportunity_won') || typeSet.has('pipeline_stage_changed')) {
    // Check if there's a "won" event
    if (typeSet.has('opportunity_won')) {
      currentStage = 'won';
      history.push({ stage: 'won', entered_at: now });
    }
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
        // Get all events for this contact
        const { data: events } = await supabase
          .from('lead_events')
          .select('event_type')
          .eq('contact_id', contactId);

        const eventTypes = (events || []).map((e: { event_type: unknown }) => e.event_type as string);
        const { stage, history } = deriveFunnelStage(eventTypes);

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
    console.error(`[EntitySync] Funnel progression computed for ${computed} contacts`);
    return { computed, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Funnel computation failed: ${msg}`);
    return { computed: 0, errors };
  }
}
