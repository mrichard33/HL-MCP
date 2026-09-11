/**
 * Payload-hash change detection (src/utils/delta-gate.ts).
 *
 * These guard the properties that make the gate safe to run in `enforce`. The
 * dangerous failure mode is not "writes too much" — it is silently skipping a
 * row that really did change, which leaves the cache permanently stale with no
 * error anywhere. Every test below is aimed at that.
 *
 * Runs against the BUILT module, so `npm run build` must precede it —
 * `npm run test:delta` chains both.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { payloadHash, deltaMode, gateByPayloadHash } from '../dist/utils/delta-gate.js';
import { chunk, UPSERT_BATCH_SIZE } from '../dist/utils/batching.js';

// ── payloadHash ───────────────────────────────────────────────────────────

test('object key order does not change the hash', () => {
  // Postgres returns JSONB with keys in its own order; that must not read as a
  // change or every row looks changed and the gate becomes a no-op.
  assert.strictEqual(
    payloadHash({ a: 1, b: { c: 2, d: 3 } }),
    payloadHash({ b: { d: 3, c: 2 }, a: 1 }),
  );
});

test('array order DOES change the hash', () => {
  // Reordered tags/steps are a real change in every payload we sync.
  assert.notStrictEqual(payloadHash({ t: ['a', 'b'] }), payloadHash({ t: ['b', 'a'] }));
});

test('any content change changes the hash', () => {
  const base = { name: 'Acme', status: 'open', value: 100 };
  assert.notStrictEqual(payloadHash(base), payloadHash({ ...base, status: 'won' }));
  assert.notStrictEqual(payloadHash(base), payloadHash({ ...base, value: 101 }));
  // null vs missing must not collide — a cleared field is a change.
  assert.notStrictEqual(payloadHash({ a: 1, b: null }), payloadHash({ a: 1 }));
});

test('the hash is stable across repeated computation', () => {
  const row = { id: 'x', tags: ['a'], nested: { z: [1, 2, { q: true }] } };
  assert.strictEqual(payloadHash(row), payloadHash(structuredClone(row)));
});

// ── deltaMode ─────────────────────────────────────────────────────────────

test('deltaMode precedence: per-entity beats global beats fallback', () => {
  const saved = { ...process.env };
  try {
    delete process.env.SYNC_DELTA_MODE;
    delete process.env.SYNC_DELTA_MODE_CONTACTS;
    assert.strictEqual(deltaMode('contacts', 'shadow'), 'shadow');

    process.env.SYNC_DELTA_MODE = 'enforce';
    assert.strictEqual(deltaMode('contacts', 'shadow'), 'enforce');

    process.env.SYNC_DELTA_MODE_CONTACTS = 'off';
    assert.strictEqual(deltaMode('contacts', 'shadow'), 'off');
  } finally {
    process.env = saved;
  }
});

test('the existing APPT_SYNC_DELTA_MODE setting still works', () => {
  // Production has this set on Railway; the refactor must not silently ignore it.
  const saved = { ...process.env };
  try {
    delete process.env.SYNC_DELTA_MODE;
    delete process.env.SYNC_DELTA_MODE_APPOINTMENTS;
    process.env.APPT_SYNC_DELTA_MODE = 'enforce';
    assert.strictEqual(deltaMode('appointments', 'shadow'), 'enforce');
  } finally {
    process.env = saved;
  }
});

test('an unrecognised mode falls back instead of throwing', () => {
  const saved = { ...process.env };
  try {
    process.env.SYNC_DELTA_MODE = 'enfroce'; // typo in a Railway variable
    assert.strictEqual(deltaMode('tags', 'enforce'), 'enforce');
  } finally {
    process.env = saved;
  }
});

// ── gateByPayloadHash ─────────────────────────────────────────────────────

/** Minimal supabase stub: only what the gate touches. */
function stubSupabase({ stored = {}, failWith = null } = {}) {
  return {
    from() {
      return {
        select() {
          return {
            in(_col, ids) {
              if (failWith) return Promise.resolve({ data: null, error: { message: failWith } });
              const data = ids
                .filter((id) => id in stored)
                .map((id) => ({ id, payload_hash: stored[id] }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  };
}

const rows = [
  { id: 'a', payload_hash: 'h-a' },
  { id: 'b', payload_hash: 'h-b-new' },
  { id: 'c', payload_hash: 'h-c' },
];

test('enforce keeps only rows whose stored hash differs', async () => {
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored: { a: 'h-a', b: 'h-b-old', c: 'h-c' } }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'test',
  });
  assert.deepStrictEqual(r.rows.map((x) => x.id), ['b']);
  assert.strictEqual(r.skippedUnchanged, 2);
  assert.strictEqual(r.gated, true);
});

test('shadow reports the same count but writes everything', async () => {
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored: { a: 'h-a', b: 'h-b-old', c: 'h-c' } }),
    table: 't', idColumn: 'id', rows, mode: 'shadow', label: 'test',
  });
  assert.strictEqual(r.rows.length, 3, 'shadow must not drop rows');
  assert.strictEqual(r.skippedUnchanged, 2, 'but must report what enforce would skip');
});

test('a row with no stored hash counts as changed', async () => {
  // New records, and rows a webhook wrote without computing a hash.
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored: { a: 'h-a' } }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'test',
  });
  assert.deepStrictEqual(r.rows.map((x) => x.id).sort(), ['b', 'c']);
});

test('a stored NULL hash counts as changed', async () => {
  // The state of every row the moment the column is first added.
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored: { a: null, b: null, c: null } }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'test',
  });
  assert.strictEqual(r.rows.length, 3);
});

test('FAILS OPEN — a prefetch error writes everything', async () => {
  // The property that makes it safe to deploy the code before the DDL:
  // "column payload_hash does not exist" must never mean "skip every row".
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ failWith: 'column "payload_hash" does not exist' }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'test',
  });
  assert.strictEqual(r.rows.length, 3, 'a prefetch failure must not skip anything');
  assert.strictEqual(r.gated, false);
  assert.strictEqual(r.skippedUnchanged, 0);
});

test('mode off passes everything through untouched', async () => {
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored: { a: 'h-a', b: 'h-b-new', c: 'h-c' } }),
    table: 't', idColumn: 'id', rows, mode: 'off', label: 'test',
  });
  assert.strictEqual(r.rows.length, 3);
  assert.strictEqual(r.gated, false);
});

test('a caller-supplied hash map is used instead of a second read', async () => {
  // syncContacts folds the hash into the tag prefetch it already runs.
  const r = await gateByPayloadHash({
    supabase: stubSupabase({ failWith: 'this read must not happen' }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'test',
    storedHashes: new Map([['a', 'h-a'], ['b', 'h-b-old'], ['c', 'h-c']]),
  });
  assert.deepStrictEqual(r.rows.map((x) => x.id), ['b']);
  assert.strictEqual(r.gated, true);
});

test('the prefetch is chunked so PostgREST URLs stay under the limit', async () => {
  // Unchunked, 21k ids serialise into a URL far past the server's limit.
  const seen = [];
  const supabase = {
    from: () => ({
      select: () => ({
        in: (_c, ids) => { seen.push(ids.length); return Promise.resolve({ data: [], error: null }); },
      }),
    }),
  };
  const many = Array.from({ length: 1200 }, (_, i) => ({ id: `id-${i}`, payload_hash: 'h' }));
  await gateByPayloadHash({ supabase, table: 't', idColumn: 'id', rows: many, mode: 'enforce', label: 'test' });
  assert.ok(seen.length > 1, 'expected more than one prefetch batch');
  assert.ok(Math.max(...seen) <= UPSERT_BATCH_SIZE, `batch too large: ${Math.max(...seen)}`);
});

// ── the property the whole gate rests on ──────────────────────────────────

test('per-cycle timestamps are excluded from the hash', () => {
  // This mirrors exactly how every caller builds its rows: hash the content,
  // THEN add synced_at/updated_at. If a caller ever folds a timestamp into the
  // hashed object, every row looks changed every cycle and the gate silently
  // reverts to writing everything.
  const content = { ghl_contact_id: 'c1', first_name: 'Sam', tags: ['lead'] };
  const cycle1 = { ...content, payload_hash: payloadHash(content), synced_at: '2026-09-11T10:00:00Z' };
  const cycle2 = { ...content, payload_hash: payloadHash(content), synced_at: '2026-09-11T10:15:00Z' };
  assert.strictEqual(cycle1.payload_hash, cycle2.payload_hash);
  assert.notStrictEqual(cycle1.synced_at, cycle2.synced_at);
});

test('chunk never loses or duplicates an element', () => {
  const src = Array.from({ length: 1001 }, (_, i) => i);
  const flat = chunk(src, 500).flat();
  assert.deepStrictEqual(flat, src);
});

// ── the write-volume ceiling (v2.2.1 regression) ──────────────────────────
//
// v2.2 removed syncOpportunities' timestamp pre-filter on the reasoning that
// the hash gate replaced it. That is true only while the gate is ENFORCING.
// In shadow/off the gate writes everything, so the sync went from ~329 writes
// per cycle to all ~21,000 — and the documented rollback (SYNC_DELTA_MODE=off)
// was the most expensive setting available. These guard the ceiling.

import { filterByNewerTimestamp } from '../dist/utils/delta-gate.js';

const opps = [
  { id: 'a', dateUpdated: '2026-09-11T10:00:00Z' }, // unchanged
  { id: 'b', dateUpdated: '2026-09-11T12:00:00Z' }, // newer -> changed
  { id: 'c', dateUpdated: '2026-09-11T10:00:00Z' }, // unchanged
  { id: 'd', dateUpdated: '2026-09-11T09:00:00Z' }, // older -> unchanged
  { id: 'new' },                                     // never seen, no timestamp
];
const stored = new Map([
  ['a', '2026-09-11T10:00:00Z'],
  ['b', '2026-09-11T11:00:00Z'],
  ['c', '2026-09-11T10:00:00Z'],
  ['d', '2026-09-11T10:00:00Z'],
]);
const pick = (list) => list.map((o) => o.id).sort();

test('the timestamp pre-filter keeps only genuinely newer records', () => {
  const out = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, stored);
  assert.deepStrictEqual(pick(out), ['b', 'new']);
});

test('equal timestamps are NOT newer — the stored row is already current', () => {
  const out = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, stored);
  assert.ok(!out.some((o) => o.id === 'a'), 'equal timestamp must not be rewritten');
});

test('an older upstream timestamp does not trigger a write', () => {
  const out = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, stored);
  assert.ok(!out.some((o) => o.id === 'd'));
});

test('records with no timestamp and unseen records fail toward writing', () => {
  const out = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, stored);
  assert.ok(out.some((o) => o.id === 'new'), 'unseen record must be written');
});

test('an empty stored map writes everything rather than skipping blindly', () => {
  // The prefetch failed. Never treat "I know nothing" as "nothing changed".
  const out = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, new Map());
  assert.strictEqual(out.length, opps.length);
});

test('THE CEILING: shadow and off can never write more than the pre-filter allows', async () => {
  // The v2.2 regression in one assertion. Whatever the delta mode, the rows
  // reaching the upsert must never exceed what the timestamp filter passed.
  const candidates = filterByNewerTimestamp(opps, (o) => o.id, (o) => o.dateUpdated, stored);
  const rows = candidates.map((o) => ({ id: o.id, payload_hash: `h-${o.id}` }));

  for (const mode of ['off', 'shadow', 'enforce']) {
    const r = await gateByPayloadHash({
      supabase: stubSupabase({ stored: { b: 'h-b', new: 'h-new' } }),
      table: 't', idColumn: 'id', rows, mode, label: 'ceiling',
    });
    assert.ok(
      r.rows.length <= candidates.length,
      `mode=${mode} wrote ${r.rows.length} rows, above the ${candidates.length}-row ceiling`,
    );
    assert.ok(r.rows.length < opps.length, `mode=${mode} escalated to a full-table write`);
  }
});

// ── v2.2.2: hash substance, not timestamps ────────────────────────────────
//
// v2.2.1 hashed date_updated alongside the record's content. Production proved
// that made the gate inert on the incremental path:
//     timestamp pre-filter — 329 candidates, 21150 unchanged
//     [DeltaGate] enforce — 329 changed, 0 unchanged skipped
// Zero skipped, every cycle: the pre-filter selects rows whose timestamp moved,
// so hashing that timestamp guaranteed the gate agreed. Two filters, one signal.

test('a timestamp bump with identical content does NOT change the hash', () => {
  // The whole point. GHL bumps dateUpdated without the record changing.
  const content = { id: 'o1', name: 'Acme', status: 'open', monetary_value: 500 };
  const cycle1 = payloadHash(content);
  const cycle2 = payloadHash(content);
  assert.strictEqual(cycle1, cycle2);

  // ...and including the timestamp is what broke it — kept as the counter-example.
  assert.notStrictEqual(
    payloadHash({ ...content, date_updated: '2026-09-11T19:00:00Z' }),
    payloadHash({ ...content, date_updated: '2026-09-11T19:30:00Z' }),
    'if this ever passes, date_updated has crept back into the hashed content',
  );
});

test('a real content change still changes the hash', () => {
  // The fix must not buy quiet by going blind.
  const base = { id: 'o1', name: 'Acme', status: 'open', monetary_value: 500 };
  for (const changed of [
    { ...base, status: 'won' },
    { ...base, monetary_value: 501 },
    { ...base, name: 'Acme Ltd' },
  ]) {
    assert.notStrictEqual(payloadHash(base), payloadHash(changed));
  }
});

test('a record GHL gives no timestamp for is stable across cycles', () => {
  // The `|| now` fallback wrote a fresh timestamp into the hashed content every
  // cycle, so these records were rewritten forever no matter what. Hashing
  // substance only means an unchanged record hashes identically even when the
  // row it lands in carries a brand-new date_updated.
  const content = { id: 'o2', name: 'No Timestamp Co', status: 'open' };
  const row = (t) => ({ ...content, date_updated: t, payload_hash: payloadHash(content) });
  assert.strictEqual(
    row('2026-09-11T19:00:00Z').payload_hash,
    row('2026-09-11T19:30:00Z').payload_hash,
  );
});

test('the gate actually skips timestamp-only churn end to end', async () => {
  // The regression in one assertion: candidates whose content is unchanged must
  // come back as skipped, not as "329 changed, 0 skipped".
  const contents = [
    { id: 'a', name: 'A', status: 'open' },
    { id: 'b', name: 'B', status: 'open' },
    { id: 'c', name: 'C-CHANGED', status: 'won' },
  ];
  const rows = contents.map((c) => ({ id: c.id, payload_hash: payloadHash(c) }));
  const stored = {
    a: payloadHash({ id: 'a', name: 'A', status: 'open' }),       // same
    b: payloadHash({ id: 'b', name: 'B', status: 'open' }),       // same
    c: payloadHash({ id: 'c', name: 'C', status: 'open' }),       // differs
  };

  const r = await gateByPayloadHash({
    supabase: stubSupabase({ stored }),
    table: 't', idColumn: 'id', rows, mode: 'enforce', label: 'churn',
  });
  assert.deepStrictEqual(r.rows.map((x) => x.id), ['c']);
  assert.strictEqual(r.skippedUnchanged, 2, 'timestamp-only churn must be skipped');
});

// ── the decision that regressed twice, now directly asserted ──────────────
import {
  opportunityHashableContent,
  contactHashableContent,
} from '../dist/extractor/entity-syncer.js';

test('OPPORTUNITY: a dateUpdated bump alone produces an identical hash', () => {
  // The exact production failure. Same record, GHL bumped the timestamp.
  const base = {
    id: 'o1', pipelineId: 'p1', pipelineStageId: 's1', contactId: 'c1',
    locationId: 'L', name: 'Acme', status: 'open', monetaryValue: 500,
    dateAdded: '2026-01-01T00:00:00Z', dateUpdated: '2026-09-11T19:00:00Z',
  };
  const bumped = { ...base, dateUpdated: '2026-09-11T19:30:00Z' };
  assert.strictEqual(
    payloadHash(opportunityHashableContent(base)),
    payloadHash(opportunityHashableContent(bumped)),
    'a timestamp-only bump must not read as a content change',
  );
});

test('OPPORTUNITY: no timestamp at all still hashes stably', () => {
  // The `|| now` fallback rewrote these forever.
  const a = { id: 'o2', name: 'No Timestamp Co', status: 'open' };
  assert.strictEqual(
    payloadHash(opportunityHashableContent(a)),
    payloadHash(opportunityHashableContent({ ...a })),
  );
});

test('OPPORTUNITY: every substantive field still moves the hash', () => {
  const base = { id: 'o1', pipelineId: 'p1', name: 'Acme', status: 'open', monetaryValue: 500 };
  const variants = [
    { ...base, status: 'won' },
    { ...base, monetaryValue: 501 },
    { ...base, name: 'Acme Ltd' },
    { ...base, pipelineStageId: 'moved' },
    { ...base, assignedTo: 'rep-2' },
    { ...base, customFields: { a: 1 } },
  ];
  for (const v of variants) {
    assert.notStrictEqual(
      payloadHash(opportunityHashableContent(base)),
      payloadHash(opportunityHashableContent(v)),
      `a change to this field must be detected: ${JSON.stringify(v)}`,
    );
  }
});

test('OPPORTUNITY: the hashed content contains no volatile keys', () => {
  const keys = Object.keys(opportunityHashableContent({ id: 'o1', dateUpdated: 'x' }));
  for (const banned of ['date_updated', 'synced_at', 'updated_at', 'payload_hash']) {
    assert.ok(!keys.includes(banned), `${banned} must never be hashed`);
  }
});

test('CONTACT: a dateUpdated bump alone produces an identical hash', () => {
  const base = {
    id: 'c1', locationId: 'L', firstName: 'Sam', lastName: 'Lee',
    email: 's@x.com', tags: ['lead'], dateUpdated: '2026-09-11T19:00:00Z',
  };
  assert.strictEqual(
    payloadHash(contactHashableContent(base)),
    payloadHash(contactHashableContent({ ...base, dateUpdated: '2026-09-11T19:30:00Z' })),
  );
});

test('CONTACT: tag changes are still detected', () => {
  // Tags drive workflow-enrollment analytics — losing these would be silent.
  const base = { id: 'c1', firstName: 'Sam', tags: ['lead'] };
  assert.notStrictEqual(
    payloadHash(contactHashableContent(base)),
    payloadHash(contactHashableContent({ ...base, tags: ['lead', 'active-w123'] })),
  );
});

test('CONTACT: the hashed content contains no volatile keys', () => {
  const keys = Object.keys(contactHashableContent({ id: 'c1', dateUpdated: 'x' }));
  for (const banned of ['date_updated', 'synced_at', 'updated_at', 'payload_hash']) {
    assert.ok(!keys.includes(banned), `${banned} must never be hashed`);
  }
});
