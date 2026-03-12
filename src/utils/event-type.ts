/**
 * Shared eventType derivation functions.
 *
 * Both webhook handlers and scheduled sync must use the same logic
 * to derive event types, otherwise the SHA256 event_hash will differ
 * and deduplication fails.
 */

export function deriveContactEventType(data: { dateAdded?: string; dateUpdated?: string }): string {
  if (!data.dateUpdated || data.dateAdded === data.dateUpdated) return 'contact_created';
  return 'contact_updated';
}

export function deriveAppointmentEventType(status?: string): string {
  if (status === 'showed') return 'appointment_showed';
  if (status === 'noshow') return 'appointment_noshow';
  if (status === 'cancelled') return 'appointment_cancelled';
  return 'appointment_booked';
}

export function deriveMessageEventType(data: { direction?: string; type?: string; status?: string }): string {
  const msgType = (data.type || 'sms').toLowerCase();

  if (data.status === 'opened') return 'email_opened';
  if (data.status === 'clicked') return 'email_clicked';

  if (msgType === 'email') {
    if (data.status === 'delivered') return 'email_delivered';
    return data.direction === 'inbound' ? 'email_received' : 'email_sent';
  }

  // Live chat / web chat widget
  if (msgType === 'live_chat' || msgType === 'livechat') {
    return data.direction === 'inbound' ? 'chat_received' : 'chat_sent';
  }

  // SMS and all other channel types (WhatsApp, FB, IG, GMB)
  if (data.status === 'delivered') return 'sms_delivered';
  return data.direction === 'inbound' ? 'sms_received' : 'sms_sent';
}
