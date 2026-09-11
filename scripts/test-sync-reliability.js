/**
 * Regressions behind the opportunities sync failure rate (2026-09-11).
 *
 * Symptom: opportunities showed 19 failed / 27 completed in 24h, incremental
 * runs measured 62-93 minutes against a 20-minute job ceiling, and every daily
 * full reconcile reported exactly 20000 records against 21,102 live rows.
 *
 * Three independent defects, one guarded here each:
 *
 *   1. ghl-rate-limiter: a queued caller tore down its own retry interval while
 *      still parked in the queue, so it could only ever be resolved as a side
 *      effect of some *other* caller arriving. A sequential pager has no other
 *      caller, so it stalled until an unrelated cron job made a GHL request.
 *   2. GHLClient.getAllOpportunities: stopped silently at the page ceiling and
 *      returned a clipped list that looked complete to callers — including
 *      softDeleteMissing, which deletes whatever it cannot see.
 *   3. softDeleteMissing: no guard against a delete batch far larger than real
 *      churn, which is always a symptom of a bad active list.
 *
 * Runs against the BUILT modules, so `npm run build` must precede it —
 * `npm run test:sync` chains both. Env is set before each dynamic import
 * because these modules read their config at module load.
 */
import { test } from 'node:test';
import assert from 'node:assert';

// ── 1. Rate limiter: every queued waiter is eventually served ──────────────
//
// Config makes the test fast and deterministic: a 2-token bucket, a 100ms
// refill, and a 200ms pause. report429() drains and pauses the bucket, then we
// queue 6 callers. A resume mints only 2 tokens, so the remaining 4 can only be
// served by their own retry ticks — exactly the path that was broken.
process.env.RATE_LIMIT_BUCKET_CAPACITY = '2';
process.env.RATE_LIMIT_REFILL_RATE_PER_MIN = '600'; // 100ms per token
process.env.RATE_LIMIT_BASE_PAUSE_MS = '200';
process.env.RATE_LIMIT_MAX_PAUSE_MS = '200';

const { acquireToken, report429 } = await import('../dist/clients/ghl-rate-limiter.js');

test('every caller queued behind a 429 pause is eventually served', async () => {
  report429();

  const WAITERS = 6;
  const started = Date.now();
  const all = Promise.all(
    Array.from({ length: WAITERS }, () => acquireToken()),
  );

  // Before the fix, a resume served only the 2 tokens it mints and the other 4
  // waiters hung forever — their intervals had already been cleared. This race
  // is what turned a ~4-minute opportunity fetch into 62-93 minutes.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `${WAITERS} queued callers did not all acquire a token within 8s — ` +
      'waiters are being stranded in the queue again',
    )), 8000);
  });

  try {
    await Promise.race([all, timeout]);
  } finally {
    clearTimeout(timer);
  }
  const elapsed = Date.now() - started;

  // 200ms pause + 2 free tokens + 4 more at 100ms each ≈ 600ms. A loose ceiling
  // guards against the refill() remainder loss creeping back in without making
  // the test timing-fragile.
  assert.ok(elapsed < 8000, `took ${elapsed}ms`);
});

// ── 2 & 3. Opportunity paging + soft-delete safety ────────────────────────
process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'test-location';

const { GHLClient } = await import('../dist/clients/ghl.js');
const { isSoftDeleteBatchPlausible } = await import('../dist/extractor/entity-syncer.js');

/** Build a client whose paging is stubbed — no network, no credentials. */
function clientReturning(totalPages) {
  const client = new GHLClient();
  let page = 0;
  client.getOpportunities = async () => {
    page++;
    const isLast = page >= totalPages;
    return {
      opportunities: Array.from({ length: 100 }, (_, i) => ({ id: `opp-${page}-${i}` })),
      // A real GHL response stops handing back a cursor on the final page.
      meta: isLast ? {} : { startAfter: String(page), startAfterId: `id-${page}` },
    };
  };
  return client;
}

test('a complete opportunity walk reports truncated=false', async () => {
  process.env.GHL_OPPORTUNITY_MAX_PAGES = '10';
  const result = await clientReturning(4).getAllOpportunitiesChecked();
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.opportunities.length, 400);
});

test('hitting the page ceiling reports truncated=true', async () => {
  // GHL still has more to give, but we stop at the ceiling. Callers MUST be
  // able to tell this apart from a complete list: the production bug was that
  // they could not, and the daily reconcile fed a 20,000-record slice of a
  // 21,102-record book straight into softDeleteMissing.
  process.env.GHL_OPPORTUNITY_MAX_PAGES = '3';
  const result = await clientReturning(99).getAllOpportunitiesChecked();
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.opportunities.length, 300);
});

test('the page ceiling is configurable and defaults above the current book', async () => {
  delete process.env.GHL_OPPORTUNITY_MAX_PAGES;
  // Default must clear 21,102 live opportunities (212 pages) with headroom;
  // the old hard-coded 200-page ceiling did not.
  const result = await clientReturning(250).getAllOpportunitiesChecked();
  assert.strictEqual(result.truncated, false);
  assert.strictEqual(result.opportunities.length, 25000);
});

test('contacts paging reports truncation the same way', async () => {
  // Contacts carried the identical 200-page ceiling against 22,567 live rows
  // and feeds softDeleteMissing() from the same full-mode path, so it needs the
  // same signal. Paginating softDeleteMissing without this would have turned a
  // dormant bug into an active mass-delete.
  const client = new GHLClient();
  let page = 0;
  client.getContacts = async () => {
    page++;
    return {
      contacts: Array.from({ length: 100 }, (_, i) => ({ id: `c-${page}-${i}` })),
      meta: { startAfter: String(page), startAfterId: `id-${page}` }, // never exhausts
    };
  };
  process.env.GHL_CONTACT_MAX_PAGES = '3';
  const result = await client.getAllContactsChecked();
  delete process.env.GHL_CONTACT_MAX_PAGES;
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.contacts.length, 300);
});

test('soft-delete allows normal churn', () => {
  // Observed real churn on this tenant: 4-33 rows/day against ~21k.
  assert.strictEqual(isSoftDeleteBatchPlausible(33, 21102).ok, true);
  assert.strictEqual(isSoftDeleteBatchPlausible(0, 21102).ok, true);
  // Small tables must not be throttled by the ratio — the absolute floor wins.
  assert.strictEqual(isSoftDeleteBatchPlausible(40, 100).ok, true);
});

test('soft-delete refuses a batch that implies a truncated list', () => {
  // The exact production scenario: a 20,000-record fetch against 21,102 rows
  // would have tried to delete 1,102 live opportunities.
  assert.strictEqual(isSoftDeleteBatchPlausible(1102, 21102).ok, false);
  assert.strictEqual(isSoftDeleteBatchPlausible(21102, 21102).ok, false);
});

test('soft-delete safety limits are env-overridable', () => {
  process.env.SOFT_DELETE_MAX_RATIO = '0.9';
  try {
    assert.strictEqual(isSoftDeleteBatchPlausible(1102, 21102).ok, true);
  } finally {
    delete process.env.SOFT_DELETE_MAX_RATIO;
  }
});
