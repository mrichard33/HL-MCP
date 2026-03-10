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
  const msgType = data.type || 'sms';
  if (data.status === 'opened') return 'email_opened';
  if (data.status === 'clicked') return 'email_clicked';
  if (data.status === 'delivered') return msgType === 'email' ? 'email_delivered' : 'sms_delivered';
  if (data.direction === 'inbound') return msgType === 'email' ? 'email_received' : 'sms_received';
  return msgType === 'email' ? 'email_sent' : 'sms_sent';
}
