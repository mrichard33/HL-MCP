/**
 * Regression: fractional GHL waits must not fail the integer delay_minutes
 * column. A single 0.5-minute wait previously failed the whole batched step
 * upsert, dropping every step of the workflow from cache.
 *
 * Runs against the BUILT module, so `npm run build` must precede it —
 * `npm test` chains both. Importing workflow-extractor needs no env vars and
 * opens no connections: the Supabase and GHL clients are constructed lazily,
 * not at module load. (The transitive import of ghl-rate-limiter does print
 * one startup line to stdout — harmless noise in the TAP output.)
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { toDelayMinutes } from '../dist/extractor/workflow-extractor.js';

const cases = [
  // [delay, unit, expected]
  [0.5,   'minutes', 1],    // the regression
  [2.5,   'minutes', 3],
  [5,     'minutes', 5],    // integer identity
  [0.5,   'hours',   30],
  [1.5,   'hours',   90],
  [0.001, 'days',    2],    // fractional days still integral
  [1,     'days',    1440],
  [30,    'seconds', 1],
  [90,    'seconds', 2],
  [0,     'minutes', 0],
  [undefined, 'minutes', 0],
  [NaN,   'minutes', 0],
  [Infinity, 'minutes', 0],
  [7,     undefined, 7],    // no unit → assume minutes
];

test('toDelayMinutes always returns an integer', () => {
  for (const [delay, unit, expected] of cases) {
    const got = toDelayMinutes(delay, unit);
    assert.strictEqual(got, expected, `${delay} ${unit} → ${got}, expected ${expected}`);
    assert.ok(Number.isInteger(got), `${delay} ${unit} produced non-integer ${got}`);
  }
});
