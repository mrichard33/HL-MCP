/**
 * src/extractor/workflow-nightly-refresh.ts
 *
 * Nightly workflow freshness job: keep workflow_steps / _actions /
 * _connections / _triggers matching live GHL without anyone running
 * refresh_workflow by hand.
 *
 * WHY THIS EXISTS (2026-09-25)
 * ────────────────────────────
 * On 2026-09-24 sync_workflow_intelligence refreshed 266 workflows and rebuilt
 * 0 steps. Only refresh_workflow was verified to rebuild step rows from the
 * internal API (A.WE-1 → version 169, 231 steps). So the step cache drifted
 * between manual refreshes, and every audit that read it answered from
 * whatever structure was cached last — with nothing saying it was stale.
 *
 * WHAT IT DOES
 * ────────────
 * At 2:30 AM ET it pulls the GHL workflow list (the same call the bulk sync
 * makes), compares each workflow's live `version` against
 * `workflows.last_refreshed_version`, and runs the single-workflow refresh
 * (workflow-refresh.ts) on every workflow that moved, was never refreshed, or
 * has zero cached steps. One at a time, ~2s apart. A refresh that did not
 * really rebuild the steps leaves the stored version alone, so the next night
 * tries again.
 *
 * MODES — WORKFLOW_NIGHTLY_REFRESH_MODE
 *   shadow (default) — refresh the cache; skip the GitHub export.
 *   live             — refresh, then hand the changed workflows' canonical
 *                      codes to the GitHub exporter.
 *   off              — do nothing.
 * Anything else reads as `shadow`. A typo must not silently turn on an export
 * that opens pull requests, and must not silently switch the refresh off.
 *
 * THE EXPORT IS A HOOK, NOT A CALL (2026-09-25)
 * ─────────────────────────────────────────────
 * The handoff builds on `export_workflows_to_github`, which does not exist yet.
 * Rather than guess its design, the job calls whatever `setWorkflowExporter()`
 * installed. With nothing installed, a live night reports
 * `export.status = 'not_installed'` with the codes it would have sent. The
 * export tool plugs in with one setWorkflowExporter() call.
 */

import { GHLClient } from '../clients/ghl.js';
import { getSupabaseClient } from '../clients/supabase.js';
import { nowET } from '../utils/timezone.js';
import type { GHLWorkflow } from '../types/ghl.js';
import { tryAcquireWorkflowSyncLock, releaseWorkflowSyncLock } from './workflow-extractor.js';
import { refreshSingleWorkflow } from './workflow-refresh.js';

type SupabaseLike = { from: (table: string) => any };

export const NIGHTLY_REFRESH_JOB = 'workflow_nightly_refresh';

/**
 * 2:30 AM America/New_York, every day. node-cron matches the wall clock in the
 * named zone, so this stays 2:30 local across EST and EDT.
 *
 * DST, measured against node-cron 4.2.1 (see the test):
 *   - Fall back (first Sunday of Nov): only 1:00–1:59 repeats, so 2:30 happens
 *     once. One run.
 *   - Spring forward (second Sunday of Mar): 2:00–2:59 does not exist that
 *     night, so there is NO run. That is harmless: the version compare is
 *     cumulative, so the next night picks up everything the skipped one would
 *     have. Moving to 3:30 would avoid it, but would put the nightly pass on
 *     top of the 3:05/3:10 full contact and opportunity reconciles.
 */
export const NIGHTLY_REFRESH_SCHEDULE = {
  expression: '30 2 * * *',
  timezone: 'America/New_York',
} as const;

// ---- Mode ----

export type NightlyRefreshMode = 'off' | 'shadow' | 'live';

export function nightlyRefreshMode(env: Record<string, string | undefined> = process.env): NightlyRefreshMode {
  const raw = (env.WORKFLOW_NIGHTLY_REFRESH_MODE || '').trim().toLowerCase();
  if (raw === 'live' || raw === 'off' || raw === 'shadow') return raw;
  return 'shadow';
}

function refreshDelayMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = parseInt(env.WORKFLOW_NIGHTLY_REFRESH_DELAY_MS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

// ---- Exporter hook ----

export interface WorkflowExportRequest {
  codes: string[];
  dry_run: boolean;
}
export type WorkflowExporter = (req: WorkflowExportRequest) => Promise<unknown>;

let installedExporter: WorkflowExporter | null = null;

/** Install (or with null, remove) the GitHub exporter the live mode calls. */
export function setWorkflowExporter(fn: WorkflowExporter | null): void {
  installedExporter = fn;
}

// ---- Selection (pure) ----

export type RefreshReason = 'never_refreshed' | 'version_changed' | 'zero_steps';

export interface RefreshCandidate {
  workflowId: string;
  name: string;
  liveVersion: number | null;
  storedVersion: number | null;
  reason: RefreshReason;
  listEntry: GHLWorkflow;
}

export interface CacheVersionRow {
  ghl_workflow_id: string;
  last_refreshed_version: number | null;
}

/**
 * Decide which workflows need a refresh tonight.
 *
 * `stepCounts` may be null (the read failed) or miss a workflow. Either way
 * that workflow's step count is UNKNOWN, and unknown is not zero: it does not
 * trigger a refresh on its own. The version compare still applies, so a
 * failed count read can never hide a real version change — it only loses the
 * zero-step backstop for one night.
 */
export function selectWorkflowsToRefresh(
  liveList: GHLWorkflow[],
  cacheRows: CacheVersionRow[],
  stepCounts: Map<string, number> | null,
): { toRefresh: RefreshCandidate[]; unchanged: number } {
  const stored = new Map<string, number | null>();
  for (const row of cacheRows) stored.set(row.ghl_workflow_id, row.last_refreshed_version ?? null);

  const toRefresh: RefreshCandidate[] = [];
  let unchanged = 0;

  for (const wf of liveList) {
    if (!wf || !wf.id) continue;
    const liveVersion = typeof wf.version === 'number' ? wf.version : null;
    const storedVersion = stored.has(wf.id) ? stored.get(wf.id)! : null;

    let reason: RefreshReason | null = null;
    if (storedVersion === null) {
      reason = 'never_refreshed';
    } else if (liveVersion === null || liveVersion !== storedVersion) {
      // A list entry with no version cannot be proven current — refresh it.
      reason = 'version_changed';
    } else if (stepCounts && stepCounts.get(wf.id) === 0) {
      reason = 'zero_steps';
    }

    if (reason) {
      toRefresh.push({
        workflowId: wf.id,
        name: wf.name || 'Unknown',
        liveVersion,
        storedVersion,
        reason,
        listEntry: wf,
      });
    } else {
      unchanged++;
    }
  }

  return { toRefresh, unchanged };
}

// ---- Reads ----

/**
 * Cached step count per workflow, from one paged read of workflow_steps.
 * Workflows with no rows are absent from the map; the caller sets them to 0
 * for every workflow it knows is cached. Returns null on any read error —
 * see selectWorkflowsToRefresh for why that is not treated as zero.
 */
export async function readStepCounts(supabase: SupabaseLike, pageSize = 1000): Promise<Map<string, number> | null> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('workflow_steps')
      .select('workflow_id')
      .order('workflow_id', { ascending: true })
      .order('step_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      console.warn(`[NightlyRefresh] workflow_steps count read failed: ${error.message}`);
      return null;
    }
    const rows = (data || []) as Array<{ workflow_id: string }>;
    for (const r of rows) counts.set(r.workflow_id, (counts.get(r.workflow_id) || 0) + 1);
    if (rows.length < pageSize) return counts;
  }
}

async function readCacheVersions(supabase: SupabaseLike): Promise<CacheVersionRow[]> {
  const { data, error } = await supabase
    .from('workflows')
    .select('ghl_workflow_id, last_refreshed_version');
  if (error) {
    throw new Error(
      `workflows.last_refreshed_version read failed: ${error.message}. ` +
      `If the column is missing, apply supabase/migrations/018_workflow_last_refreshed_version.sql.`,
    );
  }
  return (data || []) as CacheVersionRow[];
}

// ---- The run ----

export interface RefreshFailure {
  workflow_id: string;
  name: string;
  reason: RefreshReason;
  error: string;
}

export interface NightlyRefreshResult {
  ok: boolean;
  mode: NightlyRefreshMode;
  started_at: string;
  finished_at: string;
  checked: number;
  unchanged: number;
  attempted: number;
  refreshed: number;
  failures: RefreshFailure[];
  refreshed_ids: string[];
  changed_codes: string[];
  unregistered_ids: string[];
  export: { status: string; codes?: string[]; error?: string; result?: unknown };
  error?: string;
}

/** The slice of refreshSingleWorkflow's result the job acts on. */
export interface RefreshOutcome {
  steps_rebuilt: boolean;
  steps_rebuilt_reason: string | null;
  detail_errors: string[];
  version_recorded: boolean;
  version_record_error: string | null;
}

export interface NightlyRefreshDeps {
  mode?: NightlyRefreshMode;
  ghl?: { getWorkflows: () => Promise<GHLWorkflow[]> };
  supabase?: SupabaseLike;
  refresh?: (workflowId: string, listEntry: GHLWorkflow) => Promise<RefreshOutcome>;
  readStepCounts?: (supabase: SupabaseLike) => Promise<Map<string, number> | null>;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  /** undefined → the installed exporter; null → none. */
  exporter?: WorkflowExporter | null;
  acquireLock?: () => boolean;
  releaseLock?: () => void;
  /** How long to wait for a running bulk workflow sync to release the lock. */
  lockWaitMs?: number;
  lockPollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Why a refresh does not count as a success, or null when it does. */
function refreshFailureReason(r: RefreshOutcome): string | null {
  if (!r.steps_rebuilt) return `steps not rebuilt (${r.steps_rebuilt_reason || 'unknown reason'})`;
  if (r.detail_errors.length > 0) return `step rows written with errors: ${r.detail_errors.slice(0, 3).join('; ')}`;
  if (!r.version_recorded) return `last_refreshed_version not written: ${r.version_record_error || 'unknown reason'}`;
  return null;
}

export async function runNightlyWorkflowRefresh(deps: NightlyRefreshDeps = {}): Promise<NightlyRefreshResult> {
  const mode = deps.mode ?? nightlyRefreshMode();
  const started_at = nowET();
  const result: NightlyRefreshResult = {
    ok: false,
    mode,
    started_at,
    finished_at: started_at,
    checked: 0,
    unchanged: 0,
    attempted: 0,
    refreshed: 0,
    failures: [],
    refreshed_ids: [],
    changed_codes: [],
    unregistered_ids: [],
    export: { status: mode === 'live' ? 'no_changes' : 'skipped_shadow' },
  };

  if (mode === 'off') {
    result.ok = true;
    result.export = { status: 'skipped_off' };
    console.log('[NightlyRefresh] WORKFLOW_NIGHTLY_REFRESH_MODE=off — not running');
    return result;
  }

  const supabase = deps.supabase ?? getSupabaseClient();
  const ghl = deps.ghl ?? new GHLClient();
  const refresh = deps.refresh ?? ((id: string, listEntry: GHLWorkflow) => refreshSingleWorkflow(id, {
    listEntry,
    supabase,
    ghl: ghl instanceof GHLClient ? ghl : undefined,
  }));
  const readCounts = deps.readStepCounts ?? readStepCounts;
  const sleep = deps.sleep ?? defaultSleep;
  const delayMs = deps.delayMs ?? refreshDelayMs();
  const exporter = deps.exporter === undefined ? installedExporter : deps.exporter;
  const acquireLock = deps.acquireLock ?? tryAcquireWorkflowSyncLock;
  const releaseLock = deps.releaseLock ?? releaseWorkflowSyncLock;
  const lockWaitMs = deps.lockWaitMs ?? 30 * 60 * 1000;
  const lockPollMs = deps.lockPollMs ?? 30 * 1000;

  // The run record. get_workflow_freshness reads the latest one of these.
  let syncLogId: string | null = null;
  try {
    const { data } = await supabase.from('sync_log').insert({
      entity_type: NIGHTLY_REFRESH_JOB,
      sync_type: 'nightly',
      status: 'running',
    }).select().single();
    syncLogId = (data?.id as string) ?? null;
  } catch (err) {
    console.warn(`[NightlyRefresh] sync_log insert failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  let haveLock = false;
  try {
    // Wait out a running bulk sync rather than skip the night: the bulk sync
    // runs hourly, this job once a day.
    const waitUntil = Date.now() + lockWaitMs;
    haveLock = acquireLock();
    while (!haveLock && Date.now() < waitUntil) {
      await sleep(lockPollMs);
      haveLock = acquireLock();
    }
    if (!haveLock) {
      throw new Error(`the bulk workflow sync held the lock for ${Math.round(lockWaitMs / 60000)} min — nightly refresh did not run`);
    }

    const liveList = await ghl.getWorkflows();
    result.checked = liveList.length;

    const cacheRows = await readCacheVersions(supabase);
    const counted = await readCounts(supabase);
    let stepCounts: Map<string, number> | null = null;
    if (counted) {
      // A workflow cached in `workflows` but absent from workflow_steps has
      // zero steps — that absence is exactly the case to catch.
      stepCounts = new Map(counted);
      for (const row of cacheRows) {
        if (!stepCounts.has(row.ghl_workflow_id)) stepCounts.set(row.ghl_workflow_id, 0);
      }
    }

    const { toRefresh, unchanged } = selectWorkflowsToRefresh(liveList, cacheRows, stepCounts);
    result.unchanged = unchanged;
    console.log(
      `[NightlyRefresh] mode=${mode}: ${liveList.length} live workflows, ${toRefresh.length} to refresh, ${unchanged} unchanged`,
    );

    const versionChangedIds: string[] = [];
    for (let i = 0; i < toRefresh.length; i++) {
      const c = toRefresh[i];
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      result.attempted++;
      try {
        const outcome = await refresh(c.workflowId, c.listEntry);
        const failure = refreshFailureReason(outcome);
        if (failure) {
          result.failures.push({ workflow_id: c.workflowId, name: c.name, reason: c.reason, error: failure });
          console.warn(`[NightlyRefresh] ${c.name} (${c.workflowId}): ${failure}`);
          continue;
        }
        result.refreshed++;
        result.refreshed_ids.push(c.workflowId);
        // Only a version that MOVED is a content change worth exporting. A
        // never-refreshed workflow (every workflow, on the first night) or a
        // zero-step backfill proves nothing changed in GHL.
        if (c.reason === 'version_changed') versionChangedIds.push(c.workflowId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.failures.push({ workflow_id: c.workflowId, name: c.name, reason: c.reason, error: msg });
        console.warn(`[NightlyRefresh] ${c.name} (${c.workflowId}) threw: ${msg}`);
      }
    }

    if (versionChangedIds.length > 0) {
      const { codes, unregistered } = await lookupCanonicalCodes(supabase, versionChangedIds);
      result.changed_codes = codes;
      result.unregistered_ids = unregistered;

      if (mode === 'live') {
        result.export = await runExport(exporter, codes);
      } else {
        result.export = { status: 'skipped_shadow', codes };
      }
    }

    // Partial failure is still a completed night: the failures are listed and
    // retried tomorrow. Only a night where EVERY attempted refresh failed
    // counts as a failed run — that is a broken refresh path, not bad luck.
    result.ok = !(result.attempted > 0 && result.refreshed === 0);
    if (!result.ok) result.error = `all ${result.attempted} attempted refreshes failed`;
  } catch (err) {
    result.ok = false;
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[NightlyRefresh] run failed: ${result.error}`);
  } finally {
    if (haveLock) releaseLock();
  }

  result.finished_at = nowET();
  console.log(
    `[NightlyRefresh] done: ${result.refreshed}/${result.attempted} refreshed, ` +
    `${result.failures.length} failed, export=${result.export.status}`,
  );

  if (syncLogId) {
    try {
      await supabase.from('sync_log').update({
        status: result.ok ? 'completed' : 'failed',
        records_synced: result.refreshed,
        error_message: summarizeForLog(result),
        completed_at: result.finished_at,
      // No `.eq('status','running')` guard, unlike the entity syncers. The
      // first night runs longer than the sync reaper's 30-min cutoff, so the
      // reaper will already have marked this row 'failed'. This process owns
      // the row and knows how the night really ended; the reaper only guessed.
      }).eq('id', syncLogId);
    } catch (err) {
      console.warn(`[NightlyRefresh] sync_log update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

async function lookupCanonicalCodes(
  supabase: SupabaseLike,
  workflowIds: string[],
): Promise<{ codes: string[]; unregistered: string[] }> {
  const { data, error } = await supabase
    .from('workflow_registry')
    .select('workflow_id, canonical_code')
    .in('workflow_id', workflowIds);
  if (error) {
    console.warn(`[NightlyRefresh] workflow_registry read failed: ${error.message}`);
    return { codes: [], unregistered: [...workflowIds] };
  }
  const byId = new Map<string, string>();
  for (const r of (data || []) as Array<{ workflow_id: string; canonical_code: string | null }>) {
    if (r.canonical_code) byId.set(r.workflow_id, r.canonical_code);
  }
  const codes: string[] = [];
  const unregistered: string[] = [];
  for (const id of workflowIds) {
    const code = byId.get(id);
    if (code) codes.push(code);
    else unregistered.push(id);
  }
  return { codes: [...new Set(codes)].sort(), unregistered };
}

async function runExport(
  exporter: WorkflowExporter | null,
  codes: string[],
): Promise<NightlyRefreshResult['export']> {
  if (codes.length === 0) return { status: 'no_registered_codes', codes };
  if (!exporter) {
    console.warn(`[NightlyRefresh] export tool not installed — would have exported: ${codes.join(', ')}`);
    return { status: 'not_installed', codes };
  }
  try {
    const out = await exporter({ codes, dry_run: false });
    return { status: 'exported', codes, result: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[NightlyRefresh] export failed: ${msg}`);
    return { status: 'failed', codes, error: msg };
  }
}

/** sync_log.error_message holds a JSON summary so the freshness tool can read failures back. */
function summarizeForLog(r: NightlyRefreshResult): string {
  return JSON.stringify({
    mode: r.mode,
    checked: r.checked,
    unchanged: r.unchanged,
    attempted: r.attempted,
    refreshed: r.refreshed,
    failure_count: r.failures.length,
    failures: r.failures.slice(0, 50),
    changed_codes: r.changed_codes,
    unregistered_ids: r.unregistered_ids,
    export_status: r.export.status,
    error: r.error ?? null,
  });
}

// ---- get_workflow_freshness ----

export interface FreshnessDeps {
  ghl?: { getWorkflows: () => Promise<GHLWorkflow[]> };
  supabase?: SupabaseLike;
  readStepCounts?: (supabase: SupabaseLike) => Promise<Map<string, number> | null>;
}

/**
 * How stale is the workflow cache right now? Each section is read on its own
 * and reports its own error, the same way get_sync_health does, so one failed
 * read never hides the others.
 */
export async function getWorkflowFreshness(deps: FreshnessDeps = {}): Promise<Record<string, unknown>> {
  const supabase = deps.supabase ?? getSupabaseClient();
  const ghl = deps.ghl ?? new GHLClient();
  const readCounts = deps.readStepCounts ?? readStepCounts;
  const out: Record<string, unknown> = { mode: nightlyRefreshMode(), checked_at: nowET() };

  // Cache rows.
  let cacheRows: Array<{ ghl_workflow_id: string; name: string | null; version: number | null; last_refreshed_version: number | null }> = [];
  try {
    const { data, error } = await supabase
      .from('workflows')
      .select('ghl_workflow_id, name, version, last_refreshed_version')
      .is('deleted_at', null);
    if (error) throw new Error(error.message);
    cacheRows = data || [];
  } catch (err) {
    out.stale = {
      error: err instanceof Error ? err.message : String(err),
      suggestion: 'If last_refreshed_version is missing, apply supabase/migrations/018_workflow_last_refreshed_version.sql.',
    };
  }

  if (!out.stale) {
    // Live version: GHL's list if reachable, else the cached workflows.version
    // (which the hourly bulk sync keeps current). The source is reported so
    // the number is never mistaken for more than it is.
    let live: Array<{ id: string; name: string; version: number | null }>;
    let versionSource: string;
    try {
      const list = await ghl.getWorkflows();
      live = list.map((w) => ({ id: w.id, name: w.name, version: typeof w.version === 'number' ? w.version : null }));
      versionSource = 'ghl_live';
    } catch (err) {
      live = cacheRows.map((r) => ({ id: r.ghl_workflow_id, name: r.name || 'Unknown', version: r.version }));
      versionSource = `cache_workflows_version (GHL list failed: ${err instanceof Error ? err.message : String(err)})`;
    }
    const stored = new Map(cacheRows.map((r) => [r.ghl_workflow_id, r.last_refreshed_version]));
    const stale = live.filter((w) => {
      const s = stored.get(w.id);
      return s === null || s === undefined || w.version === null || w.version !== s;
    });
    out.version_source = versionSource;
    out.total_workflows = live.length;
    out.stale_count = stale.length;
    out.never_refreshed_count = stale.filter((w) => stored.get(w.id) == null).length;
    out.stale_sample = stale.slice(0, 25).map((w) => ({
      workflow_id: w.id,
      name: w.name,
      live_version: w.version,
      last_refreshed_version: stored.get(w.id) ?? null,
    }));
  }

  // Zero-step workflows.
  try {
    const counts = await readCounts(supabase);
    if (!counts) throw new Error('workflow_steps read failed');
    const zero = cacheRows.filter((r) => !counts.get(r.ghl_workflow_id));
    out.zero_step_count = zero.length;
    out.zero_step_sample = zero.slice(0, 25).map((r) => ({ workflow_id: r.ghl_workflow_id, name: r.name }));
  } catch (err) {
    out.zero_step_count = { error: err instanceof Error ? err.message : String(err) };
  }

  // Last nightly run.
  try {
    const { data, error } = await supabase
      .from('sync_log')
      .select('status, started_at, completed_at, records_synced, error_message')
      .eq('entity_type', NIGHTLY_REFRESH_JOB)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data || [])[0];
    if (!row) {
      out.last_run = null;
    } else {
      let summary: unknown = row.error_message;
      try { summary = row.error_message ? JSON.parse(row.error_message) : null; } catch { /* keep raw text */ }
      out.last_run = {
        status: row.status,
        started_at: row.started_at,
        completed_at: row.completed_at,
        refreshed: row.records_synced,
        summary,
      };
    }
  } catch (err) {
    out.last_run = { error: err instanceof Error ? err.message : String(err) };
  }

  return out;
}
