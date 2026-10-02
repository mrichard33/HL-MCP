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

/**
 * GHL reports the message channel three different ways depending on the path:
 *  - REST sync (conversations/messages): numeric code as a string ('2', '3', '29')
 *  - Marketplace webhook: messageType string ('SMS', 'Email', 'Live_Chat')
 *  - Older callers: lowercase words ('sms', 'email', 'live_chat')
 * Before 2026-10-02 only the lowercase words were recognised, so every email
 * (code '3'), chat (code '29') and call (code '1') was logged as sms_delivered.
 */
const CHANNEL_BY_GHL_CODE: Record<string, string> = {
  '1': 'call', '2': 'sms', '3': 'email', '4': 'sms', '5': 'live_chat',
  '6': 'sms', '7': 'sms', '8': 'call', '9': 'email', '11': 'facebook',
  '18': 'instagram', '19': 'whatsapp', '29': 'live_chat',
};

export function normalizeMessageChannel(raw?: string | number | null): string {
  if (raw === undefined || raw === null || raw === '') return 'sms';
  const s = String(raw).trim();
  if (CHANNEL_BY_GHL_CODE[s]) return CHANNEL_BY_GHL_CODE[s];
  const k = s.toLowerCase().replace(/^type_/, '');
  if (k.includes('email')) return 'email';
  if (k.includes('live_chat') || k === 'livechat' || k.includes('webchat')) return 'live_chat';
  if (k.includes('call') || k.includes('voicemail')) return 'call';
  if (k.includes('facebook')) return 'facebook';
  if (k.includes('instagram')) return 'instagram';
  if (k.includes('whatsapp')) return 'whatsapp';
  if (k.includes('gmb')) return 'gmb';
  if (k.includes('sms')) return 'sms';
  return 'other';
}

export function deriveMessageEventType(data: { direction?: string; type?: string; status?: string }): string {
  const channel = normalizeMessageChannel(data.type);
  const inbound = data.direction === 'inbound';
  const status = (data.status || '').toLowerCase();

  if (channel === 'email') {
    if (!inbound && status === 'opened') return 'email_opened';
    if (!inbound && status === 'clicked') return 'email_clicked';
    if (!inbound && status === 'delivered') return 'email_delivered';
    return inbound ? 'email_received' : 'email_sent';
  }

  // Live chat / web chat widget
  if (channel === 'live_chat') return inbound ? 'chat_received' : 'chat_sent';

  // Phone calls logged into conversations
  if (channel === 'call') return inbound ? 'call_inbound' : 'call_outbound';

  // SMS and all other channel types (WhatsApp, FB, IG, GMB, unknown) — unchanged
  // behaviour, except 'delivered' now only applies to OUTBOUND messages.
  if (!inbound && status === 'delivered') return 'sms_delivered';
  return inbound ? 'sms_received' : 'sms_sent';
}
