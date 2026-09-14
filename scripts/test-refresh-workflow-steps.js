/**
 * refresh_workflow's step rebuild — the shared detail-persistence path.
 *
 * WHY THIS FILE EXISTS
 *
 * refresh_workflow used to update ONLY the `workflows` row. raw_json went
 * current while workflow_steps / _connections / _triggers / _actions kept
 * whatever the last full sync captured, and every reader of workflow_steps
 * answered from pre-edit structure with no staleness signal. Observed
 * 2026-09-14 on cca1f069-9524-4e57-8ebd-d1184704aa39: 11 cached steps against
 * 25 live, two structural revisions behind, and it produced two wrong
 * diagnostic answers in one session.
 *
 * The rebuild is a DELETE-then-INSERT, so getting the guards wrong does not
 * fail loudly — it empties a good cache. These tests therefore assert the
 * CALLS ACTUALLY MADE (and, for the refusals, that no delete was made at all),
 * not a returned summary number.
 *
 * Runs against the BUILT module — `npm test` chains the build.
 */
import { test } from 'node:test';
import assert from 'node:assert';

import {
  syncWorkflowDetailToSupabase,
  shouldRebuildWorkflowDetail,
  DEEP_WORKFLOW_SOURCE,
} from '../dist/extractor/workflow-extractor.js';

/**
 * Records every table operation in order, so a test can assert that the four
 * deletes precede every insert rather than trusting the counters.
 */
function stubClient({ errors = {} } = {}) {
  const ops = [];

  const result = (table, kind) => {
    const err = errors[`${table}.${kind}`];
    return Promise.resolve({ data: [], error: err ? { message: err } : null });
  };

  const client = {
    from(table) {
      return {
        delete() {
          return {
            eq(col, val) {
              ops.push({ table, kind: 'delete', col, val });
              return result(table, 'delete');
            },
          };
        },
        upsert(rows, opts) {
          ops.push({ table, kind: 'upsert', rows, opts });
          return result(table, 'upsert');
        },
        insert(rows) {
          ops.push({ table, kind: 'insert', rows });
          return result(table, 'insert');
        },
        select() {
          return {
            eq() {
              ops.push({ table, kind: 'select' });
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
        update() {
          return {
            eq() {
              ops.push({ table, kind: 'update' });
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };

  return { client, ops };
}

const WF_ID = 'cca1f069-9524-4e57-8ebd-d1184704aa39';

function workflowDetail(overrides = {}) {
  return {
    id: WF_ID,
    locationId: 'loc_1',
    name: 'I.LP-FAIL LP Sync Failure Handler',
    status: 'published',
    version: 29,
    steps: [
      { id: 's1', type: 'wait', delay: 90, delayUnit: 'minutes' },
      { id: 's2', type: 'if_else', condition: 'Appointment Exist' },
      { id: 's3', type: 'internal_notification' },
    ],
    triggers: [{ id: 't1', type: 'contact_tag' }],
    actions: [{ id: 's3', type: 'internal_notification', target: 'dispatch' }],
    ...overrides,
  };
}

// ---- The rebuild gate ----------------------------------------------------

test('gate refuses a shallow source — that payload has no step data to rebuild from', () => {
  const gate = shouldRebuildWorkflowDetail('highlevel_public_api_list', null);
  assert.equal(gate.rebuild, false);
  assert.equal(gate.reason, 'shallow_source_no_step_data');
});

test('gate refuses a deep source that parsed to zero steps', () => {
  const gate = shouldRebuildWorkflowDetail(DEEP_WORKFLOW_SOURCE, 0);
  assert.equal(gate.rebuild, false);
  assert.equal(gate.reason, 'parsed_zero_steps');
});

test('gate allows a deep source with parsed steps, and reports no reason', () => {
  const gate = shouldRebuildWorkflowDetail(DEEP_WORKFLOW_SOURCE, 25);
  assert.equal(gate.rebuild, true);
  assert.equal(gate.reason, null);
});

// ---- The persistence path ------------------------------------------------

test('the four deletes run first, scoped to this workflow, before any insert', async () => {
  const { client, ops } = stubClient();
  await syncWorkflowDetailToSupabase(workflowDetail(), [], { client });

  const deletes = ops.filter((o) => o.kind === 'delete');
  assert.deepEqual(
    deletes.map((d) => d.table),
    ['workflow_steps', 'workflow_connections', 'workflow_triggers', 'workflow_actions'],
    'delete order must stay as the full sync issues it',
  );
  for (const d of deletes) {
    assert.equal(d.col, 'workflow_id');
    assert.equal(d.val, WF_ID, 'a delete must never reach beyond this workflow');
  }

  const firstWrite = ops.findIndex((o) => o.kind === 'insert' || o.kind === 'upsert');
  const lastDelete = ops.map((o) => o.kind).lastIndexOf('delete');
  assert.ok(lastDelete < firstWrite, 'every delete must precede every insert');
});

test('steps are written with the composite-PK upsert from migration 011', async () => {
  const { client, ops } = stubClient();
  const counts = await syncWorkflowDetailToSupabase(workflowDetail(), [], { client });

  const stepWrite = ops.find((o) => o.table === 'workflow_steps' && o.kind === 'upsert');
  assert.ok(stepWrite, 'steps must be written');
  assert.equal(stepWrite.opts.onConflict, 'workflow_id,step_id');
  assert.equal(stepWrite.opts.ignoreDuplicates, true);
  assert.equal(stepWrite.rows.length, 3);
  assert.equal(counts.steps, 3);
  assert.deepEqual(counts.errors, []);
});

test('running the same detail twice produces the same rows — idempotent, no 23505', async () => {
  const first = stubClient();
  const a = await syncWorkflowDetailToSupabase(workflowDetail(), [], { client: first.client });
  const second = stubClient();
  const b = await syncWorkflowDetailToSupabase(workflowDetail(), [], { client: second.client });

  assert.deepEqual(a, b);
  const rowsOf = (s) => s.ops.find((o) => o.table === 'workflow_steps' && o.kind === 'upsert').rows;
  assert.deepEqual(rowsOf(first), rowsOf(second));
});

test('duplicate step ids are deduped in memory before the write', async () => {
  const { client, ops } = stubClient();
  const detail = workflowDetail({
    steps: [
      { id: 'dup', type: 'wait' },
      { id: 'dup', type: 'wait' },
      { id: 's2', type: 'if_else' },
    ],
  });
  const counts = await syncWorkflowDetailToSupabase(detail, [], { client });

  const rows = ops.find((o) => o.table === 'workflow_steps' && o.kind === 'upsert').rows;
  assert.equal(rows.length, 2);
  assert.equal(counts.steps, 2);
});

test('a failed write counts nothing and surfaces as an error string', async () => {
  const { client } = stubClient({ errors: { 'workflow_steps.upsert': 'boom' } });
  const counts = await syncWorkflowDetailToSupabase(workflowDetail(), [], { client });

  assert.equal(counts.steps, 0, 'a failed write must never be counted as synced');
  assert.equal(counts.errors.length, 1);
  assert.match(counts.errors[0], /steps insert failed: boom/);
});

test('connections fall back to sequential pairs when the graph parsed none', async () => {
  const { client, ops } = stubClient();
  const counts = await syncWorkflowDetailToSupabase(workflowDetail(), [], { client });

  const rows = ops.find((o) => o.table === 'workflow_connections' && o.kind === 'insert').rows;
  assert.deepEqual(rows.map((r) => [r.from_step, r.to_step]), [['s1', 's2'], ['s2', 's3']]);
  assert.equal(counts.connections, 2);
});

test('parsed connections win over the sequential fallback', async () => {
  const { client, ops } = stubClient();
  const parsed = [{ fromStep: 's1', toStep: 's3', condition: 'yes' }];
  await syncWorkflowDetailToSupabase(workflowDetail(), parsed, { client });

  const rows = ops.find((o) => o.table === 'workflow_connections' && o.kind === 'insert').rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_step, 's3');
  assert.equal(rows[0].condition, 'yes');
});

test('a workflow with no steps writes no rows but still issues its deletes', async () => {
  const { client, ops } = stubClient();
  const counts = await syncWorkflowDetailToSupabase(
    workflowDetail({ steps: [], triggers: [], actions: [] }),
    [],
    { client },
  );

  assert.equal(ops.filter((o) => o.kind === 'delete').length, 4);
  assert.deepEqual(
    { steps: counts.steps, triggers: counts.triggers, actions: counts.actions, connections: counts.connections },
    { steps: 0, triggers: 0, actions: 0, connections: 0 },
  );
});
