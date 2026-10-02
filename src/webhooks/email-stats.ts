import { createHash } from 'node:crypto';
import { getSupabaseClient } from '../clients/supabase.js';
import { emitSystemEvent } from './event-bus.js';
import { trackBackground } from '../graceful-shutdown.js';

/**
 * GHL LCEmailStats webhook (Mailgun email events) → email_events + lead_events.
 *
 * Added 2026-10-02: until now nothing subscribed to LCEmailStats, so no email
 * open, click or bounce reached Supabase at all.
 *
 * Expected envelope: { type: 'LCEmailStats', locationId, webhookPayload: <Mailgun event-data> }.
 * Parsed defensively — also accepts `event-data` or a bare Mailgun event.
 * Mailgun event-data fields used: event, id, timestamp (epoch seconds),
 * recipient, severity, url (clicks), message.headers {message-id, subject, from, to},
 * user-variables, delivery-status, client-info, and GHL's own lc-operations block.
 *
 * Self-contained on purpose (no import from handler.ts) — handler.ts imports
 * this module, so importing back would be circular.
 */

type Json = Record<string, unknown>;

const KNOWN_EVENTS = new Set([
  'accepted', 'delivered', 'opened', 'clicked', 'failed', 'complained', 'unsubscribed', 'rejected', 'stored',
]);

// Agentic layer: opens are excluded on purpose — Apple Mail Privacy Protection
// makes them unreliable. Clicks and negative signals only.
const SYSTEM_EVENT_PRIORITY: Record<string, 'high' | 'normal'> = {
  clicked: 'normal',
  failed: 'normal',
  complained: 'high',
  unsubscribed: 'high',
};

// messages.type for an email: '3'/'9' from the REST sync, 'Email' from the
// marketplace webhook, plus the older spellings.
const EMAIL_MESSAGE_TYPES = ['3', '9', 'Email', 'email', 'TYPE_EMAIL'];

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function asObj(v: unknown): Json {
  return v && typeof v === 'object' ? (v as Json) : {};
}

function toIso(ts: unknown): string {
  const n = typeof ts === 'string' ? Number(ts) : (ts as number);
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  if (typeof ts === 'string' && !Number.isNaN(Date.parse(ts))) return new Date(ts).toISOString();
  return new Date().toISOString();
}

function urlParam(url: string | null, key: string): string | null {
  if (!url) return null;
  try { return new URL(url).searchParams.get(key); } catch { return null; }
}

/**
 * Apple Mail Privacy Protection pre-fetches images through a proxy whose
 * user agent is the bare string "Mozilla/5.0". Those are machine opens, not a
 * person reading. Heuristic — clicks remain the trusted engagement signal.
 */
export function isMachineOpen(clientInfo: Json): boolean {
  const ua = String(clientInfo['user-agent'] ?? clientInfo.userAgent ?? '').trim();
  return ua === 'Mozilla/5.0';
}

export interface ParsedEmailEvent {
  event: string;
  severity: string | null;
  providerEventId: string | null;
  providerMessageId: string | null;
  recipient: string | null;
  subject: string | null;
  fromAddress: string | null;
  contactIdHint: string | null;
  ghlMessageIdHint: string | null;
  ghlEmailMessageId: string | null;
  clickedUrl: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  clientInfo: Json;
  failureReason: string | null;
  occurredAt: string;
  eventHash: string;
}

export function parseEmailStatsPayload(payload: Json): ParsedEmailEvent | null {
  const data = asObj(payload.webhookPayload ?? payload['event-data'] ?? payload.eventData ?? payload);
  const rawEvent = String(data.event ?? '').toLowerCase();
  if (!rawEvent) return null;

  const message = asObj(data.message);
  const headers = asObj(message.headers);
  const userVars = asObj(data['user-variables'] ?? data.userVariables);
  const deliveryStatus = asObj(data['delivery-status']);
  // GHL adds its own block to every Mailgun event. email_message_id is GHL's id
  // for the sent email — the same value as `emailMessageId` on the
  // OutboundMessage webhook. Seen on every live event, 2026-10-02.
  const lcOps = asObj(data['lc-operations']);
  const clickedUrl = (data.url as string) || null;
  const providerMessageId = (headers['message-id'] as string) || null;
  const providerEventId = (data.id as string) || null;
  const occurredAt = toIso(data.timestamp);
  const event = KNOWN_EVENTS.has(rawEvent) ? rawEvent : `other:${rawEvent}`;

  return {
    event,
    severity: (data.severity as string) || null,
    providerEventId,
    providerMessageId,
    recipient: (((data.recipient as string) || (headers.to as string) || '').toLowerCase()) || null,
    subject: (headers.subject as string) || null,
    fromAddress: (headers.from as string) || null,
    contactIdHint: ((userVars.contactId ?? userVars.contact_id ?? payload.contactId ?? null) as string | null),
    ghlMessageIdHint: ((userVars.messageId ?? userVars.message_id ?? userVars.email_message_id ?? null) as string | null),
    ghlEmailMessageId: (lcOps.email_message_id as string) || null,
    clickedUrl,
    utmCampaign: urlParam(clickedUrl, 'utm_campaign'),
    utmContent: urlParam(clickedUrl, 'utm_content'),
    clientInfo: asObj(data['client-info']),
    failureReason:
      (deliveryStatus.description as string) || (deliveryStatus.message as string) || (data.reason as string) || null,
    occurredAt,
    eventHash: sha256(
      providerEventId
        ? `mailgun:${providerEventId}`
        : `${providerMessageId ?? ''}:${event}:${occurredAt}:${clickedUrl ?? ''}`,
    ),
  };
}

// ── trigger link cache ──
export type LinkRow = { ghl_link_id: string; name: string | null; url: string | null; redirect_to: string | null };
let linkCache: LinkRow[] = [];
let linkCacheExpiry = 0;

async function loadLinks(): Promise<LinkRow[]> {
  if (Date.now() < linkCacheExpiry) return linkCache;
  const { data, error } = await getSupabaseClient()
    .from('trigger_links')
    .select('ghl_link_id, name, url, redirect_to')
    .is('deleted_at', null);
  if (!error && data) {
    linkCache = data as LinkRow[];
    linkCacheExpiry = Date.now() + 10 * 60 * 1000;
  }
  return linkCache;
}

/** Match a clicked URL to a GHL trigger link: by link id first, then by utm_campaign + utm_content. */
export function matchTriggerLink(
  clickedUrl: string | null, links: LinkRow[],
): { id: string; name: string | null } | null {
  if (!clickedUrl) return null;
  for (const l of links) {
    const fieldKey = (l.url || '').match(/trigger_link\.([A-Za-z0-9]+)/)?.[1];
    if ((l.ghl_link_id && clickedUrl.includes(l.ghl_link_id)) || (fieldKey && clickedUrl.includes(fieldKey))) {
      return { id: l.ghl_link_id, name: l.name };
    }
  }
  const camp = urlParam(clickedUrl, 'utm_campaign');
  const content = urlParam(clickedUrl, 'utm_content');
  if (camp && content) {
    for (const l of links) {
      const r = (l.redirect_to || '').replace(/\{\{[^}]+\}\}/g, 'x');
      if (urlParam(r, 'utm_campaign') === camp && urlParam(r, 'utm_content') === content) {
        return { id: l.ghl_link_id, name: l.name };
      }
    }
  }
  return null;
}

async function resolveContactId(p: ParsedEmailEvent): Promise<string | null> {
  if (p.contactIdHint) return p.contactIdHint;
  if (!p.recipient) return null;
  const escaped = p.recipient.replace(/[%_\\]/g, (m) => `\\${m}`);
  const { data } = await getSupabaseClient()
    .from('contacts')
    .select('ghl_contact_id')
    .ilike('email', escaped)
    .is('deleted_at', null)
    .order('date_updated', { ascending: false })
    .limit(1);
  return (data?.[0]?.ghl_contact_id as string) ?? null;
}

/**
 * Which sent email this event belongs to.
 *
 * GHL's own email id (lc-operations) comes first. The "last email to this
 * contact" guess is only a fallback: on 2026-10-02 two test emails sent a
 * minute apart were both attributed to the same message by it.
 *
 * NOTE: attributed_message_id holds GHL's EMAIL message id when the method is
 * 'lc_operations' (join on the OutboundMessage webhook's `emailMessageId`),
 * and a conversation message id (messages.ghl_message_id) when the method is
 * 'last_email_to_contact'. The messages table does not store the email id.
 */
export async function attributeMessage(
  p: ParsedEmailEvent, contactId: string | null,
): Promise<{ id: string | null; method: string }> {
  if (p.ghlMessageIdHint) return { id: p.ghlMessageIdHint, method: 'user_variables' };
  if (p.ghlEmailMessageId) return { id: p.ghlEmailMessageId, method: 'lc_operations' };
  if (!contactId) return { id: null, method: 'none' };
  const since = new Date(Date.parse(p.occurredAt) - 30 * 86400_000).toISOString();
  const { data } = await getSupabaseClient()
    .from('messages')
    .select('ghl_message_id')
    .eq('ghl_contact_id', contactId)
    .eq('direction', 'outbound')
    .in('type', EMAIL_MESSAGE_TYPES)
    .is('deleted_at', null)
    .lte('sent_at', p.occurredAt)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
    .limit(1);
  const id = (data?.[0]?.ghl_message_id as string) ?? null;
  return { id, method: id ? 'last_email_to_contact' : 'none' };
}

/** Throws on unparseable payloads or write errors so handleWebhook logs to webhook_failures (replayable). */
export async function handleEmailStatsWebhook(payload: Record<string, unknown>): Promise<void> {
  const p = parseEmailStatsPayload(payload);
  if (!p) throw new Error('LCEmailStats payload has no event field');

  const supabase = getSupabaseClient();
  const contactId = await resolveContactId(p);
  const link = p.event === 'clicked' ? matchTriggerLink(p.clickedUrl, await loadLinks()) : null;
  const attribution = await attributeMessage(p, contactId);

  const { error } = await supabase.from('email_events').upsert(
    {
      event_hash: p.eventHash,
      provider_event_id: p.providerEventId,
      event: p.event,
      severity: p.severity,
      ghl_contact_id: contactId,
      recipient: p.recipient,
      subject: p.subject,
      from_address: p.fromAddress,
      provider_message_id: p.providerMessageId,
      attributed_message_id: attribution.id,
      attribution_method: attribution.method,
      clicked_url: p.clickedUrl,
      trigger_link_id: link?.id ?? null,
      trigger_link_name: link?.name ?? null,
      utm_campaign: p.utmCampaign,
      utm_content: p.utmContent,
      is_machine_open: p.event === 'opened' && isMachineOpen(p.clientInfo),
      failure_reason: p.failureReason,
      client_info: p.clientInfo,
      occurred_at: p.occurredAt,
      raw_json: payload,
    },
    { onConflict: 'event_hash', ignoreDuplicates: true },
  );
  if (error) throw new Error(`email_events upsert: ${error.message}`);

  // Contact timeline (same hash scheme as createLeadEvent in handler.ts).
  const leadEventType = p.event.startsWith('other:') ? 'email_other' : `email_${p.event}`;
  const sourceId = p.providerEventId || p.eventHash;
  const { error: leErr } = await supabase.from('lead_events').upsert(
    {
      event_hash: sha256(`${sourceId}:${leadEventType}:${p.occurredAt}`),
      contact_id: contactId,
      event_type: leadEventType,
      source_system: 'highlevel',
      event_time: p.occurredAt,
      raw_json: payload,
    },
    { onConflict: 'event_hash', ignoreDuplicates: true },
  );
  if (leErr) console.warn(`[EmailStats] lead_events upsert failed: ${leErr.message}`);

  // Agentic layer — OFF by default. Flip EMAIL_STATS_SYSTEM_EVENTS=on as a separate decision.
  const priority = SYSTEM_EVENT_PRIORITY[p.event];
  if (process.env.EMAIL_STATS_SYSTEM_EVENTS === 'on' && priority && contactId) {
    trackBackground(emitSystemEvent({
      event_type: `email.${p.event}`,
      source: 'ghl',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        subject: p.subject,
        clicked_url: p.clickedUrl,
        trigger_link_id: link?.id ?? null,
        trigger_link_name: link?.name ?? null,
        utm_campaign: p.utmCampaign,
        utm_content: p.utmContent,
        failure_reason: p.failureReason,
        severity: p.severity,
        attributed_message_id: attribution.id,
      },
      priority,
      event_timestamp: p.occurredAt,
    }).catch(() => {}));
  }
}
