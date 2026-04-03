import { createHash } from 'node:crypto';
import { getLpSupabaseClient, isLpSupabaseConfigured } from '../clients/supabase-lp.js';

/**
 * Event Bus Bridge — forwards GHL webhook events to the agentic system_events table
 * on the LP MCP Supabase instance.
 * 
 * This runs non-blocking alongside the existing lead_events writes.
 * If LP Supabase is not configured, events are silently skipped.
 */

interface SystemEvent {
  event_type: string;
  event_subtype?: string;
  source: string;
  entity_type: string;
  entity_id: string;
  ghl_contact_id?: string;
  lp_lead_id?: string;
  lp_prospect_id?: string;
  payload: Record<string, unknown>;
  previous_state?: Record<string, unknown>;
  new_state?: Record<string, unknown>;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  event_timestamp?: string;
  idempotency_key?: string;
}

/**
 * Generate an idempotency key to prevent duplicate events.
 */
function makeIdempotencyKey(source: string, entityId: string, eventType: string, timestamp: string): string {
  return createHash('sha256')
    .update(`${source}:${entityId}:${eventType}:${timestamp}`)
    .digest('hex')
    .slice(0, 48); // Keep it reasonable length
}

/**
 * Write a system event to the LP MCP Supabase event bus.
 * Non-blocking — errors are logged but never thrown.
 */
export async function emitSystemEvent(event: SystemEvent): Promise<boolean> {
  if (!isLpSupabaseConfigured()) return false;

  const client = getLpSupabaseClient();
  if (!client) return false;

  try {
    const timestamp = event.event_timestamp || new Date().toISOString();
    const idempotencyKey = event.idempotency_key || makeIdempotencyKey(
      event.source, event.entity_id, event.event_type, timestamp
    );

    const { error } = await client
      .from('system_events')
      .upsert(
        {
          event_type: event.event_type,
          event_subtype: event.event_subtype || null,
          source: event.source,
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          ghl_contact_id: event.ghl_contact_id || null,
          lp_lead_id: event.lp_lead_id || null,
          lp_prospect_id: event.lp_prospect_id || null,
          payload: event.payload,
          previous_state: event.previous_state || null,
          new_state: event.new_state || null,
          priority: event.priority || 'normal',
          event_timestamp: timestamp,
          idempotency_key: idempotencyKey,
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true }
      );

    if (error) {
      console.warn(`[EventBus] Failed to emit ${event.event_type}: ${error.message}`);
      return false;
    }

    return true;
  } catch (err) {
    console.warn(`[EventBus] Exception emitting ${event.event_type}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Derive event type and priority from a GHL contact webhook payload.
 */
export function contactToSystemEvent(payload: Record<string, unknown>): SystemEvent | null {
  const contactId = (payload.id || payload.contactId) as string;
  if (!contactId) return null;

  const action = payload.action as string | undefined;
  const tags = payload.tags as string[] | undefined;
  const timestamp = (payload.dateUpdated || payload.dateAdded || new Date().toISOString()) as string;

  // Determine event type
  let eventType = 'contact.updated';
  let eventSubtype: string | undefined;
  let priority: SystemEvent['priority'] = 'normal';

  if (action === 'tag_added' && tags) {
    eventType = 'contact.tag_added';
    // Check for high-priority tags
    const lastTag = Array.isArray(payload.tag) ? (payload.tag as string[])[0] : (payload.tag as string);
    eventSubtype = lastTag || undefined;
    
    if (lastTag && (lastTag.startsWith('entry:') || lastTag.startsWith('objection') || lastTag.startsWith('appt:'))) {
      priority = 'high';
    }
  } else if (action === 'tag_removed') {
    eventType = 'contact.tag_removed';
    const lastTag = Array.isArray(payload.tag) ? (payload.tag as string[])[0] : (payload.tag as string);
    eventSubtype = lastTag || undefined;
  } else if (!payload.dateUpdated && payload.dateAdded) {
    eventType = 'contact.created';
    priority = 'high';
  } else if (payload.dnd === true || (payload.dndSettings && (payload.dndSettings as Record<string, unknown>).status === true)) {
    eventType = 'contact.dnd_enabled';
    priority = 'high';
  }

  return {
    event_type: eventType,
    event_subtype: eventSubtype,
    source: 'ghl',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload,
    priority,
    event_timestamp: timestamp,
  };
}

/**
 * Derive event from opportunity webhook.
 */
export function opportunityToSystemEvent(payload: Record<string, unknown>): SystemEvent | null {
  const oppId = (payload.id || payload.opportunityId) as string;
  const contactId = payload.contactId as string | undefined;
  if (!oppId) return null;

  const timestamp = (payload.dateUpdated || payload.updatedAt || payload.dateAdded || payload.createdAt || new Date().toISOString()) as string;
  
  let eventType = 'opportunity.updated';
  let eventSubtype: string | undefined;
  let priority: SystemEvent['priority'] = 'normal';

  if (payload.previousStageId) {
    eventType = 'opportunity.stage_changed';
    priority = 'high';
    eventSubtype = (payload.pipelineStageId || payload.stageId) as string;
  } else if (payload.previousStatus) {
    eventType = 'opportunity.status_changed';
    priority = 'high';
    eventSubtype = payload.status as string;
  } else if (!payload.dateUpdated && (payload.dateAdded || payload.createdAt)) {
    eventType = 'opportunity.created';
    priority = 'normal';
  }

  return {
    event_type: eventType,
    event_subtype: eventSubtype,
    source: 'ghl',
    entity_type: 'opportunity',
    entity_id: oppId,
    ghl_contact_id: contactId,
    payload,
    previous_state: payload.previousStageId ? { stageId: payload.previousStageId, status: payload.previousStatus } : undefined,
    new_state: { stageId: payload.pipelineStageId || payload.stageId, status: payload.status },
    priority,
    event_timestamp: timestamp,
  };
}

/**
 * Derive event from appointment webhook.
 */
export function appointmentToSystemEvent(payload: Record<string, unknown>): SystemEvent | null {
  const apptId = (payload.id || payload.appointmentId) as string;
  const contactId = payload.contactId as string | undefined;
  const calendarId = payload.calendarId as string | undefined;
  if (!apptId) return null;

  const status = ((payload.status as string) || 'confirmed').toLowerCase();
  const timestamp = (payload.startTime || new Date().toISOString()) as string;

  let eventType = 'appointment.updated';
  let eventSubtype: string | undefined;
  let priority: SystemEvent['priority'] = 'high'; // All appointment events are high priority

  // Map calendar IDs to appointment types for subtype
  const calendarMap: Record<string, string> = {
    'DQYMaJ22N6zL4SXjHukw': 'review-session',
    'zEdPmkNccR2ovo3rQAd3': 'measurement-verification',
    'aJj14ONxh1oFyDcQ706O': 'window-estimate',
    'zS1wg0JqQ1zsszJyJqKX': 'home-assessment',
    'gFWoSQrlKIdfRbAPV842': 'confirmation-call',
  };
  eventSubtype = calendarId ? calendarMap[calendarId] : undefined;

  if (status === 'confirmed' || status === 'booked') {
    eventType = 'appointment.booked';
    priority = 'critical'; // Bookings are the #1 conversion event
  } else if (status === 'cancelled') {
    eventType = 'appointment.cancelled';
  } else if (status === 'noshow' || status === 'no_show' || status === 'no-show') {
    eventType = 'appointment.noshow';
    priority = 'critical';
  } else if (status === 'completed' || status === 'showed') {
    eventType = 'appointment.completed';
  }

  return {
    event_type: eventType,
    event_subtype: eventSubtype,
    source: 'ghl',
    entity_type: 'appointment',
    entity_id: apptId,
    ghl_contact_id: contactId,
    payload,
    new_state: { status, calendarId },
    priority,
    event_timestamp: timestamp,
  };
}

/**
 * Derive event from inbound message webhook (contact replied).
 */
export function messageToSystemEvent(payload: Record<string, unknown>): SystemEvent | null {
  const msgId = (payload.id || payload.messageId) as string;
  const contactId = payload.contactId as string | undefined;
  if (!msgId) return null;

  const direction = payload.direction as string | number | undefined;
  const isInbound = direction === 'inbound' || direction === 1;
  
  // Only emit events for inbound messages (contact replies)
  if (!isInbound) return null;

  const timestamp = (payload.dateAdded || new Date().toISOString()) as string;
  const msgType = (payload.type as string) || 'sms';

  return {
    event_type: 'contact.replied',
    event_subtype: msgType,
    source: 'ghl',
    entity_type: 'contact',
    entity_id: contactId || msgId,
    ghl_contact_id: contactId,
    payload: {
      messageId: msgId,
      conversationId: payload.conversationId,
      type: msgType,
      direction: 'inbound',
      body: payload.body || payload.message || '',
    },
    priority: 'high', // Replies should be processed quickly
    event_timestamp: timestamp,
  };
}
