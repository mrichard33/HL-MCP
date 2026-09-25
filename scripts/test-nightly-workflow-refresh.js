/**
 * Nightly workflow freshness refresh — selection, version stamping, modes, DST.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-09-24 sync_workflow_intelligence refreshed 266 workflows and rebuilt
 * 0 steps, so the step cache drifted between manual refresh_workflow runs and
 * audits read stale structure. The nightly job fixes that by refreshing every
 * workflow whose GHL version moved past `last_refreshed_version`.
 *
 * The dangerous failure is silent: a refresh that did NOT rebuild the steps but
 * still stamped the version would mark a stale workflow fresh forever, and
 * nothing would ever look at it again. So these tests assert the writes that
 * were actually made (or not made), not just a returned summary.
 *
 * Runs against the BUILT module — `npm test` chains the build.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  selectWorkflowsToRefresh,
  runNightlyWorkflowRefresh,
  nightlyRefreshMode,
  readStepCounts,
  getWorkflowFreshness,
  NIGHTLY_REFRESH_SCHEDULE,
} from '../dist/extractor/workflow-nightly-refresh.js';
import { refreshSingleWorkflow } from '../dist/extractor/workflow-refresh.js';

// ---- Stubs ----------------------------------------------------------------

/**
 * A chainable Supabase stand-in. Every builder method returns the builder;
 * awaiting it records the finished op and asks `respond` for the result.
 */
function stubSupabase(respond = () => ({ data: [], error: null })) {
  const ops = [];
  const client = {
    from(table) {
      const op = { table, kind: null, payload: null, filters: [], range: null };
      const builder = {
        select(cols) { if (!op.kind) op.kind = 'select'; op.cols = cols; return builder; },
        insert(rows) { op.kind = 'insert'; op.payload = rows; return builder; },
        upsert(rows, opts) { op.kind = 'upsert'; op.payload = rows; op.opts = opts; return builder; },
        update(patch) { op.kind = 'update'; op.payload = patch; return builder; },
        delete() { op.kind = 'delete'; return builder; },
        eq(col, val) { op.filters.push(['eq', col, val]); return builder; },
        in(col, val) { op.filters.push(['in', col, val]); return builder; },
        is(col, val) { op.filters.push(['is', col, val]); return builder; },
        not() { return builder; },
        order() { return builder; },
        limit() { return builder; },
        range(from, to) { op.range = [from, to]; return builder; },
        single() { op.single = true; return builder; },
        maybeSingle() { op.single = true; return builder; },
        then(resolve, reject) {
          ops.push(op);
          try {
            return Promise.resolve(respond(op)).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  };
  return { client, ops };
}

const noSleep = async () => {};

function wf(id, version, name = `WF ${id}`) {
  return { id, name, status: 'published', version };
}

/** Responds to the reads the nightly run makes; everything else succeeds empty. */
function nightlyResponder({ cacheRows = [], registry = [], cacheError = null } = {}) {
  return (op) => {
    if (op.table === 'sync_log' && op.kind === 'insert') return { data: { id: 'log_1' }, error: null };
    if (op.table === 'workflows' && op.kind === 'select') {
      return cacheError ? { data: null, error: { message: cacheError } } : { data: cacheRows, error: null };
    }
    if (op.table === 'workflow_registry') return { data: registry, error: null };
    return { data: [], error: null };
  };
}

function okOutcome() {
  return { steps_rebuilt: true, steps_rebuilt_reason: null, detail_errors: [], version_recorded: true, version_record_error: null };
}

function baseDeps(overrides = {}) {
  return {
    mode: 'shadow',
    sleep: noSleep,
    delayMs: 0,
    exporter: null,
    acquireLock: () => true,
    releaseLock: () => {},
    readStepCounts: async () => new Map(),
    ...overrides,
  };
}

// ---- Selection (pure) -----------------------------------------------------

test('unchanged version with cached steps → skipped', () => {
  const { toRefresh, unchanged } = selectWorkflowsToRefresh(
    [wf('a', 5)],
    [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
    new Map([['a', 12]]),
  );
  assert.equal(toRefresh.length, 0);
  assert.equal(unchanged, 1);
});

test('changed version → selected as version_changed', () => {
  const { toRefresh } = selectWorkflowsToRefresh(
    [wf('a', 6)],
    [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
    new Map([['a', 12]]),
  );
  assert.deepEqual(toRefresh.map((c) => [c.workflowId, c.reason]), [['a', 'version_changed']]);
});

test('never refreshed (NULL or no cache row) → selected', () => {
  const { toRefresh } = selectWorkflowsToRefresh(
    [wf('a', 5), wf('b', 1)],
    [{ ghl_workflow_id: 'a', last_refreshed_version: null }],
    new Map(),
  );
  assert.deepEqual(toRefresh.map((c) => c.reason), ['never_refreshed', 'never_refreshed']);
});

test('zero-step cache → selected even when the version matches', () => {
  const { toRefresh } = selectWorkflowsToRefresh(
    [wf('a', 5)],
    [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
    new Map([['a', 0]]),
  );
  assert.deepEqual(toRefresh.map((c) => c.reason), ['zero_steps']);
});

test('unknown step count is not zero — a failed count read does not trigger a refresh by itself', () => {
  const { toRefresh } = selectWorkflowsToRefresh(
    [wf('a', 5)],
    [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
    null,
  );
  assert.equal(toRefresh.length, 0);
});

test('a list entry with no version cannot be proven current → refreshed', () => {
  const { toRefresh } = selectWorkflowsToRefresh(
    [{ id: 'a', name: 'A', status: 'published' }],
    [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
    new Map([['a', 3]]),
  );
  assert.deepEqual(toRefresh.map((c) => c.reason), ['version_changed']);
});

// ---- The run --------------------------------------------------------------

test('run: only changed workflows are refreshed, sequentially with the delay between them', async () => {
  const { client } = stubSupabase(nightlyResponder({
    cacheRows: [
      { ghl_workflow_id: 'a', last_refreshed_version: 5 },
      { ghl_workflow_id: 'b', last_refreshed_version: 2 },
      { ghl_workflow_id: 'c', last_refreshed_version: 9 },
    ],
  }));
  const refreshed = [];
  const sleeps = [];
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 5), wf('b', 3), wf('c', 10)] },
    readStepCounts: async () => new Map([['a', 4], ['b', 4], ['c', 4]]),
    refresh: async (id) => { refreshed.push(id); return okOutcome(); },
    sleep: async (ms) => { sleeps.push(ms); },
    delayMs: 2000,
  }));
  assert.deepEqual(refreshed, ['b', 'c']);
  assert.deepEqual(sleeps, [2000], 'one gap between two refreshes, none before the first');
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, 2);
  assert.equal(result.unchanged, 1);
});

test('run: a workflow in workflows but absent from workflow_steps counts as zero steps', async () => {
  const { client } = stubSupabase(nightlyResponder({
    cacheRows: [{ ghl_workflow_id: 'a', last_refreshed_version: 5 }],
  }));
  const refreshed = [];
  await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 5)] },
    readStepCounts: async () => new Map(), // no rows at all for 'a'
    refresh: async (id) => { refreshed.push(id); return okOutcome(); },
  }));
  assert.deepEqual(refreshed, ['a']);
});

test('run: failed refreshes are recorded, never counted, and the loop carries on', async () => {
  const { client, ops } = stubSupabase(nightlyResponder({
    cacheRows: [
      { ghl_workflow_id: 'a', last_refreshed_version: 1 },
      { ghl_workflow_id: 'b', last_refreshed_version: 1 },
      { ghl_workflow_id: 'c', last_refreshed_version: 1 },
    ],
  }));
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 2), wf('b', 2), wf('c', 2)] },
    refresh: async (id) => {
      if (id === 'a') return { ...okOutcome(), steps_rebuilt: false, steps_rebuilt_reason: 'shallow_source_no_step_data', version_recorded: false };
      if (id === 'b') throw new Error('internal API 502');
      return okOutcome();
    },
  }));
  assert.equal(result.refreshed, 1);
  assert.deepEqual(result.refreshed_ids, ['c']);
  assert.deepEqual(result.failures.map((f) => f.workflow_id), ['a', 'b']);
  assert.match(result.failures[0].error, /steps not rebuilt/);
  assert.match(result.failures[1].error, /internal API 502/);
  assert.equal(result.ok, true, 'a partial failure is still a completed night');

  const logUpdate = ops.find((o) => o.table === 'sync_log' && o.kind === 'update');
  assert.equal(logUpdate.payload.status, 'completed');
  assert.equal(JSON.parse(logUpdate.payload.error_message).failure_count, 2);
});

test('run: every attempted refresh failing marks the run failed', async () => {
  const { client, ops } = stubSupabase(nightlyResponder({
    cacheRows: [{ ghl_workflow_id: 'a', last_refreshed_version: 1 }],
  }));
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 2)] },
    refresh: async () => { throw new Error('Firebase auth expired'); },
  }));
  assert.equal(result.ok, false);
  assert.equal(ops.find((o) => o.table === 'sync_log' && o.kind === 'update').payload.status, 'failed');
});

test('run: a missing last_refreshed_version column fails the run instead of refreshing blind', async () => {
  const { client } = stubSupabase(nightlyResponder({ cacheError: 'column workflows.last_refreshed_version does not exist' }));
  let called = false;
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 2)] },
    refresh: async () => { called = true; return okOutcome(); },
  }));
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.match(result.error, /018_workflow_last_refreshed_version/);
});

test('run: waits for the bulk sync lock, and always releases it', async () => {
  const { client } = stubSupabase(nightlyResponder({ cacheRows: [] }));
  let attempts = 0;
  let released = 0;
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => [] },
    acquireLock: () => ++attempts >= 3,
    releaseLock: () => { released++; },
    lockWaitMs: 60_000,
    lockPollMs: 1,
  }));
  assert.equal(result.ok, true);
  assert.equal(attempts, 3);
  assert.equal(released, 1);
});

test('run: gives up (and records a failed run) when the lock never frees', async () => {
  const { client, ops } = stubSupabase(nightlyResponder({ cacheRows: [] }));
  let released = 0;
  let listed = false;
  const result = await runNightlyWorkflowRefresh(baseDeps({
    supabase: client,
    ghl: { getWorkflows: async () => { listed = true; return []; } },
    acquireLock: () => false,
    releaseLock: () => { released++; },
    lockWaitMs: 0,
  }));
  assert.equal(result.ok, false);
  assert.equal(listed, false);
  assert.equal(released, 0, 'never release a lock we did not take');
  assert.equal(ops.find((o) => o.table === 'sync_log' && o.kind === 'update').payload.status, 'failed');
});

// ---- Modes and the export hook ---------------------------------------------

test('mode: default and unrecognised values read as shadow', () => {
  assert.equal(nightlyRefreshMode({}), 'shadow');
  assert.equal(nightlyRefreshMode({ WORKFLOW_NIGHTLY_REFRESH_MODE: 'LIVE ' }), 'live');
  assert.equal(nightlyRefreshMode({ WORKFLOW_NIGHTLY_REFRESH_MODE: 'off' }), 'off');
  assert.equal(nightlyRefreshMode({ WORKFLOW_NIGHTLY_REFRESH_MODE: 'enforce' }), 'shadow');
});

function exportScenario(mode, exporter, { versions = [2, 2] } = {}) {
  const { client } = stubSupabase(nightlyResponder({
    cacheRows: [
      { ghl_workflow_id: 'a', last_refreshed_version: 1 },
      { ghl_workflow_id: 'b', last_refreshed_version: 1 },
    ],
    registry: [{ workflow_id: 'a', canonical_code: 'A.WE-1' }],
  }));
  return runNightlyWorkflowRefresh(baseDeps({
    mode,
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', versions[0]), wf('b', versions[1])] },
    readStepCounts: async () => new Map([['a', 3], ['b', 3]]),
    refresh: async () => okOutcome(),
    exporter,
  }));
}

test('shadow: refreshes but never calls the exporter', async () => {
  let calls = 0;
  const result = await exportScenario('shadow', async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(result.refreshed, 2);
  assert.equal(result.export.status, 'skipped_shadow');
  assert.deepEqual(result.changed_codes, ['A.WE-1']);
});

test('live: exports the changed canonical codes with dry_run false; unregistered ids are listed', async () => {
  const calls = [];
  const result = await exportScenario('live', async (req) => { calls.push(req); return { pr: 1 }; });
  assert.deepEqual(calls, [{ codes: ['A.WE-1'], dry_run: false }]);
  assert.equal(result.export.status, 'exported');
  assert.deepEqual(result.unregistered_ids, ['b']);
});

test('live: no changes → no export', async () => {
  let calls = 0;
  const result = await exportScenario('live', async () => { calls++; }, { versions: [1, 1] });
  assert.equal(calls, 0);
  assert.equal(result.attempted, 0);
  assert.equal(result.export.status, 'no_changes');
});

test('live: with no exporter installed the night reports not_installed and the codes it would send', async () => {
  const result = await exportScenario('live', null);
  assert.deepEqual(result.export, { status: 'not_installed', codes: ['A.WE-1'] });
  assert.equal(result.ok, true);
});

test('live: a never-refreshed workflow is not exported — the first night proves nothing changed', async () => {
  const { client } = stubSupabase(nightlyResponder({
    cacheRows: [{ ghl_workflow_id: 'a', last_refreshed_version: null }],
    registry: [{ workflow_id: 'a', canonical_code: 'A.WE-1' }],
  }));
  let calls = 0;
  const result = await runNightlyWorkflowRefresh(baseDeps({
    mode: 'live',
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 7)] },
    refresh: async () => okOutcome(),
    exporter: async () => { calls++; },
  }));
  assert.equal(result.refreshed, 1);
  assert.equal(calls, 0);
});

test('off: does nothing at all', async () => {
  const { client, ops } = stubSupabase();
  const result = await runNightlyWorkflowRefresh(baseDeps({ mode: 'off', supabase: client }));
  assert.equal(result.ok, true);
  assert.equal(ops.length, 0);
});

// ---- refreshSingleWorkflow stamps the version only on a clean rebuild -----

function deepGhl(version, steps) {
  return {
    getWorkflowDetail: async (id) => ({ id, name: 'A.WE-1', status: 'published', version, locationId: 'loc_1', steps }),
    getWorkflow: async () => ({}),
    getWorkflowTriggers: async () => [],
    getWorkflows: async () => [],
    getLocationId: () => 'loc_1',
  };
}

test('refreshSingleWorkflow: a clean deep rebuild stamps last_refreshed_version with the live version', async () => {
  const { client, ops } = stubSupabase();
  const r = await refreshSingleWorkflow('wf_1', {
    ghl: deepGhl(169, [{ id: 's1', type: 'sms' }, { id: 's2', type: 'wait', delay: 1, delayUnit: 'days' }]),
    supabase: client,
  });
  assert.equal(r.steps_rebuilt, true);
  assert.equal(r.version_recorded, true);
  const stamp = ops.find((o) => o.table === 'workflows' && o.kind === 'update' && o.payload && 'last_refreshed_version' in o.payload);
  assert.deepEqual(stamp.payload, { last_refreshed_version: 169 });
  assert.deepEqual(stamp.filters, [['eq', 'ghl_workflow_id', 'wf_1']]);
});

test('refreshSingleWorkflow: the shallow fallback never stamps the version', async () => {
  const { client, ops } = stubSupabase();
  const ghl = { ...deepGhl(4, []), getWorkflowDetail: async () => null };
  const r = await refreshSingleWorkflow('wf_1', { ghl, supabase: client, listEntry: wf('wf_1', 4) });
  assert.equal(r.steps_rebuilt, false);
  assert.equal(r.version_recorded, false);
  assert.equal(ops.some((o) => o.payload && 'last_refreshed_version' in o.payload), false);
});

test('refreshSingleWorkflow: a rebuild with write errors does not stamp the version', async () => {
  const { client, ops } = stubSupabase((op) => (
    op.table === 'workflow_steps' && op.kind === 'upsert'
      ? { data: null, error: { message: 'insert failed' } }
      : { data: [], error: null }
  ));
  const r = await refreshSingleWorkflow('wf_1', { ghl: deepGhl(9, [{ id: 's1', type: 'sms' }]), supabase: client });
  assert.equal(r.steps_rebuilt, true);
  assert.ok(r.detail_errors.length > 0);
  assert.equal(r.version_recorded, false);
  assert.equal(ops.some((o) => o.payload && 'last_refreshed_version' in o.payload), false);
});

// ---- Reads ------------------------------------------------------------------

test('readStepCounts pages through workflow_steps and returns null on a read error', async () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ workflow_id: 'a' })),
    ...Array.from({ length: 2 }, () => ({ workflow_id: 'b' })),
  ];
  const { client } = stubSupabase((op) => ({ data: rows.slice(op.range[0], op.range[1] + 1), error: null }));
  const counts = await readStepCounts(client, 2);
  assert.deepEqual([...counts.entries()], [['a', 3], ['b', 2]]);

  const { client: bad } = stubSupabase(() => ({ data: null, error: { message: 'boom' } }));
  assert.equal(await readStepCounts(bad), null);
});

test('get_workflow_freshness: counts stale against the live version and reads back the last run', async () => {
  const { client } = stubSupabase((op) => {
    if (op.table === 'workflows') {
      return {
        data: [
          { ghl_workflow_id: 'a', name: 'A', version: 5, last_refreshed_version: 5 },
          { ghl_workflow_id: 'b', name: 'B', version: 3, last_refreshed_version: 3 },
          { ghl_workflow_id: 'c', name: 'C', version: 1, last_refreshed_version: null },
        ],
        error: null,
      };
    }
    if (op.table === 'sync_log') {
      return {
        data: [{ status: 'completed', started_at: 't0', completed_at: 't1', records_synced: 4, error_message: '{"failure_count":1}' }],
        error: null,
      };
    }
    return { data: [], error: null };
  });
  const out = await getWorkflowFreshness({
    supabase: client,
    ghl: { getWorkflows: async () => [wf('a', 5), wf('b', 4, 'B'), wf('c', 1, 'C')] },
    readStepCounts: async () => new Map([['a', 2], ['b', 2]]),
  });
  assert.equal(out.version_source, 'ghl_live');
  assert.equal(out.stale_count, 2);
  assert.equal(out.never_refreshed_count, 1);
  assert.equal(out.zero_step_count, 1);
  assert.deepEqual(out.last_run.summary, { failure_count: 1 });
});

// ---- DST: 2:30 AM ET all year ----------------------------------------------

/**
 * Checks the schedule against node-cron's OWN matcher, not a re-implementation
 * of it, because what matters is what the library will actually do. The
 * matcher is internal to node-cron (not in its exports map), so it is loaded
 * by path. If an upgrade moves it, this test fails loudly — re-verify DST then.
 */
function nodeCronMatcher() {
  const require = createRequire(import.meta.url);
  // The CJS entry is dist/cjs/node-cron.js; the matcher sits beside it.
  const cjsDir = path.dirname(require.resolve('node-cron'));
  const { TimeMatcher } = require(path.join(cjsDir, 'time/time-matcher.js'));
  // node-cron expands 5-field expressions with a leading seconds field of 0.
  return new TimeMatcher(`0 ${NIGHTLY_REFRESH_SCHEDULE.expression}`, NIGHTLY_REFRESH_SCHEDULE.timezone);
}

test('schedule is 2:30 AM America/New_York', () => {
  assert.equal(NIGHTLY_REFRESH_SCHEDULE.expression, '30 2 * * *');
  assert.equal(NIGHTLY_REFRESH_SCHEDULE.timezone, 'America/New_York');
});

test('DST: fires at 07:30Z in EST and 06:30Z in EDT, never at the wrong offset', () => {
  const m = nodeCronMatcher();
  // Winter (EST, UTC-5)
  assert.equal(m.match(new Date('2026-01-15T07:30:00Z')), true);
  assert.equal(m.match(new Date('2026-01-15T06:30:00Z')), false);
  // Summer (EDT, UTC-4)
  assert.equal(m.match(new Date('2026-07-15T06:30:00Z')), true);
  assert.equal(m.match(new Date('2026-07-15T07:30:00Z')), false);
});

test('DST: spring forward (2026-03-08) — 2:30 does not exist, so that one night has no run; the nights around it do', () => {
  const m = nodeCronMatcher();
  assert.equal(m.match(new Date('2026-03-07T07:30:00Z')), true, 'Mar 7, still EST');
  assert.equal(m.match(new Date('2026-03-08T06:30:00Z')), false, '01:30 EST');
  assert.equal(m.match(new Date('2026-03-08T07:30:00Z')), false, '03:30 EDT');
  assert.equal(m.match(new Date('2026-03-09T06:30:00Z')), true, 'Mar 9, now EDT');
});

test('DST: fall back (2026-11-01) — 2:30 happens exactly once', () => {
  const m = nodeCronMatcher();
  assert.equal(m.match(new Date('2026-10-31T06:30:00Z')), true, 'Oct 31, still EDT');
  assert.equal(m.match(new Date('2026-11-01T06:30:00Z')), false, '01:30 EST, the repeated hour');
  assert.equal(m.match(new Date('2026-11-01T07:30:00Z')), true, '02:30 EST');
  assert.equal(m.match(new Date('2026-11-02T07:30:00Z')), true, 'Nov 2, EST');
});
