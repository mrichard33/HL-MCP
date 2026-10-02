/**
 * test-email-stats.js — GHL LCEmailStats (Mailgun) ingestion (2026-10-02).
 *
 * Nothing subscribed to LCEmailStats before this, so no email open, click or
 * bounce ever reached Supabase. These tests cover the pure parts: the payload
 * parser, the dedup hash, the Apple MPP machine-open heuristic, trigger-link
 * matching, and routing by payload type whatever URL GHL posts to.
 *
 * Runs against the compiled output in dist/, per `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseEmailStatsPayload, isMachineOpen, matchTriggerLink, handleEmailStatsWebhook, attributeMessage } =
  await import('../dist/webhooks/email-stats.js');
const { pickWebhookHandler } = await import('../dist/webhooks/handler.js');
const { etDayStart, nextDay, isMissingRelation } = await import('../dist/tools/admin/supabase-tools.js');

function mailgun(event, extra = {}) {
  return {
    event,
    id: `evt-${event}`,
    timestamp: 1759420800, // 2025-10-02T16:00:00Z, epoch seconds
    recipient: 'Jane.Doe@Example.com',
    message: {
      headers: {
        'message-id': 'msg-123@send.getreecewindows.com',
        subject: 'Your window estimate',
        from: 'Reece Team <team@send.getreecewindows.com>',
        to: 'jane.doe@example.com',
      },
    },
    'user-variables': { contactId: 'contact-1' },
    ...extra,
  };
}

// ── parseEmailStatsPayload ──

test('reads the GHL envelope { type, webhookPayload }', () => {
  const p = parseEmailStatsPayload({ type: 'LCEmailStats', locationId: 'loc', webhookPayload: mailgun('delivered') });
  assert.equal(p.event, 'delivered');
  assert.equal(p.providerEventId, 'evt-delivered');
  assert.equal(p.providerMessageId, 'msg-123@send.getreecewindows.com');
  assert.equal(p.subject, 'Your window estimate');
  assert.equal(p.recipient, 'jane.doe@example.com', 'recipient is lowercased for the contact lookup');
  assert.equal(p.contactIdHint, 'contact-1');
  assert.equal(p.occurredAt, '2025-10-02T16:00:00.000Z', 'epoch seconds become ISO');
});

test('reads { event-data } and a bare Mailgun event', () => {
  assert.equal(parseEmailStatsPayload({ 'event-data': mailgun('opened') }).event, 'opened');
  assert.equal(parseEmailStatsPayload(mailgun('complained')).event, 'complained');
});

test('clicked keeps the url and its utm params', () => {
  const url = 'https://reecewindows.com/offer?utm_campaign=fall26&utm_content=cta1&contact=abc';
  const p = parseEmailStatsPayload({ type: 'LCEmailStats', webhookPayload: mailgun('clicked', { url }) });
  assert.equal(p.event, 'clicked');
  assert.equal(p.clickedUrl, url);
  assert.equal(p.utmCampaign, 'fall26');
  assert.equal(p.utmContent, 'cta1');
});

test('failed keeps severity and the delivery-status description', () => {
  const p = parseEmailStatsPayload({
    type: 'LCEmailStats',
    webhookPayload: mailgun('failed', {
      severity: 'permanent',
      'delivery-status': { description: 'No such user', code: 550 },
    }),
  });
  assert.equal(p.event, 'failed');
  assert.equal(p.severity, 'permanent');
  assert.equal(p.failureReason, 'No such user');
});

test('unsubscribed is a known event; an unknown one becomes other:<name>', () => {
  assert.equal(parseEmailStatsPayload(mailgun('unsubscribed')).event, 'unsubscribed');
  assert.equal(parseEmailStatsPayload(mailgun('bounced_softly')).event, 'other:bounced_softly');
});

test('a payload with no event is null', () => {
  assert.equal(parseEmailStatsPayload({ type: 'LCEmailStats', webhookPayload: { id: 'x' } }), null);
});

test('a payload with no event makes the handler throw (so it lands in webhook_failures)', async () => {
  await assert.rejects(() => handleEmailStatsWebhook({ type: 'LCEmailStats' }), /no event field/);
});

// ── eventHash ──

test('eventHash is stable for the same input', () => {
  const a = parseEmailStatsPayload(mailgun('clicked', { url: 'https://x.com/a' }));
  const b = parseEmailStatsPayload(mailgun('clicked', { url: 'https://x.com/a' }));
  assert.equal(a.eventHash, b.eventHash);
});

test('without a Mailgun event id, a different click URL gives a different hash', () => {
  const noId = (url) => {
    const e = mailgun('clicked', { url });
    delete e.id;
    return parseEmailStatsPayload(e);
  };
  assert.notEqual(noId('https://x.com/a').eventHash, noId('https://x.com/b').eventHash);
  assert.equal(noId('https://x.com/a').eventHash, noId('https://x.com/a').eventHash);
});

// ── isMachineOpen ──

test('isMachineOpen: bare "Mozilla/5.0" is Apple MPP; a real UA or nothing is not', () => {
  assert.equal(isMachineOpen({ 'user-agent': 'Mozilla/5.0' }), true);
  assert.equal(isMachineOpen({
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  }), false);
  assert.equal(isMachineOpen({
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  }), false);
  assert.equal(isMachineOpen({}), false);
});

// ── matchTriggerLink ──

const links = [
  { ghl_link_id: 'LINKabc123', name: 'Book Estimate', url: '{{trigger_link.LINKabc123}}', redirect_to: 'https://reecewindows.com/book' },
  {
    ghl_link_id: 'LINKdef456', name: 'Fall Offer',
    url: '{{trigger_link.FIELDkey789}}',
    redirect_to: 'https://reecewindows.com/offer?utm_campaign=fall26&utm_content=cta1&email={{contact.email}}',
  },
];

test('matchTriggerLink: the link id inside the clicked URL wins', () => {
  assert.deepEqual(
    matchTriggerLink('https://link.reecewindows.com/l/LINKabc123?x=1', links),
    { id: 'LINKabc123', name: 'Book Estimate' },
  );
});

test('matchTriggerLink: utm_campaign + utm_content match a redirect with {{contact.*}} merge tags', () => {
  assert.deepEqual(
    matchTriggerLink('https://reecewindows.com/offer?utm_campaign=fall26&utm_content=cta1&email=jane%40x.com', links),
    { id: 'LINKdef456', name: 'Fall Offer' },
  );
});

test('matchTriggerLink: no match is null', () => {
  assert.equal(matchTriggerLink('https://example.com/unrelated', links), null);
  assert.equal(matchTriggerLink(null, links), null);
});

// ── routing ──

test('LCEmailStats routes to the email handler even when posted to /contact', () => {
  const picked = pickWebhookHandler('/webhooks/highlevel/contact', { type: 'LCEmailStats' });
  assert.equal(picked.handler, handleEmailStatsWebhook);
  assert.equal(picked.eventType, 'LCEmailStats', 'failures are logged under LCEmailStats, not "contact"');
});

test('the dedicated /email-stats path routes to the email handler too', () => {
  assert.equal(pickWebhookHandler('/webhooks/highlevel/email-stats', {}).handler, handleEmailStatsWebhook);
});

test('other payloads still route by path', () => {
  const picked = pickWebhookHandler('/webhooks/highlevel/contact', { type: 'ContactUpdate' });
  assert.notEqual(picked.handler, handleEmailStatsWebhook);
  assert.equal(picked.eventType, 'contact');
  assert.equal(pickWebhookHandler('/webhooks/highlevel/nope', { type: 'ContactUpdate' }), null);
});

// ── get_email_performance helpers ──

test('etDayStart uses the ET offset for that date (EDT and EST)', () => {
  assert.equal(etDayStart('2026-07-04'), '2026-07-04T00:00:00-04:00');
  assert.equal(etDayStart('2026-12-25'), '2026-12-25T00:00:00-05:00');
});

test('nextDay rolls months and years', () => {
  assert.equal(nextDay('2026-10-31'), '2026-11-01');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
});

test('isMissingRelation recognises a missing table, not other errors', () => {
  assert.equal(isMissingRelation({ code: '42P01', message: 'relation "email_events" does not exist' }), true);
  assert.equal(isMissingRelation({ code: 'PGRST205', message: "Could not find the table 'public.email_events'" }), true);
  assert.equal(isMissingRelation({ code: '57014', message: 'canceling statement due to statement timeout' }), false);
  assert.equal(isMissingRelation(null), false);
});

// ── attribution by GHL's own email id (2026-10-02) ──

// A real LCEmailStats event from the first live test (trimmed). The "last
// email to this contact" fallback attributed this AND the test email sent a
// minute earlier to the same conversation message.
const liveDelivered = {
  type: 'LCEmailStats',
  locationId: 'SsBG7j5KQAIP1SFP2Sca',
  webhookPayload: {
    id: 'T_d2e820QFmBmQgC8GznBg',
    event: 'delivered',
    recipient: 'mfollen@icloud.com',
    timestamp: 1790977856.8811038,
    message: {
      headers: {
        to: 'mfollen@icloud.com',
        subject: 'Test',
        'message-id': '20261002215054.5e7c9eee8ff1ab54@send.getreecewindows.com',
      },
    },
    'lc-operations': {
      domain: 'send.getreecewindows.com',
      email_type: 'one_to_one',
      location_id: 'SsBG7j5KQAIP1SFP2Sca',
      email_message_id: 'RWeiqpbRDHCGCxsbUeXs',
    },
  },
};

test('reads GHL\'s email id from lc-operations', () => {
  assert.equal(parseEmailStatsPayload(liveDelivered).ghlEmailMessageId, 'RWeiqpbRDHCGCxsbUeXs');
  assert.equal(parseEmailStatsPayload(mailgun('delivered')).ghlEmailMessageId, null, 'absent block → null');
});

test('attribution uses GHL\'s email id before any guess (no database read)', async () => {
  // Returns before the Supabase fallback, so this runs without credentials.
  const a = await attributeMessage(parseEmailStatsPayload(liveDelivered), 'hZOcPk6XmMvWVvjZJ7mz');
  assert.deepEqual(a, { id: 'RWeiqpbRDHCGCxsbUeXs', method: 'lc_operations' });
});

test('two emails to the same contact get two different ids', async () => {
  const earlier = structuredClone(liveDelivered);
  earlier.webhookPayload['lc-operations'].email_message_id = 'gEXs7FRV39zBZDhc4QuX';
  const a = await attributeMessage(parseEmailStatsPayload(earlier), 'hZOcPk6XmMvWVvjZJ7mz');
  const b = await attributeMessage(parseEmailStatsPayload(liveDelivered), 'hZOcPk6XmMvWVvjZJ7mz');
  assert.notEqual(a.id, b.id);
});

test('an explicit user-variables id still wins', async () => {
  const withVar = structuredClone(liveDelivered);
  withVar.webhookPayload['user-variables'] = { messageId: 'explicit-1' };
  const a = await attributeMessage(parseEmailStatsPayload(withVar), 'c');
  assert.deepEqual(a, { id: 'explicit-1', method: 'user_variables' });
});
