import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { createLeadEvent } from '../webhooks/handler.js';

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
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
    completed_at: new Date().toISOString(),
  }).eq('id', syncLogId);
}

async function logSyncFailed(syncLogId: string | null, errorMessage: string): Promise<void> {
  if (!syncLogId) return;
  const supabase = getSupabaseClient();
  await supabase.from('sync_log').update({
    status: 'failed',
    error_message: errorMessage,
    completed_at: new Date().toISOString(),
  }).eq('id', syncLogId);
}

// ---- Contact Sync (every 15 min) ----

export async function syncContacts(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('contacts');

  try {
    const lastSynced = await getLastSynced('contacts');
    const { contacts } = await ghl.getContacts({ limit: 100, updatedAfter: lastSynced });

    const now = new Date().toISOString();
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
        await createLeadEvent(c.id, eventType, c.id, now, c);
      } catch (err) {
        errors.push(`Contact ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('contacts');
    await logSyncComplete(syncLogId, contacts.length);
    console.error(`[EntitySync] Contacts synced: ${contacts.length} (since ${lastSynced})`);
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
    const lastSynced = await getLastSynced('opportunities');
    const { opportunities } = await ghl.getOpportunities({ limit: 100, updatedAfter: lastSynced });

    const now = new Date().toISOString();
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

        await createLeadEvent(o.contactId, 'opportunity_updated', o.id, now, o);
      } catch (err) {
        errors.push(`Opportunity ${o.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('opportunities');
    await logSyncComplete(syncLogId, opportunities.length);
    console.error(`[EntitySync] Opportunities synced: ${opportunities.length} (since ${lastSynced})`);
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

export async function syncAppointments(): Promise<{ synced: number; errors: string[] }> {
  const ghl = new GHLClient();
  const supabase = getSupabaseClient();
  const errors: string[] = [];
  const syncLogId = await logSyncStart('appointments');

  try {
    const lastSynced = await getLastSynced('appointments');

    // Fetch appointments from now - 24h to now + 30 days to cover recent and upcoming
    const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const { events } = await ghl.getAppointments({ startTime, endTime });

    const now = new Date().toISOString();
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
        await createLeadEvent(apt.contactId, eventType, apt.id, now, apt);
        synced++;
      } catch (err) {
        errors.push(`Appointment ${apt.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await updateLastSynced('appointments');
    await logSyncComplete(syncLogId, synced);
    console.error(`[EntitySync] Appointments synced: ${synced} (since ${lastSynced})`);
    return { synced, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Fatal: ${msg}`);
    await logSyncFailed(syncLogId, msg);
    console.error(`[EntitySync] Appointment sync failed: ${msg}`);
    return { synced: 0, errors };
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
  const now = new Date().toISOString();
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
    const contactIds = [...new Set((contacts || []).map(r => r.contact_id as string).filter(Boolean))];

    let computed = 0;
    const now = new Date().toISOString();

    for (const contactId of contactIds) {
      try {
        // Get all events for this contact
        const { data: events } = await supabase
          .from('lead_events')
          .select('event_type')
          .eq('contact_id', contactId);

        const eventTypes = (events || []).map(e => e.event_type as string);
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
