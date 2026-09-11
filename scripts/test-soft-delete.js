/**
 * softDeleteMissing — the restore path (src/extractor/entity-syncer.ts).
 *
 * WHY THIS FILE EXISTS
 *
 * The restore path had never worked at scale, and the damage was live: 330
 * opportunities sat marked deleted in Supabase while GHL kept returning them as
 * active, so every report filtering `deleted_at IS NULL` was missing them.
 *
 * Two defects, both invisible:
 *   1. `.in()` was handed the whole active id list (21,494 ids) unchunked.
 *      PostgREST serialises .in() into the URL, so the request blew the URL
 *      length limit and failed.
 *   2. The result destructured `data` but not `error`, so the failure never
 *      surfaced and `restored` confidently reported 0.
 *
 * "It reported 0 restored" is indistinguishable from "there was nothing to
 * restore" — which is exactly why it went unnoticed. These tests assert the
 * calls actually made, not the summary number.
 *
 * Runs against the BUILT module — `npm run test:softdelete` chains the build.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { softDeleteMissing } from '../dist/extractor/entity-syncer.js';
import { UPSERT_BATCH_SIZE } from '../dist/utils/batching.js';

/**
 * Records every `.in()` batch size the call makes, so a test can assert the
 * request shape rather than trusting the returned count.
 */
function stubClient({ restoreError = null, pagedIds = [], restoredPerBatch = 0 } = {}) {
  const calls = { restoreBatches: [], deleteBatches: [], selects: 0 };

  const updateChain = (kind) => ({
    in(_col, ids) {
      const rec = { ids: ids.length };
      const self = {
        not() { return self; },
        select() {
          if (kind === 'restore') {
            calls.restoreBatches.push(rec.ids);
            if (restoreError) return Promise.resolve({ data: null, error: { message: restoreError } });
            return Promise.resolve({
              data: Array.from({ length: restoredPerBatch }, (_, i) => ({ id: `r${i}` })),
              error: null,
            });
          }
          calls.deleteBatches.push(rec.ids);
          return Promise.resolve({ data: [], error: null });
        },
      };
      return self;
    },
  });

  let updateCount = 0;
  const client = {
    from() {
      return {
        update(patch) {
          updateCount++;
          // deleted_at: null is the restore; a timestamp is the delete.
          return updateChain(patch.deleted_at === null ? 'restore' : 'delete');
        },
        select() {
          calls.selects++;
          const q = {
            is: () => q,
            eq: () => q,
            range: (from) => Promise.resolve({
              data: from === 0 ? pagedIds.map((id) => ({ ghl_id: id })) : [],
              error: null,
            }),
          };
          return q;
        },
      };
    },
  };
  return { client, calls, updateCount: () => updateCount };
}

test('THE BUG: the restore chunks its id list instead of sending all of them', async () => {
  // 1,200 active ids. Unchunked this is one .in() with 1,200 ids — the shape
  // that blew the PostgREST URL limit in production and failed every cycle.
  const activeIds = Array.from({ length: 1200 }, (_, i) => `opp-${i}`);
  const { client, calls } = stubClient({ pagedIds: [] });

  await softDeleteMissing('opportunities', 'ghl_id', activeIds, 'LOC', { client });

  assert.ok(calls.restoreBatches.length > 1,
    `expected the restore to chunk 1,200 ids; it made ${calls.restoreBatches.length} call(s)`);
  assert.ok(Math.max(...calls.restoreBatches) <= UPSERT_BATCH_SIZE,
    `a restore batch of ${Math.max(...calls.restoreBatches)} exceeds the ${UPSERT_BATCH_SIZE} limit`);
  assert.strictEqual(calls.restoreBatches.reduce((a, b) => a + b, 0), 1200,
    'every id must still be covered across the batches');
});

test('restored counts accumulate across every chunk', async () => {
  const activeIds = Array.from({ length: 1200 }, (_, i) => `opp-${i}`);
  const { client } = stubClient({ pagedIds: [], restoredPerBatch: 7 });

  const r = await softDeleteMissing('opportunities', 'ghl_id', activeIds, 'LOC', { client });

  // 3 chunks x 7 = 21. Counting only the last chunk would report 7.
  assert.strictEqual(r.restored, 21);
});

test('a restore failure is surfaced, not reported as a quiet zero', async () => {
  // The exact production symptom: the request fails, nothing is restored, and
  // the old code returned 0 with no error anywhere — indistinguishable from
  // "nothing needed restoring".
  const activeIds = Array.from({ length: 600 }, (_, i) => `opp-${i}`);
  const { client, calls } = stubClient({ pagedIds: [], restoreError: 'URI too long' });

  const errors = [];
  const realError = console.error;
  console.error = (msg) => errors.push(String(msg));
  try {
    await softDeleteMissing('opportunities', 'ghl_id', activeIds, 'LOC', { client });
  } finally {
    console.error = realError;
  }

  assert.ok(errors.some((e) => e.includes('restore failed')),
    'a failed restore must log an error; silence is what hid this for months');
  assert.strictEqual(calls.restoreBatches.length, 1,
    'it must stop on the first error rather than hammering every chunk');
});

test('the delete pass is chunked and error-checked too', async () => {
  // Same two defects existed on the delete side. The plausibility guard usually
  // keeps this list small, but it is overridable — and an unchunked .in() fails
  // exactly when the list is largest.
  const activeIds = ['keep-1'];
  const stale = Array.from({ length: 900 }, (_, i) => `stale-${i}`);
  const { client, calls } = stubClient({ pagedIds: [...stale, 'keep-1'] });

  const saved = process.env.SOFT_DELETE_MAX_RATIO;
  // 900 of 901 rows is a 99.9% delete — above even a 0.99 guard, which is the
  // guard doing its job. Set 1.0 so this test exercises chunking, not the guard
  // (the guard has its own tests in test-sync-reliability.js).
  process.env.SOFT_DELETE_MAX_RATIO = '1';
  try {
    await softDeleteMissing('opportunities', 'ghl_id', activeIds, 'LOC', { client });
  } finally {
    if (saved === undefined) delete process.env.SOFT_DELETE_MAX_RATIO;
    else process.env.SOFT_DELETE_MAX_RATIO = saved;
  }

  assert.ok(calls.deleteBatches.length > 1,
    `expected the delete to chunk 900 ids; it made ${calls.deleteBatches.length} call(s)`);
  assert.ok(Math.max(...calls.deleteBatches) <= UPSERT_BATCH_SIZE);
});

test('restores still run when the active list is truncated', async () => {
  // A short list proves nothing about absence, so the delete pass is skipped —
  // but a record PRESENT in a short list definitely exists, so restoring is
  // still correct and still valuable.
  const activeIds = Array.from({ length: 600 }, (_, i) => `opp-${i}`);
  const { client, calls } = stubClient({ pagedIds: [], restoredPerBatch: 3 });

  const r = await softDeleteMissing('opportunities', 'ghl_id', activeIds, 'LOC', {
    client, listIsComplete: false,
  });

  assert.ok(r.skipped, 'the delete pass must be skipped on a truncated list');
  assert.strictEqual(r.deleted, 0);
  assert.strictEqual(r.restored, 6, 'restores must still have run across both chunks');
  assert.strictEqual(calls.deleteBatches.length, 0);
});
