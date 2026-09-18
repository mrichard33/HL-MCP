import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampVerified, verifiedStampEnabled, VERIFIED_FROM } from '../dist/utils/freshness.js';

const ON = { GHL_VERIFIED_AT_ENABLED: 'true' };
const NOW = '2026-09-18T12:00:00.000Z';

/**
 * Minimal supabase stub: records the update payload and the filters applied,
 * and returns the ids the caller pretends are stale.
 */
function stubSupabase({ stale = [], failWith = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        update(payload) {
          const call = { table, payload, ids: null, or: null };
          calls.push(call);
          const chain = {
            in(_col, ids) { call.ids = ids; return chain; },
            or(expr) { call.or = expr; return chain; },
            select(_col) {
              if (failWith) return Promise.resolve({ data: null, error: { message: failWith } });
              const data = (call.ids || []).filter((id) => stale.includes(id)).map((id) => ({ id }));
              return Promise.resolve({ data, error: null });
            },
          };
          return chain;
        },
      };
    },
  };
}

const base = { table: 'contacts', idColumn: 'ghl_contact_id', now: NOW, source: VERIFIED_FROM.GHL };

test('the flag is off by default, and off means no statement at all', async () => {
  assert.equal(verifiedStampEnabled({}), false);
  const supabase = stubSupabase();
  const r = await stampVerified({ ...base, supabase, ids: ['a', 'b'], env: {} });
  assert.deepEqual(r, { stamped: 0, ran: false });
  assert.equal(supabase.calls.length, 0, 'must not touch the database when disabled');
});

test('stamps both columns with the source it was given', async () => {
  const supabase = stubSupabase({ stale: ['a', 'b'] });
  const r = await stampVerified({ ...base, supabase, ids: ['a', 'b'], env: ON });
  assert.equal(r.stamped, 2);
  assert.deepEqual(supabase.calls[0].payload, { verified_at: NOW, verified_from: 'ghl' });
});

test('the daily rate limit is a server-side filter, not a read', async () => {
  const supabase = stubSupabase({ stale: ['a'] });
  await stampVerified({ ...base, supabase, ids: ['a', 'b'], env: ON });
  // 24h before NOW — a row stamped more recently is excluded by the database.
  assert.equal(supabase.calls[0].or, 'verified_at.is.null,verified_at.lt.2026-09-17T12:00:00.000Z');
  assert.equal(supabase.calls.length, 1, 'no extra round trip to read verified_at');
});

test('only rows past the filter count as stamped', async () => {
  const supabase = stubSupabase({ stale: ['a'] });
  const r = await stampVerified({ ...base, supabase, ids: ['a', 'b', 'c'], env: ON });
  assert.equal(r.stamped, 1);
});

test('maxAgeMs is honoured', async () => {
  const supabase = stubSupabase();
  await stampVerified({ ...base, supabase, ids: ['a'], env: ON, maxAgeMs: 60 * 60 * 1000 });
  assert.match(supabase.calls[0].or, /2026-09-18T11:00:00\.000Z$/);
});

test('an empty id list is a no-op that still reports as run', async () => {
  const supabase = stubSupabase();
  const r = await stampVerified({ ...base, supabase, ids: [], env: ON });
  assert.deepEqual(r, { stamped: 0, ran: true });
  assert.equal(supabase.calls.length, 0);
});

// The whole point of isolating this in its own UPDATE: a failure here must
// report and stop, never throw into the sync. Before migration 016 lands this
// is exactly what happens ("column verified_at does not exist").
test('a failure is reported, not thrown, and never blocks the sync', async () => {
  const supabase = stubSupabase({ failWith: 'column "verified_at" does not exist' });
  const r = await stampVerified({ ...base, supabase, ids: ['a'], env: ON });
  assert.equal(r.ran, true);
  assert.equal(r.stamped, 0);
  assert.match(r.error, /verified_at/);
});

test('ids are chunked so a large cycle cannot blow the URL limit', async () => {
  const ids = Array.from({ length: 1200 }, (_, i) => `c${i}`);
  const supabase = stubSupabase({ stale: ids });
  const r = await stampVerified({ ...base, supabase, ids, env: ON });
  assert.equal(supabase.calls.length, 3, '1200 ids at batch size 500 → 3 statements');
  assert.equal(r.stamped, 1200);
});
