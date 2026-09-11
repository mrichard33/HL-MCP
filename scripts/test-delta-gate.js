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
