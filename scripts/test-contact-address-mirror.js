/**
 * Contact address mirroring (src/extractor/entity-syncer.ts).
 *
 * Migration 017 adds address1 / city / state / postal_code to the contacts
 * mirror so market assignment, service-area checks, dedup and the LP↔GHL link
 * repair stop needing a live GHL fetch for a postal code.
 *
 * THE FAILURE THESE GUARD AGAINST is not "writes too much". It is erasing a
 * good address because GHL happened to return the contact without one — the
 * identical defect that cost LP-MCP three separate rounds of repair on
 * ghl_contact_id (sync-leads v10.1, then #784, then lp_notes/lp_call_logs,
 * 27,349 + 236,961 rows). Nothing throws when it happens and nothing reports it.
 *
 * Two properties make the fix work and both are pinned below:
 *   1. An absent address carries the STORED value forward, never null.
 *   2. Every row in one cycle carries the SAME key set — PostgREST silently
 *      defaults columns on a ragged batch, so per-row omission is not an option
 *      and the "leave them alone" case has to omit for the whole cycle at once.
 *
 * Runs against the BUILT module, so `npm run build` must precede it.
 * Run: npm run build && node --test scripts/test-contact-address-mirror.js
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { contactHashableContent, contactAddressFields } from '../dist/extractor/entity-syncer.js';
import { payloadHash } from '../dist/utils/delta-gate.js';

const FULL = {
  id: 'C1',
  firstName: 'Liz',
  lastName: 'Alcazar',
  phone: '+13524453161',
  address1: '742 Evergreen Terrace',
  city: 'Sarasota',
  state: 'FL',
  postalCode: '34239',
};

const STORED = {
  address1: '742 Evergreen Terrace',
  city: 'Sarasota',
  state: 'FL',
  postal_code: '34239',
};

// ═══════════════════════════════════════════════════════════════════
// 11. A payload with a full address populates all four columns
// ═══════════════════════════════════════════════════════════════════

test('11. a contact payload with a full address populates all four columns', () => {
  const row = contactHashableContent(FULL, undefined);
  assert.strictEqual(row.address1, '742 Evergreen Terrace');
  assert.strictEqual(row.city, 'Sarasota');
  assert.strictEqual(row.state, 'FL');
  assert.strictEqual(row.postal_code, '34239');
});

test('a NEW contact (no stored row) writes the payload address', () => {
  // `undefined` means the prefetch found nothing to carry forward, which is the
  // normal case for a contact created since the last cycle.
  const row = contactHashableContent(FULL, undefined);
  assert.strictEqual(row.postal_code, '34239');
});

test('a payload address WINS over a stale stored one', () => {
  // A real move. The mirror must follow GHL, not freeze on the first value it
  // ever saw — "never null" is not "never change".
  const moved = { ...FULL, postalCode: '33101', city: 'Miami' };
  const row = contactHashableContent(moved, STORED);
  assert.strictEqual(row.postal_code, '33101');
  assert.strictEqual(row.city, 'Miami');
});

// ═══════════════════════════════════════════════════════════════════
// 12. A payload with the address absent must not null the stored value
// ═══════════════════════════════════════════════════════════════════

test('12. a contact payload with the address absent does NOT null the stored values', () => {
  const bare = { id: 'C1', firstName: 'Liz', lastName: 'Alcazar', phone: '+13524453161' };
  const row = contactHashableContent(bare, STORED);
  assert.strictEqual(row.address1, '742 Evergreen Terrace');
  assert.strictEqual(row.city, 'Sarasota');
  assert.strictEqual(row.state, 'FL');
  assert.strictEqual(row.postal_code, '34239');
});

test('a PARTIALLY absent address preserves only the missing halves', () => {
  const partial = { id: 'C1', postalCode: '33101' };   // zip moved, rest absent
  const row = contactHashableContent(partial, STORED);
  assert.strictEqual(row.postal_code, '33101', 'the supplied field updates');
  assert.strictEqual(row.city, 'Sarasota', 'the absent field is preserved');
  assert.strictEqual(row.address1, '742 Evergreen Terrace');
});

test('an EMPTY STRING from GHL is a real clear, not an absence', () => {
  // `??`, not `||`, on purpose. GHL sends '' when a user clears a field, and
  // that is a deliberate edit the mirror should follow. Only undefined/null —
  // the field genuinely not being in the payload — falls back to stored.
  const cleared = { id: 'C1', address1: '', city: '', state: '', postalCode: '' };
  const row = contactHashableContent(cleared, STORED);
  assert.strictEqual(row.address1, '');
  assert.strictEqual(row.postal_code, '');
});

test('no payload address AND no stored row yields null, not undefined', () => {
  // undefined would drop the key out of the JSON body and make the batch ragged.
  const row = contactHashableContent({ id: 'C1' }, undefined);
  for (const k of ['address1', 'city', 'state', 'postal_code']) {
    assert.strictEqual(row[k], null, `${k} must be null, not undefined`);
  }
  assert.ok(k4().every((k) => k in row), 'all four keys must be present');
});

// ═══════════════════════════════════════════════════════════════════
// stored === null — the "leave these columns alone" signal
// ═══════════════════════════════════════════════════════════════════

test('stored === null omits all four columns entirely', () => {
  // The prefetch failed, or migration 017 is not applied. Writing nothing is
  // always recoverable; writing a null over a good address is not.
  const row = contactHashableContent(FULL, null);
  for (const k of k4()) {
    assert.strictEqual(k in row, false, `${k} must be ABSENT when stored is null`);
  }
  // Everything else still syncs — the address is the only thing that degrades.
  assert.strictEqual(row.ghl_contact_id, 'C1');
  assert.strictEqual(row.phone, '+13524453161');
});

test('a whole cycle keeps ONE key set, whichever branch it takes', () => {
  // PostgREST defaults columns silently on a ragged batch. The caller passes
  // null for EVERY contact or for none, so this pins both shapes as uniform.
  const contacts = [FULL, { id: 'C2' }, { id: 'C3', city: 'Tampa' }];

  const withAddress = contacts.map((c) => contactHashableContent(c, undefined));
  const shape = Object.keys(withAddress[0]).sort().join(',');
  for (const r of withAddress) {
    assert.strictEqual(Object.keys(r).sort().join(','), shape, 'ragged keys with address');
  }

  const without = contacts.map((c) => contactHashableContent(c, null));
  const bareShape = Object.keys(without[0]).sort().join(',');
  for (const r of without) {
    assert.strictEqual(Object.keys(r).sort().join(','), bareShape, 'ragged keys without address');
  }
  assert.notStrictEqual(shape, bareShape, 'the two shapes must genuinely differ');
});

// ═══════════════════════════════════════════════════════════════════
// The hash — why the existing 25,003 rows will actually populate
// ═══════════════════════════════════════════════════════════════════

test('the address is INSIDE the hash, so the delta gate cannot skip the backfill', () => {
  // This is what makes the one-time backfill happen by itself. The gate skips a
  // contact whose hash is unchanged, so an address outside the hash would stay
  // NULL forever on every row that never changes again.
  const bare = { id: 'C1', firstName: 'Liz', lastName: 'Alcazar', phone: '+13524453161' };
  assert.notStrictEqual(
    payloadHash(contactHashableContent({ ...bare, postalCode: '34239' }, undefined)),
    payloadHash(contactHashableContent(bare, undefined)),
  );
});

test('the hash SETTLES once the address is stored — no permanent churn', () => {
  // The other half of the same property. If a payload that omits the address
  // hashed differently from the stored row, every such contact would rewrite on
  // every cycle forever — the exact defect v2.2.2 fixed for date_updated.
  const bare = { id: 'C1', firstName: 'Liz', lastName: 'Alcazar', phone: '+13524453161' };
  assert.strictEqual(
    payloadHash(contactHashableContent(bare, STORED)),
    payloadHash(contactHashableContent({ ...bare, ...addrPayload(STORED) }, STORED)),
  );
});

test('contactAddressFields is the single place the fallback lives', () => {
  assert.deepStrictEqual(
    contactAddressFields({ id: 'C1' }, STORED),
    { address1: '742 Evergreen Terrace', city: 'Sarasota', state: 'FL', postal_code: '34239' },
  );
  assert.deepStrictEqual(
    contactAddressFields({ id: 'C1' }, undefined),
    { address1: null, city: null, state: null, postal_code: null },
  );
});

// ── helpers ───────────────────────────────────────────────────────────────
function k4() { return ['address1', 'city', 'state', 'postal_code']; }
function addrPayload(stored) {
  return {
    address1: stored.address1, city: stored.city,
    state: stored.state, postalCode: stored.postal_code,
  };
}
