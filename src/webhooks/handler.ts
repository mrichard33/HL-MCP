import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';

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
 * Log a webhook failure for monitoring.
 */
async function logWebhookFailure(
  endpoint: string,
  eventType: string,
  error: string,
  payload: unknown,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('webhook_failures').insert({
      endpoint,
      event_type: eventType,
      error_message: error,
      payload,
    });
  } catch {
    // Swallow logging errors to not break the webhook response
  }
}

// ---- Individual webhook handlers ----

async function handleContactWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.contactId) as string;
  const now = nowET();

  await supabase.from('contacts').upsert(
    {
      ghl_contact_id: id,
      ghl_location_id: (payload.locationId as string) || null,
      first_name: (payload.firstName as string) || null,
      last_name: (payload.lastName as string) || null,
      email: (payload.email as string) || null,
      phone: (payload.phone as string) || null,
      company_name: (payload.companyName as string) || null,
      tags: (payload.tags as string[]) || [],
      source: (payload.source as string) || null,
      custom_fields: payload.customFields || {},
      date_added: (payload.dateAdded as string) || null,
      date_updated: (payload.dateUpdated as string) || now,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_contact_id' },
  );

  const eventType = payload.dateAdded && !payload.dateUpdated ? 'contact_created' : 'contact_updated';
  const stableTs = (payload.dateUpdated || payload.dateAdded || now) as string;
  await createLeadEvent(id, eventType, id, stableTs, payload);

  // Track tag changes as separate events
  if (payload.tags && Array.isArray(payload.tags)) {
    const action = payload.action as string | undefined;
    if (action === 'tag_added' || action === 'tag_removed') {
      await createLeadEvent(id, action, id, stableTs, payload);
    }
  }
}

async function handleOpportunityWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.opportunityId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

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
      date_added: (payload.dateAdded as string) || null,
      date_updated: (payload.dateUpdated as string) || now,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_opportunity_id' },
  );

  const eventType = payload.previousStageId ? 'pipeline_stage_changed' : 'opportunity_created';
  const stableTs = (payload.dateUpdated || payload.dateAdded || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);
}

async function handleAppointmentWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.appointmentId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

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

  const status = (payload.status as string) || '';
  let eventType = 'appointment_booked';
  if (status === 'showed') eventType = 'appointment_showed';
  else if (status === 'noshow') eventType = 'appointment_noshow';
  else if (status === 'cancelled') eventType = 'appointment_cancelled';
  else if (payload.dateUpdated) eventType = 'appointment_updated';

  const stableTs = (payload.startTime || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);
}

async function handleMessageWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.messageId) as string;
  const contactId = payload.contactId as string | undefined;
  const direction = (payload.direction as string) || 'outbound';
  const msgType = (payload.type as string) || 'sms';
  const now = nowET();

  await supabase.from('messages').upsert(
    {
      ghl_message_id: id,
      ghl_conversation_id: (payload.conversationId as string) || '',
      ghl_contact_id: contactId || null,
      direction,
      type: msgType,
      body: (payload.body || payload.message) as string || null,
      status: (payload.status as string) || 'delivered',
      sent_at: (payload.dateAdded as string) || now,
    },
    { onConflict: 'ghl_message_id' },
  );

  // Derive event type from direction and message type
  let eventType: string;
  if (direction === 'inbound') {
    eventType = msgType === 'email' ? 'email_received' : 'sms_received';
  } else {
    eventType = msgType === 'email' ? 'email_sent' : 'sms_sent';
  }
  if (payload.status === 'delivered') {
    eventType = msgType === 'email' ? 'email_delivered' : 'sms_delivered';
  }
  if (payload.status === 'opened') {
    eventType = 'email_opened';
  }
  if (payload.status === 'clicked') {
    eventType = 'email_clicked';
  }

  const stableTs = (payload.dateAdded || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);
}

async function handleWorkflowWebhook(payload: Record<string, unknown>): Promise<void> {
  const supabase = getSupabaseClient();
  const id = (payload.id || payload.workflowId) as string;
  const contactId = payload.contactId as string | undefined;
  const now = nowET();

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
    console.error(`[Webhook] Processed ${pathname} successfully`);
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
export { createLeadEvent, eventHash };
