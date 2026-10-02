/**
 * test-message-channel.js — message channel classification (2026-10-02).
 *
 * THE DEFECT. deriveMessageEventType only recognised the lowercase word
 * "email". GHL's REST sync sends the channel as a numeric code ('3' email,
 * '29' live chat, '1' call) and its webhooks send messageType ('Email',
 * 'Live_Chat'), so every email, chat and call was logged as sms_delivered.
 * In the 7 days to 2026-10-02 sms_delivered held 1,211 emails, 320 chats and
 * 332 Live_Chat webhooks. Inbound messages with status 'delivered' were
 * counted as sms_delivered too.
 *
 * Runs against the compiled output in dist/, per `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeMessageChannel, deriveMessageEventType } =
  await import('../dist/utils/event-type.js');

test('normalizeMessageChannel maps GHL codes, webhook strings and old words', () => {
  const cases = [
    ['3', 'email'], ['9', 'email'], ['Email', 'email'], ['TYPE_EMAIL', 'email'],
    ['29', 'live_chat'], ['Live_Chat', 'live_chat'],
    ['1', 'call'], ['2', 'sms'], ['SMS', 'sms'], ['11', 'facebook'],
    ['37', 'other'], [undefined, 'sms'],
  ];
  for (const [raw, want] of cases) {
    assert.equal(normalizeMessageChannel(raw), want, `normalizeMessageChannel(${JSON.stringify(raw)})`);
  }
});

test('deriveMessageEventType classifies by the real channel', () => {
  const cases = [
    [{ direction: 'outbound', type: '3', status: 'delivered' }, 'email_delivered'],
    [{ direction: 'inbound', type: '3' }, 'email_received'],
    [{ direction: 'outbound', type: '29' }, 'chat_sent'],
    [{ direction: 'inbound', type: '1' }, 'call_inbound'],
    [{ direction: 'outbound', type: '2', status: 'delivered' }, 'sms_delivered'],
    [{ direction: 'outbound', type: 'Email', status: 'opened' }, 'email_opened'],
  ];
  for (const [input, want] of cases) {
    assert.equal(deriveMessageEventType(input), want, JSON.stringify(input));
  }
});

test('regression: an INBOUND delivered SMS is a reply, not sms_delivered', () => {
  assert.equal(
    deriveMessageEventType({ direction: 'inbound', type: '2', status: 'delivered' }),
    'sms_received',
  );
});

test('the webhook event name is not a channel: an email code never becomes SMS', () => {
  // Before the fix, '3' fell through to the SMS branch.
  assert.notEqual(
    deriveMessageEventType({ direction: 'outbound', type: '3', status: 'delivered' }),
    'sms_delivered',
  );
});
