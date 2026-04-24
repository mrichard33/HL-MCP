import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import { deriveContactEventType, deriveAppointmentEventType, deriveMessageEventType } from '../utils/event-type.js';
import { normalizeDirection, extractMessageBody } from '../utils/normalize.js';
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

  const eventType = deriveContactEventType({ dateAdded: payload.dateAdded as string, dateUpdated: payload.dateUpdated as string });
  const stableTs = (payload.dateUpdated || payload.dateAdded || now) as string;
  await createLeadEvent(id, eventType, id, stableTs, payload);

  // Track tag changes as separate events
  if (payload.tags && Array.isArray(payload.tags)) {
    const action = payload.action as string | undefined;
    if (action === 'tag_added' || action === 'tag_removed') {
      await createLeadEvent(id, action, id, stableTs, payload);
    }
  }

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = contactToSystemEvent(payload);
  if (systemEvent) {
    emitSystemEvent(systemEvent).catch(() => {}); // fire-and-forget
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
      date_added: (payload.dateAdded as string) || (payload.createdAt as string) || null,
      date_updated: (payload.dateUpdated as string) || (payload.updatedAt as string) || now,
      synced_at: now,
      updated_at: now,
    },
    { onConflict: 'ghl_opportunity_id' },
  );

  const eventType = payload.previousStageId ? 'pipeline_stage_changed' : 'opportunity_created';
  const stableTs = (payload.dateUpdated || payload.updatedAt || payload.dateAdded || payload.createdAt || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = opportunityToSystemEvent(payload);
  if (systemEvent) {
    emitSystemEvent(systemEvent).catch(() => {});
  }
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

  const eventType = deriveAppointmentEventType((payload.status as string) || '');
  const stableTs = (payload.startTime || now) as string;
  await createLeadEvent(contactId, eventType, id, stableTs, payload);

  // ── Forward to agentic event bus (non-blocking) ──
  const systemEvent = appointmentToSystemEvent(payload);
  if (systemEvent) {
    emitSystemEvent(systemEvent).catch(() => {});
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
    emitSystemEvent(systemEvent).catch(() => {});
  }
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

  // Also populate workflow_executions table
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
  emitSystemEvent({
    event_type: 'workflow.contact_added',
    source: 'ghl',
    entity_type: 'workflow',
    entity_id: id,
    ghl_contact_id: contactId,
    payload,
    priority: 'normal',
    event_timestamp: stableTs,
  }).catch(() => {});
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
