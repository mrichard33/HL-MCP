/**
 * Webhook forward retry regression tests — scripts/test-webhook-retry.js
 *
 * Locks in the Project 2 (2026-08-29) retry invariants for the LP MCP tag
 * forward. Runs against the compiled output in dist/, per `npm test`.
 *
 * The one that matters most is the predicate. isTransientUpstreamError is
 * shaped around GHLClient's error strings and does NOT match
 * "The operation was aborted due to timeout" — which is 4,150 of the 4,222
 * rows in webhook_failures. Reusing it would have shipped a retry that never
 * fired on the failure it was built for, and the bug would have looked fixed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const { withBoundedRetry, isRetryableServiceCallError, isTransientUpstreamError } =
  await import('../dist/utils/retry.js');

// ════════════════════════════════════════════════════════════════════
// Predicate
// ════════════════════════════════════════════════════════════════════

test('the dominant failure mode is retryable', () => {
  // Verbatim from webhook_failures.error_message — 4,150 rows.
  const msg = 'The operation was aborted due to timeout';
  assert.equal(isRetryableServiceCallError(new Error(msg)), true);

  // Guard the reason this predicate exists at all: the default one misses it.
  assert.equal(isTransientUpstreamError(new Error(msg)), false,
    'if this starts passing, isRetryableServiceCallError may be redundant — recheck');
});

test('every observed failure mode in webhook_failures is retryable', () => {
  const observed = [
    'The operation was aborted due to timeout',      // 4,150
    'LP MCP returned 500: snapshot read failed',     //    40
    'fetch failed',                                  //    13
    'LP MCP returned 502: Application failed to respond', // 10
    'LP MCP returned 502: upstream error',           //     9
  ];
  for (const msg of observed) {
    assert.equal(isRetryableServiceCallError(new Error(msg)), true, `should retry: ${msg}`);
  }
});

test('deterministic client errors are not retried', () => {
  for (const msg of ['LP MCP returned 400: missing or invalid contact_id',
                     'LP MCP returned 404: not found',
                     'LP MCP returned 422: tags must be an array']) {
    assert.equal(isRetryableServiceCallError(new Error(msg)), false, `should not retry: ${msg}`);
  }
});

// ════════════════════════════════════════════════════════════════════
// Delay ladder
// ════════════════════════════════════════════════════════════════════

test('delaysMs is used verbatim — no jitter, no maxDelayMs cap', async () => {
  const waits = [];
  const realSetTimeout = globalThis.setTimeout;
  // Capture the requested delay, then fire immediately so the test is fast.
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };

  try {
    let attempt = 0;
    await withBoundedRetry(
      async () => {
        attempt++;
        if (attempt < 3) throw new Error('The operation was aborted due to timeout');
        return 'ok';
      },
      {
        maxAttempts: 3,
        delaysMs: [2000, 10000, 60000],
        isRetryable: isRetryableServiceCallError,
        label: 'test',
      },
    );
    assert.deepEqual(waits, [2000, 10000],
      'the ladder must be exact — the default schedule caps at maxDelayMs (10s) and jitters');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('the computed schedule still jitters when delaysMs is absent', async () => {
  const waits = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    let attempt = 0;
    await withBoundedRetry(
      async () => { attempt++; if (attempt < 3) throw new Error('fetch failed'); return 'ok'; },
      { maxAttempts: 3, baseDelayMs: 1000, label: 'test' },
    );
    // Full-range jitter: 0..backoff. Anti-herd behaviour for the cron jobs
    // sharing a boundary — must survive the delaysMs addition.
    assert.equal(waits.length, 2);
    for (const w of waits) assert.ok(w >= 0 && w <= 2000, `unexpected wait ${w}`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ════════════════════════════════════════════════════════════════════
// Retry outcomes
// ════════════════════════════════════════════════════════════════════

test('a timeout on attempt 1 succeeds on attempt 2 and reports no failure', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    let attempt = 0;
    const result = await withBoundedRetry(
      async () => {
        attempt++;
        if (attempt === 1) throw new Error('The operation was aborted due to timeout');
        return 'delivered';
      },
      { maxAttempts: 3, delaysMs: [2000, 10000, 60000], isRetryable: isRetryableServiceCallError },
    );
    assert.equal(result, 'delivered');
    assert.equal(attempt, 2, 'should have succeeded on the second attempt');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a 400 fails immediately without burning the ladder', async () => {
  let attempt = 0;
  await assert.rejects(
    () => withBoundedRetry(
      async () => { attempt++; throw new Error('LP MCP returned 400: bad payload'); },
      { maxAttempts: 3, delaysMs: [2000, 10000, 60000], isRetryable: isRetryableServiceCallError },
    ),
    /returned 400/,
  );
  assert.equal(attempt, 1, 'a deterministic error must not be retried');
});

test('exhausting all attempts rethrows the original error', async () => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    let attempt = 0;
    await assert.rejects(
      () => withBoundedRetry(
        async () => { attempt++; throw new Error('The operation was aborted due to timeout'); },
        { maxAttempts: 3, delaysMs: [2000, 10000, 60000], isRetryable: isRetryableServiceCallError },
      ),
      /aborted due to timeout/,
    );
    assert.equal(attempt, 3, 'should spend exactly the bounded number of attempts');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('maxAttempts beyond the ladder clamps to the last delay rather than 0', async () => {
  const waits = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  try {
    await assert.rejects(() => withBoundedRetry(
      async () => { throw new Error('fetch failed'); },
      { maxAttempts: 5, delaysMs: [2000, 10000], isRetryable: isRetryableServiceCallError },
    ));
    assert.deepEqual(waits, [2000, 10000, 10000, 10000],
      'running past the ladder must keep waiting, not hammer with 0ms');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
