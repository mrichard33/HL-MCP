/**
 * test-appointment-webhook.js — v2.3 appointment webhook payload reader.
 *
 * THE DEFECT (2026-09-28). GHL's app webhooks nest the appointment under
 * `appointment`. handleAppointmentWebhook read the top level, found no id, and
 * the appointments upsert failed on ghl_appointment_id NOT NULL with its error
 * unchecked — "Processed successfully" was logged and nothing was written. The
 * HL cache therefore ran up to 15 minutes behind GHL, and the LP parity
 * watchdog paged ops for SANDRA WATSON (PlB224EDUJYZJ2xnJ7mr), whose webhook
 * arrived at 20:30:24Z and whose row only landed with the 20:45 sync.
 *
 * Runs against the compiled output in dist/, per `npm test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { readAppointmentWebhook, toSyncTimestamp } =
  await import('../dist/webhooks/appointment-payload.js');

// The AppointmentCreate GHL actually sent for Sandra, as stored in lead_events.
const sandra = {
  type: 'AppointmentCreate',
  appId: '67870659eed1292e41547c94',
  timestamp: '2026-09-28T20:30:24.271Z',
  webhookId: 'sandra-webhook',
  locationId: 'SsBG7j5KQAIP1SFP2Sca',
  appointment: {
    id: 'PlB224EDUJYZJ2xnJ7mr',
    title: 'Sandra Watson - Window Estimate',
    source: 'third_party',
    endTime: '2026-09-30T19:30:00.000Z',
    contactId: 'Bq3lxQMhFduSVV1FX7PF',
    dateAdded: '2026-09-28T20:30:23.047Z',
    startTime: '2026-09-30T18:00:00.000Z',
    calendarId: 'aJj14ONxh1oFyDcQ706O',
    dateUpdated: '2026-09-28T20:30:23.047Z',
    assignedUserId: '3K6HtoPyBLWeQrrnSnCD',
    appointmentStatus: 'new',
  },
};

test('Sandra regression: the nested GHL envelope reads the real appointment', () => {
  const a = readAppointmentWebhook(sandra);
  assert.ok(a, 'the id is inside `appointment` — v2.2 found nothing here');
  assert.equal(a.id, 'PlB224EDUJYZJ2xnJ7mr');
  assert.equal(a.contactId, 'Bq3lxQMhFduSVV1FX7PF');
  assert.equal(a.calendarId, 'aJj14ONxh1oFyDcQ706O');
  assert.equal(a.status, 'new');
  assert.equal(a.locationId, 'SsBG7j5KQAIP1SFP2Sca', 'locationId lives on the envelope, not the appointment');
  assert.equal(a.startTime, '2026-09-30T18:00:00.000Z');
  assert.equal(a.assignedUserId, '3K6HtoPyBLWeQrrnSnCD');
  assert.equal(a.deleted, false);
  assert.equal(a.raw, sandra.appointment, 'raw_json stores the record, not the envelope');
});

test('the legacy flat shape still reads', () => {
  const a = readAppointmentWebhook({
    id: 'flat-1', contactId: 'c-1', status: 'cancelled', startTime: '2026-10-01T14:00:00.000Z',
  });
  assert.equal(a.id, 'flat-1');
  assert.equal(a.contactId, 'c-1');
  assert.equal(a.status, 'cancelled');
});

test('hash parity: the webhook time formats to the exact string the sync stored', () => {
  // The 20:45 sync stored raw_json.startTime = "2026-09-30T14:00:00-04:00" for
  // this appointment. event_hash is built from that STRING, so anything else
  // would give every appointment two lead events.
  assert.equal(toSyncTimestamp('2026-09-30T18:00:00.000Z'), '2026-09-30T14:00:00-04:00');
  // And across the DST change, in EST.
  assert.equal(toSyncTimestamp('2026-12-01T15:00:00.000Z'), '2026-12-01T10:00:00-05:00');
});

test('an already-ET time keeps its value and format', () => {
  assert.equal(toSyncTimestamp('2026-09-30T14:00:00-04:00'), '2026-09-30T14:00:00-04:00');
});

test('unparseable or empty times are returned unchanged', () => {
  assert.equal(toSyncTimestamp('not a date'), 'not a date');
  assert.equal(toSyncTimestamp(null), null);
});

test('AppointmentDelete marks the record deleted', () => {
  const a = readAppointmentWebhook({ ...sandra, type: 'AppointmentDelete' });
  assert.equal(a.deleted, true);
  assert.equal(a.id, 'PlB224EDUJYZJ2xnJ7mr');
});

test('no id anywhere → null (the handler turns that into a recorded failure)', () => {
  assert.equal(readAppointmentWebhook({ type: 'AppointmentCreate', appointment: { contactId: 'x' } }), null);
  assert.equal(readAppointmentWebhook({}), null);
});

test('the GHL `appoinmentStatus` typo is read when appointmentStatus is absent', () => {
  const a = readAppointmentWebhook({ type: 'AppointmentUpdate', appointment: { id: 'typo-1', appoinmentStatus: 'showed' } });
  assert.equal(a.status, 'showed');
});
