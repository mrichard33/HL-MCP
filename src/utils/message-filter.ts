/**
 * GHL Message Type Filter
 *
 * The GHL conversations/messages API returns both real messages AND
 * system activity events in the same stream. Activity events are NOT
 * messages — they're internal CRM events that GHL injects into the
 * conversation timeline. Storing them in the messages table pollutes
 * the data and inflates message counts.
 *
 * GHL numeric message types (from API responses):
 *
 * REAL MESSAGES (store in messages table):
 *   1  = Phone Call
 *   2  = SMS
 *   3  = Email
 *   4  = SMS (MMS)
 *   5  = Google My Business
 *   6  = WhatsApp
 *   7  = Voicemail
 *   8  = Campaign Call
 *   9  = Facebook Messenger
 *   10 = Custom SMS
 *   11 = Facebook/Instagram Comment
 *   12 = Custom Email
 *   13 = Custom Provider
 *   14 = Web Chat
 *   15 = Google Business Chat
 *   18 = Instagram DM
 *   29 = Live Chat
 *
 * SYSTEM ACTIVITY (skip — not real messages):
 *   25 = DnD Activity ("DnD enabled by user", "DnD disabled by user")
 *   28 = Opportunity Activity ("Opportunity created", "Opportunity deleted", "Opportunity status changed")
 *   30 = Chat System Info ("Your chat has ended", "Chat closed due to user Inactivity", "Please share contact details")
 *   31 = Appointment Activity ("Mark Richard - Window Estimate")
 *   38 = Employee Action Log ("Employee action log created")
 */

/** GHL message types that are system/CRM activity events, NOT real messages. */
export const ACTIVITY_MESSAGE_TYPES = new Set([25, 28, 30, 31, 38]);

/** String versions for comparison when type comes back as string from Supabase. */
export const ACTIVITY_MESSAGE_TYPE_STRINGS = new Set(['25', '28', '30', '31', '38']);

/**
 * Returns true if the message is a real communication (SMS, email, chat, call, etc.)
 * and should be stored in the messages table. Returns false for system activity events.
 */
export function isRealMessage(msg: { type?: string | number | unknown }): boolean {
  const t = msg.type;
  if (t == null) return true; // Unknown type — keep it to be safe
  const num = typeof t === 'string' ? parseInt(t, 10) : typeof t === 'number' ? t : NaN;
  if (isNaN(num)) return true; // Non-numeric type — keep it
  return !ACTIVITY_MESSAGE_TYPES.has(num);
}
