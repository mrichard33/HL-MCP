/**
 * Regression: run_sql results must arrive as row arrays, and a truncated reply
 * must be refused rather than used.
 *
 * src/admin/supabase-admin.ts used to wrap every SELECT in json_agg before
 * sending, because run_sql carried the original `EXECUTE query_text INTO
 * result` body — first column of the first row, everything else dropped, and a
 * raise on any non-JSON scalar. Migration 014_run_sql_full_resultset.sql fixes
 * that server-side, so the wrap is gone.
 *
 * Two things this pins:
 *
 *  1. The refusal. 014 is applied by the Supabase branching workflow, i.e. on a
 *     different schedule from this code. Against an un-migrated instance the old
 *     body answers a multi-column SELECT with one plausible-looking scalar and
 *     every caller would quietly act on truncated data. Verified against a real
 *     Postgres 16 which values actually arrive from the pre-014 body:
 *         SELECT count(*) AS probed, 8 AS exactly_one, ...  ->  273
 *         SELECT now()                                      ->  raises
 *     Both are non-arrays, so both are caught here.
 *
 *  2. Non-SELECT replies must pass through. run_sql answers INSERT/CREATE/etc.
 *     with {status, rows_affected}; refusing that would break every write path.
 *
 * The removed wrap had a bug of its own worth remembering: it aliased the
 * subquery `t`, and Postgres binds a bare `t` to a COLUMN named t first, so
 * `SELECT now() AS ts, 'text-value' AS t, count(*) AS n FROM contacts` came back
 * as ["text-value"] — silently wrong, no error.
 *
 * Runs against the BUILT module, so `npm run build` must precede it —
 * `npm test` chains both. These two helpers are pure and open no connections.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { isSelectish, assertRowArray } from '../dist/admin/supabase-admin.js';

test('isSelectish recognises the statements whose shape we police', () => {
  assert.equal(isSelectish('SELECT 1'), true);
  assert.equal(isSelectish('  select 1'), true, 'leading whitespace tolerated');
  assert.equal(isSelectish('with t as (select 1) select * from t'), true, 'CTEs are SELECTs');
  assert.equal(isSelectish('INSERT INTO t VALUES (1)'), false);
  assert.equal(isSelectish(''), false);
});

test('a row array passes through untouched', () => {
  const rows = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
  assert.strictEqual(assertRowArray('SELECT a, b FROM t', rows), rows);
  assert.deepEqual(assertRowArray('SELECT 1 WHERE false', []), [], 'zero rows is [] and is valid');
});

test('the truncated shapes a pre-014 instance returns are REFUSED', () => {
  for (const truncated of [
    273,                              // multi-column count aggregate
    '273',                            // a text first-column
    { probed: 273, exactly_one: 8 },  // single json column — survives, still not rows
    null,                             // zero rows on the old body
  ]) {
    assert.throws(
      () => assertRowArray('SELECT count(*) AS probed, 8 AS exactly_one FROM t', truncated),
      /014_run_sql_full_resultset\.sql is NOT applied/,
      `a ${JSON.stringify(truncated)} reply to a SELECT must be refused, not used`,
    );
  }
});

test('non-SELECT replies pass through, so write paths keep working', () => {
  const status = { status: 'ok', rows_affected: 'n/a' };
  for (const q of ['INSERT INTO t VALUES (1)', 'create table if not exists t(id int)', 'UPDATE t SET x = 1']) {
    assert.deepEqual(assertRowArray(q, status), status, `non-SELECT (${q.slice(0, 12)}…) must pass through`);
  }
});
